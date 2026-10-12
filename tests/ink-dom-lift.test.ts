import { describe, expect, it } from "vitest";
import type { InkItem, InkPaint, InkPathCommand } from "@/lib/ink/model";
import { inkShapePath } from "@/lib/ink/shapes";
import { isInkLiveStroke, sameInkPaint } from "@/lib/ink-dom/lift";

const black = { r: 17, g: 24, b: 39, a: 1 };
const fill: InkPaint = { fill: black, stroke: null, opacity: 1 };
const stroke: InkPaint = { fill: null, stroke: { color: black, width: 3, cap: "round", join: "round" }, opacity: 1 };
const path: InkPathCommand[] = [
  { op: "M", x: 0, y: 0 },
  { op: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 },
];

const outline = (overrides: Partial<Extract<InkItem, { kind: "outline" }>> = {}): InkItem => ({
  kind: "outline",
  id: "a",
  layer: "pen",
  path,
  paint: fill,
  ...overrides,
});

describe("sameInkPaint", () => {
  it("compares colours at 8-bit alpha, widths, caps and joins", () => {
    expect(sameInkPaint(fill, { ...fill })).toBe(true);
    expect(sameInkPaint(fill, { ...fill, fill: { ...black, a: 0.9999 } })).toBe(true);
    expect(sameInkPaint(fill, { ...fill, fill: { ...black, r: 18 } })).toBe(false);
    expect(sameInkPaint(fill, stroke)).toBe(false);
    expect(sameInkPaint(stroke, { ...stroke, stroke: { ...stroke.stroke!, width: 3.5 } })).toBe(false);
    expect(sameInkPaint(stroke, { ...stroke, stroke: { ...stroke.stroke!, join: "miter" } })).toBe(false);
    expect(sameInkPaint(fill, { ...fill, opacity: 0.5 })).toBe(false);
  });
});

describe("isInkLiveStroke", () => {
  const live = { commands: path, paint: fill };

  it("accepts the live geometry itself, or an equal copy of it", () => {
    expect(isInkLiveStroke(outline(), "pen", live)).toBe(true);
    expect(isInkLiveStroke(outline({ path: path.map((command) => ({ ...command })), paint: { ...fill } }), "pen", live)).toBe(
      true
    );
  });

  it("accepts a stroke snapped to a shape, which live ink drew as the shape's own path and paint", () => {
    const shape: InkItem = {
      kind: "shape",
      id: "s",
      layer: "pen",
      color: black,
      width: 3,
      shape: { type: "polygon", corners: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }] },
    };
    if (shape.kind !== "shape") return;
    const drawn = { commands: inkShapePath(shape.shape, 3), paint: stroke };
    expect(isInkLiveStroke(shape, "pen", drawn)).toBe(true);
    expect(isInkLiveStroke({ ...shape, width: 3.5 }, "pen", drawn)).toBe(false);
    expect(isInkLiveStroke(shape, "highlighter", drawn)).toBe(false);
  });

  it("refuses anything that would not draw the same pixels", () => {
    expect(isInkLiveStroke(outline({ layer: "highlighter" }), "pen", live)).toBe(false);
    expect(isInkLiveStroke(outline({ paint: stroke }), "pen", live)).toBe(false);
    expect(isInkLiveStroke(outline({ path: [...path, { op: "Z" }] }), "pen", live)).toBe(false);
    const shape: InkItem = {
      kind: "shape",
      id: "s",
      layer: "pen",
      color: black,
      width: 3,
      shape: { type: "line", from: { x: 0, y: 0 }, to: { x: 5, y: 6 } },
    };
    expect(isInkLiveStroke(shape, "pen", live)).toBe(false);
  });
});
