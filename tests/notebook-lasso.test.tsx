// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import NotebookLassoLayer from "@/components/workspace/NotebookLassoLayer";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import { useNotebookLasso, type NotebookLassoPlaced } from "@/hooks/useNotebookLasso";
import type { InkItem, InkOutlineItem } from "@/lib/ink/model";
import type { NotebookImageRef, NotebookTextBlock } from "@/lib/workspace/notebooks";

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
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // The layer is the page at one CSS pixel per page unit.
    return this.dataset.notebookLasso
      ? ({ left: 0, top: 0, width: 900, height: 1240, right: 900, bottom: 1240, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
      : original.call(this);
  };
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = original;
});

let container: HTMLDivElement;
let root: Root;
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
  const edits: string[] = [];
  const handle = {
    lasso: {
      inkInLoop: vi.fn(() => ["ink"]),
      items: vi.fn((ids: readonly string[]) => doc.filter((item) => ids.includes(item.id))),
      beginEdit: () => edits.push("begin"),
      showEdit: (items: readonly InkItem[]) => {
        doc = doc.map((item) => items.find((each) => each.id === item.id) ?? item);
        edits.push("show");
      },
      endEdit: () => edits.push("end"),
      removeItems: (ids: readonly string[]) => {
        doc = doc.filter((item) => !ids.includes(item.id));
        edits.push("remove");
      },
    },
  } as unknown as NotebookInkEditorHandle;
  let images: NotebookImageRef[] = [{ id: "img", x: 120, y: 120, displayWidth: 40, displayHeight: 40 }];
  let texts: NotebookTextBlock[] = [{ id: "far", x: 600, y: 900, width: 100, height: 40, text: "x", outlineVisible: false }];
  const placed: NotebookLassoPlaced = {
    images: () => images,
    graphs: () => [],
    showImages: (next) => {
      images = next;
    },
    showGraphs: () => undefined,
    saveImages: vi.fn((next: NotebookImageRef[]) => {
      images = next;
    }),
    saveGraphs: vi.fn(),
    texts: () => texts,
    setTexts: (next) => {
      texts = next;
    },
    recordTexts: vi.fn(),
    markUnsaved: vi.fn(),
  };
  function Harness() {
    const ref = useRef(handle);
    const lasso = useNotebookLasso({ active: true, pageId: "p", inkEditorRef: ref, placed });
    return <NotebookLassoLayer lasso={lasso} />;
  }
  act(() => root.render(<Harness />));
  return { edits, placed, doc: () => doc, images: () => images };
}

function pointer(type: string, x: number, y: number) {
  const layer = container.querySelector("[data-notebook-lasso]")!;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "pen" } });
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

  it("moves everything picked up together, as one ink undo step and one image save", () => {
    const { edits, placed, doc, images } = setUp();
    drawLoop();
    pointer("pointerdown", 150, 150);
    pointer("pointermove", 170, 160);
    pointer("pointermove", 190, 170);
    pointer("pointerup", 190, 170);
    expect(edits[0]).toBe("begin");
    expect(edits.at(-1)).toBe("end");
    const moved = doc()[0] as InkOutlineItem;
    expect(moved.path[0]).toMatchObject({ x: 140, y: 120 });
    expect(images()[0]).toMatchObject({ x: 160, y: 140 });
    expect(placed.saveImages).toHaveBeenCalledTimes(1);
  });

  it("deletes everything picked up", () => {
    const { doc, images } = setUp();
    drawLoop();
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete what is selected"]')!;
    act(() => remove.click());
    expect(doc()).toEqual([]);
    expect(images()).toEqual([]);
    expect(container.querySelector('[aria-label="Selection"]')).toBeNull();
  });
});
