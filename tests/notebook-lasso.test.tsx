// @vitest-environment jsdom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import NotebookLassoLayer from "@/components/workspace/NotebookLassoLayer";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import { useNotebookLasso, type NotebookLassoController, type NotebookLassoPlaced } from "@/hooks/useNotebookLasso";
import type { InkItem, InkOutlineItem } from "@/lib/ink/model";
import type { NotebookImageRef, NotebookTextBlock } from "@/lib/workspace/notebooks";
import { FakePath2D, installFakeCanvas, type FakeCanvasEnvironment } from "./support/fake-canvas";

const black = { r: 17, g: 24, b: 39, a: 1 };
const ink: InkOutlineItem = {
  kind: "outline",
  id: "ink",
  layer: "pen",
  path: [
    { op: "M", x: 100, y: 100 },
    { op: "L", x: 200, y: 200 },
  ],
  paint: { fill: null, stroke: { color: black, width: 3, cap: "round", join: "round" }, opacity: 1 },
};

const original = HTMLElement.prototype.getBoundingClientRect;
let canvas: FakeCanvasEnvironment;
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // The layer is the page at one CSS pixel per page unit.
    return this.dataset.notebookLasso
      ? ({ left: 0, top: 0, width: 900, height: 1240, right: 900, bottom: 1240, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
      : original.call(this);
  };
  canvas = installFakeCanvas();
  vi.stubGlobal("Path2D", FakePath2D);
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = original;
  canvas.restore();
  vi.unstubAllGlobals();
});

let container: HTMLDivElement;
let root: Root;
/** The lasso as last rendered. */
let controller: NotebookLassoController;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function setUp() {
  let doc: InkItem[] = [ink];
  let start: InkItem[] | null = null;
  const edits: string[] = [];
  /** What was saved inside `together`, which makes it one undo step. */
  const grouped: string[] = [];
  let inGroup = false;
  const drawn: Array<() => void> = [];
  const handle = {
    lasso: {
      inkInLoop: vi.fn(() => ["ink"]),
      items: vi.fn((ids: readonly string[]) => doc.filter((item) => ids.includes(item.id))),
      beginEdit: () => {
        start = doc;
        edits.push("begin");
      },
      showEdit: (items: readonly InkItem[]) => {
        doc = doc.map((item) => items.find((each) => each.id === item.id) ?? item);
        edits.push("show");
      },
      hideItems: (ids: readonly string[]) => {
        doc = doc.filter((item) => !ids.includes(item.id));
        edits.push("hide");
      },
      endEdit: (items?: readonly InkItem[]) => {
        if (items && start) doc = start.map((item) => items.find((each) => each.id === item.id) ?? item);
        start = null;
        edits.push("end");
        if (inGroup) grouped.push("ink");
      },
      removeItems: (ids: readonly string[]) => {
        doc = doc.filter((item) => !ids.includes(item.id));
        edits.push("remove");
        if (inGroup) grouped.push("ink");
      },
      whenVisibleDrawn: (callback: () => void) => {
        drawn.push(callback);
        return () => undefined;
      },
    },
  } as unknown as NotebookInkEditorHandle;
  const picture: NotebookImageRef = { id: "img", x: 120, y: 120, displayWidth: 40, displayHeight: 40 };
  let images: NotebookImageRef[] = [picture];
  let texts: NotebookTextBlock[] = [{ id: "far", x: 600, y: 900, width: 100, height: 40, text: "x", outlineVisible: false }];
  const placed: NotebookLassoPlaced = {
    images: () => images,
    graphs: () => [],
    saveImages: vi.fn((next: NotebookImageRef[]) => {
      images = next;
      if (inGroup) grouped.push("images");
    }),
    saveGraphs: vi.fn(),
    deleteImages: vi.fn((ids: readonly string[]) => {
      images = images.filter((image) => !ids.includes(image.id));
      if (inGroup) grouped.push("images");
    }),
    texts: () => texts,
    setTexts: (next) => {
      texts = next;
    },
    recordTexts: vi.fn(),
    markUnsaved: vi.fn(),
    together: vi.fn((run: () => void) => {
      inGroup = true;
      try {
        run();
      } finally {
        inGroup = false;
      }
    }),
  };
  function Harness({ active }: { active: boolean }) {
    const ref = useRef(handle);
    const lasso = useNotebookLasso({ active, pageId: "p", inkEditorRef: ref, placed });
    useEffect(() => {
      controller = lasso;
    });
    return (
      <>
        {/* The picture, as the image layer shows it. */}
        <div data-notebook-placed="image:img" />
        <NotebookLassoLayer lasso={lasso} page={fingers} />
      </>
    );
  }
  act(() => root.render(<Harness active />));
  return {
    edits,
    grouped,
    placed,
    doc: () => doc,
    images: () => images,
    picture: () => container.querySelector<HTMLElement>('[data-notebook-placed="image:img"]')!,
    ghost: () => container.querySelector("[data-notebook-lasso] canvas"),
    /** The page draws the ink put back. */
    draw: () => act(() => drawn.splice(0).forEach((callback) => callback())),
    putDown: () => act(() => root.render(<Harness active={false} />)),
    /** An undo: the ink and the picture are back where they were picked up. */
    undo: () => {
      doc = [ink];
      images = [picture];
    },
  };
}

/** The page's own handling of fingers, as the lasso hands them on. */
const fingers = {
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
};

function pointer(type: string, x: number, y: number, pointerType = "pen") {
  const layer = container.querySelector("[data-notebook-lasso]")!;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
  act(() => {
    layer.dispatchEvent(event);
  });
}

function drawLoop() {
  pointer("pointerdown", 50, 50);
  for (const [x, y] of [
    [300, 50],
    [300, 300],
    [50, 300],
    [50, 60],
  ]) {
    pointer("pointermove", x, y);
  }
  pointer("pointerup", 50, 60);
}

describe("the lasso", () => {
  it("picks up the ink and the image inside its loop, and leaves what is outside", () => {
    setUp();
    drawLoop();
    expect(container.querySelector('[role="toolbar"][aria-label="Selection"]')).not.toBeNull();
    // Colour and thickness are for ink, which there is.
    expect(container.querySelector('[aria-label="Thicker"]')).not.toBeNull();
  });

  it("moves everything picked up together, as one undo step and one image save", () => {
    const { edits, grouped, placed, doc, images } = setUp();
    drawLoop();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 170, 160);
    pointer("pointermove", 190, 170);
    pointer("pointerup", 190, 170);
    expect(edits).toEqual(["begin", "hide", "end"]);
    const moved = doc()[0] as InkOutlineItem;
    expect(moved.path[0]).toMatchObject({ x: 140, y: 120 });
    expect(images()[0]).toMatchObject({ x: 160, y: 140 });
    expect(placed.saveImages).toHaveBeenCalledTimes(1);
    expect(placed.together).toHaveBeenCalledTimes(1);
    expect(grouped).toEqual(["ink", "images"]);
  });

  it("carries what it picked up by CSS while it moves, and changes the page only when it is put down", () => {
    const { placed, doc, images, picture, ghost, draw } = setUp();
    drawLoop();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 170, 160);
    pointer("pointermove", 190, 170);
    // The ink is off the page, shown by a picture of it; the image moves by its CSS.
    expect(doc()).toEqual([]);
    expect(ghost()).not.toBeNull();
    expect(picture().style.translate).not.toBe("");
    expect(images()[0]).toMatchObject({ x: 120, y: 120 });
    expect(placed.saveImages).not.toHaveBeenCalled();

    pointer("pointerup", 190, 170);
    // The image is where its layer now draws it, and its CSS is gone.
    expect(images()[0]).toMatchObject({ x: 160, y: 140 });
    expect(picture().style.translate).toBe("");
    // The picture of the ink stays until the page has drawn the ink itself.
    expect(ghost()).not.toBeNull();
    draw();
    expect(ghost()).toBeNull();
  });

  it("moves and saves nothing for a tap inside the box", () => {
    const { edits, placed, doc } = setUp();
    drawLoop();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 151, 151);
    pointer("pointerup", 151, 151);
    expect(edits).toEqual([]);
    expect(doc()).toEqual([ink]);
    expect(placed.saveImages).not.toHaveBeenCalled();
  });

  it("puts everything back where it was when the lasso is put down mid-drag", () => {
    const { edits, placed, doc, images, picture, putDown } = setUp();
    drawLoop();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 190, 170);
    putDown();
    expect(edits).toEqual(["begin", "hide", "end"]);
    expect(doc()).toEqual([ink]);
    expect(doc()[0]).toBe(ink);
    expect(images()[0]).toMatchObject({ x: 120, y: 120 });
    expect(picture().style.translate).toBe("");
    expect(placed.saveImages).not.toHaveBeenCalled();
  });

  it("moves what is on the page now, after an undo has put it back", () => {
    const { doc, images, undo } = setUp();
    drawLoop();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 190, 170);
    pointer("pointerup", 190, 170);
    undo();
    // Inside the box, which still shows where the drag left things.
    pointer("pointerdown", 170, 170);
    pointer("pointermove", 180, 170);
    pointer("pointerup", 180, 170);
    expect((doc()[0] as InkOutlineItem).path[0]).toMatchObject({ x: 110, y: 100 });
    expect(images()[0]).toMatchObject({ x: 130, y: 120 });
  });

  it("fits its box to where things are after an undo puts them back", () => {
    const { undo } = setUp();
    drawLoop();
    const outline = () => container.querySelector("[data-notebook-lasso] svg polygon")?.getAttribute("points");
    const pickedUp = outline();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 190, 170);
    pointer("pointerup", 190, 170);
    expect(outline()).not.toBe(pickedUp);
    undo();
    act(() => controller.refresh());
    expect(outline()).toBe(pickedUp);
  });

  it("hands fingers on to the page, so they still pinch and pan, and picks nothing up with them", () => {
    const { edits } = setUp();
    Object.values(fingers).forEach((handler) => handler.mockClear());
    pointer("pointerdown", 50, 50, "touch");
    pointer("pointermove", 300, 300, "touch");
    pointer("pointerup", 300, 300, "touch");
    pointer("pointercancel", 300, 300, "touch");
    expect(fingers.onPointerDown).toHaveBeenCalledTimes(1);
    expect(fingers.onPointerMove).toHaveBeenCalledTimes(1);
    expect(fingers.onPointerUp).toHaveBeenCalledTimes(1);
    expect(fingers.onPointerCancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Selection"]')).toBeNull();
    expect(edits).toEqual([]);
  });

  it("deletes everything picked up, as one undo step", () => {
    const { doc, images, grouped, placed } = setUp();
    drawLoop();
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete what is selected"]')!;
    act(() => remove.click());
    expect(doc()).toEqual([]);
    expect(images()).toEqual([]);
    // Images go with their files, through the page's own delete.
    expect(placed.deleteImages).toHaveBeenCalledWith(["img"]);
    expect(grouped).toEqual(["ink", "images"]);
    expect(container.querySelector('[aria-label="Selection"]')).toBeNull();
  });
});
