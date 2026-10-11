"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  getNotebookLivePinchTransform,
  getNotebookPageZoomAfterPinch,
  getPinchDistance,
  shouldSuppressTouchAfterStylus,
  type NotebookPagePan,
  type PointerClientSample,
} from "@/lib/workspace/notebook-inking";
import {
  clampNotebookViewportOrigin,
  createNotebookPinchFrameQueue,
  getNotebookViewportLayout,
  isNotebookViewportZoomedIn,
  NOTEBOOK_PAN_GESTURE_SLOP,
  type NotebookViewportGeometry,
  type NotebookViewportLayout,
} from "@/lib/workspace/notebook-viewport";
import {
  safelyReleasePointerCapture,
  safelySetPointerCapture,
} from "@/lib/workspace/notebook-interaction-lock";

export type NotebookViewportFrameSize = { width: number; height: number };

/**
 * A pinch in flight. Everything here is captured at gesture start so the live
 * compositor transform can be rebuilt from the newest touch sample without
 * re-reading layout mid-gesture.
 */
export type NotebookPinchZoomState = {
  startDistance: number;
  startZoom: number;
  startCenterX: number;
  startCenterY: number;
  lastCenterX: number;
  lastCenterY: number;
  /** Pinch anchor as a fraction of the page, so the page point under the
   * fingers stays under the fingers while zooming. */
  anchorFx: number;
  anchorFy: number;
  /** Committed pan at gesture start; the live transform builds on top of it. */
  basePanX: number;
  basePanY: number;
  frameHeight: number;
  frameWidth: number;
  pendingZoom: number;
  startPageHeight: number;
  startPageWidth: number;
};

/**
 * One finger moving a zoomed sheet. Held from the moment the finger lands, but
 * only `moving` once it has travelled far enough to mean it -- a tap on a
 * zoomed page still belongs to whatever it landed on.
 */
export type NotebookPanGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  basePanX: number;
  basePanY: number;
  moving: boolean;
};

export type CancelActivePinchOptions = {
  /** Clear tracked touch pointers as well, for blur/visibility teardown. */
  clearPointers?: boolean;
  /**
   * Commit the live pan back into React state. Only applies when a pinch was
   * actually running: committing unconditionally would push a pan update on
   * every resize, which is not what the page did before.
   */
  commitPan?: boolean;
};

export type NotebookTouchPointerEndOptions = {
  allowTextTap?: boolean;
  cancelled?: boolean;
};

type UseNotebookViewportControllerOptions = {
  frameSize: NotebookViewportFrameSize;
  pageZoom: number;
  pagePan: NotebookPagePan;
  pageWidth: number;
  pageHeight: number;
  setPageZoom: (zoom: number) => void;
  setPagePan: (pan: NotebookPagePan) => void;
  pageSurfaceRef: RefObject<HTMLDivElement | null>;
  pageFrameRef: RefObject<HTMLDivElement | null>;
  isNavigationLocked: () => boolean;
  /** True while a stylus stroke (or its cooldown) should swallow touch input. */
  isStylusSuppressingTouch: () => boolean;
  /**
   * A second finger landed. The page unwinds an in-flight swipe completely:
   * track offset, preview layer, and the create-page affordance.
   */
  onPinchTakeover: () => void;
  /**
   * A pinch is already running. Only drop the pending swipe candidate — the
   * track has been unwound by `onPinchTakeover` already, and repeating that
   * work every pinch frame would fight the compositor.
   */
  onClearSwipeCandidate: () => void;
  /** Single-finger release is a page-navigation concern, not a viewport one. */
  onSwipeEnd: (
    event: ReactPointerEvent<HTMLElement>,
    options: NotebookTouchPointerEndOptions
  ) => void;
};

export type NotebookViewportController = {
  layout: NotebookViewportLayout;
  /** Where `NotebookViewport` draws the sheets, kept the same object until it changes. */
  geometry: NotebookViewportGeometry;
  pageFit: NotebookViewportLayout["fitSize"];
  pageWidthPx: number;
  pageHeightPx: number;
  pageTrackTravelDistance: number;
  /** Live pan written by the compositor, ahead of the committed React state. */
  pagePanLiveRef: RefObject<NotebookPagePan>;
  isPinchActive: () => boolean;
  cancelPinchAnimationFrame: () => void;
  resetPageSurfaceTransform: () => void;
  /** Ends any in-flight pinch. Returns whether one was actually running. */
  cancelActivePinch: (options?: CancelActivePinchOptions) => boolean;
  /** Full teardown for notebook switches. */
  resetViewportGestures: () => void;
  handleTouchPointerDown: (event: ReactPointerEvent<HTMLElement>) => boolean;
  handleTouchPointerMove: (event: ReactPointerEvent<HTMLElement>) => boolean;
  handleTouchPointerEnd: (
    event: ReactPointerEvent<HTMLElement>,
    options?: NotebookTouchPointerEndOptions
  ) => boolean;
};

/**
 * Owns notebook page zoom and pan: the fit/pan maths, the anchored two-finger
 * pinch, and the compositor transform written during a gesture.
 *
 * Page swiping and navigation deliberately stay outside. This controller only
 * reports single-finger releases through `onSwipeEnd` so the two gesture
 * systems cannot reach into each other's state.
 */
export function useNotebookViewportController({
  frameSize,
  pageZoom,
  pagePan,
  pageWidth,
  pageHeight,
  setPageZoom,
  setPagePan,
  pageSurfaceRef,
  pageFrameRef,
  isNavigationLocked,
  isStylusSuppressingTouch,
  onPinchTakeover,
  onClearSwipeCandidate,
  onSwipeEnd,
}: UseNotebookViewportControllerOptions): NotebookViewportController {
  const pinchZoomRef = useRef<NotebookPinchZoomState | null>(null);
  const panGestureRef = useRef<NotebookPanGesture | null>(null);
  const pinchCommitPendingRef = useRef(false);
  const pagePanLiveRef = useRef<NotebookPagePan>({ x: 0, y: 0 });
  const touchPointersRef = useRef<Map<number, PointerClientSample>>(new Map());

  const pinchFrameQueue = useMemo(
    () =>
      createNotebookPinchFrameQueue({
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
      }),
    []
  );

  const layout = useMemo(
    () =>
      getNotebookViewportLayout({
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        pageWidth,
        pageHeight,
        zoom: pageZoom,
        pan: pagePan,
      }),
    [frameSize, pageHeight, pagePan, pageWidth, pageZoom]
  );

  const geometry = useMemo<NotebookViewportGeometry>(
    () => ({
      pageWidth: layout.pageSize.width,
      pageHeight: layout.pageSize.height,
      pageX: layout.pageOrigin.x,
      pageY: layout.pageOrigin.y,
      swipeTravel: layout.swipeTravel,
    }),
    [layout]
  );

  // The gesture handlers below must keep a stable identity — they sit on the
  // stylus hot path and are re-attached on every render otherwise. Holding the
  // caller's latest values behind refs lets the page pass inline callbacks
  // (including ones declared later in its body) without churning the handlers.
  const layoutRef = useRef(layout);
  const onPinchTakeoverRef = useRef(onPinchTakeover);
  const onClearSwipeCandidateRef = useRef(onClearSwipeCandidate);
  const onSwipeEndRef = useRef(onSwipeEnd);
  const isNavigationLockedRef = useRef(isNavigationLocked);
  const isStylusSuppressingTouchRef = useRef(isStylusSuppressingTouch);

  useEffect(() => {
    layoutRef.current = layout;
    onPinchTakeoverRef.current = onPinchTakeover;
    onClearSwipeCandidateRef.current = onClearSwipeCandidate;
    onSwipeEndRef.current = onSwipeEnd;
    isNavigationLockedRef.current = isNavigationLocked;
    isStylusSuppressingTouchRef.current = isStylusSuppressingTouch;
  }, [
    isNavigationLocked,
    isStylusSuppressingTouch,
    layout,
    onClearSwipeCandidate,
    onPinchTakeover,
    onSwipeEnd,
  ]);

  const cancelPinchAnimationFrame = useCallback(() => {
    pinchFrameQueue.cancel();
  }, [pinchFrameQueue]);

  const writeLivePinchTransform = useCallback(
    (pinch: NotebookPinchZoomState) => {
      const surface = pageSurfaceRef.current;
      if (!surface) return null;
      const liveTransform = getNotebookLivePinchTransform({
        anchorFx: pinch.anchorFx,
        anchorFy: pinch.anchorFy,
        basePanX: pinch.basePanX,
        basePanY: pinch.basePanY,
        currentCenterX: pinch.lastCenterX,
        currentCenterY: pinch.lastCenterY,
        frameHeight: pinch.frameHeight,
        frameWidth: pinch.frameWidth,
        nextZoom: pinch.pendingZoom,
        startCenterX: pinch.startCenterX,
        startCenterY: pinch.startCenterY,
        startPageHeight: pinch.startPageHeight,
        startPageWidth: pinch.startPageWidth,
        startZoom: pinch.startZoom,
      });
      surface.style.transformOrigin = "0 0";
      surface.style.transform = `translate3d(${liveTransform.x}px, ${
        liveTransform.y
      }px, 0) scale(${liveTransform.scaleRatio})`;
      return liveTransform;
    },
    [pageSurfaceRef]
  );

  const queueLivePinchTransform = useCallback(() => {
    pinchFrameQueue.queue(() => {
      const pinch = pinchZoomRef.current;
      if (pinch) writeLivePinchTransform(pinch);
    });
  }, [pinchFrameQueue, writeLivePinchTransform]);

  /**
   * Writes the live pan straight to the compositor.
   *
   * Only a translation, so unlike the pinch there is no scale to reconcile
   * afterwards: React's own transform for the settled pan is this same string,
   * and the commit at the end of the gesture simply re-renders it.
   */
  const writeLivePanTransform = useCallback(() => {
    const surface = pageSurfaceRef.current;
    if (!surface) return;
    surface.style.transformOrigin = "0 0";
    surface.style.transform = `translate3d(${pagePanLiveRef.current.x}px, ${
      pagePanLiveRef.current.y
    }px, 0)`;
  }, [pageSurfaceRef]);

  const queueLivePanTransform = useCallback(() => {
    pinchFrameQueue.queue(writeLivePanTransform);
  }, [pinchFrameQueue, writeLivePanTransform]);

  const resetPageSurfaceTransform = useCallback(() => {
    pinchCommitPendingRef.current = false;
    const surface = pageSurfaceRef.current;
    if (!surface) return;
    surface.style.transformOrigin = "0 0";
    surface.style.transform = `translate3d(${pagePanLiveRef.current.x}px, ${
      pagePanLiveRef.current.y
    }px, 0)`;
    surface.style.willChange = "";
  }, [pageSurfaceRef]);

  // Keep the last compositor pinch matrix in place until React has committed
  // the matching page dimensions. Resetting the scale before that commit
  // briefly renders the old-sized sheet at the new origin on iPad.
  useLayoutEffect(() => {
    if (!pinchCommitPendingRef.current) return;
    resetPageSurfaceTransform();
  }, [pagePan, pageZoom, resetPageSurfaceTransform]);

  const isPinchActive = useCallback(() => Boolean(pinchZoomRef.current), []);

  const cancelActivePinch = useCallback(
    (options: CancelActivePinchOptions = {}) => {
      const wasPinching = Boolean(pinchZoomRef.current);
      if (wasPinching) {
        cancelPinchAnimationFrame();
        resetPageSurfaceTransform();
      }
      pinchZoomRef.current = null;
      panGestureRef.current = null;
      if (options.clearPointers) touchPointersRef.current.clear();
      if (wasPinching && options.commitPan) setPagePan(pagePanLiveRef.current);
      return wasPinching;
    },
    [cancelPinchAnimationFrame, resetPageSurfaceTransform, setPagePan]
  );

  const resetViewportGestures = useCallback(() => {
    cancelPinchAnimationFrame();
    pinchZoomRef.current = null;
    panGestureRef.current = null;
    pinchCommitPendingRef.current = false;
    touchPointersRef.current.clear();
    pagePanLiveRef.current = { x: 0, y: 0 };
  }, [cancelPinchAnimationFrame]);

  const updateTouchPointer = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      touchPointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
        pressure: 0.5,
        time: Math.max(0, Math.round(event.nativeEvent.timeStamp ?? 0)),
      });
    },
    []
  );

  const startPinchZoom = useCallback(() => {
    const [first, second] = Array.from(touchPointersRef.current.values());
    if (!first || !second) return;
    cancelPinchAnimationFrame();
    // A second finger ends any pan outright rather than letting it commit when
    // the first one lifts: from here the pinch owns where the sheet sits.
    panGestureRef.current = null;
    onPinchTakeoverRef.current();

    const surface = pageSurfaceRef.current;
    const frameRect = pageFrameRef.current?.getBoundingClientRect();
    const rect = surface?.getBoundingClientRect();
    if (!surface || !frameRect || !rect || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const centerX = (first.clientX + second.clientX) / 2;
    const centerY = (first.clientY + second.clientY) / 2;
    surface.style.willChange = "transform";
    surface.style.transformOrigin = "0 0";
    pinchZoomRef.current = {
      startDistance: getPinchDistance(first, second),
      startZoom: layoutRef.current.zoom,
      startCenterX: centerX,
      startCenterY: centerY,
      lastCenterX: centerX,
      lastCenterY: centerY,
      anchorFx: (centerX - rect.left) / rect.width,
      anchorFy: (centerY - rect.top) / rect.height,
      // Read the rendered origin so a ResizeObserver/state update cannot make
      // the first live pinch frame jump after rotation or viewport resizing.
      basePanX: rect.left - frameRect.left,
      basePanY: rect.top - frameRect.top,
      frameHeight: frameRect.height,
      frameWidth: frameRect.width,
      pendingZoom: layoutRef.current.zoom,
      startPageHeight: rect.height,
      startPageWidth: rect.width,
    };
  }, [cancelPinchAnimationFrame, pageFrameRef, pageSurfaceRef]);

  // Ends an anchored pinch: commits the final zoom to layout and computes the
  // pan that keeps the page point that was under the fingers exactly where
  // the fingers left it, clamped to the frame.
  const finalizePinchCommit = useCallback(
    (pinch: NotebookPinchZoomState) => {
      cancelPinchAnimationFrame();
      const surface = pageSurfaceRef.current;
      if (!surface) return;
      const nextZoom = pinch.pendingZoom;
      // Flush the newest touch sample and commit that exact bounded transform.
      // Live and settled geometry must be identical or the page visibly shifts
      // as soon as the second finger lifts.
      const finalTransform = writeLivePinchTransform(pinch);
      if (!finalTransform) return;
      const nextPan = { x: finalTransform.x, y: finalTransform.y };
      pagePanLiveRef.current = nextPan;
      pinchCommitPendingRef.current = true;
      setPageZoom(nextZoom);
      setPagePan(nextPan);
    },
    [
      cancelPinchAnimationFrame,
      pageSurfaceRef,
      setPagePan,
      setPageZoom,
      writeLivePinchTransform,
    ]
  );

  const handleTouchPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return false;
      if (isNavigationLockedRef.current()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (isStylusSuppressingTouchRef.current()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      /*
       * The primary touch is the first finger on glass with no other finger
       * down, so anything still tracked at that moment is a finger whose
       * release never arrived. Left in place it pairs with the new finger as a
       * pinch, and a one-finger swipe zooms the page.
       */
      if (event.isPrimary && touchPointersRef.current.size > 0) {
        if (pinchZoomRef.current) {
          cancelPinchAnimationFrame();
          resetPageSurfaceTransform();
          pinchZoomRef.current = null;
        }
        touchPointersRef.current.clear();
      }
      updateTouchPointer(event);
      safelySetPointerCapture(event.currentTarget, event.pointerId);
      if (touchPointersRef.current.size >= 2) {
        startPinchZoom();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      // Offered rather than claimed: the gesture is only a pan once the finger
      // has actually travelled, so a tap still reaches the page underneath.
      panGestureRef.current = isNotebookViewportZoomedIn(layoutRef.current.zoom)
        ? {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            basePanX: layoutRef.current.pageOrigin.x,
            basePanY: layoutRef.current.pageOrigin.y,
            moving: false,
          }
        : null;
      return false;
    },
    [
      cancelPinchAnimationFrame,
      resetPageSurfaceTransform,
      startPinchZoom,
      updateTouchPointer,
    ]
  );

  /**
   * The pen is writing, so every finger already on the glass is a palm.
   *
   * The stylus guard only ever judged touches as they landed. A hand resting
   * on the page before a word began -- which happens every time the pen lifts
   * between words for longer than the cooldown -- went on steering the sheet
   * for as long as it moved: panning it, pinching it, or dragging it as a
   * swipe, underneath the pen that was writing on it. Whatever it started
   * settles where it is on screen, so nothing jumps, and it lets go.
   */
  const yieldTouchToStylus = useCallback(() => {
    const pinch = pinchZoomRef.current;
    const pan = panGestureRef.current;
    pinchZoomRef.current = null;
    panGestureRef.current = null;
    touchPointersRef.current.clear();
    onClearSwipeCandidateRef.current();
    if (pinch) {
      finalizePinchCommit(pinch);
      return;
    }
    if (pan?.moving) {
      cancelPinchAnimationFrame();
      writeLivePanTransform();
      const surface = pageSurfaceRef.current;
      if (surface) surface.style.willChange = "";
      setPagePan(pagePanLiveRef.current);
    }
  }, [
    cancelPinchAnimationFrame,
    finalizePinchCommit,
    pageSurfaceRef,
    setPagePan,
    writeLivePanTransform,
  ]);

  const handleTouchPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        event.pointerType !== "touch" ||
        !touchPointersRef.current.has(event.pointerId)
      ) {
        return false;
      }
      if (isStylusSuppressingTouchRef.current()) {
        yieldTouchToStylus();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      updateTouchPointer(event);
      const pinch = pinchZoomRef.current;
      const pan = panGestureRef.current;
      if (
        !pinch &&
        pan &&
        pan.pointerId === event.pointerId &&
        touchPointersRef.current.size === 1
      ) {
        const dx = event.clientX - pan.startX;
        const dy = event.clientY - pan.startY;
        if (!pan.moving && Math.hypot(dx, dy) < NOTEBOOK_PAN_GESTURE_SLOP) {
          return false;
        }
        if (!pan.moving) {
          pan.moving = true;
          const surface = pageSurfaceRef.current;
          if (surface) surface.style.willChange = "transform";
        }
        // Bounds come from the live layout rather than gesture start: they
        // depend only on zoom, which a single finger cannot change.
        pagePanLiveRef.current = clampNotebookViewportOrigin({
          origin: { x: pan.basePanX + dx, y: pan.basePanY + dy },
          bounds: layoutRef.current.panBounds,
        });
        queueLivePanTransform();
        onClearSwipeCandidateRef.current();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (!pinch || touchPointersRef.current.size < 2) return false;

      const [first, second] = Array.from(touchPointersRef.current.values());
      if (first && second) {
        const centerX = (first.clientX + second.clientX) / 2;
        const centerY = (first.clientY + second.clientY) / 2;
        pinch.pendingZoom = getNotebookPageZoomAfterPinch({
          startDistance: pinch.startDistance,
          currentDistance: getPinchDistance(first, second),
          startZoom: pinch.startZoom,
        });
        pinch.lastCenterX = centerX;
        pinch.lastCenterY = centerY;
        // Pointer events can outpace iPad paint. Keep only the latest two-finger
        // sample and write one anchored compositor transform per animation frame.
        queueLivePinchTransform();
      }
      onClearSwipeCandidateRef.current();
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [
      pageSurfaceRef,
      queueLivePanTransform,
      queueLivePinchTransform,
      updateTouchPointer,
      yieldTouchToStylus,
    ]
  );

  const handleTouchPointerEnd = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      options: NotebookTouchPointerEndOptions = {}
    ) => {
      if (event.pointerType !== "touch") return false;
      const wasPinching =
        Boolean(pinchZoomRef.current) || touchPointersRef.current.size >= 2;
      touchPointersRef.current.delete(event.pointerId);
      safelyReleasePointerCapture(event.currentTarget, event.pointerId);
      if (wasPinching) {
        const pinch = pinchZoomRef.current;
        if (pinch) finalizePinchCommit(pinch);
        pinchZoomRef.current = null;
        onClearSwipeCandidateRef.current();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      const pan = panGestureRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        panGestureRef.current = null;
        if (pan.moving) {
          // Flush the newest position before committing, so the settled
          // transform is the one the finger last saw.
          cancelPinchAnimationFrame();
          writeLivePanTransform();
          const surface = pageSurfaceRef.current;
          if (surface) surface.style.willChange = "";
          setPagePan(pagePanLiveRef.current);
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
      }

      onSwipeEndRef.current(event, options);
      return true;
    },
    [
      cancelPinchAnimationFrame,
      finalizePinchCommit,
      pageSurfaceRef,
      setPagePan,
      writeLivePanTransform,
    ]
  );

  return {
    layout,
    geometry,
    pageFit: layout.fitSize,
    pageWidthPx: layout.pageSize.width,
    pageHeightPx: layout.pageSize.height,
    pageTrackTravelDistance: layout.swipeTravel,
    pagePanLiveRef,
    isPinchActive,
    cancelPinchAnimationFrame,
    resetPageSurfaceTransform,
    cancelActivePinch,
    resetViewportGestures,
    handleTouchPointerDown,
    handleTouchPointerMove,
    handleTouchPointerEnd,
  };
}

export { shouldSuppressTouchAfterStylus };
