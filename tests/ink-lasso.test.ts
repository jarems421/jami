import { describe, expect, it } from "vitest";
import type { InkItem, InkOutlineItem, InkShapeItem } from "@/lib/ink/model";
import {
  applyInkLassoTransform,
  identityInkLassoTransform,
  inkItemsInLoop,
  isInsideInkLoop,
  recolourInkItem,
  thickenInkItem,
  transformInkItem,
} from "@/lib/ink/tools/lasso";
import {
  lassoBoxFrame,
  lassoImageFrame,
  lassoPlacedBox,
  sameLassoFrame,
  transformLassoGraph,
  transformLassoImage,
  transformLassoText,
} from "@/lib/workspace/notebook-lasso";
import { normalizeNotebookImageRefs } from "@/lib/workspace/notebooks";
import { normalizeNotebookGraphBlocks } from "@/lib/workspace/notebook-graphs";

const black = { r: 17, g: 24, b: 39, a: 1 };
const red = { r: 220, g: 38, b: 38, a: 1 };

const stroke = (id: string, x: number, y: number): InkOutlineItem => ({
  kind: "outline",
  id,
  layer: "pen",
  path: [
    { op: "M", x, y },
    { op: "L", x: x + 40, y },
    { op: "L", x: x + 40, y: y + 20 },
  ],
  paint: { fill: null, stroke: { color: black, width: 3, cap: "round", join: "round" }, opacity: 1 },
});
const square = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 200 },
  { x: 0, y: 200 },
];

describe("what a lasso loop picks up", () => {
  it("knows inside from outside", () => {
    expect(isInsideInkLoop(square, { x: 100, y: 100 })).toBe(true);
    expect(isInsideInkLoop(square, { x: 250, y: 100 })).toBe(false);
  });

  it("takes ink mostly inside it, and leaves ink it only clips", () => {
    const doc = { version: 3 as const, items: [stroke("in", 50, 50), stroke("half", 180, 50), stroke("out", 400, 400)] as InkItem[] };
    expect(inkItemsInLoop(doc, square)).toEqual(["in"]);
  });
});

describe("moving, resizing and turning ink", () => {
  it("carries, scales and turns a point about the middle of the selection", () => {
    const transform = { ...identityInkLassoTransform(100, 100), dx: 10, scale: 2, rotation: Math.PI / 2 };
    const moved = applyInkLassoTransform(transform, { x: 110, y: 100 });
    expect(moved.x).toBeCloseTo(110);
    expect(moved.y).toBeCloseTo(120);
  });

  it("keeps an item's id, scales a stroked line's width, and turns a circle as a circle", () => {
    const transform = { ...identityInkLassoTransform(0, 0), scale: 2, rotation: 0.3 };
    const moved = transformInkItem(stroke("a", 10, 10), transform);
    expect(moved.id).toBe("a");
    expect(moved.kind === "outline" && moved.paint.stroke?.width).toBe(6);
    const circle: InkShapeItem = {
      kind: "shape",
      id: "c",
      layer: "pen",
      color: black,
      width: 2,
      shape: { type: "ellipse", cx: 10, cy: 0, rx: 5, ry: 5, rotation: 0 },
    };
    const turned = transformInkItem(circle, transform) as InkShapeItem;
    expect(turned.width).toBe(4);
    expect(turned.shape).toMatchObject({ type: "ellipse", rx: 10, ry: 10, rotation: 0.3 });
  });
});

describe("restyling ink", () => {
  it("recolours, keeping a highlighter see-through", () => {
    const highlight: InkOutlineItem = { ...stroke("h", 0, 0), layer: "highlighter", paint: { fill: { ...black, a: 0.4 }, stroke: null, opacity: 1 } };
    const recoloured = recolourInkItem(highlight, red) as InkOutlineItem;
    expect(recoloured.paint.fill).toEqual({ ...red, a: 0.4 });
  });

  it("thickens a stroked line, traces round a tapered one and thins it back, and leaves the highlighter", () => {
    expect((thickenInkItem(stroke("s", 0, 0), 1) as InkOutlineItem).paint.stroke?.width).toBeCloseTo(4.2);
    const tapered: InkOutlineItem = { ...stroke("t", 0, 0), paint: { fill: black, stroke: null, opacity: 1 } };
    const thicker = thickenInkItem(tapered, 1) as InkOutlineItem;
    expect(thicker.paint.stroke).toMatchObject({ color: black, width: 1.2 });
    expect((thickenInkItem(thicker, -1) as InkOutlineItem).paint.stroke).toBeNull();
    const highlight: InkOutlineItem = { ...tapered, layer: "highlighter" };
    expect(thickenInkItem(highlight, 1)).toBe(highlight);
  });
});

describe("what the lasso does to things placed on the page", () => {
  const transform = { ...identityInkLassoTransform(100, 100), dx: 50, scale: 2, rotation: Math.PI / 6 };

  it("turns an image and a graph about their middles, and keeps the turn through saving", () => {
    const image = transformLassoImage({ id: "i", x: 80, y: 80, displayWidth: 40, displayHeight: 40 }, transform);
    expect(image).toMatchObject({ displayWidth: 80, displayHeight: 80, x: 110, y: 60 });
    expect(image.rotation).toBeCloseTo(Math.PI / 6);
    expect(normalizeNotebookImageRefs([image])[0].rotation).toBeCloseTo(Math.PI / 6);

    const graph = transformLassoGraph(normalizeNotebookGraphBlocks([{ id: "g", x: 80, y: 80, width: 300, height: 260 }])[0], transform);
    expect(graph.rotation).toBeCloseTo(Math.PI / 6);
    expect(normalizeNotebookGraphBlocks([graph])[0].rotation).toBeCloseTo(Math.PI / 6);
  });

  it("keeps a text box upright", () => {
    const text = transformLassoText(
      { id: "t", x: 80, y: 80, width: 40, height: 40, text: "x", outlineVisible: false },
      transform
    );
    expect(text).toMatchObject({ width: 80, height: 80 });
    expect("rotation" in text).toBe(false);
  });

  it("reads the corners of a turned image for the box round a selection", () => {
    const corners = lassoPlacedBox(lassoImageFrame({ id: "i", x: 0, y: 0, displayWidth: 100, displayHeight: 100, rotation: Math.PI / 4 }));
    expect(Math.min(...corners.map((corner) => corner.y))).toBeCloseTo(50 - 50 * Math.SQRT2);
    expect(lassoBoxFrame({ id: "t", x: 1, y: 2, width: 3, height: 4, text: "", outlineVisible: false }).rotation).toBe(0);
  });

  it("tells whether something placed is still where the lasso left it", () => {
    const image = { id: "i", x: 80, y: 80, displayWidth: 40, displayHeight: 40 };
    const left = lassoImageFrame(transformLassoImage(image, transform));
    // The same move made again, and read back through a save's rounding.
    expect(sameLassoFrame(left, lassoImageFrame(transformLassoImage(image, transform)))).toBe(true);
    expect(sameLassoFrame(left, { ...left, x: left.x + 1e-9 })).toBe(true);
    // Moved since, or gone.
    expect(sameLassoFrame(left, { ...left, x: left.x + 1 })).toBe(false);
    expect(sameLassoFrame(left, { ...left, rotation: 0 })).toBe(false);
    expect(sameLassoFrame(left, null)).toBe(false);
  });
});
