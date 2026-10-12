// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJamiInkPointerInput } from "@/hooks/useJamiInkPointerInput";
import type { JamiInkSurfaceEngine } from "@/hooks/useJamiInkSurface";
import { InkInputTrace } from "@/lib/ink-dom/input-trace";
import type { InkScreenMapping } from "@/lib/ink-dom/stroke-session";
import type { InkSurface } from "@/lib/ink-dom/surface";
import { getNotebookEraserCursorDiameter, type NotebookEraserMode } from "@/lib/workspace/notebook-eraser";
import type { NotebookInkStyle } from "@/lib/workspace/notebook-ink-types";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";
import { NotebookInkPointerLifecycle } from "@/lib/workspace/notebook-pointer-lifecycle";

const scribble = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("@/lib/workspace/notebook-scribble-erase", () => ({
  detectNotebookScribble: scribble.detect,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The page's corner is at (100, 50) on screen, drawn at two screen pixels per page unit. */
const MAPPING: InkScreenMapping = { left: 100, top: 50, scale: 2 };

type FakeSurface = {
  [K in
    | "beginStroke"
    | "moveStroke"
    | "endStroke"
    | "cancelStroke"
    | "beginErase"
    | "moveErase"
    | "endErase"
    | "cancelErase"]: ReturnType<typeof vi.fn>;
};

const baseStyle: NotebookInkStyle = {
  activeTool: "pen",
  eraserMode: "precision",
  eraserThickness: 24,
  highlighterColor: "yellow",
  highlighterThickness: 18,
  penColor: "black",
  penSettings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
  penThickness: 3,
};

type HarnessProps = {
  style: NotebookInkStyle;
  readOnly: boolean;
  scribbleToErase: boolean;
  trace?: { recorder: InkInputTrace; readoutRef: { current: HTMLDivElement | null } } | null;
};

let container: HTMLDivElement;
let root: Root;
let surface: FakeSurface;
let engine: JamiInkSurfaceEngine;
let lifecycle: NotebookInkPointerLifecycle;
let eraserModeRef: { current: NotebookEraserMode };
let props: HarnessProps;
const reportInteraction = vi.fn();
const settle = vi.fn();
const page = {
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
};

function Harness({ style, readOnly, scribbleToErase, trace = null }: HarnessProps) {
  const inkSurfaceRef = useRef<HTMLDivElement | null>(null);
  const eraserCursorRef = useRef<HTMLDivElement | null>(null);
  const lifecycleRef = useRef(lifecycle);
  const input = useJamiInkPointerInput({
    engine,
    inkSurfaceRef,
    eraserCursorRef,
    lifecycleRef,
    eraserModeRef,
    style,
    readOnly,
    scribbleToErase,
    shapesOnHold: true,
    reportInteraction,
    page,
    trace,
  });
  return (
    <div ref={inkSurfaceRef} data-testid="surface" {...input.surfaceHandlers}>
      <div ref={eraserCursorRef} data-testid="ring" />
    </div>
  );
}

function render(overrides: Partial<HarnessProps> = {}) {
  props = { ...props, ...overrides };
  act(() => {
    root.render(<Harness {...props} />);
  });
}

const surfaceEl = () => container.querySelector<HTMLElement>('[data-testid="surface"]')!;
const ringEl = () => container.querySelector<HTMLElement>('[data-testid="ring"]')!;

type EventInit = {
  pointerId?: number;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
  buttons?: number;
  pressure?: number;
};

function fire(type: string, init: EventInit = {}, extra?: Record<string, unknown>) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "pen",
    buttons: 1,
    pressure: 0.5,
    ...init,
  });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
  }
  act(() => {
    surfaceEl().dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  surface = {
    beginStroke: vi.fn(),
    moveStroke: vi.fn(),
    endStroke: vi.fn(() => "committed"),
    cancelStroke: vi.fn(),
    beginErase: vi.fn(),
    moveErase: vi.fn(),
    endErase: vi.fn(),
    cancelErase: vi.fn(),
  };
  engine = {
    surfaceRef: { current: surface as unknown as InkSurface },
    loadedRef: { current: true },
    getMapping: () => MAPPING,
    measureNow: () => MAPPING,
    peekMapping: () => MAPPING,
    settle,
  };
  lifecycle = new NotebookInkPointerLifecycle();
  eraserModeRef = { current: "precision" };
  props = { style: baseStyle, readOnly: false, scribbleToErase: false };
  reportInteraction.mockReset();
  settle.mockReset();
  scribble.detect.mockReset();
  for (const handler of Object.values(page)) handler.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a pen stroke", () => {
  it("begins with the tool fixed at contact, draws each packet, and ends at the lift", () => {
    const down = fire("pointerdown", { clientX: 120, clientY: 90 });
    expect(down.defaultPrevented).toBe(true);
    expect(surface.beginStroke).toHaveBeenCalledTimes(1);
    const begin = surface.beginStroke.mock.calls[0][0];
    expect(begin.mapping).toEqual(MAPPING);
    expect(begin.first).toMatchObject({ clientX: 120, clientY: 90, pressure: 0.5 });
    expect(begin.tool).toMatchObject({
      kind: "pen",
      color: { r: 0x11, g: 0x18, b: 0x27, a: 1 },
      thickness: 3,
      settings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
      // A stylus asks the browser where it is heading.
      predictTip: true,
    });
    expect(typeof begin.tool.pressure).toBe("boolean");
    expect(reportInteraction).toHaveBeenCalledWith(true);
    expect(lifecycle.isDown(1)).toBe(true);

    const earlier = { clientX: 124, clientY: 92, pressure: 0.6, timeStamp: down.timeStamp + 1 };
    const move = fire(
      "pointermove",
      { clientX: 130, clientY: 95, pressure: 0.7 },
      {
        getCoalescedEvents: () => [earlier],
        getPredictedEvents: () => [{ clientX: 140, clientY: 100, pressure: 0.7, timeStamp: down.timeStamp + 9 }],
      }
    );
    expect(surface.moveStroke).toHaveBeenCalledTimes(1);
    const [samples, predicted] = surface.moveStroke.mock.calls[0];
    expect(samples).toEqual([earlier, move]);
    expect(predicted).toEqual([expect.objectContaining({ clientX: 140, clientY: 100 })]);

    fire("pointerup", { clientX: 130, clientY: 95, buttons: 0 });
    expect(surface.endStroke).toHaveBeenCalledTimes(1);
    expect(surface.endStroke).toHaveBeenCalledWith(null);
    expect(surface.cancelStroke).not.toHaveBeenCalled();
    expect(reportInteraction).toHaveBeenLastCalledWith(false);
    expect(lifecycle.isInteracting).toBe(false);
    expect(settle).toHaveBeenCalled();
  });

  it("with the timing readout on, writes the stroke's figures when the pen lifts, and nothing before", () => {
    const readout = document.createElement("div");
    const frames = { request: vi.fn(() => 1), cancel: vi.fn() };
    const recorder = new InkInputTrace(16, {
      now: () => performance.now(),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    render({ trace: { recorder, readoutRef: { current: readout } } });

    const down = fire("pointerdown", { clientX: 120, clientY: 90 });
    expect(frames.request).toHaveBeenCalledTimes(1);
    fire(
      "pointermove",
      { clientX: 130, clientY: 95 },
      { getCoalescedEvents: () => [{ clientX: 124, clientY: 92, pressure: 0.6, timeStamp: down.timeStamp + 1 }] }
    );
    expect(readout.textContent).toBe("");
    fire("pointerup", { clientX: 130, clientY: 95, buttons: 0 });

    expect(readout.textContent).toContain("Last stroke: pen, pen, 1 packets");
    expect(readout.textContent).toContain("samples per packet  2.0");
    expect(frames.cancel).toHaveBeenCalled();
  });

  it("does not ask a mouse for a predicted tip", () => {
    fire("pointerdown", { pointerType: "mouse" });
    expect(surface.beginStroke.mock.calls[0][0].tool.predictTip).toBe(false);
    fire("pointermove", { pointerType: "mouse", clientX: 130 }, { getPredictedEvents: vi.fn(() => []) });
    expect(surface.moveStroke.mock.calls[0][1]).toBeUndefined();
  });

  it("builds a highlighter from its own colour, width and the nib angle", () => {
    render({ style: { ...baseStyle, activeTool: "highlighter" } });
    fire("pointerdown");
    const { tool } = surface.beginStroke.mock.calls[0][0];
    expect(tool).toMatchObject({
      kind: "highlighter",
      thickness: 18,
      settings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
    });
    expect(tool.color.a).toBeCloseTo(107 / 255, 6);
    expect(typeof tool.nibAngle()).toBe("number");
  });

  it("ignores a hover, and a move once the contact has no button down", () => {
    fire("pointermove", { buttons: 0 });
    expect(surface.moveStroke).not.toHaveBeenCalled();

    fire("pointerdown");
    fire("pointermove", { clientX: 140, buttons: 0 });
    expect(surface.moveStroke).not.toHaveBeenCalled();
    fire("pointermove", { clientX: 141 });
    expect(surface.moveStroke).toHaveBeenCalledTimes(1);

    fire("pointerup", { buttons: 0 });
    fire("pointermove", { clientX: 150 });
    expect(surface.moveStroke).toHaveBeenCalledTimes(1);
  });

  it("keeps drawing the stroke in progress when the tool is changed under it", () => {
    fire("pointerdown");
    render({ style: { ...baseStyle, activeTool: "text" } });
    fire("pointermove", { clientX: 150 });
    expect(surface.moveStroke).toHaveBeenCalledTimes(1);
    fire("pointerup", { buttons: 0 });
    expect(surface.endStroke).toHaveBeenCalledTimes(1);
    expect(page.onPointerMove).not.toHaveBeenCalled();
  });

  it("cancels a stranded stroke when a new contact begins", () => {
    fire("pointerdown", { pointerId: 1 });
    fire("pointerdown", { pointerId: 2 });
    expect(surface.cancelStroke).toHaveBeenCalledTimes(1);
    expect(surface.beginStroke).toHaveBeenCalledTimes(2);
    expect(surface.cancelStroke.mock.invocationCallOrder[0]).toBeLessThan(
      surface.beginStroke.mock.invocationCallOrder[1]
    );
  });

  it("cancels on pointercancel, on blur and when capture is lost", () => {
    fire("pointerdown");
    fire("pointercancel", { buttons: 0 });
    expect(surface.cancelStroke).toHaveBeenCalledTimes(1);
    expect(surface.endStroke).not.toHaveBeenCalled();
    expect(lifecycle.isInteracting).toBe(false);

    fire("pointerdown");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(surface.cancelStroke).toHaveBeenCalledTimes(2);
    expect(lifecycle.isInteracting).toBe(false);
    expect(reportInteraction).toHaveBeenLastCalledWith(false);

    fire("pointerdown");
    fire("lostpointercapture");
    expect(surface.cancelStroke).toHaveBeenCalledTimes(3);
    expect(lifecycle.isInteracting).toBe(false);
    expect(reportInteraction).toHaveBeenLastCalledWith(false);
  });

  it("does not take an expected capture loss after a lift for a cancel", () => {
    const element = surfaceEl();
    let captured = false;
    Object.assign(element, {
      hasPointerCapture: () => captured,
      setPointerCapture: () => {
        captured = true;
      },
      releasePointerCapture: () => {
        captured = false;
      },
    });
    fire("pointerdown");
    expect(captured).toBe(true);
    fire("pointerup", { buttons: 0 });
    expect(captured).toBe(false);
    fire("pointerdown");
    fire("lostpointercapture");
    // The loss that follows the first lift is spent on it; this contact is still drawing.
    expect(surface.cancelStroke).not.toHaveBeenCalled();
    expect(lifecycle.isDown(1)).toBe(true);
  });
});

describe("what ink does not take", () => {
  it("leaves touch, the text and select tools and a read-only page to the page", () => {
    fire("pointerdown", { pointerType: "touch" });
    expect(page.onPointerDown).toHaveBeenCalledTimes(1);

    render({ style: { ...baseStyle, activeTool: "text" } });
    fire("pointerdown");
    expect(page.onPointerDown).toHaveBeenCalledTimes(2);

    render({ style: { ...baseStyle, activeTool: "select" } });
    fire("pointerdown");
    expect(page.onPointerDown).toHaveBeenCalledTimes(3);

    render({ style: baseStyle, readOnly: true });
    const down = fire("pointerdown");
    expect(page.onPointerDown).toHaveBeenCalledTimes(4);
    expect(down.defaultPrevented).toBe(false);
    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(surface.beginErase).not.toHaveBeenCalled();
    expect(reportInteraction).not.toHaveBeenCalled();
  });

  it("gives a finger's moves and lifts to the page even while the pen is drawing", () => {
    fire("pointerdown");
    fire("pointermove", { pointerId: 7, pointerType: "touch", clientX: 200 });
    fire("pointerup", { pointerId: 7, pointerType: "touch", buttons: 0 });
    expect(page.onPointerMove).toHaveBeenCalledTimes(1);
    expect(page.onPointerUp).toHaveBeenCalledTimes(1);
    expect(surface.cancelStroke).not.toHaveBeenCalled();
    expect(lifecycle.isDown(1)).toBe(true);
  });

  it("swallows a pen that lands before the page's ink has loaded", () => {
    engine.loadedRef.current = false;
    const down = fire("pointerdown");
    expect(down.defaultPrevented).toBe(true);
    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(page.onPointerDown).not.toHaveBeenCalled();
    expect(reportInteraction).not.toHaveBeenCalled();
  });
});

describe("the eraser", () => {
  it("erases whatever is selected with the pen's eraser end for that one contact", () => {
    // buttons 32 is the eraser end; the selected tool stays the pen.
    fire("pointerdown", { buttons: 32 | 1, clientX: 120, clientY: 90 });
    expect(surface.beginStroke).not.toHaveBeenCalled();
    expect(surface.beginErase).toHaveBeenCalledTimes(1);
    fire("pointerup", { buttons: 0 });
    expect(surface.endErase).toHaveBeenCalledTimes(1);

    fire("pointerdown", { buttons: 1 });
    expect(surface.beginStroke).toHaveBeenCalledTimes(1);
    expect(surface.beginErase).toHaveBeenCalledTimes(1);
  });

  it("is not borrowed from a mouse or a finger", () => {
    fire("pointerdown", { pointerType: "mouse", buttons: 32 });
    expect(surface.beginStroke).toHaveBeenCalledTimes(1);
    expect(surface.beginErase).not.toHaveBeenCalled();
  });

  it("begins a precision erase at the ring's radius in page units, and carries its packets onto the page", () => {
    render({ style: { ...baseStyle, activeTool: "eraser" } });
    fire("pointerdown", { clientX: 120, clientY: 90 });
    const diameter = getNotebookEraserCursorDiameter(24);
    expect(surface.beginErase).toHaveBeenCalledWith({
      mode: "precision",
      radius: diameter / 2 / MAPPING.scale,
      at: { x: 10, y: 20 },
    });
    expect(ringEl().style.opacity).toBe("1");
    expect(ringEl().style.transform).toContain("translate3d(");

    fire("pointermove", { clientX: 140, clientY: 90 });
    expect(surface.moveErase).toHaveBeenCalledTimes(1);
    expect(surface.moveErase.mock.calls[0][0]).toEqual([{ x: 20, y: 20 }]);

    fire("pointerup", { clientX: 140, clientY: 90, buttons: 0 });
    expect(surface.endErase).toHaveBeenCalledTimes(1);
    expect(surface.cancelErase).not.toHaveBeenCalled();
  });

  it("takes the mode for the next contact from the ref, so the stroke eraser is a stroke erase", () => {
    render({ style: { ...baseStyle, activeTool: "eraser" } });
    eraserModeRef.current = "stroke";
    fire("pointerdown");
    expect(surface.beginErase.mock.calls[0][0].mode).toBe("stroke");
  });

  it("follows a hovering pen with the ring without erasing, and hides it on cancel", () => {
    render({ style: { ...baseStyle, activeTool: "eraser" } });
    fire("pointermove", { buttons: 0, clientX: 150, clientY: 80 });
    expect(ringEl().style.opacity).toBe("1");
    expect(surface.moveErase).not.toHaveBeenCalled();

    fire("pointerdown");
    fire("pointercancel", { buttons: 0 });
    expect(surface.cancelErase).toHaveBeenCalledTimes(1);
    expect(surface.endErase).not.toHaveBeenCalled();
    expect(ringEl().style.opacity).toBe("0");
  });

  it("cancels the erase when capture is lost", () => {
    render({ style: { ...baseStyle, activeTool: "eraser" } });
    fire("pointerdown");
    fire("lostpointercapture");
    expect(surface.cancelErase).toHaveBeenCalledTimes(1);
    expect(lifecycle.isInteracting).toBe(false);
  });
});

describe("scribble-to-erase", () => {
  const found = {
    band: {
      hull: [
        { x: 120, y: 90 },
        { x: 220, y: 90 },
        { x: 220, y: 190 },
      ],
      bounds: { minX: 120, minY: 90, maxX: 220, maxY: 190 },
    },
    legs: 3,
    majorExtent: 80,
    reversals: 2,
  };

  it("hands the stroke's band to the surface in page units, with the extent as detected", () => {
    render({ scribbleToErase: true });
    scribble.detect.mockReturnValue(found);
    fire("pointerdown", { clientX: 120, clientY: 90 });
    fire("pointermove", { clientX: 160, clientY: 100 });
    fire("pointerup", { clientX: 200, clientY: 110, buttons: 0 });

    expect(scribble.detect).toHaveBeenCalledTimes(1);
    const [samples, options] = scribble.detect.mock.calls[0];
    expect(samples.map((s: { x: number; y: number }) => [s.x, s.y])).toEqual([
      [120, 90],
      [160, 100],
      [200, 110],
    ]);
    expect(options).toEqual({ strokeWidth: 3 * MAPPING.scale, viewportScale: MAPPING.scale });
    expect(surface.endStroke).toHaveBeenCalledWith({
      band: {
        hull: [
          { x: 10, y: 20 },
          { x: 60, y: 20 },
          { x: 60, y: 70 },
        ],
        bounds: { minX: 10, minY: 20, maxX: 60, maxY: 70 },
      },
      majorExtent: 80,
    });
  });

  it("ends an ordinary stroke without a band when nothing looks like a scribble", () => {
    render({ scribbleToErase: true });
    scribble.detect.mockReturnValue(null);
    fire("pointerdown");
    fire("pointerup", { buttons: 0 });
    expect(surface.endStroke).toHaveBeenCalledWith(null);
  });

  it("is not watched when the setting is off, for the highlighter, or for a cancelled stroke", () => {
    fire("pointerdown");
    fire("pointerup", { buttons: 0 });
    expect(scribble.detect).not.toHaveBeenCalled();

    render({ scribbleToErase: true, style: { ...baseStyle, activeTool: "highlighter" } });
    fire("pointerdown");
    fire("pointerup", { buttons: 0 });
    expect(scribble.detect).not.toHaveBeenCalled();

    render({ scribbleToErase: true, style: baseStyle });
    fire("pointerdown");
    fire("pointercancel", { buttons: 0 });
    expect(scribble.detect).not.toHaveBeenCalled();
  });
});
