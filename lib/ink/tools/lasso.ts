/**
 * The lasso: what a loop drawn round part of the page picks up, and the moves,
 * resizes, turns and restyles made to it. Pure and DOM-free.
 *
 * A move, a resize and a turn are one transform, about the middle of what was
 * picked up (`InkLassoTransform`): carried by `dx, dy`, scaled by `scale` the
 * same both ways, and turned by `rotation`. Uniform scaling keeps every circle
 * a circle and every stroke the weight it was drawn at relative to its size.
 */

import type { InkColor, InkDocument, InkItem, InkPathCommand, InkPoint, InkShapeGeometry } from "@/lib/ink/model";
import { inkShapePath } from "@/lib/ink/shapes";

export type InkLassoTransform = {
  /** The middle of the selection before it moved, in page units. */
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
};

/** An ink item counts as picked up when at least this share of its points is inside the loop. */
const INSIDE_SHARE = 0.6;
/** How much a press of Thicker or Thinner adds to or takes from a stroke, in page units. */
const THICKNESS_STEP = 1.2;

export function identityInkLassoTransform(cx: number, cy: number): InkLassoTransform {
  return { cx, cy, dx: 0, dy: 0, scale: 1, rotation: 0 };
}

/** Whether `point` is inside the loop (even-odd, the loop closed back to its start). */
export function isInsideInkLoop(loop: readonly InkPoint[], point: InkPoint): boolean {
  let inside = false;
  for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index, index += 1) {
    const a = loop[index];
    const b = loop[previous];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pathPoints(path: readonly InkPathCommand[]): InkPoint[] {
  const points: InkPoint[] = [];
  for (const command of path) {
    if (command.op === "Z") continue;
    points.push({ x: command.x, y: command.y });
  }
  return points;
}

function itemPoints(item: InkItem): InkPoint[] {
  if (item.kind === "outline") return pathPoints(item.path);
  if (item.kind === "shape") return pathPoints(inkShapePath(item.shape, item.width));
  return [];
}

/** The ids of the ink the loop goes round: most of each item inside it. */
export function inkItemsInLoop(doc: InkDocument, loop: readonly InkPoint[]): string[] {
  if (loop.length < 3) return [];
  const ids: string[] = [];
  for (const item of doc.items) {
    const points = itemPoints(item);
    if (points.length === 0) continue;
    let inside = 0;
    for (const point of points) if (isInsideInkLoop(loop, point)) inside += 1;
    if (inside / points.length >= INSIDE_SHARE) ids.push(item.id);
  }
  return ids;
}

/** Where a point goes under the transform. */
export function applyInkLassoTransform(transform: InkLassoTransform, point: InkPoint): InkPoint {
  const ox = (point.x - transform.cx) * transform.scale;
  const oy = (point.y - transform.cy) * transform.scale;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.cx + transform.dx + ox * cos - oy * sin,
    y: transform.cy + transform.dy + ox * sin + oy * cos,
  };
}

function transformPath(path: readonly InkPathCommand[], move: (point: InkPoint) => InkPoint): InkPathCommand[] {
  return path.map((command): InkPathCommand => {
    switch (command.op) {
      case "Z":
        return command;
      case "M":
      case "L": {
        const to = move(command);
        return { op: command.op, x: to.x, y: to.y };
      }
      case "Q": {
        const control = move({ x: command.x1, y: command.y1 });
        const to = move(command);
        return { op: "Q", x1: control.x, y1: control.y, x: to.x, y: to.y };
      }
      case "C": {
        const first = move({ x: command.x1, y: command.y1 });
        const second = move({ x: command.x2, y: command.y2 });
        const to = move(command);
        return { op: "C", x1: first.x, y1: first.y, x2: second.x, y2: second.y, x: to.x, y: to.y };
      }
    }
  });
}

function transformShape(shape: InkShapeGeometry, transform: InkLassoTransform): InkShapeGeometry {
  const move = (point: InkPoint) => applyInkLassoTransform(transform, point);
  switch (shape.type) {
    case "line":
    case "arrow":
      return { type: shape.type, from: move(shape.from), to: move(shape.to) };
    case "polygon":
      return { type: "polygon", corners: shape.corners.map(move) };
    case "ellipse": {
      const centre = move({ x: shape.cx, y: shape.cy });
      return {
        type: "ellipse",
        cx: centre.x,
        cy: centre.y,
        rx: shape.rx * transform.scale,
        ry: shape.ry * transform.scale,
        rotation: shape.rotation + transform.rotation,
      };
    }
  }
}

/** The item moved, resized and turned. It keeps its id: it is the same ink, somewhere else. */
export function transformInkItem(item: InkItem, transform: InkLassoTransform): InkItem {
  const move = (point: InkPoint) => applyInkLassoTransform(transform, point);
  if (item.kind === "outline") {
    const stroke = item.paint.stroke;
    return {
      ...item,
      path: transformPath(item.path, move),
      paint: stroke ? { ...item.paint, stroke: { ...stroke, width: stroke.width * transform.scale } } : item.paint,
    };
  }
  if (item.kind === "shape") {
    return { ...item, shape: transformShape(item.shape, transform), width: item.width * transform.scale };
  }
  return item;
}

/** A colour's hue in place of another's, keeping how see-through it was: a highlighter stays a highlighter. */
const recolour = (from: InkColor, to: InkColor): InkColor => ({ ...to, a: from.a });

/** The item in a new colour. */
export function recolourInkItem(item: InkItem, color: InkColor): InkItem {
  if (item.kind === "outline") {
    const { fill, stroke } = item.paint;
    return {
      ...item,
      paint: {
        ...item.paint,
        fill: fill ? recolour(fill, color) : null,
        stroke: stroke ? { ...stroke, color: recolour(stroke.color, color) } : null,
      },
    };
  }
  if (item.kind === "shape") return { ...item, color: recolour(item.color, color) };
  return item;
}

/**
 * The item a step thicker (`direction` 1) or thinner (-1). A stroked line or a
 * shape changes its width. A tapered stroke is a filled outline, whose width
 * was drawn into its shape; it is thickened by tracing round that outline in
 * its own colour, and thinned only back to the outline it was drawn as. The
 * highlighter is left alone: tracing round see-through ink darkens its edge.
 */
export function thickenInkItem(item: InkItem, direction: 1 | -1): InkItem {
  if (item.kind === "shape") {
    return { ...item, width: Math.max(0.5, item.width + direction * THICKNESS_STEP) };
  }
  if (item.kind !== "outline" || item.layer !== "pen") return item;
  const { fill, stroke } = item.paint;
  if (!fill && stroke) {
    return { ...item, paint: { ...item.paint, stroke: { ...stroke, width: Math.max(0.5, stroke.width + direction * THICKNESS_STEP) } } };
  }
  if (!fill) return item;
  const traced = (stroke?.width ?? 0) + direction * THICKNESS_STEP;
  return {
    ...item,
    paint: {
      ...item.paint,
      stroke: traced > 0.01 ? { color: fill, width: traced, cap: "round", join: "round" } : null,
    },
  };
}

/** The box round some points, or null for none. */
export function boundsOfInkPoints(points: readonly InkPoint[]) {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Every point an ink item is drawn through, for the box round a selection. */
export function inkItemOutlinePoints(item: InkItem): InkPoint[] {
  return itemPoints(item);
}
