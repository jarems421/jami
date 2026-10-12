import { inkBoxUnion, inkItemBounds, inkItemLayer, type InkBox, type InkItem } from "@/lib/ink/model";
import { browserPathFactory, InkDrawableCache, paintInkItems, setInkDeviceTransform } from "@/lib/ink-dom/rasterizer";

/**
 * The most pixels a ghost is painted at: a bigger selection is painted
 * coarser while it moves, rather than holding a canvas the size of the page
 * at full zoom, which an iPad may not have the memory for.
 */
const MAX_GHOST_PIXELS = 4_000_000;
/** Device pixels left round the ink, so the edges of its anti-aliasing are not cut off. */
const MARGIN_PX = 2;

/**
 * Ink the lasso picked up, painted once onto a canvas of its own so a drag can
 * carry it about with a CSS transform: nothing is drawn again while it moves,
 * where moving the ink itself repainted every tile it crossed, every frame.
 * Highlighter under pen, as on the page. `unitPx` is device pixels per page
 * unit. `box` is where the canvas sits, in page units. Null for nothing to
 * paint.
 */
export function paintInkGhost(items: readonly InkItem[], unitPx: number): { canvas: HTMLCanvasElement; box: InkBox } | null {
  let bounds: InkBox | null = null;
  for (const item of items) {
    const box = inkItemBounds(item);
    if (box.maxX < box.minX) continue;
    bounds = bounds ? inkBoxUnion(bounds, box) : box;
  }
  if (!bounds || !(unitPx > 0)) return null;
  const margin = MARGIN_PX / unitPx;
  const width = bounds.maxX - bounds.minX + margin * 2;
  const height = bounds.maxY - bounds.minY + margin * 2;
  const scale = Math.min(unitPx, Math.sqrt(MAX_GHOST_PIXELS / Math.max(1, width * height)));
  // A whole-pixel origin, as the page's own tiles have.
  const left = Math.floor((bounds.minX - margin) * scale);
  const top = Math.floor((bounds.minY - margin) * scale);
  const right = Math.max(left + 1, Math.ceil((bounds.maxX + margin) * scale));
  const bottom = Math.max(top + 1, Math.ceil((bounds.maxY + margin) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = right - left;
  canvas.height = bottom - top;
  const context = canvas.getContext("2d");
  if (!context) return null;
  setInkDeviceTransform(context, scale, left, top);
  const drawables = new InkDrawableCache(browserPathFactory);
  paintInkItems(context, items.filter((item) => inkItemLayer(item) === "highlighter"), drawables);
  paintInkItems(context, items.filter((item) => inkItemLayer(item) === "pen"), drawables);
  return { canvas, box: { minX: left / scale, minY: top / scale, maxX: right / scale, maxY: bottom / scale } };
}

/** Lets go of a ghost's pixels at once: Safari otherwise holds a canvas's memory until it is collected. */
export function dropInkGhost(canvas: HTMLCanvasElement): void {
  canvas.remove();
  canvas.width = 0;
  canvas.height = 0;
}
