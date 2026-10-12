/**
 * The one routine that turns ink into pixels. Dry tiles and live ink both
 * draw through it, with the same path (built once, in page units) and the
 * same transform (device pixels per page unit, and a whole-pixel origin), so
 * the pixels a stroke has while it is written are the pixels it keeps once it
 * is lifted.
 *
 * It mirrors how js-draw's `CanvasRenderer` painted a path, because js-draw is
 * what students have been looking at:
 *
 * - fill first (when there is one), then stroke;
 * - strokes always round-capped and round-joined at the item's width;
 * - a closing `Z` is drawn as a line back to the subpath's start, as js-draw's
 *   own path type does;
 * - one path per item, so a translucent highlighter whose subpaths overlap is
 *   filled once and never darkens where they cross.
 *
 * Two deliberate differences, both in `docs/notebook-ink.md`: highlighter ink
 * is drawn under pen ink (the caller orders layers), and an item's `opacity`
 * (from old v1 pages) is honoured.
 */

import { formatInkColor } from "@/lib/ink/color";
import type { InkBox, InkItem, InkPaint, InkPathCommand } from "@/lib/ink/model";
import { inkShapePaint, inkShapePath } from "@/lib/ink/shapes";

/** The parts of a 2D context the rasteriser uses. */
export type InkContext2D = Pick<
  CanvasRenderingContext2D,
  | "setTransform"
  | "fill"
  | "stroke"
  | "clearRect"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "globalAlpha"
>;

/** The parts of `Path2D` the rasteriser uses. */
export type InkPath2D = Pick<Path2D, "moveTo" | "lineTo" | "bezierCurveTo" | "quadraticCurveTo">;

export type InkPathFactory = () => InkPath2D;

/** Builds a path in the browser's own `Path2D`. */
export const browserPathFactory: InkPathFactory = () => new Path2D();

export type InkBuiltPath = {
  path: InkPath2D;
  /**
   * The box around every point and control point: never smaller than the
   * drawn curve, and found in the same pass, for live ink's dirty region.
   * Null when the path has no points.
   */
  hull: InkBox | null;
};

/** Writes commands into a new path, noting the box around every point as it goes. */
export function buildInkPath(commands: readonly InkPathCommand[], factory: InkPathFactory): InkBuiltPath {
  const path = factory();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const note = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let startX = 0;
  let startY = 0;
  for (const command of commands) {
    switch (command.op) {
      case "M":
        path.moveTo(command.x, command.y);
        startX = command.x;
        startY = command.y;
        note(command.x, command.y);
        break;
      case "L":
        path.lineTo(command.x, command.y);
        note(command.x, command.y);
        break;
      case "C":
        path.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
        note(command.x1, command.y1);
        note(command.x2, command.y2);
        note(command.x, command.y);
        break;
      case "Q":
        path.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
        note(command.x1, command.y1);
        note(command.x, command.y);
        break;
      case "Z":
        path.lineTo(startX, startY);
        break;
    }
  }
  const hull = maxX >= minX ? { minX, minY, maxX, maxY } : null;
  return { path, hull };
}

/** How an item is painted: its path and paint, ready to draw. */
export type InkDrawable = { path: InkPath2D; paint: InkPaint };

/**
 * Paths for items, built once per item and kept for as long as the item is.
 * Items are immutable (see `model.ts`), so the object is the key.
 */
export class InkDrawableCache {
  private readonly cache = new WeakMap<InkItem, InkDrawable | null>();

  constructor(private readonly factory: InkPathFactory) {}

  get(item: InkItem): InkDrawable | null {
    if (this.cache.has(item)) return this.cache.get(item) ?? null;
    let drawable: InkDrawable | null = null;
    if (item.kind === "outline") {
      drawable = { path: buildInkPath(item.path, this.factory).path, paint: item.paint };
    } else if (item.kind === "shape") {
      drawable = { path: buildInkPath(inkShapePath(item.shape, item.width), this.factory).path, paint: inkShapePaint(item) };
    }
    this.cache.set(item, drawable);
    return drawable;
  }

  /**
   * Hands an item the path already built for it while it was live, so the
   * lift draws the very same path object rather than an equal one.
   */
  seed(item: InkItem, path: InkPath2D): void {
    if (item.kind === "outline") this.cache.set(item, { path, paint: item.paint });
    else if (item.kind === "shape") this.cache.set(item, { path, paint: inkShapePaint(item) });
  }
}

const colorStrings = new WeakMap<InkPaint, { fill: string | null; stroke: string | null }>();

function paintStrings(paint: InkPaint) {
  let strings = colorStrings.get(paint);
  if (!strings) {
    strings = {
      fill: paint.fill && paint.fill.a > 0 ? formatInkColor(paint.fill) : null,
      stroke: paint.stroke && paint.stroke.color.a > 0 ? formatInkColor(paint.stroke.color) : null,
    };
    colorStrings.set(paint, strings);
  }
  return strings;
}

/**
 * Points the context at a part of the sheet: page units in, device pixels
 * out, with (`originX`, `originY`), a whole sheet device pixel, at the
 * canvas's top-left corner.
 */
export function setInkDeviceTransform(ctx: InkContext2D, unitPx: number, originX: number, originY: number): void {
  ctx.setTransform(unitPx, 0, 0, unitPx, -originX, -originY);
}

/** Paints one path. The transform must already be set. */
export function paintInkPath(ctx: InkContext2D, path: InkPath2D, paint: InkPaint): void {
  if (!(paint.opacity > 0)) return;
  const strings = paintStrings(paint);
  if (!strings.fill && !strings.stroke) return;
  ctx.globalAlpha = Math.min(1, paint.opacity);
  if (strings.fill) {
    ctx.fillStyle = strings.fill;
    ctx.fill(path as Path2D);
  }
  if (strings.stroke && paint.stroke) {
    ctx.strokeStyle = strings.stroke;
    ctx.lineWidth = paint.stroke.width;
    ctx.lineCap = paint.stroke.cap;
    ctx.lineJoin = paint.stroke.join;
    ctx.stroke(path as Path2D);
  }
  ctx.globalAlpha = 1;
}

/** Paints items in the order given. The transform must already be set. */
export function paintInkItems(ctx: InkContext2D, items: readonly InkItem[], drawables: InkDrawableCache): void {
  for (const item of items) {
    const drawable = drawables.get(item);
    if (drawable) paintInkPath(ctx, drawable.path, drawable.paint);
  }
}
