// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { InkPoint, InkShapeGeometry } from "@/lib/ink/model";
import { adjustInkShape, recognizeInkShape, type InkRecognizedShape } from "@/lib/ink/tools/shape-recognition";

/**
 * Shapes as a hand draws them: a sample every few units, a tremor on each, a
 * slow wobble, corners rounded off, and an end that stops short of the start
 * or runs past it. Page units at a zoom of one.
 */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

type Hand = { seed?: number; tremor?: number; wobble?: number; end?: number; count?: number };

/** A closed outline `at(t)` for t from 0 to 1, drawn once round, from `0` to `end`. */
function drawn(at: (t: number) => InkPoint, { seed = 3, tremor = 0.6, wobble = 0.02, end = 0.96, count = 160 }: Hand = {}) {
  const random = seeded(seed);
  const centre = at(0.5);
  return Array.from({ length: count }, (_, index) => {
    const t = (index / (count - 1)) * end;
    const point = at(t % 1);
    // A slow swell in and out, the way a circle drawn freehand is never quite round.
    const swell = 1 + wobble * Math.sin(t * 2 * Math.PI * 3 + 1);
    const base = { x: centre.x + (point.x - centre.x) * swell, y: centre.y + (point.y - centre.y) * swell };
    return { x: base.x + random() * 2 * tremor, y: base.y + random() * 2 * tremor };
  });
}

const ellipseAt = (cx: number, cy: number, rx: number, ry: number, rotation = 0) => (t: number) => {
  const angle = t * 2 * Math.PI;
  const u = rx * Math.cos(angle);
  const v = ry * Math.sin(angle);
  return {
    x: cx + u * Math.cos(rotation) - v * Math.sin(rotation),
    y: cy + u * Math.sin(rotation) + v * Math.cos(rotation),
  };
};

/** Round the corners of a polygon, `rounding` of each side's length either side of a corner. */
function polygonAt(corners: InkPoint[], rounding = 0.1) {
  const sides = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]] as const);
  const lengths = sides.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const point = (t: number): InkPoint => {
    let left = (((t % 1) + 1) % 1) * total;
    for (let index = 0; index < sides.length; index += 1) {
      if (left <= lengths[index]) {
        const [a, b] = sides[index];
        const share = left / lengths[index];
        return { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share };
      }
      left -= lengths[index];
    }
    return corners[0];
  };
  // Rounded by averaging along the outline, which is what a hand turning a corner does.
  const window = (rounding * total) / corners.length;
  return (t: number) => {
    let x = 0;
    let y = 0;
    const steps = 9;
    for (let step = 0; step < steps; step += 1) {
      const p = point(t + ((step / (steps - 1) - 0.5) * window) / total);
      x += p.x / steps;
      y += p.y / steps;
    }
    return { x, y };
  };
}

const rotated = (points: InkPoint[], angle: number, about: InkPoint) =>
  points.map((p) => ({
    x: about.x + (p.x - about.x) * Math.cos(angle) - (p.y - about.y) * Math.sin(angle),
    y: about.y + (p.x - about.x) * Math.sin(angle) + (p.y - about.y) * Math.cos(angle),
  }));

const OPTIONS = { width: 3, pixelSize: 1 };
const degrees = (radians: number) => (radians * 180) / Math.PI;

function recognise(points: InkPoint[]) {
  return recognizeInkShape(points, OPTIONS);
}

function polygonOf(shape: InkRecognizedShape | null) {
  expect(shape?.geometry.type).toBe("polygon");
  return (shape!.geometry as Extract<InkShapeGeometry, { type: "polygon" }>).corners;
}

function ellipseOf(shape: InkRecognizedShape | null) {
  expect(shape?.geometry.type).toBe("ellipse");
  return shape!.geometry as Extract<InkShapeGeometry, { type: "ellipse" }>;
}

const sideLengths = (corners: InkPoint[]) =>
  corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    return Math.hypot(next.x - corner.x, next.y - corner.y);
  });

describe("recognising a held stroke", () => {
  it("makes a freehand circle round, about where it was drawn", () => {
    const circle = ellipseOf(recognise(drawn(ellipseAt(300, 300, 80, 80))));
    expect(circle.rx).toBe(circle.ry);
    expect(circle.rx).toBeCloseTo(80, -1);
    expect(Math.hypot(circle.cx - 300, circle.cy - 300)).toBeLessThan(4);
  });

  it("keeps an oval an oval, upright when it was nearly upright, and tilted when it was tilted", () => {
    const upright = ellipseOf(recognise(drawn(ellipseAt(300, 300, 130, 60, (4 * Math.PI) / 180))));
    expect(upright.rotation).toBe(0);
    expect(upright.rx / upright.ry).toBeGreaterThan(1.8);

    const tilted = ellipseOf(recognise(drawn(ellipseAt(300, 300, 130, 60, Math.PI / 6), { seed: 9 })));
    expect(Math.abs(degrees(tilted.rotation) - 30)).toBeLessThan(5);
  });

  it("closes a circle drawn past its start, and one stopped a little short of it", () => {
    expect(recognise(drawn(ellipseAt(300, 300, 70, 70), { end: 1.12 }))?.geometry.type).toBe("ellipse");
    expect(recognise(drawn(ellipseAt(300, 300, 70, 70), { end: 0.9 }))?.geometry.type).toBe("ellipse");
  });

  it("squares a rough square, level", () => {
    const square = [
      { x: 200, y: 200 },
      { x: 360, y: 205 },
      { x: 355, y: 362 },
      { x: 198, y: 358 },
    ];
    const corners = polygonOf(recognise(drawn(polygonAt(square), { wobble: 0.01 })));
    expect(corners).toHaveLength(4);
    const lengths = sideLengths(corners);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(0.5);
    // Level: the first side flat or upright.
    const angle = Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x);
    expect(Math.abs(Math.sin(2 * angle))).toBeLessThan(1e-9);
  });

  it("finds four corners whether the square was closed short of its first corner, past it, or from mid-side", () => {
    const square = [
      { x: 200, y: 200 },
      { x: 360, y: 200 },
      { x: 360, y: 360 },
      { x: 200, y: 360 },
    ];
    const near = (corners: InkPoint[]) =>
      square.every((corner) => corners.some((found) => Math.hypot(found.x - corner.x, found.y - corner.y) < 12));
    const short = polygonOf(recognise(drawn(polygonAt(square), { end: 0.93, wobble: 0.01 })));
    expect(short).toHaveLength(4);
    expect(near(short)).toBe(true);
    const past = polygonOf(recognise(drawn(polygonAt(square), { end: 1.08, wobble: 0.01, seed: 4 })));
    expect(past).toHaveLength(4);
    expect(near(past)).toBe(true);
    const midSide = polygonOf(
      recognise(drawn((t) => polygonAt(square)(t + 0.125), { end: 0.94, wobble: 0.01, seed: 6 }))
    );
    expect(midSide).toHaveLength(4);
    expect(near(midSide)).toBe(true);
  });

  it("keeps a tilted rectangle tilted, with square corners and its own proportions", () => {
    const rectangle = rotated(
      [
        { x: 160, y: 240 },
        { x: 400, y: 240 },
        { x: 400, y: 360 },
        { x: 160, y: 360 },
      ],
      Math.PI / 7,
      { x: 280, y: 300 }
    );
    const corners = polygonOf(recognise(drawn(polygonAt(rectangle), { wobble: 0.01, seed: 5 })));
    const [a, b, c] = sideLengths(corners);
    expect(Math.max(a, b) / Math.min(a, b)).toBeGreaterThan(1.7);
    expect(Math.abs(a - c)).toBeLessThan(0.5);
    const angle = Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x);
    expect(Math.abs(Math.sin(2 * angle))).toBeGreaterThan(0.3);
  });

  it("makes a near-equilateral triangle equilateral, its base flat", () => {
    const triangle = [
      { x: 300, y: 160 },
      { x: 392, y: 322 },
      { x: 206, y: 318 },
    ];
    const corners = polygonOf(recognise(drawn(polygonAt(triangle, 0.06), { wobble: 0.01 })));
    expect(corners).toHaveLength(3);
    const lengths = sideLengths(corners);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(0.5);
    const flat = corners.some((corner, index) => {
      const next = corners[(index + 1) % 3];
      return Math.abs(next.y - corner.y) < 1e-6;
    });
    expect(flat).toBe(true);
  });

  it("keeps a right-angled triangle's own shape", () => {
    const triangle = [
      { x: 200, y: 200 },
      { x: 200, y: 380 },
      { x: 420, y: 380 },
    ];
    const corners = polygonOf(recognise(drawn(polygonAt(triangle, 0.06), { wobble: 0.01, seed: 11 })));
    const lengths = sideLengths(corners).sort((p, q) => p - q);
    expect(lengths[2] / lengths[0]).toBeGreaterThan(1.4);
  });

  it("finds the six corners of a hexagon rather than calling it a circle", () => {
    const hexagon = Array.from({ length: 6 }, (_, index) => ({
      x: 300 + 110 * Math.cos((index * Math.PI) / 3),
      y: 300 + 110 * Math.sin((index * Math.PI) / 3),
    }));
    expect(polygonOf(recognise(drawn(polygonAt(hexagon, 0.05), { wobble: 0.005 })))).toHaveLength(6);
  });

  it("sees an arrow drawn in one stroke, shaft then head", () => {
    const tip = { x: 420, y: 300 };
    const stroke = [
      ...Array.from({ length: 60 }, (_, index) => ({ x: 120 + index * 5, y: 300 + Math.sin(index / 6) * 1.2 })),
      ...Array.from({ length: 12 }, (_, index) => ({ x: tip.x - index * 3.4, y: tip.y - index * 2.6 })),
      ...Array.from({ length: 12 }, (_, index) => ({ x: tip.x - 40.8 + index * 3.4, y: tip.y - 31.2 + index * 2.6 })),
      ...Array.from({ length: 12 }, (_, index) => ({ x: tip.x - index * 3.4, y: tip.y + index * 2.6 })),
    ];
    const shape = recognise(stroke);
    expect(shape?.geometry.type).toBe("arrow");
    const arrow = shape!.geometry as Extract<InkShapeGeometry, { from: InkPoint }>;
    expect(arrow.from).toEqual(stroke[0]);
    expect(Math.hypot(arrow.to.x - tip.x, arrow.to.y - tip.y)).toBeLessThan(6);
  });

  describe("leaves as drawn", () => {
    it("a small 'o', which is a letter", () => {
      expect(recognise(drawn(ellipseAt(300, 300, 9, 11)))).toBeNull();
    });

    it("an open curve, a 'C' with a wide gap, a wave and a zigzag", () => {
      const curve = Array.from({ length: 80 }, (_, index) => ({ x: 200 + index * 3, y: 300 - Math.sin((index / 79) * Math.PI) * 90 }));
      const wave = Array.from({ length: 100 }, (_, index) => ({ x: 100 + index * 4, y: 300 + Math.sin(index / 8) * 30 }));
      const zigzag = Array.from({ length: 100 }, (_, index) => ({ x: 100 + index * 4, y: 300 + ((index % 20) < 10 ? index % 20 : 20 - (index % 20)) * 6 }));
      expect(recognise(curve)).toBeNull();
      expect(recognise(drawn(ellipseAt(300, 300, 80, 80), { end: 0.72 }))).toBeNull();
      expect(recognise(wave)).toBeNull();
      expect(recognise(zigzag)).toBeNull();
    });

    it("a figure of eight, even one started at its crossing, which is back at its start halfway", () => {
      const eight = (shift: number) => (t: number) => ({
        x: 300 + 80 * Math.sin(2 * Math.PI * (t + shift)),
        y: 300 + 60 * Math.sin(4 * Math.PI * (t + shift)),
      });
      expect(recognise(drawn(eight(0), { end: 1 }))).toBeNull();
      expect(recognise(drawn(eight(0.25), { end: 1 }))).toBeNull();
    });

    it("a loop too lumpy to be any shape", () => {
      const blob = drawn(ellipseAt(300, 300, 90, 90), { wobble: 0.22 });
      expect(recognise(blob)).toBeNull();
    });
  });
});

describe("adjusting a snapped shape while the pen stays down", () => {
  const circle: InkRecognizedShape = {
    geometry: { type: "ellipse", cx: 300, cy: 300, rx: 80, ry: 80, rotation: 0 },
    anchor: { x: 300, y: 300 },
  };

  it("grows and shrinks with the pen, about its middle", () => {
    const grown = adjustInkShape(circle, { x: 380, y: 300 }, { x: 420, y: 300 }, 0.6);
    expect(grown).toMatchObject({ cx: 300, cy: 300, rx: 120, ry: 120 });
  });

  it("does not tilt for a hand drifting, but turns when it is turned", () => {
    const rectangle: InkRecognizedShape = {
      geometry: {
        type: "polygon",
        corners: [
          { x: 200, y: 250 },
          { x: 400, y: 250 },
          { x: 400, y: 350 },
          { x: 200, y: 350 },
        ],
      },
      anchor: { x: 300, y: 300 },
    };
    const drift = adjustInkShape(rectangle, { x: 400, y: 350 }, { x: 398, y: 355 }, 0.6);
    expect(drift.type === "polygon" && drift.corners[0].y === drift.corners[1].y).toBe(true);

    const turned = adjustInkShape(rectangle, { x: 400, y: 350 }, { x: 350, y: 400 }, 0.6);
    expect(turned.type === "polygon" && Math.abs(turned.corners[0].y - turned.corners[1].y) > 10).toBe(true);
  });

  it("follows a turn smoothly once it is past drift, never jumping", () => {
    const square: InkRecognizedShape = {
      geometry: { type: "polygon", corners: [{ x: 250, y: 250 }, { x: 350, y: 250 }, { x: 350, y: 350 }, { x: 250, y: 350 }] },
      anchor: { x: 300, y: 300 },
    };
    const tiltAt = (degrees: number) => {
      const angle = (degrees * Math.PI) / 180;
      // The pen swung round the middle from the corner it snapped at.
      const pen = { x: 300 + 50 * Math.cos(angle) - 50 * Math.sin(angle), y: 300 + 50 * Math.sin(angle) + 50 * Math.cos(angle) };
      const turned = adjustInkShape(square, { x: 350, y: 350 }, pen, 0.6);
      if (turned.type !== "polygon") throw new Error("expected a polygon");
      return (Math.atan2(turned.corners[1].y - turned.corners[0].y, turned.corners[1].x - turned.corners[0].x) * 180) / Math.PI;
    };
    expect(tiltAt(2.9)).toBe(0);
    expect(tiltAt(10)).toBeCloseTo(10, 6);
    expect(tiltAt(30)).toBeCloseTo(30, 6);
    let previous = tiltAt(0);
    for (let degrees = 0.25; degrees <= 14; degrees += 0.25) {
      const tilt = tiltAt(degrees);
      expect(tilt).toBeGreaterThanOrEqual(previous);
      expect(tilt - previous).toBeLessThan(0.6);
      previous = tilt;
    }
  });

  it("aims an arrow from its tail, leaning to the nearest 45 degrees", () => {
    const arrow: InkRecognizedShape = {
      geometry: { type: "arrow", from: { x: 100, y: 300 }, to: { x: 400, y: 300 } },
      anchor: { x: 100, y: 300 },
    };
    // Swung a degree or two off flat: it settles flat.
    const aimed = adjustInkShape(arrow, { x: 400, y: 300 }, { x: 420, y: 309 }, 0.6);
    expect(aimed.type).toBe("arrow");
    if (aimed.type !== "arrow") return;
    expect(aimed.from).toEqual({ x: 100, y: 300 });
    expect(Math.abs(aimed.to.y - 300)).toBeLessThan(1);
    expect(aimed.to.x).toBeGreaterThan(400);
  });
});
