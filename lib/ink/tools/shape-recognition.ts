/**
 * What a stroke held still at its end was meant to be, when it was not a
 * straight line (which the pen judges itself, `straighten` in `pen.ts`): a
 * circle or an oval, a rectangle or a square, a triangle or another polygon of
 * up to six sides, or an arrow. Pure and DOM-free.
 *
 * Every candidate is fitted to the stroke and the best fit wins, if it is good
 * enough -- the approach the sketch-recognition literature settled on, and
 * what Apple's Notes and Procreate's QuickShape behave like. A closed stroke is
 * fitted as an ellipse and as a polygon (its corners found by simplifying it,
 * then each side fitted as a line), and whichever lies closer to the stroke is
 * it. An open one is an arrow if it runs straight out to a tip and then turns
 * back to make a head on both sides of the shaft. Anything else stays as drawn.
 *
 * The result is levelled the way a snapped line is: a rectangle or oval within
 * a few degrees of upright is made upright, a near-square square, a
 * near-circle round, a triangle's near-flat side flat.
 */

import { aimAlongGuides } from "@/lib/ink/geometry/aim";
import { Vec } from "@/lib/ink/geometry/vector";
import type { InkPoint, InkShapeGeometry } from "@/lib/ink/model";

export type InkShapeRecognitionOptions = {
  /** The pen's width, in page units. */
  width: number;
  /** One screen pixel, in page units. */
  pixelSize: number;
};

export type InkRecognizedShape = {
  geometry: InkShapeGeometry;
  /**
   * What the shape turns and scales about while the pen stays down
   * (`adjustInkShape`): the centre of a closed shape, the tail of an arrow.
   */
  anchor: InkPoint;
};

/** The stroke is resampled to this many points, evenly along it, before anything is fitted. */
const RESAMPLE_COUNT = 96;
/**
 * The smallest shape there is, as its bounding box's diagonal: on screen, and
 * in nib widths. Smaller than a deliberate shape is drawn, larger than a
 * letter is written -- so the pause at the end of an 'o' leaves an 'o'.
 */
const MINIMUM_SIZE_PX = 36;
const MINIMUM_SIZE_WIDTHS = 6;
/** How near its start a stroke has to come again, as a share of its size, to be closed. */
const CLOSE_GAP_SHARE = 0.25;
/** And where it does, as a share of the way along it. */
const CLOSE_AFTER_SHARE = 0.6;
/** Simplifying a closed stroke to its corners keeps every point this far, as a share of its size, off a side. */
const CORNER_TOLERANCE_SHARE = 0.05;
/** A corner turning less than this is part of a side: two sides drawn as one. */
const MINIMUM_CORNER_TURN = (28 * Math.PI) / 180;
/** A side shorter than this share of the stroke's length is no side. */
const MINIMUM_SIDE_SHARE = 0.06;
/** The most a polygon's sides may sit from the stroke, on average, as a share of its size. */
const POLYGON_MAXIMUM_ERROR = 0.022;
/** And an ellipse's outline. */
const ELLIPSE_MAXIMUM_ERROR = 0.03;
/**
 * A polygon wins only by this much: a rounded square is closer to a square than
 * to an oval, but a wobbly circle can be closer to some hexagon than to a
 * circle by a hair, and a circle is what it was.
 */
const POLYGON_PREFERENCE = 0.75;
/** Within this of upright, an oval or a rectangle is made upright, and a triangle's side flat. */
const LEVEL_WITHIN = (8 * Math.PI) / 180;
/** Every corner of a quadrilateral within this of square makes it a rectangle. */
const RIGHT_ANGLE_WITHIN = (16 * Math.PI) / 180;
/** Sides (or axes) within this share of each other are made equal: a square, an equilateral triangle, a circle. */
const EQUAL_WITHIN = 0.1;
/** An arrow's tip is where the stroke first comes this near its furthest from the start, as a share of that. */
const TIP_WITHIN_SHARE = 0.03;
/** An arrow's shaft strays no more than this from straight, as a share of its length. */
const SHAFT_STRAY_SHARE = 0.08;
/** Its head reaches no further than this from the tip. */
const HEAD_REACH_SHARE = 0.45;
/** And opens at least this far either side of the shaft. */
const HEAD_SPREAD_SHARE = 0.05;
/** Turning this little while adjusting is the hand drifting, and no turn. */
const ADJUST_DRIFT_TURN = (3 * Math.PI) / 180;
/** And this much is all turn, eased in from the drift so the shape never jumps. */
const ADJUST_FULL_TURN = (10 * Math.PI) / 180;

type Fit = { error: number };
type EllipseFit = Fit & { cx: number; cy: number; rx: number; ry: number; rotation: number };
type PolygonFit = Fit & { corners: InkPoint[] };

const distance = (a: InkPoint, b: InkPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Points evenly spaced along the stroke, so a slow stretch is not over-represented in a fit. */
function resample(points: readonly InkPoint[], count: number): InkPoint[] {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1] + distance(points[index - 1], points[index]));
  }
  const total = lengths[lengths.length - 1];
  if (!(total > 0)) return [];
  const out: InkPoint[] = [];
  let segment = 1;
  for (let step = 0; step < count; step += 1) {
    const target = (total * step) / (count - 1);
    while (segment < points.length - 1 && lengths[segment] < target) segment += 1;
    const from = points[segment - 1];
    const to = points[segment];
    const span = lengths[segment] - lengths[segment - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (target - lengths[segment - 1]) / span)) : 0;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return out;
}

/**
 * The closed part of a stroke: up to where, late in it, it comes back nearest
 * its start -- trimming an overshoot past it -- or null if it never comes back
 * near enough. Only late in it: a figure of eight started at its crossing is
 * back at its start halfway, and its second half is no overshoot.
 */
function closedLoop(path: readonly InkPoint[], size: number): InkPoint[] | null {
  let travelled = 0;
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += distance(path[index - 1], path[index]);
  let nearest = Infinity;
  let end = -1;
  for (let index = 1; index < path.length; index += 1) {
    travelled += distance(path[index - 1], path[index]);
    if (travelled < total * CLOSE_AFTER_SHARE) continue;
    const gap = distance(path[index], path[0]);
    if (gap < nearest) {
      nearest = gap;
      end = index;
    }
  }
  return end > 0 && nearest <= size * CLOSE_GAP_SHARE ? path.slice(0, end + 1) : null;
}

/**
 * How many times a closed loop turns right round, joined back to its start:
 * one, either way, for anything that is a shape -- a figure of eight or a
 * scribble that happens to end where it began turns some other number of
 * times. It only counts the turns between steps, so a shaky hand changes
 * nothing.
 */
function wholeTurns(loop: readonly InkPoint[]): number {
  const headings: number[] = [];
  for (let index = 1; index < loop.length; index += 1) {
    const dx = loop[index].x - loop[index - 1].x;
    const dy = loop[index].y - loop[index - 1].y;
    if (dx !== 0 || dy !== 0) headings.push(Math.atan2(dy, dx));
  }
  // Across the gap a stroke stopped short of its start leaves, which carries
  // on the way it was going. A gap smaller than a step has no direction to trust.
  const last = loop[loop.length - 1];
  const step = distance(loop[0], loop[1]);
  if (distance(last, loop[0]) > step) headings.push(Math.atan2(loop[0].y - last.y, loop[0].x - last.x));
  let total = 0;
  for (let index = 0; index < headings.length; index += 1) {
    total += fold(headings[(index + 1) % headings.length] - headings[index], 2 * Math.PI);
  }
  return Math.round(total / (2 * Math.PI));
}

const centroidOf = (points: readonly InkPoint[]) => {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
};

/**
 * An ellipse through a closed loop: centre and axes from the loop's moments,
 * then the radii by least squares on `u²/a² + v²/b² = 1` in the axes' frame.
 * Error is the mean radial distance from the loop to it.
 */
function fitEllipse(loop: readonly InkPoint[]): EllipseFit | null {
  const centre = centroidOf(loop);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of loop) {
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const rotation = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const frame = (point: InkPoint) => {
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
  };
  let u4 = 0;
  let v4 = 0;
  let u2v2 = 0;
  let u2 = 0;
  let v2 = 0;
  for (const point of loop) {
    const { u, v } = frame(point);
    u4 += u ** 4;
    v4 += v ** 4;
    u2v2 += u * u * v * v;
    u2 += u * u;
    v2 += v * v;
  }
  const determinant = u4 * v4 - u2v2 * u2v2;
  if (!(determinant > 0)) return null;
  const a = (u2 * v4 - u2v2 * v2) / determinant;
  const b = (u4 * v2 - u2v2 * u2) / determinant;
  if (!(a > 0) || !(b > 0)) return null;
  const rx = 1 / Math.sqrt(a);
  const ry = 1 / Math.sqrt(b);
  let total = 0;
  for (const point of loop) {
    const { u, v } = frame(point);
    const radius = Math.hypot(u, v);
    if (radius === 0) continue;
    const onEllipse = (rx * ry) / Math.hypot((ry * u) / radius, (rx * v) / radius);
    total += Math.abs(radius - onEllipse);
  }
  return { cx: centre.x, cy: centre.y, rx, ry, rotation, error: total / loop.length };
}

function distanceToSegment(point: InkPoint, a: InkPoint, b: InkPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Indices Douglas-Peucker keeps of a polyline: its first and last, and every point needed to stay within `tolerance`. */
function simplify(points: readonly InkPoint[], tolerance: number): number[] {
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let index = from + 1; index < to; index += 1) {
      const gap = distanceToSegment(points[index], points[from], points[to]);
      if (gap > worstDistance) {
        worst = index;
        worstDistance = gap;
      }
    }
    if (worst < 0) continue;
    keep[worst] = true;
    stack.push([from, worst], [worst, to]);
  }
  return keep.flatMap((kept, index) => (kept ? [index] : []));
}

const turnAt = (previous: InkPoint, here: InkPoint, next: InkPoint) => {
  const ax = here.x - previous.x;
  const ay = here.y - previous.y;
  const bx = next.x - here.x;
  const by = next.y - here.y;
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return lengths > 0 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / lengths))) : 0;
};

/** The line through some points, as a point on it and its direction (total least squares). */
function lineThrough(points: readonly InkPoint[]) {
  const centre = centroidOf(points);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: centre, direction: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function intersect(
  a: { point: InkPoint; direction: InkPoint },
  b: { point: InkPoint; direction: InkPoint }
): InkPoint | null {
  const denominator = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(denominator) < 1e-6) return null;
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const t = (dx * b.direction.y - dy * b.direction.x) / denominator;
  return { x: a.point.x + t * a.direction.x, y: a.point.y + t * a.direction.y };
}

/**
 * A polygon through a closed loop: its sides by simplifying the loop, a line
 * fitted to each, and the corners where those lines meet -- so the sides
 * follow the edges drawn, not the samples nearest the corners. Error is the
 * mean distance from the loop to the polygon.
 *
 * Where the stroke started and ended needs no corner of its own. Its last side
 * and its first either run on into each other, when it started part way along
 * a side, or meet at a corner, when it started at one -- and either way the
 * gap left by stopping a little short is no side of the shape.
 */
function fitPolygon(loop: readonly InkPoint[], size: number): PolygonFit | null {
  // Each side is the indices of the loop drawn along it, in order.
  const kept = simplify(loop, size * CORNER_TOLERANCE_SHARE);
  let sides = kept.slice(1).map((to, index) => {
    const from = kept[index];
    return Array.from({ length: to - from + 1 }, (_, step) => from + step);
  });
  const chord = (side: readonly number[]) => {
    const from = loop[side[0]];
    const to = loop[side[side.length - 1]];
    return { x: to.x - from.x, y: to.y - from.y };
  };
  const turnBetween = (before: readonly number[], after: readonly number[]) => {
    const a = chord(before);
    const b = chord(after);
    return Math.abs(fold(Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x), 2 * Math.PI));
  };
  let perimeter = 0;
  for (let index = 1; index < loop.length; index += 1) perimeter += distance(loop[index - 1], loop[index]);

  while (sides.length > 2) {
    // The neighbours turning least, if they barely turn, are one side drawn in two.
    let straightest = -1;
    let least = MINIMUM_CORNER_TURN;
    for (let index = 0; index < sides.length; index += 1) {
      const turn = turnBetween(sides[index], sides[(index + 1) % sides.length]);
      if (turn < least) {
        least = turn;
        straightest = index;
      }
    }
    if (straightest >= 0) {
      const next = (straightest + 1) % sides.length;
      const before = sides[straightest];
      const after = sides[next];
      const joined = before[before.length - 1] === after[0] ? [...before, ...after.slice(1)] : [...before, ...after];
      sides =
        next === 0
          ? [joined, ...sides.slice(1, -1)]
          : [...sides.slice(0, straightest), joined, ...sides.slice(next + 1)];
      continue;
    }
    // Then the shortest, if it is too short to be a side: a corner drawn
    // round, or the scrap between a corner and where the stroke closed.
    let shortest = 0;
    const lengthOf = (side: readonly number[]) => Math.hypot(chord(side).x, chord(side).y);
    for (let index = 1; index < sides.length; index += 1) {
      if (lengthOf(sides[index]) < lengthOf(sides[shortest])) shortest = index;
    }
    if (lengthOf(sides[shortest]) >= perimeter * MINIMUM_SIDE_SHARE) break;
    sides = sides.filter((_, index) => index !== shortest);
  }
  if (sides.length < 3 || sides.length > 6) return null;

  // Each side's line, from the points along it away from both its ends.
  const lines = sides.map((side) => {
    const inset = Math.floor((side.length - 1) * 0.2);
    const along = side.slice(inset, side.length - inset).map((index) => loop[index]);
    return along.length >= 2 ? lineThrough(along) : null;
  });
  const fitted = sides.map((side, at) => {
    const previous = sides[(at + sides.length - 1) % sides.length];
    const ended = loop[previous[previous.length - 1]];
    const started = loop[side[0]];
    const drawn = { x: (ended.x + started.x) / 2, y: (ended.y + started.y) / 2 };
    const before = lines[(at + lines.length - 1) % lines.length];
    const after = lines[at];
    const meet = before && after ? intersect(before, after) : null;
    // A meeting far from the drawn corner is two nearly parallel sides.
    return meet && distance(meet, drawn) < size * 0.15 ? meet : drawn;
  });

  let total = 0;
  for (const point of loop) {
    let nearest = Infinity;
    for (let index = 0; index < fitted.length; index += 1) {
      nearest = Math.min(nearest, distanceToSegment(point, fitted[index], fitted[(index + 1) % fitted.length]));
    }
    total += nearest;
  }
  return { corners: fitted, error: total / loop.length };
}

/** An angle folded into (-period/2, period/2]. */
const fold = (angle: number, period: number) => angle - period * Math.round(angle / period);

const rotateAbout = (point: InkPoint, centre: InkPoint, angle: number): InkPoint => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
};

/** A quadrilateral whose corners are all near square, as an exact rectangle (or square), levelled. */
function asRectangle(corners: readonly InkPoint[]): InkPoint[] | null {
  for (let index = 0; index < 4; index += 1) {
    const turn = turnAt(corners[(index + 3) % 4], corners[index], corners[(index + 1) % 4]);
    if (Math.abs(turn - Math.PI / 2) > RIGHT_ANGLE_WITHIN) return null;
  }
  // The sides' direction, averaged a quarter turn at a time, weighted by length.
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < 4; index += 1) {
    const from = corners[index];
    const to = corners[(index + 1) % 4];
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const length = distance(from, to);
    sumX += Math.cos(4 * angle) * length;
    sumY += Math.sin(4 * angle) * length;
  }
  let angle = Math.atan2(sumY, sumX) / 4;
  if (Math.abs(fold(angle, Math.PI / 2)) < LEVEL_WITHIN) angle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  const centre = centroidOf(corners);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let halfWidth = 0;
  let halfHeight = 0;
  for (const corner of corners) {
    const dx = corner.x - centre.x;
    const dy = corner.y - centre.y;
    halfWidth += Math.abs(dx * cos + dy * sin) / 4;
    halfHeight += Math.abs(-dx * sin + dy * cos) / 4;
  }
  if (Math.abs(halfWidth - halfHeight) <= EQUAL_WITHIN * Math.max(halfWidth, halfHeight)) {
    halfWidth = halfHeight = (halfWidth + halfHeight) / 2;
  }
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) => ({
    x: centre.x + u * halfWidth * cos - v * halfHeight * sin,
    y: centre.y + u * halfWidth * sin + v * halfHeight * cos,
  }));
}

/** A triangle with near-equal sides made equilateral, and a side within a few degrees of flat made flat. */
function levelTriangle(corners: readonly InkPoint[]): InkPoint[] {
  const centre = centroidOf(corners);
  const lengths = corners.map((corner, index) => distance(corner, corners[(index + 1) % 3]));
  const mean = (lengths[0] + lengths[1] + lengths[2]) / 3;
  let shaped = [...corners];
  if (lengths.every((length) => Math.abs(length - mean) <= EQUAL_WITHIN * mean)) {
    // Kept turning the way it was drawn, from its first corner.
    const radius = mean / Math.sqrt(3);
    const start = Math.atan2(corners[0].y - centre.y, corners[0].x - centre.x);
    const direction = Math.sign(
      (corners[1].x - corners[0].x) * (corners[2].y - corners[0].y) -
        (corners[1].y - corners[0].y) * (corners[2].x - corners[0].x)
    ) || 1;
    shaped = [0, 1, 2].map((step) => ({
      x: centre.x + radius * Math.cos(start + (direction * step * 2 * Math.PI) / 3),
      y: centre.y + radius * Math.sin(start + (direction * step * 2 * Math.PI) / 3),
    }));
  }
  // The side nearest flat, levelled if it is within a few degrees.
  let turn = Infinity;
  for (let index = 0; index < 3; index += 1) {
    const from = shaped[index];
    const to = shaped[(index + 1) % 3];
    const off = fold(Math.atan2(to.y - from.y, to.x - from.x), Math.PI);
    if (Math.abs(off) < Math.abs(turn)) turn = off;
  }
  return Math.abs(turn) < LEVEL_WITHIN ? shaped.map((corner) => rotateAbout(corner, centre, -turn)) : shaped;
}

/** An ellipse within a few degrees of upright made upright, and one nearly round made round. */
function levelEllipse(fit: EllipseFit): Extract<InkShapeGeometry, { type: "ellipse" }> {
  let { rx, ry } = fit;
  let rotation = fold(fit.rotation, Math.PI);
  if (Math.abs(fold(rotation, Math.PI / 2)) < LEVEL_WITHIN) {
    // Upright: a quarter turn swaps the axes instead.
    if (Math.abs(rotation) > Math.PI / 4) [rx, ry] = [ry, rx];
    rotation = 0;
  }
  if (Math.abs(rx - ry) <= EQUAL_WITHIN * Math.max(rx, ry)) {
    rx = ry = (rx + ry) / 2;
    rotation = 0;
  }
  return { type: "ellipse", cx: fit.cx, cy: fit.cy, rx, ry, rotation };
}

/**
 * An arrow drawn in one stroke: out along a straight shaft to the furthest
 * point from the start, then a head that stays near that tip, behind it, and
 * opens to both sides of the shaft.
 */
function fitArrow(path: readonly InkPoint[]): { from: InkPoint; to: InkPoint } | null {
  const start = path[0];
  let furthest = 0;
  for (const point of path) furthest = Math.max(furthest, distance(point, start));
  // The first time the stroke gets there: a head drawn as one barb, back to
  // the tip, then the other, comes back to it again.
  let tip = path.findIndex((point) => distance(point, start) >= furthest * (1 - TIP_WITHIN_SHARE));
  while (tip + 1 < path.length && distance(path[tip + 1], start) > distance(path[tip], start)) tip += 1;
  const shaft = distance(path[tip], start);
  // Nothing after the tip is a line, which is the pen's to straighten.
  if (shaft === 0 || tip > path.length - 4) return null;
  for (let index = 1; index < tip; index += 1) {
    if (distanceToSegment(path[index], start, path[tip]) > shaft * SHAFT_STRAY_SHARE) return null;
  }
  const back = { x: (start.x - path[tip].x) / shaft, y: (start.y - path[tip].y) / shaft };
  let left = 0;
  let right = 0;
  for (let index = tip + 1; index < path.length; index += 1) {
    const dx = path[index].x - path[tip].x;
    const dy = path[index].y - path[tip].y;
    if (Math.hypot(dx, dy) > shaft * HEAD_REACH_SHARE) return null;
    // Forward past the tip is not a head.
    if (dx * back.x + dy * back.y < -shaft * HEAD_SPREAD_SHARE) return null;
    const across = dx * -back.y + dy * back.x;
    left = Math.max(left, across);
    right = Math.max(right, -across);
  }
  if (Math.min(left, right) < shaft * HEAD_SPREAD_SHARE) return null;
  return { from: start, to: path[tip] };
}

/** What the stroke was meant to be, or null to leave it as drawn. */
export function recognizeInkShape(
  points: readonly InkPoint[],
  options: InkShapeRecognitionOptions
): InkRecognizedShape | null {
  if (points.length < 4) return null;
  const path = resample(points, RESAMPLE_COUNT);
  if (path.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of path) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const size = Math.hypot(maxX - minX, maxY - minY);
  if (size < Math.max(MINIMUM_SIZE_PX * options.pixelSize, MINIMUM_SIZE_WIDTHS * options.width)) return null;

  const loop = closedLoop(path, size);
  if (loop) {
    if (Math.abs(wholeTurns(loop)) !== 1) return null;
    const ellipse = fitEllipse(loop);
    const polygon = fitPolygon(loop, size);
    const ellipseError = ellipse ? ellipse.error / size : Infinity;
    const polygonError = polygon ? polygon.error / size : Infinity;
    if (polygon && polygonError <= POLYGON_MAXIMUM_ERROR && polygonError < ellipseError * POLYGON_PREFERENCE) {
      const corners =
        polygon.corners.length === 4
          ? (asRectangle(polygon.corners) ?? polygon.corners)
          : polygon.corners.length === 3
            ? levelTriangle(polygon.corners)
            : polygon.corners;
      return { geometry: { type: "polygon", corners }, anchor: centroidOf(corners) };
    }
    if (ellipse && ellipseError <= ELLIPSE_MAXIMUM_ERROR) {
      const geometry = levelEllipse(ellipse);
      return { geometry, anchor: { x: geometry.cx, y: geometry.cy } };
    }
    return null;
  }

  const arrow = fitArrow(path);
  return arrow ? { geometry: { type: "arrow", ...arrow }, anchor: arrow.from } : null;
}

/**
 * The turn a shape takes for the pen turning it by `turn` about its anchor:
 * none for drift, all of it past `ADJUST_FULL_TURN`, and between the two a
 * cubic that leaves no turn changing at no rate and arrives at the whole turn
 * changing as fast as it -- so the shape stays still, then follows, with no
 * jump in where it is or how fast it moves.
 */
function heldTurn(turn: number): number {
  const size = Math.abs(turn);
  if (size <= ADJUST_DRIFT_TURN) return 0;
  if (size >= ADJUST_FULL_TURN) return turn;
  const span = ADJUST_FULL_TURN - ADJUST_DRIFT_TURN;
  const s = (size - ADJUST_DRIFT_TURN) / span;
  return Math.sign(turn) * (ADJUST_FULL_TURN * (3 * s * s - 2 * s ** 3) + span * (s ** 3 - s * s));
}

/**
 * The shape as the pen moves on while it is still down: turned and scaled
 * about its anchor so that the point under the pen when it snapped follows the
 * pen (`from` to `to`) -- Procreate's QuickShape, which is what makes a snapped
 * shape something to size and aim rather than accept.
 *
 * A small turn is no turn: a hand resting on the pen drifts, and a levelled
 * rectangle should not tilt (`heldTurn`). An arrow aims like a snapped line
 * instead, leaning towards the nearest 45 degrees (`aimAlongGuides`; one screen
 * pixel, `pixelSize`, is too short a reach to have a direction).
 */
export function adjustInkShape(
  shape: InkRecognizedShape,
  from: InkPoint,
  to: InkPoint,
  pixelSize: number
): InkShapeGeometry {
  const { anchor, geometry } = shape;
  const before = { x: from.x - anchor.x, y: from.y - anchor.y };
  const after = { x: to.x - anchor.x, y: to.y - anchor.y };
  const reach = Math.hypot(before.x, before.y);
  if (reach === 0) return geometry;
  const scale = Math.min(4, Math.max(0.25, Math.hypot(after.x, after.y) / reach));
  const drawn = fold(Math.atan2(after.y, after.x) - Math.atan2(before.y, before.x), 2 * Math.PI);
  const turn = geometry.type === "arrow" ? drawn : heldTurn(drawn);
  const place = (point: InkPoint) => {
    const turned = rotateAbout(point, anchor, turn);
    return { x: anchor.x + (turned.x - anchor.x) * scale, y: anchor.y + (turned.y - anchor.y) * scale };
  };
  switch (geometry.type) {
    case "line":
    case "arrow": {
      // Anchored at the tail, which stays where it was drawn.
      const head = place(geometry.to);
      const aimed = aimAlongGuides(Vec.of(geometry.from.x, geometry.from.y), Vec.of(head.x, head.y), pixelSize);
      return { ...geometry, to: { x: aimed.x, y: aimed.y } };
    }
    case "polygon":
      return { type: "polygon", corners: geometry.corners.map(place) };
    case "ellipse":
      return {
        ...geometry,
        rx: geometry.rx * scale,
        ry: geometry.ry * scale,
        rotation: geometry.rx === geometry.ry ? 0 : geometry.rotation + turn,
      };
  }
}

