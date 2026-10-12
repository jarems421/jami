/**
 * The ruler: a straightedge laid over the page to draw along, moved and turned
 * with the fingers. Pure and DOM-free. It is never saved: it is a tool on the
 * desk, not ink on the page.
 *
 * A stroke that starts within reach of one of its long edges is held to that
 * edge for its whole length (`inkRulerEdgeNear`, `projectOntoInkRulerEdge`),
 * which is what a real ruler does to a pen run along it.
 */

import type { InkPoint } from "@/lib/ink/model";

export type InkRuler = {
  /** Its middle, in page units. */
  cx: number;
  cy: number;
  /** Radians, clockwise from flat. */
  angle: number;
  length: number;
  /** Edge to edge. */
  width: number;
};

/** One long edge: a point on it and its direction, a unit vector. */
export type InkRulerEdge = { x: number; y: number; dx: number; dy: number };

/** A turn this close to a detent settles on it. */
const DETENT_WITHIN = (2 * Math.PI) / 180;
/** The detents: every 15 degrees. */
const DETENT_STEP = Math.PI / 12;

/** A ruler across the middle of a page, flat. */
export function initialInkRuler(page: { width: number; height: number }): InkRuler {
  return {
    cx: page.width / 2,
    cy: page.height / 2,
    angle: 0,
    length: page.width * 0.85,
    width: Math.max(56, page.width * 0.075),
  };
}

function edges(ruler: InkRuler): [InkRulerEdge, InkRulerEdge] {
  const dx = Math.cos(ruler.angle);
  const dy = Math.sin(ruler.angle);
  const half = ruler.width / 2;
  return [
    { x: ruler.cx + dy * half, y: ruler.cy - dx * half, dx, dy },
    { x: ruler.cx - dy * half, y: ruler.cy + dx * half, dx, dy },
  ];
}

/** Whether `point` is on the ruler itself (its body), `slop` included all round. */
export function isOnInkRuler(ruler: InkRuler, point: InkPoint, slop = 0): boolean {
  const ox = point.x - ruler.cx;
  const oy = point.y - ruler.cy;
  const along = ox * Math.cos(ruler.angle) + oy * Math.sin(ruler.angle);
  const across = -ox * Math.sin(ruler.angle) + oy * Math.cos(ruler.angle);
  return Math.abs(along) <= ruler.length / 2 + slop && Math.abs(across) <= ruler.width / 2 + slop;
}

/**
 * The long edge a stroke starting at `point` is drawn along: the nearer edge,
 * if the point is within `reach` of it and alongside the ruler's length.
 */
export function inkRulerEdgeNear(ruler: InkRuler, point: InkPoint, reach: number): InkRulerEdge | null {
  let best: InkRulerEdge | null = null;
  let bestGap = reach;
  for (const edge of edges(ruler)) {
    const ox = point.x - edge.x;
    const oy = point.y - edge.y;
    const along = ox * edge.dx + oy * edge.dy;
    if (Math.abs(along) > ruler.length / 2) continue;
    const gap = Math.abs(-ox * edge.dy + oy * edge.dx);
    if (gap <= bestGap) {
      bestGap = gap;
      best = edge;
    }
  }
  return best;
}

/** `point` moved onto the edge, straight across it. */
export function projectOntoInkRulerEdge(edge: InkRulerEdge, point: InkPoint): InkPoint {
  const along = (point.x - edge.x) * edge.dx + (point.y - edge.y) * edge.dy;
  return { x: edge.x + edge.dx * along, y: edge.y + edge.dy * along };
}

/** An angle within a couple of degrees of a multiple of 15 settles on it. */
export function settleInkRulerAngle(angle: number): number {
  const nearest = Math.round(angle / DETENT_STEP) * DETENT_STEP;
  return Math.abs(angle - nearest) <= DETENT_WITHIN ? nearest : angle;
}

/** The angle as the readout shows it: whole degrees, 0 to 179, a ruler having no front. */
export function inkRulerDegrees(angle: number): number {
  const degrees = Math.round((angle * 180) / Math.PI);
  return ((degrees % 180) + 180) % 180;
}

/** Moved by one finger, from `from` to `to`. */
export function slideInkRuler(ruler: InkRuler, from: InkPoint, to: InkPoint): InkRuler {
  return { ...ruler, cx: ruler.cx + to.x - from.x, cy: ruler.cy + to.y - from.y };
}

/**
 * Moved and turned by two fingers: the ruler follows the pair as if held by
 * them -- turned about their midpoint by as much as the line between them
 * turned, and carried with the midpoint. Its length never changes. `start` is
 * the ruler and `before` the fingers when they landed, so the detents act on
 * the whole turn and a settled angle can always be turned off again.
 */
export function twistInkRuler(
  start: InkRuler,
  before: [InkPoint, InkPoint],
  after: [InkPoint, InkPoint]
): InkRuler {
  const turnBefore = Math.atan2(before[1].y - before[0].y, before[1].x - before[0].x);
  const turnAfter = Math.atan2(after[1].y - after[0].y, after[1].x - after[0].x);
  const angle = settleInkRulerAngle(start.angle + (turnAfter - turnBefore));
  const turn = angle - start.angle;
  const midBefore = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
  const midAfter = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
  const ox = start.cx - midBefore.x;
  const oy = start.cy - midBefore.y;
  return {
    ...start,
    angle,
    cx: midAfter.x + ox * Math.cos(turn) - oy * Math.sin(turn),
    cy: midAfter.y + ox * Math.sin(turn) + oy * Math.cos(turn),
  };
}
