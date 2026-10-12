import type { NotebookStroke } from "@/lib/workspace/notebooks";
import { normalizeInkPressure, normalizeInkTime } from "@/lib/workspace/notebook-ink-engine";
import {
  clampNotebookViewportOrigin,
  getNotebookViewportFit,
  getNotebookViewportPanBounds,
  isNotebookViewportZoomedIn,
  NOTEBOOK_VIEWPORT_MAX_ZOOM,
  NOTEBOOK_VIEWPORT_MIN_ZOOM,
  type NotebookViewportPoint,
} from "@/lib/workspace/notebook-viewport";

export { isNotebookViewportZoomedIn };

export type NotebookInkPoint = {
  x: number;
  y: number;
  pressure?: number;
  time?: number;
};

export type PointerClientSample = {
  clientX: number;
  clientY: number;
  pressure: number;
  time: number;
};

export type LivePointerSample = {
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
};

const DEFAULT_MIN_POINT_DISTANCE = 1.35;
const DEFAULT_MAX_INTERPOLATED_POINT_DISTANCE = 4.75;
export const NOTEBOOK_INITIAL_POINTS_WITHOUT_DISTANCE_FILTER = 5;
export const NOTEBOOK_NATIVE_COMMIT_IDLE_MS = 750;
export const NOTEBOOK_MAX_PENDING_NATIVE_STROKES = 120;
export const NOTEBOOK_PAGE_SWIPE_THRESHOLD = 64;
export const NOTEBOOK_PAGE_SWIPE_COMMIT_RATIO = 0.22;
export const NOTEBOOK_PAGE_SWIPE_FLICK_VELOCITY = 0.55;
export const NOTEBOOK_PAGE_SWIPE_VELOCITY_WINDOW_MS = 100;
// Pulling forward past the last page far enough to fill this fraction of the page
// width (with a px floor) creates a new page. A fast forward flick can shortcut it.
export const NOTEBOOK_CREATE_PAGE_THRESHOLD_RATIO = 0.32;
export const NOTEBOOK_CREATE_PAGE_MIN_THRESHOLD = 96;
export const NOTEBOOK_CREATE_PAGE_FLICK_VELOCITY = 0.6;
export const NOTEBOOK_PAGE_MIN_ZOOM = NOTEBOOK_VIEWPORT_MIN_ZOOM;
export const NOTEBOOK_PAGE_MAX_ZOOM = NOTEBOOK_VIEWPORT_MAX_ZOOM;
export const NOTEBOOK_DEFAULT_THICKNESS_PERCENT = 50;
/**
 * The nib, in page units, on a page 900 across.
 *
 * These were raised when the pen stopped being measured in screen pixels. Under
 * the old arithmetic a stroke came out `width / fitScale` wide on the page, and
 * the fitted scale is well under one whenever the page is letterboxed -- around
 * 0.58 on a landscape tablet, where the height is what constrains it. The same
 * setting therefore drew far heavier than its nominal value, and correcting the
 * arithmetic without correcting the numbers made every pen visibly thinner.
 *
 * The range now reproduces what that setting actually put on the page, and does
 * it the same way on every screen, in either orientation, at any zoom.
 */
export const NOTEBOOK_PEN_MIN_WIDTH = 3;
export const NOTEBOOK_PEN_MAX_WIDTH = 16;
/**
 * A highlighter is laid over a line of text, so its useful range starts around
 * the height of one and goes well past it. The old ceiling of 30 needed
 * several passes to cover an ordinary sentence, which is not what the tool is
 * for; the floor still leaves something thin enough to underline with.
 */
export const NOTEBOOK_HIGHLIGHTER_MIN_WIDTH = 16;
export const NOTEBOOK_HIGHLIGHTER_MAX_WIDTH = 64;
export const NOTEBOOK_MAX_LIVE_POINTER_SAMPLES_PER_EVENT = 8;

export function appendPendingNotebookStroke(
  pending: NotebookStroke[],
  stroke: NotebookStroke,
  maxPending = NOTEBOOK_MAX_PENDING_NATIVE_STROKES
) {
  const boundedLimit = Math.max(1, Math.floor(maxPending));
  return [...pending, stroke].slice(-boundedLimit);
}

export function clampNotebookThicknessPercent(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return NOTEBOOK_DEFAULT_THICKNESS_PERCENT;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getWidthFromThicknessPercent(input: {
  value: unknown;
  minWidth: number;
  maxWidth: number;
}) {
  const percent = clampNotebookThicknessPercent(input.value);
  const width = input.minWidth + (percent / 100) * (input.maxWidth - input.minWidth);
  return Math.round(width * 100) / 100;
}

export function getPenWidthFromPercent(value: unknown) {
  return getWidthFromThicknessPercent({
    value,
    minWidth: NOTEBOOK_PEN_MIN_WIDTH,
    maxWidth: NOTEBOOK_PEN_MAX_WIDTH,
  });
}

export function getHighlighterWidthFromPercent(value: unknown) {
  return getWidthFromThicknessPercent({
    value,
    minWidth: NOTEBOOK_HIGHLIGHTER_MIN_WIDTH,
    maxWidth: NOTEBOOK_HIGHLIGHTER_MAX_WIDTH,
  });
}

export function shouldPointerDraw(
  pointerType: string,
  tool: "pen" | "eraser" | "highlighter" | "text" | "select"
) {
  if (tool !== "pen" && tool !== "highlighter") return false;
  return pointerType === "pen" || pointerType === "mouse";
}

export type NotebookPointerDrawEventLike = {
  pointerType: string;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
};

export function shouldPointerDrawEvent(
  event: NotebookPointerDrawEventLike,
  tool: "pen" | "eraser" | "highlighter" | "text" | "select"
) {
  return shouldPointerDraw(event.pointerType, tool);
}

export function shouldUseNotebookPenPressure(input: {
  maxTouchPoints: number;
  platform: string;
  pointerType: string;
  userAgent: string;
}) {
  if (input.pointerType !== "pen") return false;

  const platform = input.platform.toLowerCase();
  const userAgent = input.userAgent.toLowerCase();
  const isIPad =
    userAgent.includes("ipad") ||
    platform.startsWith("ipad") ||
    (platform === "macintel" && input.maxTouchPoints > 1);
  return isIPad;
}

export function shouldPointerSwipePages(pointerType: string) {
  return pointerType === "touch";
}

export type NotebookPageDragIntent = "page" | "pan" | "none";

/**
 * What one finger does, decided by whether the whole sheet is on screen.
 *
 * A fitted sheet has nowhere to go, so a sideways drag can only mean the next
 * page, and a vertical one can only mean nothing. That much has always been
 * true here.
 *
 * A zoomed sheet is the opposite case, and it used to be given the same answer:
 * one finger did nothing at all, on the reasoning that where the page sits
 * belongs to the two-finger gesture. That reads as the page being stuck. Most
 * of it is off screen, the obvious way to reach the rest is to push it, and
 * pushing it did nothing -- so the only way across a zoomed page was to pinch
 * out and back in again.
 *
 * So zoomed in, one finger moves the sheet, in whichever direction it is
 * pushed. Turning the page is then reached by zooming out, which is the same
 * order the eye works in anyway: step back, then move on. It also means the two
 * gestures can never be confused, because they are never both available.
 */
export function getNotebookPageDragIntent(input: {
  axis: "horizontal" | "vertical";
  zoom?: number;
}): NotebookPageDragIntent {
  if (isNotebookViewportZoomedIn(input.zoom ?? 1)) return "pan";
  return input.axis === "horizontal" ? "page" : "none";
}

export function shouldSuppressTouchAfterStylus(input: {
  stylusActive: boolean;
  cooldownUntil: number;
  now: number;
}) {
  return input.stylusActive || input.now < input.cooldownUntil;
}

export function getNotebookSwipeDirection(input: {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  threshold?: number;
}): "next" | "previous" | null {
  const threshold = input.threshold ?? NOTEBOOK_PAGE_SWIPE_THRESHOLD;
  const dx = input.currentX - input.startX;
  const dy = input.currentY - input.startY;
  if (Math.abs(dx) < threshold) return null;
  if (Math.abs(dx) < Math.abs(dy) * 1.15) return null;
  return dx < 0 ? "next" : "previous";
}

export function getNotebookPageIndexAfterSwipe(input: {
  currentIndex: number;
  pageCount: number;
  direction: "next" | "previous";
}) {
  if (input.pageCount <= 0 || input.currentIndex < 0 || input.currentIndex >= input.pageCount) {
    return input.currentIndex;
  }
  const offset = input.direction === "next" ? 1 : -1;
  return Math.max(0, Math.min(input.pageCount - 1, input.currentIndex + offset));
}

export type NotebookSwipeSample = { x: number; time: number };

export function getNotebookSwipeVelocity(
  samples: readonly NotebookSwipeSample[],
  windowMs = NOTEBOOK_PAGE_SWIPE_VELOCITY_WINDOW_MS
) {
  const validSamples = samples.filter(
    (sample) => Number.isFinite(sample.x) && Number.isFinite(sample.time)
  );
  const latest = validSamples[validSamples.length - 1];
  if (!latest) return 0;
  const cutoff = latest.time - Math.max(0, windowMs);
  const windowSamples = validSamples.filter(
    (sample) => sample.time >= cutoff && sample.time <= latest.time
  );
  const first = windowSamples[0];
  if (!first || first === latest) return 0;
  const elapsed = latest.time - first.time;
  return elapsed > 0 ? (latest.x - first.x) / elapsed : 0;
}

export function getNotebookSwipeReleaseDecision(input: {
  totalDx: number;
  pageWidth: number;
  velocityX: number;
  currentIndex: number;
  pageCount: number;
}) {
  const distanceDirection = input.totalDx < 0 ? "next" : "previous";
  const flickDirection = input.velocityX < 0 ? "next" : "previous";
  const distanceQualifies =
    Math.abs(input.totalDx) >= Math.max(1, input.pageWidth) * NOTEBOOK_PAGE_SWIPE_COMMIT_RATIO;
  const flickQualifies =
    Math.abs(input.velocityX) >= NOTEBOOK_PAGE_SWIPE_FLICK_VELOCITY;
  const direction = distanceQualifies
    ? distanceDirection
    : flickQualifies
      ? flickDirection
      : null;
  if (!direction) {
    return { direction: null, targetIndex: input.currentIndex, shouldCommit: false } as const;
  }
  const targetIndex = getNotebookPageIndexAfterSwipe({
    currentIndex: input.currentIndex,
    pageCount: input.pageCount,
    direction,
  });
  return {
    direction,
    targetIndex,
    shouldCommit: targetIndex !== input.currentIndex,
  } as const;
}

export function getNotebookSwipeDragOffset(input: {
  totalDx: number;
  currentIndex: number;
  pageCount: number;
}) {
  const canMoveNext = input.totalDx < 0 && input.currentIndex < input.pageCount - 1;
  const canMovePrevious = input.totalDx > 0 && input.currentIndex > 0;
  if (canMoveNext || canMovePrevious || input.totalDx === 0) return input.totalDx;
  return Math.sign(input.totalDx) * Math.sqrt(Math.abs(input.totalDx)) * 5;
}

export function getNotebookSwipeSettleDuration(input: {
  currentOffset: number;
  targetOffset: number;
  travelDistance: number;
  velocityX: number;
  reducedMotion?: boolean;
}) {
  if (input.reducedMotion) return 0;
  if (Math.abs(input.targetOffset - input.currentOffset) < 0.5) return 0;
  const remainingProgress = Math.max(
    0,
    Math.min(
      1,
      Math.abs(input.targetOffset - input.currentOffset) /
        Math.max(1, Math.abs(input.travelDistance))
    )
  );
  const duration =
    140 +
    160 * remainingProgress -
    Math.min(80, Math.abs(input.velocityX) * 40);
  return Math.round(Math.max(140, Math.min(300, duration)));
}

export function getNotebookCreatePageThreshold(pageWidth: number) {
  return Math.max(
    NOTEBOOK_CREATE_PAGE_MIN_THRESHOLD,
    Math.max(1, pageWidth) * NOTEBOOK_CREATE_PAGE_THRESHOLD_RATIO
  );
}

// Describes the "pull past the last page to create a new one" gesture. A forward
// pull is a leftward drag, so `totalDx` is negative; `progress` (0..1) drives the
// circular ring, and `resistedOffset` is the rubber-banded page translation (the
// same sqrt curve used for the first/last-page bounce).
export function getNotebookCreatePagePull(input: {
  totalDx: number;
  pageWidth: number;
}): { progress: number; resistedOffset: number } {
  const pull = Math.max(0, -input.totalDx);
  const threshold = getNotebookCreatePageThreshold(input.pageWidth);
  const progress = Math.max(0, Math.min(1, pull / threshold));
  // Track the finger (with a little drag) so the incoming blank page is revealed
  // bit by bit as you pull, capped so it never slides further than the page.
  const resistedOffset =
    pull > 0 ? -Math.min(pull * 0.6, Math.max(1, input.pageWidth) * 0.6) : 0;
  return { progress, resistedOffset };
}

export function shouldCreateNotebookPageOnRelease(input: {
  totalDx: number;
  pageWidth: number;
  velocityX: number;
}): boolean {
  const { progress } = getNotebookCreatePagePull({
    totalDx: input.totalDx,
    pageWidth: input.pageWidth,
  });
  if (progress >= 1) return true;
  // A fast forward flick (leftward → negative velocityX) past a partial pull.
  return (
    progress >= 0.5 && input.velocityX <= -NOTEBOOK_CREATE_PAGE_FLICK_VELOCITY
  );
}

export function clampNotebookPageZoom(
  value: number,
  minZoom = NOTEBOOK_PAGE_MIN_ZOOM
) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(minZoom, Math.min(NOTEBOOK_PAGE_MAX_ZOOM, value));
}

export type NotebookPagePan = NotebookViewportPoint;

export function getNotebookPageFit(input: {
  frameWidth: number;
  frameHeight: number;
  pageWidth: number;
  pageHeight: number;
}) {
  return getNotebookViewportFit(input);
}

// Position of the zoomed page inside its fixed frame: centered while the page
// fits, otherwise clamped so the frame is always fully covered by page.
export function clampNotebookPagePan(input: {
  pan: NotebookPagePan;
  pageWidth: number;
  pageHeight: number;
  frameWidth: number;
  frameHeight: number;
  /** Live zoom, so a zoomed-in sheet may sit off-centre on an axis with room. */
  zoom?: number;
}): NotebookPagePan {
  return clampNotebookViewportOrigin({
    origin: input.pan,
    bounds: getNotebookViewportPanBounds(input),
  });
}

export function getNotebookPagePanAfterPinch(input: {
  pinchCenterX: number;
  pinchCenterY: number;
  frameLeft: number;
  frameTop: number;
  anchorFx: number;
  anchorFy: number;
  pageWidth: number;
  pageHeight: number;
  frameWidth: number;
  frameHeight: number;
  zoom?: number;
}) {
  return clampNotebookPagePan({
    pan: {
      x: input.pinchCenterX - input.frameLeft - input.anchorFx * input.pageWidth,
      y: input.pinchCenterY - input.frameTop - input.anchorFy * input.pageHeight,
    },
    pageWidth: input.pageWidth,
    pageHeight: input.pageHeight,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    zoom: input.zoom,
  });
}

export function getNotebookLivePinchTransform(input: {
  anchorFx: number;
  anchorFy: number;
  basePanX: number;
  basePanY: number;
  currentCenterX: number;
  currentCenterY: number;
  frameHeight: number;
  frameWidth: number;
  nextZoom: number;
  startCenterX: number;
  startCenterY: number;
  startPageHeight: number;
  startPageWidth: number;
  startZoom: number;
}) {
  const scaleRatio =
    Number.isFinite(input.startZoom) &&
    input.startZoom > 0 &&
    Number.isFinite(input.nextZoom)
      ? input.nextZoom / input.startZoom
      : 1;
  const nextPageWidth = input.startPageWidth * scaleRatio;
  const nextPageHeight = input.startPageHeight * scaleRatio;
  const pan = clampNotebookPagePan({
    pan: {
      x:
        input.basePanX +
        input.currentCenterX -
        input.startCenterX +
        input.anchorFx * (input.startPageWidth - nextPageWidth),
      y:
        input.basePanY +
        input.currentCenterY -
        input.startCenterY +
        input.anchorFy * (input.startPageHeight - nextPageHeight),
    },
    pageWidth: nextPageWidth,
    pageHeight: nextPageHeight,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    zoom: input.nextZoom,
  });

  return {
    ...pan,
    scaleRatio,
  };
}

export function getPinchDistance(
  first: PointerClientSample,
  second: PointerClientSample
) {
  const dx = first.clientX - second.clientX;
  const dy = first.clientY - second.clientY;
  return Math.hypot(dx, dy);
}

export function getNotebookPageZoomAfterPinch(input: {
  startDistance: number;
  currentDistance: number;
  startZoom: number;
  /** Zoom floor relative to the fitted page size. */
  minZoom?: number;
}) {
  if (input.startDistance <= 0) {
    return clampNotebookPageZoom(input.startZoom, input.minZoom);
  }
  return clampNotebookPageZoom(
    (input.currentDistance / input.startDistance) * input.startZoom,
    input.minZoom
  );
}

/**
 * Screen pixels two fingers have to spread or close by, or carry their middle,
 * before they move the page. A hand resting on the glass to write touches it
 * in two places, which shift as it settles, and each of those shifts zoomed
 * the page a little; a pinch meant is past this in its first moments.
 */
export const NOTEBOOK_PINCH_ZOOM_SLOP = 32;
export const NOTEBOOK_PINCH_PAN_SLOP = 24;

/**
 * Where a two-finger gesture counts from once it has gone past the slop, or
 * null while it has not. What went past the slop starts from the slop's edge,
 * the rest from where the fingers are now, so the page takes the gesture up
 * from there without a jump.
 */
export function engageNotebookPinch(input: {
  startDistance: number;
  distance: number;
  startCenter: { x: number; y: number };
  center: { x: number; y: number };
}): { startDistance: number; startCenter: { x: number; y: number } } | null {
  const spread = input.distance - input.startDistance;
  const shiftX = input.center.x - input.startCenter.x;
  const shiftY = input.center.y - input.startCenter.y;
  const shift = Math.hypot(shiftX, shiftY);
  const zooms = Math.abs(spread) >= NOTEBOOK_PINCH_ZOOM_SLOP;
  const pans = shift >= NOTEBOOK_PINCH_PAN_SLOP;
  if (!zooms && !pans) return null;
  return {
    startDistance: zooms
      ? Math.max(1, input.startDistance + Math.sign(spread) * NOTEBOOK_PINCH_ZOOM_SLOP)
      : input.distance,
    startCenter: pans
      ? {
          x: input.startCenter.x + (shiftX / shift) * NOTEBOOK_PINCH_PAN_SLOP,
          y: input.startCenter.y + (shiftY / shift) * NOTEBOOK_PINCH_PAN_SLOP,
        }
      : input.center,
  };
}

export function clampInkPoint(
  point: NotebookInkPoint,
  width: number,
  height: number
): NotebookInkPoint {
  const clampedPoint: NotebookInkPoint = {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  };
  if (point.pressure !== undefined) clampedPoint.pressure = point.pressure;
  if (point.time !== undefined) clampedPoint.time = point.time;
  return clampedPoint;
}

export function mapClientPointToNotebookPage(input: {
  clientX: number;
  clientY: number;
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  width: number;
  height: number;
}): NotebookInkPoint {
  const x = ((input.clientX - input.rect.left) / input.rect.width) * input.width;
  const y = ((input.clientY - input.rect.top) / input.rect.height) * input.height;
  return clampInkPoint({ x, y }, input.width, input.height);
}

export function normalizePointerPressure(value: unknown) {
  return normalizeInkPressure(value);
}

export function getPointerClientSamples(event: PointerEvent): PointerClientSample[] {
  const coalescedEvents =
    typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const samples = coalescedEvents.length > 0 ? coalescedEvents : [event];
  const fallbackTime = normalizeInkTime(event.timeStamp, 0);
  return samples.map((sample) => ({
    clientX: sample.clientX,
    clientY: sample.clientY,
    pressure: normalizePointerPressure(sample.pressure),
    time: normalizeInkTime(sample.timeStamp, fallbackTime),
  }));
}

export function getBoundedLivePointerSamples<T extends LivePointerSample>(
  event: T & { getCoalescedEvents?: () => readonly T[] },
  previous?: LivePointerSample
): T[] {
  const coalescedSamples =
    typeof event.getCoalescedEvents === "function"
      ? event.getCoalescedEvents()
      : [];
  if (!previous || coalescedSamples.length === 0) return [event];

  const candidates = coalescedSamples.filter((sample, index, samples) => {
    /*
     * Nothing older than what has already been drawn.
     *
     * A packet is meant to hold only the samples since the last event, but
     * nothing enforced it: `previous` was checked for existing and never read.
     * A sample from before the last one drawn -- a packet overlapping the one
     * before it -- was replayed, and the line jumped back to it and forward
     * again: a kink in the middle of a straight line, at random.
     */
    const alreadyDrawn =
      sample.timeStamp < previous.timeStamp ||
      (sample.timeStamp === previous.timeStamp &&
        sample.clientX === previous.clientX &&
        sample.clientY === previous.clientY);
    if (alreadyDrawn) return false;
    const duplicatesEndpoint =
      sample.clientX === event.clientX &&
      sample.clientY === event.clientY &&
      sample.timeStamp === event.timeStamp;
    const prior = samples[index - 1];
    const duplicatesPrior =
      prior?.clientX === sample.clientX &&
      prior.clientY === sample.clientY &&
      prior.timeStamp === sample.timeStamp;
    return !duplicatesEndpoint && !duplicatesPrior;
  });
  if (candidates.length === 0) return [event];

  const historyLimit = NOTEBOOK_MAX_LIVE_POINTER_SAMPLES_PER_EVENT - 1;
  if (candidates.length <= historyLimit) return [...candidates, event];

  // Dense packets are uncommon, but keep their full time span rather than
  // taking only the newest points. Even sampling preserves curves and pressure
  // changes while keeping the amount of per-event geometry work bounded.
  const selected: T[] = [];
  for (let index = 0; index < historyLimit; index += 1) {
    const candidateIndex = Math.round(
      (index * (candidates.length - 1)) / (historyLimit - 1)
    );
    const candidate = candidates[candidateIndex];
    if (candidate && selected.at(-1) !== candidate) selected.push(candidate);
  }
  return [...selected, event];
}

export function shouldAppendInkPoint(
  points: NotebookInkPoint[],
  point: NotebookInkPoint,
  minDistance = DEFAULT_MIN_POINT_DISTANCE
) {
  if (points.length < NOTEBOOK_INITIAL_POINTS_WITHOUT_DISTANCE_FILTER) return true;
  const previousPoint = points[points.length - 1];
  if (!previousPoint) return true;
  const dx = point.x - previousPoint.x;
  const dy = point.y - previousPoint.y;
  return dx * dx + dy * dy >= minDistance * minDistance;
}

export function appendInkPoints(
  currentPoints: NotebookInkPoint[],
  incomingPoints: NotebookInkPoint[],
  maxPoints: number,
  minDistance = DEFAULT_MIN_POINT_DISTANCE
) {
  const nextPoints = [...currentPoints];
  for (const point of incomingPoints) {
    if (nextPoints.length >= maxPoints) break;
    if (shouldAppendInkPoint(nextPoints, point, minDistance)) {
      nextPoints.push(point);
    }
  }
  return nextPoints;
}

function interpolateNotebookPoint(
  previousPoint: NotebookInkPoint,
  currentPoint: NotebookInkPoint,
  progress: number
): NotebookInkPoint {
  const previousPressure = normalizePointerPressure(previousPoint.pressure);
  const currentPressure = normalizePointerPressure(currentPoint.pressure);
  const previousTime = normalizeInkTime(previousPoint.time, 0);
  const currentTime = normalizeInkTime(currentPoint.time, previousTime);
  return {
    x: previousPoint.x + (currentPoint.x - previousPoint.x) * progress,
    y: previousPoint.y + (currentPoint.y - previousPoint.y) * progress,
    pressure: previousPressure + (currentPressure - previousPressure) * progress,
    time: Math.round(previousTime + (currentTime - previousTime) * progress),
  };
}

export function interpolateInkSampleGaps(
  points: NotebookInkPoint[],
  maxDistance = DEFAULT_MAX_INTERPOLATED_POINT_DISTANCE
) {
  if (points.length < 2) return points;
  const nextPoints: NotebookInkPoint[] = [points[0]];

  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = nextPoints[nextPoints.length - 1];
    const currentPoint = points[index];
    const dx = currentPoint.x - previousPoint.x;
    const dy = currentPoint.y - previousPoint.y;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(distance / maxDistance));

    for (let step = 1; step <= steps; step += 1) {
      nextPoints.push(interpolateNotebookPoint(previousPoint, currentPoint, step / steps));
    }
  }

  return nextPoints;
}

export function finalizeInkStroke(stroke: NotebookStroke | null): NotebookStroke | null {
  if (!stroke || stroke.points.length === 0) return null;
  return {
    ...stroke,
    points: interpolateInkSampleGaps(stroke.points).slice(0, 1_200),
  };
}
