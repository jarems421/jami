// @vitest-environment jsdom

import {
  act,
  useRef,
  type MouseEventHandler,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useNotebookToolbarDocking } from "@/hooks/useNotebookToolbarDocking";
import { NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY } from "@/lib/workspace/notebook-toolbar";

type FrameSize = { width: number; height: number };
type HarnessProps = {
  frameSize: FrameSize;
  onAction: MouseEventHandler<HTMLButtonElement>;
  onDragStarted: () => void;
  prefersReducedMotion?: boolean;
  /** A top bar 60px tall above the frame, as the notebook has. */
  withTopBar?: boolean;
};

type PointerInit = {
  button?: number;
  clientX: number;
  clientY: number;
  isPrimary?: boolean;
  pointerId?: number;
  pointerType?: string;
  timeStamp?: number;
};

const FRAME_RECT = {
  left: 0,
  top: 0,
  width: 800,
  height: 600,
};
const TOOLBAR_SIZE = {
  width: 100,
  height: 40,
};

let activeRoot: Root | null = null;
let capturedPointers: WeakMap<HTMLElement, Set<number>>;
let pointerCaptureCalls: Array<{ element: HTMLElement; pointerId: number }>;
let animationFrameCallbacks: Map<number, FrameRequestCallback>;
let nextAnimationFrameId: number;
let nextEventTime: number;

const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;
const originalHasPointerCapture =
  HTMLElement.prototype.hasPointerCapture;
const originalSetPointerCapture =
  HTMLElement.prototype.setPointerCapture;
const originalReleasePointerCapture =
  HTMLElement.prototype.releasePointerCapture;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

function rect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    bottom: input.top + input.height,
    height: input.height,
    left: input.left,
    right: input.left + input.width,
    top: input.top,
    width: input.width,
    x: input.left,
    y: input.top,
    toJSON: () => input,
  };
}

function readTranslate(element: HTMLElement) {
  const match =
    /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px,\s*0(?:px)?\s*\)/.exec(
      element.style.transform
    );
  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
  };
}

function getToolbarBasePosition(element: HTMLElement) {
  switch (element.dataset.toolbarDock) {
    case "top":
      return { left: 350, top: 8 };
    case "right":
      return { left: 692, top: 280 };
    case "left":
      return { left: 8, top: 280 };
    default:
      return { left: 350, top: 552 };
  }
}

function Harness({
  frameSize,
  onAction,
  onDragStarted,
  prefersReducedMotion = false,
  withTopBar = false,
}: HarnessProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const topBarRef = useRef<HTMLElement | null>(null);
  const { dock, toolbarRef, toolbarBindings } =
    useNotebookToolbarDocking({
      frameRef,
      topBarRef: withTopBar ? topBarRef : undefined,
      frameSize,
      onDragStarted,
      prefersReducedMotion,
    });

  return (
    <>
      {withTopBar ? <header ref={topBarRef} data-notebook-top-bar="true" /> : null}
      <div ref={frameRef} data-notebook-frame="true">
        <div
          ref={toolbarRef}
          role="toolbar"
          data-toolbar-dock={dock}
          {...toolbarBindings}
        >
          <button
            type="button"
            data-notebook-toolbar-action="true"
            onClick={onAction}
          >
            Pen
          </button>
        </div>
        <output aria-label="toolbar dock">{dock}</output>
      </div>
    </>
  );
}

function renderHarness(props: HarnessProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  activeRoot = root;

  act(() => {
    root.render(<Harness {...props} />);
  });

  return {
    action: () =>
      container.querySelector<HTMLButtonElement>(
        "[data-notebook-toolbar-action='true']"
      )!,
    dock: () =>
      container.querySelector<HTMLOutputElement>(
        "output[aria-label='toolbar dock']"
      )!.textContent,
    rerender(nextProps: HarnessProps) {
      act(() => {
        root.render(<Harness {...nextProps} />);
      });
    },
    toolbar: () =>
      container.querySelector<HTMLDivElement>("[data-toolbar-dock]")!,
  };
}

function dispatchPointer(
  target: Element,
  type: string,
  init: PointerInit
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: init.button ?? 0,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperties(event, {
    isPrimary: { value: init.isPrimary ?? true },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "pen" },
    timeStamp: {
      value: init.timeStamp ?? (nextEventTime += 16),
    },
  });

  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function dispatchClick(target: Element) {
  const event = new MouseEvent("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function dispatchTransitionEnd(target: Element, propertyName: string) {
  const event = new Event("transitionend", {
    bubbles: true,
    cancelable: false,
  });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  act(() => {
    target.dispatchEvent(event);
  });
}

function flushAnimationFrames() {
  const callbacks = [...animationFrameCallbacks.values()];
  animationFrameCallbacks.clear();
  act(() => {
    for (const callback of callbacks) {
      callback(performance.now());
    }
  });
}

function startActionDrag(
  action: HTMLButtonElement,
  input: {
    endX: number;
    endY: number;
    pointerId?: number;
    pointerType?: string;
    startX?: number;
    startY?: number;
  }
) {
  const pointerId = input.pointerId ?? 1;
  const pointerType = input.pointerType ?? "pen";
  dispatchPointer(action, "pointerdown", {
    clientX: input.startX ?? 400,
    clientY: input.startY ?? 570,
    pointerId,
    pointerType,
  });
  dispatchPointer(action, "pointermove", {
    clientX: input.endX,
    clientY: input.endY,
    pointerId,
    pointerType,
  });
}

beforeAll(() => {
  Object.defineProperty(
    HTMLElement.prototype,
    "getBoundingClientRect",
    {
      configurable: true,
      value(this: HTMLElement) {
        if (this.dataset.notebookFrame === "true") {
          return rect(FRAME_RECT);
        }
        if (this.dataset.notebookTopBar === "true") {
          return rect({ left: 0, top: -60, width: 800, height: 60 });
        }
        if (this.dataset.toolbarDock) {
          const base = getToolbarBasePosition(this);
          const translate = readTranslate(this);
          return rect({
            left: base.left + translate.x,
            top: base.top + translate.y,
            ...TOOLBAR_SIZE,
          });
        }
        return rect({ left: 0, top: 0, width: 0, height: 0 });
      },
    }
  );
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      return capturedPointers.get(this)?.has(pointerId) ?? false;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      const pointers = capturedPointers.get(this) ?? new Set<number>();
      pointers.add(pointerId);
      capturedPointers.set(this, pointers);
      pointerCaptureCalls.push({ element: this, pointerId });
    },
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      capturedPointers.get(this)?.delete(pointerId);
    },
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value(callback: FrameRequestCallback) {
      const id = nextAnimationFrameId;
      nextAnimationFrameId += 1;
      animationFrameCallbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value(id: number) {
      animationFrameCallbacks.delete(id);
    },
  });
});

beforeEach(() => {
  window.localStorage.clear();
  capturedPointers = new WeakMap();
  pointerCaptureCalls = [];
  animationFrameCallbacks = new Map();
  nextAnimationFrameId = 1;
  nextEventTime = 0;
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (activeRoot) {
    act(() => activeRoot?.unmount());
    activeRoot = null;
  }
  document.body.replaceChildren();
});

afterAll(() => {
  Object.defineProperty(
    HTMLElement.prototype,
    "getBoundingClientRect",
    {
      configurable: true,
      value: originalGetBoundingClientRect,
    }
  );
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: originalHasPointerCapture,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: originalSetPointerCapture,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: originalReleasePointerCapture,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: originalRequestAnimationFrame,
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: originalCancelAnimationFrame,
  });
});

describe("useNotebookToolbarDocking", () => {
  it("keeps a Pencil action tap native below its drag threshold", () => {
    const onAction = vi.fn();
    const onDragStarted = vi.fn();
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction,
      onDragStarted,
    });

    dispatchPointer(harness.action(), "pointerdown", {
      clientX: 400,
      clientY: 570,
      pointerId: 1,
      pointerType: "pen",
    });
    dispatchPointer(harness.action(), "pointermove", {
      clientX: 406,
      clientY: 570,
      pointerId: 1,
      pointerType: "pen",
    });
    dispatchPointer(harness.action(), "pointerup", {
      clientX: 406,
      clientY: 570,
      pointerId: 1,
      pointerType: "pen",
    });
    dispatchClick(harness.action());

    expect(onDragStarted).not.toHaveBeenCalled();
    expect(pointerCaptureCalls).toHaveLength(0);
    expect(onAction).toHaveBeenCalledOnce();
    expect(harness.toolbar().dataset.toolbarDragging).toBeUndefined();
  });

  it("starts at the action threshold and writes drag position directly", () => {
    const onDragStarted = vi.fn();
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction: vi.fn(),
      onDragStarted,
    });

    dispatchPointer(harness.action(), "pointerdown", {
      clientX: 400,
      clientY: 570,
      pointerId: 2,
      pointerType: "pen",
    });
    dispatchPointer(harness.action(), "pointermove", {
      clientX: 407,
      clientY: 570,
      pointerId: 2,
      pointerType: "pen",
    });
    expect(onDragStarted).not.toHaveBeenCalled();
    expect(harness.toolbar().style.transform).toBe("");

    dispatchPointer(harness.action(), "pointermove", {
      clientX: 408,
      clientY: 570,
      pointerId: 2,
      pointerType: "pen",
    });

    expect(onDragStarted).toHaveBeenCalledOnce();
    expect(pointerCaptureCalls.map(({ pointerId }) => pointerId)).toEqual([
      2,
    ]);
    expect(harness.toolbar().dataset.toolbarDragging).toBe("true");
    expect(harness.toolbar().style.transform).toBe(
      "translate3d(8px, 0px, 0)"
    );
  });

  it("forgets an uncaptured action candidate when the pointer leaves", () => {
    const onAction = vi.fn();
    const onDragStarted = vi.fn();
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction,
      onDragStarted,
    });

    dispatchPointer(harness.action(), "pointerdown", {
      clientX: 400,
      clientY: 570,
      pointerId: 3,
      pointerType: "pen",
    });
    dispatchPointer(harness.action(), "pointerout", {
      clientX: 403,
      clientY: 570,
      pointerId: 3,
      pointerType: "pen",
    });
    dispatchPointer(harness.toolbar(), "pointermove", {
      clientX: 500,
      clientY: 400,
      pointerId: 3,
      pointerType: "pen",
    });
    dispatchClick(harness.action());

    expect(onDragStarted).not.toHaveBeenCalled();
    expect(pointerCaptureCalls).toHaveLength(0);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "rolls back without persistence on %s",
    (finishEvent) => {
      const harness = renderHarness({
        frameSize: { width: 800, height: 600 },
        onAction: vi.fn(),
        onDragStarted: vi.fn(),
      });

      startActionDrag(harness.action(), {
        startY: 28,
        endX: 400,
        endY: 580,
        pointerId: 4,
      });
      dispatchPointer(harness.toolbar(), finishEvent, {
        clientX: 400,
        clientY: 580,
        pointerId: 4,
        pointerType: "pen",
      });

      expect(harness.dock()).toBe("top");
      expect(harness.toolbar().dataset.toolbarDragging).toBeUndefined();
      expect(harness.toolbar().style.transform).toBe(
        "translate3d(0, 0, 0)"
      );
      expect(
        window.localStorage.getItem(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY)
      ).toBeNull();
    }
  );

  it("persists a successful dock and suppresses exactly one click", () => {
    const onAction = vi.fn();
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction,
      onDragStarted: vi.fn(),
    });

    startActionDrag(harness.action(), {
      startY: 28,
      endX: 400,
      endY: 580,
      pointerId: 5,
    });
    dispatchPointer(harness.toolbar(), "pointerup", {
      clientX: 400,
      clientY: 580,
      pointerId: 5,
      pointerType: "pen",
    });

    expect(harness.dock()).toBe("bottom");
    expect(
      window.localStorage.getItem(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY)
    ).toBe("bottom");
    expect(harness.toolbar().style.transition).toBe("none");
    expect(harness.toolbar().style.transform).not.toBe(
      "translate3d(0, 0, 0)"
    );

    dispatchClick(harness.action());
    dispatchClick(harness.action());
    expect(onAction).toHaveBeenCalledOnce();

    flushAnimationFrames();
    expect(harness.toolbar().style.transition).toContain("transform");
    dispatchTransitionEnd(harness.toolbar(), "transform");
    expect(harness.toolbar().style.transition).toBe("");
    expect(harness.toolbar().style.transform).toBe("");
  });

  it("carries a toolbar up into the top bar, and stops one at the frame's edge without one", () => {
    const drawUp = (withTopBar: boolean) => {
      const harness = renderHarness({
        frameSize: { width: 800, height: 600 },
        onAction: vi.fn(),
        onDragStarted: vi.fn(),
        withTopBar,
      });
      startActionDrag(harness.action(), { startY: 28, endX: 400, endY: -40, pointerId: 9 });
      const transform = harness.toolbar().style.transform;
      act(() => activeRoot?.unmount());
      activeRoot = null;
      return transform;
    };
    // Up to the bar's top, less the inset a floating toolbar keeps.
    expect(drawUp(true)).toBe("translate3d(0px, -60px, 0)");
    expect(drawUp(false)).toBe("translate3d(0px, 0px, 0)");
  });

  it("stops a toolbar floating over the page at the frame's edge, which clips it, even with a top bar", () => {
    window.localStorage.setItem(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY, "left");
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction: vi.fn(),
      onDragStarted: vi.fn(),
      withTopBar: true,
    });
    expect(harness.dock()).toBe("left");
    startActionDrag(harness.action(), { startX: 30, startY: 300, endX: 30, endY: -40, pointerId: 10 });
    // From 280 down the frame up to the 8px inset at its top, and no further.
    expect(harness.toolbar().style.transform).toBe("translate3d(0px, -272px, 0)");
    dispatchPointer(harness.toolbar(), "pointerup", { clientX: 30, clientY: -40, pointerId: 10, pointerType: "pen" });
    // Let go over the bar, it goes into the bar.
    expect(harness.dock()).toBe("top");
  });

  it("restores the saved dock after mounting", () => {
    window.localStorage.setItem(
      NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY,
      "left"
    );
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction: vi.fn(),
      onDragStarted: vi.fn(),
    });

    expect(harness.dock()).toBe("left");
    expect(harness.toolbar().dataset.toolbarDock).toBe("left");
  });

  it("cancels an active drag on resize without saving it", () => {
    const onAction = vi.fn();
    const onDragStarted = vi.fn();
    const initialProps: HarnessProps = {
      frameSize: { width: 800, height: 600 },
      onAction,
      onDragStarted,
    };
    const harness = renderHarness(initialProps);

    startActionDrag(harness.action(), {
      startY: 28,
      endX: 400,
      endY: 580,
      pointerId: 6,
    });
    harness.rerender({
      ...initialProps,
      frameSize: { width: 801, height: 600 },
    });

    expect(harness.dock()).toBe("top");
    expect(harness.toolbar().dataset.toolbarDragging).toBeUndefined();
    expect(harness.toolbar().style.transform).toBe(
      "translate3d(0, 0, 0)"
    );
    expect(
      window.localStorage.getItem(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY)
    ).toBeNull();

    dispatchClick(harness.action());
    dispatchClick(harness.action());
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("settles immediately when reduced motion is preferred", () => {
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction: vi.fn(),
      onDragStarted: vi.fn(),
      prefersReducedMotion: true,
    });

    startActionDrag(harness.action(), {
      startY: 28,
      endX: 400,
      endY: 580,
      pointerId: 7,
    });
    dispatchPointer(harness.toolbar(), "pointerup", {
      clientX: 400,
      clientY: 580,
      pointerId: 7,
      pointerType: "pen",
    });

    expect(harness.dock()).toBe("bottom");
    expect(harness.toolbar().style.transition).toBe("");
    expect(harness.toolbar().style.transform).toBe(
      "translate3d(0, 0, 0)"
    );
    expect(animationFrameCallbacks.size).toBe(0);
  });

  it("rolls a cancelled drag back immediately with reduced motion", () => {
    const harness = renderHarness({
      frameSize: { width: 800, height: 600 },
      onAction: vi.fn(),
      onDragStarted: vi.fn(),
      prefersReducedMotion: true,
    });

    startActionDrag(harness.action(), {
      startY: 28,
      endX: 400,
      endY: 580,
      pointerId: 8,
    });
    expect(harness.toolbar().style.transform).not.toBe(
      "translate3d(0, 0, 0)"
    );

    dispatchPointer(harness.toolbar(), "pointercancel", {
      clientX: 400,
      clientY: 580,
      pointerId: 8,
      pointerType: "pen",
    });

    expect(harness.dock()).toBe("top");
    expect(harness.toolbar().style.transition).toBe("");
    expect(harness.toolbar().style.transform).toBe("");
    expect(animationFrameCallbacks.size).toBe(0);
    expect(
      window.localStorage.getItem(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY)
    ).toBeNull();
  });
});
