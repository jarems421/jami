"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject,
  type TransitionEventHandler,
} from "react";
import {
  clearNotebookNativeSelection,
  safelyReleasePointerCapture,
  safelySetPointerCapture,
} from "@/lib/workspace/notebook-interaction-lock";
import {
  clampNotebookToolbarDragOffset,
  getNearestNotebookToolbarDock,
  getNotebookToolbarDragThreshold,
  getNotebookToolbarDragVelocity,
  getNotebookToolbarSettleDuration,
  hasNotebookToolbarDragStarted,
  NOTEBOOK_TOOLBAR_DEFAULT_DOCK,
  readNotebookToolbarDockPreference,
  saveNotebookToolbarDockPreference,
  snapNotebookToolbarOffsetToDevicePixels,
  type NotebookToolbarDock,
  type NotebookToolbarPointerSample,
} from "@/lib/workspace/notebook-toolbar";

const NOTEBOOK_TOOLBAR_SETTLE_EASING =
  "cubic-bezier(0.22, 1, 0.36, 1)";

export type NotebookToolbarFrameSize = {
  width: number;
  height: number;
};

type NotebookToolbarDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  originLeft: number;
  originTop: number;
  toolbarWidth: number;
  toolbarHeight: number;
  frameWidth: number;
  frameHeight: number;
  /** How far above the frame the top bar reaches, which the toolbar may be carried into. */
  topReach: number;
  originDock: NotebookToolbarDock;
  pointerType: string;
  samples: NotebookToolbarPointerSample[];
  started: boolean;
  startedOnAction: boolean;
};

export type NotebookToolbarBindings = {
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerLeave: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onLostPointerCapture: PointerEventHandler<HTMLDivElement>;
  onClickCapture: MouseEventHandler<HTMLDivElement>;
  onTransitionEnd: TransitionEventHandler<HTMLDivElement>;
  onDragStart: DragEventHandler<HTMLDivElement>;
};

type UseNotebookToolbarDockingOptions = {
  frameRef: RefObject<HTMLDivElement | null>;
  /** The notebook's top bar, where the toolbar sits when docked `top`. */
  topBarRef?: RefObject<HTMLElement | null>;
  frameSize: NotebookToolbarFrameSize;
  onDragStarted: () => void;
  prefersReducedMotion: boolean | (() => boolean);
};

type UseNotebookToolbarDockingResult = {
  dock: NotebookToolbarDock;
  toolbarRef: RefObject<HTMLDivElement | null>;
  toolbarBindings: NotebookToolbarBindings;
};

export function useNotebookToolbarDocking({
  frameRef,
  topBarRef,
  frameSize,
  onDragStarted,
  prefersReducedMotion,
}: UseNotebookToolbarDockingOptions): UseNotebookToolbarDockingResult {
  const [dock, setDock] = useState<NotebookToolbarDock>(NOTEBOOK_TOOLBAR_DEFAULT_DOCK);
  const [snapRevision, setSnapRevision] = useState(0);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<NotebookToolbarDock>(NOTEBOOK_TOOLBAR_DEFAULT_DOCK);
  const dragRef = useRef<NotebookToolbarDragState | null>(null);
  const pendingSnapRectRef = useRef<DOMRect | null>(null);
  const pendingSnapVelocityRef = useRef(0);
  const snapAnimationFrameRef = useRef<number | null>(null);
  const clickResetTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const shouldReduceMotion = useCallback(
    () =>
      typeof prefersReducedMotion === "function"
        ? prefersReducedMotion()
        : prefersReducedMotion,
    [prefersReducedMotion]
  );

  useEffect(() => {
    const savedDock = readNotebookToolbarDockPreference();
    dockRef.current = savedDock;
    // The preference is intentionally restored after hydration so the server
    // and first client render both use the default dock.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDock(savedDock);
  }, []);

  useEffect(
    () => () => {
      if (snapAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(snapAnimationFrameRef.current);
      }
      if (clickResetTimerRef.current !== null) {
        window.clearTimeout(clickResetTimerRef.current);
      }
    },
    []
  );

  const requestDockSnap = useCallback(
    (
      nextDock: NotebookToolbarDock,
      persist: boolean,
      releaseVelocity = 0,
      dragDistance = 0
    ) => {
      const toolbar = toolbarRef.current;
      if (toolbar && nextDock === dockRef.current) {
        pendingSnapRectRef.current = null;
        pendingSnapVelocityRef.current = 0;
        const settleDuration = getNotebookToolbarSettleDuration({
          distance: dragDistance,
          velocity: releaseVelocity,
        });
        if (shouldReduceMotion()) {
          toolbar.style.transition = "";
          toolbar.style.transform = "";
        } else {
          toolbar.style.transition = `transform ${settleDuration}ms ${NOTEBOOK_TOOLBAR_SETTLE_EASING}`;
          toolbar.style.transform = "translate3d(0, 0, 0)";
        }
        if (persist) saveNotebookToolbarDockPreference(nextDock);
        return;
      }

      if (toolbar) {
        pendingSnapRectRef.current = toolbar.getBoundingClientRect();
      }
      pendingSnapVelocityRef.current = releaseVelocity;
      dockRef.current = nextDock;
      setDock(nextDock);
      setSnapRevision((revision) => revision + 1);
      if (persist) {
        saveNotebookToolbarDockPreference(nextDock);
      }
    },
    [shouldReduceMotion]
  );

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const draggedRect = pendingSnapRectRef.current;
    if (!toolbar || !draggedRect) return;

    pendingSnapRectRef.current = null;
    const releaseVelocity = pendingSnapVelocityRef.current;
    pendingSnapVelocityRef.current = 0;
    if (snapAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(snapAnimationFrameRef.current);
      snapAnimationFrameRef.current = null;
    }

    toolbar.style.transition = "none";
    toolbar.style.transform = "translate3d(0, 0, 0)";
    const dockedRect = toolbar.getBoundingClientRect();
    const deltaX =
      draggedRect.left +
      draggedRect.width / 2 -
      (dockedRect.left + dockedRect.width / 2);
    const deltaY =
      draggedRect.top +
      draggedRect.height / 2 -
      (dockedRect.top + dockedRect.height / 2);
    const settleDuration = getNotebookToolbarSettleDuration({
      distance: Math.hypot(deltaX, deltaY),
      velocity: releaseVelocity,
    });

    if (shouldReduceMotion()) {
      toolbar.style.transform = "translate3d(0, 0, 0)";
      toolbar.style.transition = "";
      return;
    }

    toolbar.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    void toolbar.offsetWidth;
    snapAnimationFrameRef.current = window.requestAnimationFrame(() => {
      snapAnimationFrameRef.current = null;
      toolbar.style.transition = `transform ${settleDuration}ms ${NOTEBOOK_TOOLBAR_SETTLE_EASING}`;
      toolbar.style.transform = "translate3d(0, 0, 0)";
    });
  }, [dock, shouldReduceMotion, snapRevision]);

  const applyDragPosition = useCallback(
    (drag: NotebookToolbarDragState, toolbar: HTMLDivElement) => {
      const offset = snapNotebookToolbarOffsetToDevicePixels(
        clampNotebookToolbarDragOffset({
          deltaX: drag.lastX - drag.startX,
          deltaY: drag.lastY - drag.startY,
          originLeft: drag.originLeft,
          originTop: drag.originTop,
          toolbarWidth: drag.toolbarWidth,
          toolbarHeight: drag.toolbarHeight,
          frameWidth: drag.frameWidth,
          frameHeight: drag.frameHeight,
          topReach: drag.topReach,
        }),
        window.devicePixelRatio
      );
      toolbar.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
    },
    []
  );

  const handlePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (
        !event.isPrimary ||
        (event.pointerType === "mouse" && event.button !== 0) ||
        dragRef.current
      ) {
        return;
      }

      const frame = frameRef.current;
      const toolbar = toolbarRef.current;
      if (!frame || !toolbar) return;

      if (snapAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(snapAnimationFrameRef.current);
        snapAnimationFrameRef.current = null;
      }
      const liveTransform = window.getComputedStyle(toolbar).transform;
      toolbar.style.transition = "none";
      if (liveTransform && liveTransform !== "none") {
        toolbar.style.transform = liveTransform;
      }

      const frameRect = frame.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const topBarRect = topBarRef?.current?.getBoundingClientRect();
      const toolbarAction =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              "[data-notebook-toolbar-action='true']"
            )
          : null;
      const startedOnAction = Boolean(
        toolbarAction && toolbar.contains(toolbarAction)
      );
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        originLeft: toolbarRect.left - frameRect.left,
        originTop: toolbarRect.top - frameRect.top,
        toolbarWidth: toolbarRect.width,
        toolbarHeight: toolbarRect.height,
        frameWidth: frameRect.width,
        frameHeight: frameRect.height,
        // Only from the bar: a toolbar floating over the page is clipped at the
        // frame's edge, so it stops there, and lifting it into the bar drops it in.
        topReach:
          topBarRect && dockRef.current === "top" ? Math.max(0, frameRect.top - topBarRect.top) : 0,
        originDock: dockRef.current,
        pointerType: event.pointerType,
        samples: [
          {
            x: event.clientX,
            y: event.clientY,
            timeStamp: event.timeStamp,
          },
        ],
        started: false,
        startedOnAction,
      };

      // Keep a control tap under the native button until movement proves this
      // is a drag. Capturing immediately can retarget Pencil-up in Safari.
      if (!startedOnAction) {
        safelySetPointerCapture(toolbar, event.pointerId);
      }
    },
    [frameRef, topBarRef]
  );

  const handlePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      const drag = dragRef.current;
      const toolbar = toolbarRef.current;
      if (!drag || !toolbar || drag.pointerId !== event.pointerId) return;

      const nativeEvent = event.nativeEvent;
      const coalescedEvents =
        typeof nativeEvent.getCoalescedEvents === "function"
          ? nativeEvent.getCoalescedEvents()
          : [];
      const latestInput =
        coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
      drag.lastX = latestInput.clientX;
      drag.lastY = latestInput.clientY;
      drag.samples.push({
        x: latestInput.clientX,
        y: latestInput.clientY,
        timeStamp: latestInput.timeStamp,
      });
      const sampleCutoff = latestInput.timeStamp - 100;
      while (
        drag.samples.length > 2 &&
        drag.samples[1].timeStamp < sampleCutoff
      ) {
        drag.samples.shift();
      }

      const deltaX = drag.lastX - drag.startX;
      const deltaY = drag.lastY - drag.startY;
      if (
        !drag.started &&
        !hasNotebookToolbarDragStarted({
          deltaX,
          deltaY,
          threshold: getNotebookToolbarDragThreshold({
            pointerType: drag.pointerType,
            startedOnAction: drag.startedOnAction,
          }),
        })
      ) {
        return;
      }

      if (!drag.started) {
        drag.started = true;
        safelySetPointerCapture(toolbar, event.pointerId);
        toolbar.dataset.toolbarDragging = "true";
        onDragStarted();
        clearNotebookNativeSelection(document);
      }

      event.preventDefault();
      event.stopPropagation();
      // Keep this hot path to compositor writes; no layout read or React state.
      applyDragPosition(drag, toolbar);
    },
    [applyDragPosition, onDragStarted]
  );

  const handlePointerLeave = useCallback<
    PointerEventHandler<HTMLDivElement>
  >((event) => {
    const drag = dragRef.current;
    const toolbar = toolbarRef.current;
    if (
      !drag ||
      !toolbar ||
      drag.pointerId !== event.pointerId ||
      drag.started ||
      !drag.startedOnAction
    ) {
      return;
    }

    // Action candidates are not captured below the drag threshold. Forget one
    // that leaves so a missing Pencil-up cannot block the next interaction.
    dragRef.current = null;
    toolbar.style.transition = "";
  }, []);

  const finishPointer = useCallback(
    (
      event: Parameters<PointerEventHandler<HTMLDivElement>>[0],
      cancelled: boolean
    ) => {
      const drag = dragRef.current;
      const toolbar = toolbarRef.current;
      if (!drag || !toolbar || drag.pointerId !== event.pointerId) return;

      if (drag.started) {
        applyDragPosition(drag, toolbar);
      }
      dragRef.current = null;
      safelyReleasePointerCapture(toolbar, event.pointerId);
      delete toolbar.dataset.toolbarDragging;
      if (!drag.started) {
        toolbar.style.transition = "";
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = true;
      if (clickResetTimerRef.current !== null) {
        window.clearTimeout(clickResetTimerRef.current);
      }
      clickResetTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        clickResetTimerRef.current = null;
      }, 0);

      const frame = frameRef.current?.getBoundingClientRect();
      const releaseVelocity = getNotebookToolbarDragVelocity(drag.samples);
      const nextDock =
        cancelled || !frame
          ? drag.originDock
          : getNearestNotebookToolbarDock({
              x: drag.lastX - frame.left,
              y: drag.lastY - frame.top,
              frameWidth: frame.width,
              frameHeight: frame.height,
              currentDock: drag.originDock,
            });
      requestDockSnap(
        nextDock,
        !cancelled,
        cancelled ? 0 : releaseVelocity,
        Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY)
      );
    },
    [applyDragPosition, frameRef, requestDockSnap]
  );

  const handlePointerUp = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => finishPointer(event, false),
    [finishPointer]
  );
  const handlePointerCancel = useCallback<
    PointerEventHandler<HTMLDivElement>
  >((event) => finishPointer(event, true), [finishPointer]);
  const handleLostPointerCapture = useCallback<
    PointerEventHandler<HTMLDivElement>
  >((event) => finishPointer(event, true), [finishPointer]);

  const handleClickCapture = useCallback<
    MouseEventHandler<HTMLDivElement>
  >((event) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  }, []);

  const handleTransitionEnd = useCallback<
    TransitionEventHandler<HTMLDivElement>
  >((event) => {
    if (
      event.currentTarget !== event.target ||
      event.propertyName !== "transform"
    ) {
      return;
    }
    event.currentTarget.style.transition = "";
    event.currentTarget.style.transform = "";
  }, []);

  const handleDragStart = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => event.preventDefault(),
    []
  );

  useEffect(() => {
    const drag = dragRef.current;
    if (!drag?.started) return;

    const toolbar = toolbarRef.current;
    if (toolbar) delete toolbar.dataset.toolbarDragging;
    dragRef.current = null;
    suppressClickRef.current = true;
    requestDockSnap(drag.originDock, false);
  }, [frameSize.height, frameSize.width, requestDockSnap]);

  const toolbarBindings = useMemo<NotebookToolbarBindings>(
    () => ({
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerLeave: handlePointerLeave,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onLostPointerCapture: handleLostPointerCapture,
      onClickCapture: handleClickCapture,
      onTransitionEnd: handleTransitionEnd,
      onDragStart: handleDragStart,
    }),
    [
      handleClickCapture,
      handleDragStart,
      handleLostPointerCapture,
      handlePointerCancel,
      handlePointerDown,
      handlePointerLeave,
      handlePointerMove,
      handlePointerUp,
      handleTransitionEnd,
    ]
  );

  return {
    dock,
    toolbarRef,
    toolbarBindings,
  };
}
