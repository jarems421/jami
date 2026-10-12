/**
 * What the lasso does to the things placed on a page alongside the ink:
 * images, graphs and text boxes. Each keeps its own shape: carried with its
 * middle, scaled by the lasso's scale, and turned by its turn -- except a text
 * box, which stays upright so it can still be read and typed into.
 */

import type { InkPoint } from "@/lib/ink/model";
import { applyInkLassoTransform, type InkLassoTransform } from "@/lib/ink/tools/lasso";
import type { NotebookGraphBlock } from "@/lib/workspace/notebook-graphs";
import { placedRotation } from "@/lib/workspace/notebook-placed-rotation";
import type { NotebookImageRef, NotebookTextBlock } from "@/lib/workspace/notebooks";

export type LassoBox = { minX: number; minY: number; maxX: number; maxY: number };

export type LassoFrame = { x: number; y: number; width: number; height: number; rotation: number };

/** Nothing placed is made smaller than this across, in page units. */
const SMALLEST = 24;

/** Where an image sits, as a frame. */
export function lassoImageFrame(image: NotebookImageRef): LassoFrame {
  return {
    x: image.x ?? 0,
    y: image.y ?? 0,
    width: image.displayWidth ?? 0,
    height: image.displayHeight ?? 0,
    rotation: image.rotation ?? 0,
  };
}

/** Where a graph or a text box sits, as a frame. Text boxes never turn. */
export function lassoBoxFrame(box: NotebookGraphBlock | NotebookTextBlock): LassoFrame {
  return { x: box.x, y: box.y, width: box.width, height: box.height, rotation: "rotation" in box ? (box.rotation ?? 0) : 0 };
}

/** The four corners of something placed, turned as it is drawn. */
export function lassoPlacedBox(frame: LassoFrame): InkPoint[] {
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) => {
    const ox = (u * frame.width) / 2;
    const oy = (v * frame.height) / 2;
    return { x: cx + ox * cos - oy * sin, y: cy + ox * sin + oy * cos };
  });
}

function moved(frame: LassoFrame, transform: InkLassoTransform) {
  const centre = applyInkLassoTransform(transform, { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
  const width = Math.max(SMALLEST, frame.width * transform.scale);
  const height = Math.max(SMALLEST, frame.height * transform.scale);
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

export function transformLassoImage(image: NotebookImageRef, transform: InkLassoTransform): NotebookImageRef {
  const frame = lassoImageFrame(image);
  const next = moved(frame, transform);
  const { rotation: _rotation, ...rest } = image;
  void _rotation;
  return {
    ...rest,
    x: next.x,
    y: next.y,
    displayWidth: next.width,
    displayHeight: next.height,
    ...placedRotation(frame.rotation + transform.rotation),
  };
}

export function transformLassoGraph(graph: NotebookGraphBlock, transform: InkLassoTransform): NotebookGraphBlock {
  const frame = lassoBoxFrame(graph);
  const next = moved(frame, transform);
  const { rotation: _rotation, ...rest } = graph;
  void _rotation;
  return { ...rest, ...next, ...placedRotation(frame.rotation + transform.rotation) };
}

/** A text box goes where its middle is carried and takes the scale, but never turns. */
export function transformLassoText(text: NotebookTextBlock, transform: InkLassoTransform): NotebookTextBlock {
  return { ...text, ...moved(lassoBoxFrame(text), transform) };
}
