// @vitest-environment jsdom

import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JamiInkEditor } from "@/components/workspace/JamiInkEditor";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import { jamiInkData } from "@/lib/workspace/notebook-ink-data";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";
import { docOf, outline } from "./support/ink-fixtures";

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/ink-dom/surface", () => ({ createInkSurface: engine.create }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeSurface = {
  [K in
    | "load"
    | "setViewport"
    | "beginGesture"
    | "endGesture"
    | "whenVisibleDrawn"
    | "beginStroke"
    | "moveStroke"
    | "endStroke"
    | "cancelStroke"
    | "beginErase"
    | "moveErase"
    | "endErase"
    | "cancelErase"
    | "undo"
    | "redo"
    | "clear"
    | "hasInk"
    | "historyState"
    | "document"
    | "destroy"]: ReturnType<typeof vi.fn>;
} & { busy: boolean };

/** The page as saved, and as it stands once the pen has been at it. */
const SAVED = docOf(outline("saved", [{ op: "M", x: 10, y: 10 }, { op: "L", x: 50, y: 50 }]));
const COMMITTED = docOf(outline("committed", [{ op: "M", x: 20, y: 20 }, { op: "L", x: 80, y: 40 }]));
const PAGE = { width: 900, height: 1240 };

function makeSurface(): FakeSurface {
  return {
    load: vi.fn(),
    setViewport: vi.fn(),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
    whenVisibleDrawn: vi.fn(() => vi.fn()),
    beginStroke: vi.fn(),
    moveStroke: vi.fn(),
    endStroke: vi.fn(() => "committed"),
    cancelStroke: vi.fn(),
    beginErase: vi.fn(),
    moveErase: vi.fn(),
    endErase: vi.fn(),
    cancelErase: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    clear: vi.fn(),
    hasInk: vi.fn(() => true),
    historyState: vi.fn(() => ({ undoDepth: 2, redoDepth: 1 })),
    document: vi.fn(() => COMMITTED),
    destroy: vi.fn(),
    busy: false,
  };
}

type Props = ComponentProps<typeof JamiInkEditor>;

const callbacks = {
  onChange: vi.fn(),
  onHistoryChange: vi.fn(),
  onInteractionChange: vi.fn(),
  onReady: vi.fn(),
  onReadyError: vi.fn(),
  onPointerCancel: vi.fn(),
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
};

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    activeTool: "pen",
    eraserMode: "precision",
    eraserThickness: 24,
    highlighterColor: "yellow",
    highlighterThickness: 18,
    penColor: "black",
    penSettings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
    penThickness: 3,
    initialInk: jamiInkData(SAVED, PAGE),
    pageHeight: 1240,
    pageId: "page-1",
    pageWidth: 900,
    ...callbacks,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let surface: FakeSurface;
let createdOptions: { page: { width: number; height: number }; onChange(): void; onHistoryChange(u: number, r: number): void };
let hostRect: { left: number; top: number; width: number; height: number };
const handle = createRef<NotebookInkEditorHandle>();

function render(props: Props) {
  act(() => {
    root.render(<JamiInkEditor ref={handle} {...props} />);
  });
}

const host = () => container.querySelector<HTMLElement>("[data-jami-ink-host]")!;
const lastViewport = () => surface.setViewport.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.useFakeTimers();
  surface = makeSurface();
  engine.create.mockReset();
  engine.create.mockImplementation((_host, options) => {
    createdOptions = options;
    return surface;
  });
  for (const fn of Object.values(callbacks)) fn.mockReset();
  hostRect = { left: 10, top: 20, width: 450, height: 620 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = "jamiInkHost" in this.dataset ? hostRect : { left: 0, top: 0, width: 0, height: 0 };
    return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("JamiInkEditor", () => {
  it("lays out the same layer as the js-draw editor: a host, the input surface and the eraser ring", () => {
    render(baseProps({ activeTool: "eraser" }));
    const wrapper = container.querySelector("[data-notebook-live-ink-editor]")!;
    expect(wrapper.className).toContain("z-20");
    expect(host().getAttribute("aria-hidden")).toBe("true");
    expect(host().className).toContain("pointer-events-none");
    const input = container.querySelector('[role="img"]')!;
    expect(input.getAttribute("aria-label")).toBe("Notebook drawing page");
    expect(input.className).toContain("touch-none");
    expect(input.className).toContain("cursor-none");
    expect(container.querySelector('[data-testid="notebook-eraser-cursor"]')).not.toBeNull();

    render(baseProps({ activeTool: "pen" }));
    expect(container.querySelector('[role="img"]')!.className).not.toContain("cursor-none");
    expect(container.querySelector('[data-testid="notebook-eraser-cursor"]')).toBeNull();
  });

  it("builds the surface for the page, loads its ink, sets the first viewport and then reports ready", () => {
    render(baseProps());
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(engine.create.mock.calls[0][0]).toBe(host());
    expect(createdOptions.page).toEqual({ width: 900, height: 1240 });
    // Its own encoding, not the SVG beside it.
    expect(surface.load).toHaveBeenCalledWith(SAVED);
    expect(lastViewport()).toMatchObject({
      scale: 0.5,
      visible: { left: 0, top: 0, width: 450, height: 620 },
      screenOrigin: { x: 10, y: 20 },
    });
    expect(surface.whenVisibleDrawn).toHaveBeenCalledTimes(1);
    expect(callbacks.onReady).not.toHaveBeenCalled();
    surface.whenVisibleDrawn.mock.calls[0][0]();
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
  });

  it("passes the surface's edits and history on to the latest callbacks", () => {
    render(baseProps());
    const later = vi.fn();
    render(baseProps({ onChange: later }));
    createdOptions.onChange();
    createdOptions.onHistoryChange(3, 0);
    expect(later).toHaveBeenCalledTimes(1);
    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(callbacks.onHistoryChange).toHaveBeenCalledWith(3, 0);
    // A changed callback never rebuilds the engine.
    expect(engine.create).toHaveBeenCalledTimes(1);
  });

  it("takes the part of the sheet on screen from the frame, each time the page moves", () => {
    hostRect = { left: -500, top: -300, width: 2700, height: 3720 };
    render(baseProps({ inkFrame: { pageX: -500, pageY: -300, frameWidth: 1000, frameHeight: 800 } }));
    expect(lastViewport()).toMatchObject({
      scale: 3,
      visible: { left: 500, top: 300, width: 1000, height: 800 },
    });
    const setViewportCalls = surface.setViewport.mock.calls.length;

    hostRect = { left: -900, top: -300, width: 2700, height: 3720 };
    render(baseProps({ inkFrame: { pageX: -900, pageY: -300, frameWidth: 1000, frameHeight: 800 } }));
    expect(surface.setViewport.mock.calls.length).toBe(setViewportCalls + 1);
    expect(lastViewport()).toMatchObject({
      visible: { left: 900, top: 300, width: 1000, height: 800 },
      screenOrigin: { x: -900, y: -300 },
    });
    // Neither move rebuilt the engine or asked for readiness again.
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(surface.whenVisibleDrawn).toHaveBeenCalledTimes(1);
  });

  it("holds the engine while a scroll lasts and measures once it settles", () => {
    render(baseProps());
    const before = surface.setViewport.mock.calls.length;
    hostRect = { left: 10, top: -140, width: 450, height: 620 };

    act(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
    });
    expect(surface.beginGesture).toHaveBeenCalledTimes(1);
    expect(surface.endGesture).not.toHaveBeenCalled();
    expect(surface.setViewport.mock.calls.length).toBe(before);

    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(surface.endGesture).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(surface.endGesture).toHaveBeenCalledTimes(1);
    expect(surface.setViewport.mock.calls.length).toBe(before + 1);
    expect(lastViewport().screenOrigin).toEqual({ x: 10, y: -140 });
  });

  /*
   * A new page took no writing (19 Oct 2026): its editor mounts mid-turn, a
   * page's width off to the side, and the turn ends by moving the page track,
   * which no scroll or resize reports. Every stroke was mapped from where the
   * sheet had been.
   */
  describe("when a page turn moves the sheet", () => {
    let track: HTMLDivElement;

    function renderInTrack(props: Props) {
      act(() => {
        root.render(
          <div data-notebook-page-track="" ref={(element) => { if (element) track = element; }}>
            <JamiInkEditor ref={handle} {...props} />
          </div>
        );
      });
    }

    it("measures again as soon as the turn ends with a jump", async () => {
      hostRect = { left: -810, top: 20, width: 450, height: 620 };
      renderInTrack(baseProps());
      expect(lastViewport().screenOrigin).toEqual({ x: -810, y: 20 });

      hostRect = { left: 10, top: 20, width: 450, height: 620 };
      await act(async () => {
        track.style.transition = "none";
        track.style.transform = "translate3d(0px, 0, 0)";
      });
      expect(lastViewport().screenOrigin).toEqual({ x: 10, y: 20 });
      expect(surface.beginGesture).not.toHaveBeenCalled();
    });

    it("holds through an animated turn and measures where it lands", async () => {
      renderInTrack(baseProps());
      const before = surface.setViewport.mock.calls.length;

      await act(async () => {
        track.style.transition = "transform 300ms ease";
        track.style.transform = "translate3d(-820px, 0, 0)";
      });
      expect(surface.beginGesture).toHaveBeenCalledTimes(1);
      expect(surface.setViewport.mock.calls.length).toBe(before);

      hostRect = { left: -810, top: 20, width: 450, height: 620 };
      const arrived = new Event("transitionend");
      Object.defineProperty(arrived, "propertyName", { value: "transform" });
      act(() => {
        track.dispatchEvent(arrived);
      });
      expect(surface.endGesture).toHaveBeenCalledTimes(1);
      expect(lastViewport().screenOrigin).toEqual({ x: -810, y: 20 });
    });
  });

  it("does not measure during a stroke; it waits for it to end", () => {
    render(baseProps());
    const input = container.querySelector('[role="img"]')!;
    const fire = (type: string, buttons: number) =>
      act(() => {
        input.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", buttons })
        );
      });
    fire("pointerdown", 1);
    surface.busy = true;
    const before = surface.setViewport.mock.calls.length;
    hostRect = { left: 10, top: -140, width: 450, height: 620 };

    act(() => {
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(120);
    });
    expect(surface.setViewport.mock.calls.length).toBe(before);

    surface.busy = false;
    fire("pointerup", 0);
    expect(surface.setViewport.mock.calls.length).toBe(before + 1);
    expect(lastViewport().screenOrigin).toEqual({ x: 10, y: -140 });
  });

  it("answers the handle from the surface", () => {
    render(baseProps());
    const api = handle.current!;
    api.undo();
    api.redo();
    api.clear();
    expect(surface.undo).toHaveBeenCalledTimes(1);
    expect(surface.redo).toHaveBeenCalledTimes(1);
    expect(surface.clear).toHaveBeenCalledTimes(1);
    expect(api.getHistoryState()).toEqual({ undoDepth: 2, redoDepth: 1 });
    expect(api.hasInk()).toBe(true);
    const saved = api.serialize();
    expect(saved).toEqual(jamiInkData(COMMITTED, PAGE));
    // Made once for each version of the page.
    expect(api.serializeWarm()).toBe(saved);
    expect(api.isInteracting()).toBe(false);
  });

  it("serializes asynchronously only while no pen is down", async () => {
    render(baseProps());
    await expect(handle.current!.serializeAsync()).resolves.toEqual(jamiInkData(COMMITTED, PAGE));

    act(() => {
      container
        .querySelector('[role="img"]')!
        .dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", buttons: 1 })
        );
    });
    expect(handle.current!.isInteracting()).toBe(true);
    expect(surface.beginStroke).toHaveBeenCalledTimes(1);
    expect(callbacks.onInteractionChange).toHaveBeenCalledWith(true);
    await expect(handle.current!.serializeAsync()).resolves.toBeNull();
  });

  it("remembers the eraser mode the page sets for the next contact", () => {
    render(baseProps({ activeTool: "eraser", eraserMode: "precision" }));
    handle.current!.setEraserMode("stroke");
    act(() => {
      container
        .querySelector('[role="img"]')!
        .dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", buttons: 1 })
        );
    });
    expect(surface.beginErase.mock.calls[0][0].mode).toBe("stroke");
  });

  it("reports a page that fails to load, and keeps the page from saving a blank one", () => {
    surface.load.mockImplementation(() => {
      throw new Error("bad page");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(baseProps());
    expect(callbacks.onReadyError).toHaveBeenCalledTimes(1);
    expect(surface.whenVisibleDrawn).not.toHaveBeenCalled();
    expect(handle.current!.serialize()).toBeNull();
    errors.mockRestore();
  });

  it("will not open a page whose ink it cannot read as an empty one", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Jami Ink's encoding alone, and not one this build can decode.
    render(baseProps({ initialInk: { version: 3, format: "jami-ink", data: "j3:AAAA" } }));
    expect(surface.load).not.toHaveBeenCalled();
    expect(callbacks.onReadyError).toHaveBeenCalledTimes(1);
    expect(handle.current!.serialize()).toBeNull();
    errors.mockRestore();
  });

  it("rebuilds for a new page, and takes the engine down with the editor", () => {
    render(baseProps());
    const first = surface;
    surface = makeSurface();
    render(baseProps({ pageId: "page-2" }));
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(engine.create).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    expect(surface.destroy).toHaveBeenCalledTimes(1);
    expect(callbacks.onInteractionChange).toHaveBeenCalledWith(false);
    root = createRoot(container);
  });
});
