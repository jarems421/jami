/**
 * Whether the item committed at a lift is exactly the stroke live ink last
 * drew. Only then may the lift hand the live tiles to the dry layer (see
 * `InkTileStore.adopt`); anything else (a highlighter traced into one outline
 * at the lift, a path rounded by the codec) is painted afresh. DOM-free.
 */

import { inkColorsEqual } from "@/lib/ink/color";
import type { InkColor, InkItem, InkLayer, InkPaint, InkPathCommand } from "@/lib/ink/model";
import { sameInkPath } from "@/lib/ink/path-change";
import { inkShapePaint, inkShapePath } from "@/lib/ink/shapes";

function sameColor(a: InkColor | null, b: InkColor | null): boolean {
  return a === b || (a !== null && b !== null && inkColorsEqual(a, b));
}

export function sameInkPaint(a: InkPaint, b: InkPaint): boolean {
  if (a === b) return true;
  if (a.opacity !== b.opacity || !sameColor(a.fill, b.fill)) return false;
  const left = a.stroke;
  const right = b.stroke;
  if (!left || !right) return left === right;
  return (
    left.width === right.width &&
    left.cap === right.cap &&
    left.join === right.join &&
    sameColor(left.color, right.color)
  );
}

/**
 * Whether `item` is the live stroke as last drawn on `layer`: an outline drawn
 * with its own path and paint, or a stroke snapped to a shape on a hold, which
 * live ink drew as the shape's own path and paint.
 */
export function isInkLiveStroke(
  item: InkItem,
  layer: InkLayer,
  live: { commands: readonly InkPathCommand[]; paint: InkPaint }
): boolean {
  if (item.kind === "unknown" || item.layer !== layer) return false;
  return item.kind === "outline"
    ? sameInkPaint(item.paint, live.paint) && sameInkPath(item.path, live.commands)
    : sameInkPaint(inkShapePaint(item), live.paint) && sameInkPath(inkShapePath(item.shape, item.width), live.commands);
}
