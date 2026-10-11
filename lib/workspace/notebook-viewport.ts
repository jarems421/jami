import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
} from "@/lib/workspace/notebooks";

export const NOTEBOOK_VIEWPORT_MIN_ZOOM = 0.92;
export const NOTEBOOK_VIEWPORT_MAX_ZOOM = 4;
export const NOTEBOOK_VIEWPORT_COMPACT_MAX_WIDTH = 767;
export const NOTEBOOK_VIEWPORT_COMPACT_INSET = 12;
export const NOTEBOOK_VIEWPORT_REGULAR_INSET = 16;
export const NOTEBOOK_VIEWPORT_LANDSCAPE_INSET = 8;
export const NOTEBOOK_VIEWPORT_COMPACT_SWIPE_GAP = 24;
export const NOTEBOOK_VIEWPORT_SWIPE_GAP = 48;
/**
 * How much of the sheet a zoomed viewport always keeps on screen. A zoomed
 * sheet is otherwise free to sit wherever the pinch put it; this is only here
 * so it can never be pushed away entirely.
 */
export const NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE = 120;
/**
 * Zoom travel over which that freedom is handed over. Short enough that a real
 * pinch is unconstrained from the outset, long enough that pinching back out to
 * the fitted view returns the sheet to the centre without a sideways snap.
 */
export const NOTEBOOK_VIEWPORT_FREE_PAN_ZOOM_RANGE = 0.15;

/**
 * How far one finger travels on a zoomed sheet before it is moving the page
 * rather than touching it, in screen pixels.
 *
 * A tap on a zoomed page still has to be able to select a text block, and no
 * finger lands and lifts without moving a little. Matched to the threshold the
 * page swipe already uses, so a drag becomes a drag at the same distance
 * whether it is turning the page or moving it.
 */
export const NOTEBOOK_PAN_GESTURE_SLOP = 8;

export type NotebookViewportSize = {
  width: number;
  height: number;
};

export type NotebookViewportPoint = {
  x: number;
  y: number;
};

export type NotebookViewportPanBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

/** Where the sheets sit in the viewport, as `NotebookViewport` draws them. */
export type NotebookViewportGeometry = {
  pageHeight: number;
  pageWidth: number;
  pageX: number;
  pageY: number;
  swipeTravel: number;
};

export type NotebookViewportLayout = {
  frameSize: NotebookViewportSize;
  logicalPageSize: NotebookViewportSize;
  inset: number;
  availableSize: NotebookViewportSize;
  fitScale: number;
  fitSize: NotebookViewportSize;
  fitOrigin: NotebookViewportPoint;
  zoom: number;
  pageSize: NotebookViewportSize;
  pageOrigin: NotebookViewportPoint;
  panBounds: NotebookViewportPanBounds;
  swipeGap: number;
  swipeTravel: number;
};

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Zoom above which the sheet counts as zoomed in rather than fitted. Shared so
 * pan bounds and drag intent agree on when the reader has left the fitted view.
 */
export const NOTEBOOK_VIEWPORT_FIT_ZOOM_EPSILON = 1.0001;

export function isNotebookViewportZoomedIn(zoom: number | undefined) {
  return (
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom > NOTEBOOK_VIEWPORT_FIT_ZOOM_EPSILON
  );
}

export function clampNotebookViewportZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(
    NOTEBOOK_VIEWPORT_MIN_ZOOM,
    Math.min(NOTEBOOK_VIEWPORT_MAX_ZOOM, value)
  );
}

export function getNotebookViewportInset(
  frameWidth: number,
  frameHeight?: number
) {
  const width = finiteNonNegative(frameWidth);
  const height = finiteNonNegative(frameHeight ?? 0);
  if (width <= NOTEBOOK_VIEWPORT_COMPACT_MAX_WIDTH) {
    return NOTEBOOK_VIEWPORT_COMPACT_INSET;
  }
  return height > 0 && width > height
    ? NOTEBOOK_VIEWPORT_LANDSCAPE_INSET
    : NOTEBOOK_VIEWPORT_REGULAR_INSET;
}

export function getNotebookViewportSwipeGap(frameWidth: number) {
  return finiteNonNegative(frameWidth) <= NOTEBOOK_VIEWPORT_COMPACT_MAX_WIDTH
    ? NOTEBOOK_VIEWPORT_COMPACT_SWIPE_GAP
    : NOTEBOOK_VIEWPORT_SWIPE_GAP;
}

export function getNotebookViewportSwipeTravel(input: {
  frameWidth: number;
  pageWidth: number;
  swipeGap: number;
}) {
  const frameWidth = finiteNonNegative(input.frameWidth);
  const pageWidth = finiteNonNegative(input.pageWidth);
  const swipeGap = finiteNonNegative(input.swipeGap);
  const centredWorkspaceGap = Math.max(0, (frameWidth - pageWidth) / 2);

  // Place each adjacent sheet just beyond the nearest viewport edge. Wide
  // workspaces therefore remain single-page surfaces instead of exposing
  // several page-width-spaced carousel slots at once.
  return pageWidth + Math.max(swipeGap, centredWorkspaceGap);
}

export function getNotebookViewportFit(input: {
  frameWidth: number;
  frameHeight: number;
  pageWidth?: number;
  pageHeight?: number;
  inset?: number;
}): NotebookViewportSize {
  const frameWidth = finiteNonNegative(input.frameWidth);
  const frameHeight = finiteNonNegative(input.frameHeight);
  const pageWidth = finiteNonNegative(
    input.pageWidth ?? NOTEBOOK_PAGE_COORDINATE_WIDTH
  );
  const pageHeight = finiteNonNegative(
    input.pageHeight ?? NOTEBOOK_PAGE_COORDINATE_HEIGHT
  );
  const inset = finiteNonNegative(
    input.inset ?? getNotebookViewportInset(frameWidth, frameHeight)
  );
  const availableWidth = Math.max(0, frameWidth - inset * 2);
  const availableHeight = Math.max(0, frameHeight - inset * 2);

  if (
    availableWidth === 0 ||
    availableHeight === 0 ||
    pageWidth === 0 ||
    pageHeight === 0
  ) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(
    availableWidth / pageWidth,
    availableHeight / pageHeight
  );
  return {
    width: pageWidth * scale,
    height: pageHeight * scale,
  };
}

export function getNotebookViewportPanBounds(input: {
  pageWidth: number;
  pageHeight: number;
  frameWidth: number;
  frameHeight: number;
  /**
   * Live zoom.
   *
   * A fitted sheet is pinned to the middle of the frame, so it rests centred
   * and horizontal drags remain page swipes. A zoomed sheet is free: it may sit
   * wherever the gesture put it, held back only by keeping a graspable slice of
   * itself on screen.
   *
   * That freedom is what makes a pinch feel right. Constraining a zoomed sheet
   * to the middle of the frame, or to covering the frame, means discarding the
   * pinch anchor whenever the two disagree -- and the page then slides out from
   * under the fingers doing the pinching.
   */
  zoom?: number;
}): NotebookViewportPanBounds {
  const pageWidth = finiteNonNegative(input.pageWidth);
  const pageHeight = finiteNonNegative(input.pageHeight);
  const frameWidth = finiteNonNegative(input.frameWidth);
  const frameHeight = finiteNonNegative(input.frameHeight);
  const zoomedIn = isNotebookViewportZoomedIn(input.zoom);
  const zoom = input.zoom ?? 1;

  const getAxisBounds = (pageSize: number, frameSize: number) => {
    const center = (frameSize - pageSize) / 2;
    if (!zoomedIn || pageSize <= 0 || frameSize <= 0) {
      return { min: center, max: center };
    }

    const minVisible = Math.min(
      pageSize,
      frameSize,
      NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE
    );
    const freeReach = Math.max(0, (frameSize + pageSize) / 2 - minVisible);
    // Opened in proportion to the zoom travelled. A real pinch barely displaces
    // the sheet this close to fit, so the anchor is honoured throughout; what
    // the taper buys is the way back, where the sheet closes on the centre
    // rather than snapping to it.
    const progress = Math.min(
      1,
      Math.max(0, (zoom - 1) / NOTEBOOK_VIEWPORT_FREE_PAN_ZOOM_RANGE)
    );
    const reach = freeReach * progress;
    return { min: center - reach, max: center + reach };
  };
  const horizontal = getAxisBounds(pageWidth, frameWidth);
  const vertical = getAxisBounds(pageHeight, frameHeight);

  return {
    minX: horizontal.min,
    maxX: horizontal.max,
    minY: vertical.min,
    maxY: vertical.max,
  };
}

export function clampNotebookViewportOrigin(input: {
  origin: NotebookViewportPoint;
  bounds: NotebookViewportPanBounds;
}): NotebookViewportPoint {
  const centeredX = (input.bounds.minX + input.bounds.maxX) / 2;
  const centeredY = (input.bounds.minY + input.bounds.maxY) / 2;
  const x = Number.isFinite(input.origin.x) ? input.origin.x : centeredX;
  const y = Number.isFinite(input.origin.y) ? input.origin.y : centeredY;

  return {
    x: Math.max(input.bounds.minX, Math.min(input.bounds.maxX, x)),
    y: Math.max(input.bounds.minY, Math.min(input.bounds.maxY, y)),
  };
}

/**
 * The scroll area a zoomed sheet pans in when the iPad's own scrolling moves it
 * (`enableNotebookNativeScroll`): the frame plus however far the sheet may
 * travel, with the sheet placed where scrolling right back to the start shows
 * it furthest right and down. So a scroll offset is the same pan as ever,
 * counted from the other side: `origin = sheet - offset`, over exactly the
 * bounds a pan has.
 *
 * Null at fit, where the sheet sits in the middle and a sideways drag turns
 * the page instead.
 */
export type NotebookViewportScroll = {
  width: number;
  height: number;
  sheetX: number;
  sheetY: number;
};

export function getNotebookViewportScroll(
  layout: Pick<NotebookViewportLayout, "zoom" | "frameSize" | "panBounds">
): NotebookViewportScroll | null {
  if (!isNotebookViewportZoomedIn(layout.zoom)) return null;
  const { frameSize, panBounds } = layout;
  return {
    width: frameSize.width + Math.max(0, panBounds.maxX - panBounds.minX),
    height: frameSize.height + Math.max(0, panBounds.maxY - panBounds.minY),
    sheetX: panBounds.maxX,
    sheetY: panBounds.maxY,
  };
}

/** The scroll offsets that show the sheet at `origin`. */
export function getNotebookScrollOffset(
  scroll: NotebookViewportScroll,
  origin: NotebookViewportPoint
): { left: number; top: number } {
  return { left: scroll.sheetX - origin.x, top: scroll.sheetY - origin.y };
}

/**
 * Where scroll offsets put the sheet, held inside its bounds: an iPad bounces
 * past the ends of a scroll before settling back.
 */
export function getNotebookOriginForScroll(input: {
  scroll: NotebookViewportScroll;
  left: number;
  top: number;
  bounds: NotebookViewportPanBounds;
}): NotebookViewportPoint {
  return clampNotebookViewportOrigin({
    origin: { x: input.scroll.sheetX - input.left, y: input.scroll.sheetY - input.top },
    bounds: input.bounds,
  });
}

/**
 * Calculates every sheet measurement from one fixed frame. Floating notebook
 * controls intentionally do not participate in this model.
 *
 * `zoom: 1` is the fitted 900 x 1240 page. `pageOrigin` is an absolute origin
 * inside the frame, matching the existing notebook pan representation.
 */
export function getNotebookViewportLayout(input: {
  frameWidth: number;
  frameHeight: number;
  zoom?: number;
  pan?: NotebookViewportPoint;
  pageWidth?: number;
  pageHeight?: number;
  swipeGap?: number;
}): NotebookViewportLayout {
  const frameSize = {
    width: finiteNonNegative(input.frameWidth),
    height: finiteNonNegative(input.frameHeight),
  };
  const logicalPageSize = {
    width: finiteNonNegative(
      input.pageWidth ?? NOTEBOOK_PAGE_COORDINATE_WIDTH
    ),
    height: finiteNonNegative(
      input.pageHeight ?? NOTEBOOK_PAGE_COORDINATE_HEIGHT
    ),
  };
  const inset = getNotebookViewportInset(
    frameSize.width,
    frameSize.height
  );
  const availableSize = {
    width: Math.max(0, frameSize.width - inset * 2),
    height: Math.max(0, frameSize.height - inset * 2),
  };
  const fitSize = getNotebookViewportFit({
    frameWidth: frameSize.width,
    frameHeight: frameSize.height,
    pageWidth: logicalPageSize.width,
    pageHeight: logicalPageSize.height,
    inset,
  });
  const fitScale =
    logicalPageSize.width > 0 ? fitSize.width / logicalPageSize.width : 0;
  const fitOrigin = {
    x: (frameSize.width - fitSize.width) / 2,
    y: (frameSize.height - fitSize.height) / 2,
  };
  const zoom = clampNotebookViewportZoom(input.zoom ?? 1);
  const pageSize = {
    width: fitSize.width * zoom,
    height: fitSize.height * zoom,
  };
  const panBounds = getNotebookViewportPanBounds({
    pageWidth: pageSize.width,
    pageHeight: pageSize.height,
    frameWidth: frameSize.width,
    frameHeight: frameSize.height,
    zoom,
  });
  const defaultOrigin = {
    x: (frameSize.width - pageSize.width) / 2,
    y: (frameSize.height - pageSize.height) / 2,
  };
  const pageOrigin = clampNotebookViewportOrigin({
    origin: input.pan ?? defaultOrigin,
    bounds: panBounds,
  });
  const swipeGap = finiteNonNegative(
    input.swipeGap ?? getNotebookViewportSwipeGap(frameSize.width)
  );

  return {
    frameSize,
    logicalPageSize,
    inset,
    availableSize,
    fitScale,
    fitSize,
    fitOrigin,
    zoom,
    pageSize,
    pageOrigin,
    panBounds,
    swipeGap,
    swipeTravel: getNotebookViewportSwipeTravel({
      frameWidth: frameSize.width,
      pageWidth: pageSize.width,
      swipeGap,
    }),
  };
}

/**
 * Zooms a laid-out page about a point in its frame, keeping whatever is under
 * that point still. The frame's middle when no point is given.
 *
 * Null when the zoom would not change. Zooming back to the fit returns the
 * fitted page with no pan, so it opens centred the way it first did.
 */
export function zoomNotebookViewportAbout(input: {
  layout: NotebookViewportLayout;
  zoom: number;
  focus?: NotebookViewportPoint;
}): { zoom: number; pan: NotebookViewportPoint } | null {
  const { layout } = input;
  const zoom = clampNotebookViewportZoom(input.zoom);
  if (Math.abs(zoom - layout.zoom) < 0.001) return null;
  if (!isNotebookViewportZoomedIn(zoom)) return { zoom: 1, pan: { x: 0, y: 0 } };
  const point = input.focus ?? {
    x: layout.frameSize.width / 2,
    y: layout.frameSize.height / 2,
  };
  const across = (point.x - layout.pageOrigin.x) / Math.max(1, layout.pageSize.width);
  const down = (point.y - layout.pageOrigin.y) / Math.max(1, layout.pageSize.height);
  const next = getNotebookViewportLayout({
    frameWidth: layout.frameSize.width,
    frameHeight: layout.frameSize.height,
    pageWidth: layout.logicalPageSize.width,
    pageHeight: layout.logicalPageSize.height,
    zoom,
    pan: {
      x: point.x - across * layout.fitSize.width * zoom,
      y: point.y - down * layout.fitSize.height * zoom,
    },
  });
  return { zoom, pan: next.pageOrigin };
}

export function getNotebookInkViewportScale(input: {
  displayWidth: number;
  displayHeight: number;
  pageWidth: number;
  pageHeight: number;
}) {
  const pageWidth = Math.max(1, input.pageWidth);
  const pageHeight = Math.max(1, input.pageHeight);
  return {
    x: Math.max(0, input.displayWidth) / pageWidth,
    y: Math.max(0, input.displayHeight) / pageHeight,
  };
}

export type NotebookAnimationFrameScheduler = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
};

export type NotebookPinchFrameQueue = {
  queue: (callback: () => void) => void;
  cancel: () => void;
  hasPendingFrame: () => boolean;
};

/**
 * Coalesces repeated live-pinch writes into one animation frame. The queued
 * frame runs the latest callback, while cancellation also invalidates a stale
 * callback if a scheduler happens to deliver it after cancelFrame.
 */
export function createNotebookPinchFrameQueue(
  scheduler: NotebookAnimationFrameScheduler
): NotebookPinchFrameQueue {
  type PendingFrame = {
    id: number | null;
  };

  let pendingFrame: PendingFrame | null = null;
  let latestCallback: (() => void) | null = null;

  return {
    queue(callback) {
      latestCallback = callback;
      if (pendingFrame) return;

      const requestedFrame: PendingFrame = { id: null };
      pendingFrame = requestedFrame;
      requestedFrame.id = scheduler.requestFrame(() => {
        if (pendingFrame !== requestedFrame) return;

        pendingFrame = null;
        const callbackToRun = latestCallback;
        latestCallback = null;
        callbackToRun?.();
      });
    },
    cancel() {
      const frameToCancel = pendingFrame;
      pendingFrame = null;
      latestCallback = null;
      if (frameToCancel?.id !== null && frameToCancel?.id !== undefined) {
        scheduler.cancelFrame(frameToCancel.id);
      }
    },
    hasPendingFrame() {
      return pendingFrame !== null;
    },
  };
}
