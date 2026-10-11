// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createInkPenBuilder,
  type InkPenFeel,
  type InkPenSample,
} from "@/lib/ink/geometry/pen";
import { inkFlattenPath } from "@/lib/ink/flatten";
import type { InkPathCommand } from "@/lib/ink/model";

/**
 * The tapered outline (`pen-outline.ts`) against the shape a round nib leaves
 * along the same centreline: every point within its half width of the line is
 * ink, and nothing further out is. Filled with the nonzero rule, as the
 * renderer fills it. The centreline is the one the pen draws untapered, so this
 * judges the outline alone and not how the samples became a line.
 *
 * The strokes are the ones that came out malformed: a Pencil sliding back or
 * slipping sideways a pixel or two as it lands, hooking as it lifts, the point
 * of a 'v', and a retrace.
 */
const FEEL: InkPenFeel = {
  cornerDegrees: 40,
  easeTowardsNeighbours: 0.3,
  cornerDominance: 1.2,
  minimumWidthFraction: 0.35,
  pressureResponse: 1,
  snapToGuides: true,
};
const WIDTH = 8;
const RADIUS = WIDTH / 2;

type Point = { x: number; y: number };

/**
 * A pen moved through `corners` at one width, sampled every 4 ms: a unit a
 * sample along the way, slowing to a fifth of that into each turn, as a hand
 * does.
 */
function through(corners: Point[]): InkPenSample[] {
  const samples: InkPenSample[] = [{ ...corners[0], width: WIDTH, time: 0 }];
  for (let index = 1; index < corners.length; index += 1) {
    const from = corners[index - 1];
    const to = corners[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    let travelled = 0;
    while (travelled < length) {
      const fromEnd = Math.min(travelled, length - travelled);
      travelled = Math.min(length, travelled + Math.min(1, 0.2 + fromEnd * 0.2));
      samples.push({
        x: from.x + ((to.x - from.x) * travelled) / length,
        y: from.y + ((to.y - from.y) * travelled) / length,
        width: WIDTH,
        time: samples.length * 4,
      });
    }
  }
  return samples;
}

function draw(samples: InkPenSample[], tapered: boolean) {
  const pen = createInkPenBuilder(samples[0], { feel: FEEL, pixelSize: 1, tapered });
  for (const next of samples.slice(1)) pen.addPoint(next);
  return pen.geometry();
}

function outline(samples: InkPenSample[]): InkPathCommand[] {
  const { path, paint } = draw(samples, true);
  expect(paint).toEqual({ kind: "fill" });
  return path;
}

/** The line the same samples draw untapered, every twentieth of a unit. */
function centreline(samples: InkPenSample[]): Point[] {
  const { path, paint } = draw(samples, false);
  expect(paint).toEqual({ kind: "stroke", width: WIDTH });
  return inkFlattenPath(path, 0.01).flatMap((line) => line.points);
}

function winding(rings: Point[][], point: Point) {
  let total = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const side = (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
      if (a.y <= point.y) {
        if (b.y > point.y && side > 0) total += 1;
      } else if (b.y <= point.y && side < 0) {
        total -= 1;
      }
    }
  }
  return total;
}

function distanceToPath(point: Point, path: Point[]) {
  let best = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      : 0;
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}

/** Where the outline leaves out ink the nib laid, and where it lays ink the nib never reached. */
function againstTheNib(corners: Point[]) {
  const samples = through(corners);
  const rings = inkFlattenPath(outline(samples), 0.02).map((line) => line.points);
  const line = centreline(samples);
  const missing: Point[] = [];
  for (let index = 0; index < line.length; index += 5) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * 2 * Math.PI;
      const point = {
        x: line[index].x + Math.cos(angle) * RADIUS * 0.96,
        y: line[index].y + Math.sin(angle) * RADIUS * 0.96,
      };
      if (winding(rings, point) === 0) missing.push(point);
    }
  }
  const stray: Point[] = [];
  const xs = line.map((point) => point.x);
  const ys = line.map((point) => point.y);
  for (let x = Math.min(...xs) - RADIUS - 3; x <= Math.max(...xs) + RADIUS + 3; x += 0.25) {
    for (let y = Math.min(...ys) - RADIUS - 3; y <= Math.max(...ys) + RADIUS + 3; y += 0.25) {
      const point = { x, y };
      if (distanceToPath(point, line) > RADIUS + 0.4 && winding(rings, point) !== 0) stray.push(point);
    }
  }
  return { missing: missing.length, stray: stray.length };
}

describe("the outline of a tapered stroke", () => {
  it("draws a plain line as the nib's shape", () => {
    expect(againstTheNib([{ x: 50, y: 50 }, { x: 100, y: 50 }])).toEqual({ missing: 0, stray: 0 });
  });

  it("keeps the start whole when the pen slides back as it lands", () => {
    // It pinched to nothing a pixel in, leaving a separate blob behind: the
    // start looked cut off.
    const landing = [{ x: 50, y: 50 }, { x: 47.5, y: 50 }, { x: 100, y: 50 }];
    expect(againstTheNib(landing)).toEqual({ missing: 0, stray: 0 });
  });

  it("puts no spike on a start that slipped sideways", () => {
    const landing = [{ x: 50, y: 52.5 }, { x: 50, y: 50 }, { x: 100, y: 50 }];
    expect(againstTheNib(landing)).toEqual({ missing: 0, stray: 0 });
  });

  it("puts no fish tail on an end that hooked as the pen lifted", () => {
    const lifting = [{ x: 50, y: 50 }, { x: 100, y: 50 }, { x: 99.5, y: 53 }];
    expect(againstTheNib(lifting)).toEqual({ missing: 0, stray: 0 });
  });

  it("fills the inside of a sharp corner", () => {
    // The point of a 'v' had a notch cut into its inside.
    const vee = [{ x: 20, y: 20 }, { x: 40, y: 45 }, { x: 60, y: 20 }];
    expect(againstTheNib(vee)).toEqual({ missing: 0, stray: 0 });

    // The inner edges of the two arms meet RADIUS / sin(38.7 degrees) above
    // the point. Nearly that far up, between the arms, is still both arms' ink.
    const rings = inkFlattenPath(outline(through(vee)), 0.02).map((line) => line.points);
    const meet = RADIUS / Math.sin(Math.atan2(20, 25));
    expect(winding(rings, { x: 40, y: 45 - meet * 0.9 })).not.toBe(0);
  });

  it("rounds the end of a retrace", () => {
    const retrace = [{ x: 50, y: 20 }, { x: 50, y: 60 }, { x: 50.6, y: 25 }];
    expect(againstTheNib(retrace)).toEqual({ missing: 0, stray: 0 });
  });
});
