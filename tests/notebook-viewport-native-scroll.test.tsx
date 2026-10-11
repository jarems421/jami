// @vitest-environment jsdom

import { act, useEffect, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useNotebookViewportController,
  type NotebookViewportController,
} from "@/hooks/useNotebookViewportController";
import { getNotebookScrollOffset } from "@/lib/workspace/notebook-viewport";
import { NOTEBOOK_PAGE_COORDINATE_HEIGHT, NOTEBOOK_PAGE_COORDINATE_WIDTH } from "@/lib/workspace/notebooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PagePan = { x: number; y: number };
type Handles = { controller: NotebookViewportController; pan: PagePan; setZoom: (zoom: number) => void };

let container: HTMLDivElement;
let root: Root;
let handles: Handles;
let surface: HTMLDivElement;
let frame: HTMLDivElement;
let scroller: HTMLDivElement;
let scrollPosition = { left: 0, top: 0 };

function stubRect(element: HTMLElement, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...rect }) as DOMRect;
}

function Harness() {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PagePan>({ x: 0, y: 0 });
  const controller = useNotebookViewportController({
    frameSize: { width: 800, height: 1000 },
    pageZoom: zoom,
    pagePan: pan,
    pageWidth: NOTEBOOK_PAGE_COORDINATE_WIDTH,
    pageHeight: NOTEBOOK_PAGE_COORDINATE_HEIGHT,
    setPageZoom: setZoom,
    setPagePan: setPan,
    pageSurfaceRef: { current: surface },
    pageFrameRef: { current: frame },
    isNavigationLocked: () => false,
    isStylusSuppressingTouch: () => false,
    onPinchTakeover: () => {},
    onClearSwipeCandidate: () => {},
    onSwipeEnd: () => {},
    nativeScroll: true,
  });
  const { attachScroller } = controller;
  useLayoutEffect(() => {
    attachScroller(scroller);
  }, [attachScroller]);
  useEffect(() => {
    handles = { controller, pan, setZoom };
  }, [controller, pan]);
  return null;
}

function pointerEvent(overrides: Partial<{ pointerId: number; clientX: number; clientY: number; isPrimary: boolean }> = {}) {
  const captured = new Set<number>();
  return {
    pointerId: overrides.pointerId ?? 1,
    pointerType: "touch",
    isPrimary: overrides.isPrimary ?? true,
    clientX: overrides.clientX ?? 0,
    clientY: overrides.clientY ?? 0,
    currentTarget: {
      hasPointerCapture: (id: number) => captured.has(id),
      setPointerCapture: (id: number) => captured.add(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    },
    nativeEvent: { timeStamp: 0 },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Scrolls the scroller as a finger would, and says so. */
function userScroll(left: number, top: number) {
  scrollPosition = { left, top };
  act(() => {
    scroller.dispatchEvent(new Event("scroll"));
  });
}

function touch(type: "touchstart" | "touchmove", fingers: number) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "touches", { value: Array.from({ length: fingers }, () => ({})) });
  scroller.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  container = document.createElement("div");
  document.body.append(container);
  surface = document.createElement("div");
  frame = document.createElement("div");
  scroller = document.createElement("div");
  scrollPosition = { left: 0, top: 0 };
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    get: () => scrollPosition.left,
    set: (value: number) => void (scrollPosition.left = value),
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollPosition.top,
    set: (value: number) => void (scrollPosition.top = value),
  });
  stubRect(surface, { left: 100, top: 50, width: 400, height: 560 });
  stubRect(frame, { left: 0, top: 0, width: 800, height: 1000 });
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a zoomed sheet panned with the browser's own scrolling", () => {
  it("has no scroll area at fit, and once zoomed shows the sheet where the pan put it", () => {
    expect(handles.controller.scroll).toBeNull();
    act(() => handles.setZoom(2));
    const scroll = handles.controller.scroll!;
    expect(scroll).not.toBeNull();
    // The sheet sits still in the scrolled content, and the scroll offsets pan it.
    expect(handles.controller.geometry.pageX).toBe(scroll.sheetX);
    expect(handles.controller.geometry.pageY).toBe(scroll.sheetY);
    expect(scrollPosition).toEqual(getNotebookScrollOffset(scroll, handles.controller.layout.pageOrigin));
  });

  it("leaves one finger to the browser rather than moving the sheet itself", () => {
    act(() => handles.setZoom(2));
    const transformBefore = surface.style.transform;
    const down = pointerEvent({ clientX: 300, clientY: 300 });
    const move = pointerEvent({ clientX: 360, clientY: 340 });
    let handled = true;
    act(() => {
      handles.controller.handleTouchPointerDown(down);
      handled = handles.controller.handleTouchPointerMove(move);
    });
    expect(handled).toBe(false);
    expect(move.preventDefault).not.toHaveBeenCalled();
    expect(surface.style.transform).toBe(transformBefore);
    expect(touch("touchmove", 1).defaultPrevented).toBe(false);
  });

  it("follows a scroll with the live pan at once, and commits the pan once it settles", () => {
    vi.useFakeTimers();
    act(() => handles.setZoom(2));
    const scroll = handles.controller.scroll!;
    const committed = handles.pan;
    userScroll(scrollPosition.left + 120, scrollPosition.top + 90);
    const live = handles.controller.pagePanLiveRef.current;
    expect(live).toEqual({ x: scroll.sheetX - scrollPosition.left, y: scroll.sheetY - scrollPosition.top });
    act(() => void vi.advanceTimersByTime(119));
    expect(handles.pan).toEqual(committed);
    act(() => void vi.advanceTimersByTime(1));
    expect(handles.pan).toEqual(live);
    // Committing does not scroll the sheet back to where it already is.
    expect(scrollPosition).toEqual(getNotebookScrollOffset(handles.controller.scroll!, live));
  });

  it("refuses two fingers to native scrolling, so a pinch keeps its pointers", () => {
    act(() => handles.setZoom(2));
    expect(touch("touchstart", 2).defaultPrevented).toBe(true);
    expect(touch("touchmove", 2).defaultPrevented).toBe(true);
    expect(touch("touchstart", 1).defaultPrevented).toBe(false);
  });

  it("holds the scroll still through a pinch, placing the sheet in the scrolled content, and lets it go after", () => {
    act(() => handles.setZoom(2));
    userScroll(100, 50);
    act(() => {
      handles.controller.handleTouchPointerDown(pointerEvent({ pointerId: 1, clientX: 200, clientY: 200 }));
      handles.controller.handleTouchPointerDown(
        pointerEvent({ pointerId: 2, clientX: 300, clientY: 300, isPrimary: false })
      );
    });
    expect(handles.controller.isPinchActive()).toBe(true);
    expect(scroller.style.overflow).toBe("hidden");
    act(() => {
      handles.controller.handleTouchPointerMove(pointerEvent({ pointerId: 2, clientX: 300, clientY: 300, isPrimary: false }));
    });
    // Where the sheet is on screen (100, 50 in the frame), plus the scroll.
    expect(surface.style.transform.startsWith("translate3d(200px, 100px, 0)")).toBe(true);

    act(() => {
      handles.controller.handleTouchPointerEnd(pointerEvent({ pointerId: 2, isPrimary: false }));
    });
    expect(handles.controller.isPinchActive()).toBe(false);
    expect(scroller.style.overflow).toBe("");
    const scroll = handles.controller.scroll!;
    expect(surface.style.transform).toBe(`translate3d(${scroll.sheetX}px, ${scroll.sheetY}px, 0)`);
  });
});
