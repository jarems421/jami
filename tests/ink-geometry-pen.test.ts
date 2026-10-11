// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInkPenBuilder,
  type InkPenFeel,
  type InkPenSample,
} from "@/lib/ink/geometry/pen";
import { inkFlattenPath } from "@/lib/ink/flatten";
import type { InkPathCommand } from "@/lib/ink/model";

/**
 * The pen geometry on its own, with no js-draw and no DOM. The golden test
 * (`ink-geometry-golden.test.ts`) pins it to the shape the js-draw builder
 * drew; these check what it is, and that it can run where js-draw cannot.
 */
const FEEL: InkPenFeel = {
  cornerDegrees: 40,
  easeTowardsNeighbours: 0.3,
  cornerDominance: 1.2,
  minimumWidthFraction: 0.35,
  pressureResponse: 1,
  snapToGuides: true,
};

function sample(x: number, y: number, width = 5, time = 0): InkPenSample {
  return { x, y, width, time };
}

function draw(samples: InkPenSample[], feel: InkPenFeel = FEEL, pixelSize = 1) {
  const pen = createInkPenBuilder(samples[0], { feel, pixelSize });
  for (const next of samples.slice(1)) pen.addPoint(next);
  return pen;
}

function arc(count: number, width: number | ((t: number) => number) = 5): InkPenSample[] {
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    return sample(
      300 + Math.cos(t * Math.PI) * 150,
      300 + Math.sin(t * Math.PI) * 150,
      typeof width === "function" ? width(t) : width,
      index * 8
    );
  });
}

const endpointOf = (command: InkPathCommand) =>
  command.op === "Z" ? null : { x: command.x, y: command.y };

describe("the pen geometry", () => {
  it("draws a steady stroke as one stroked centre line", () => {
    const { path, paint } = draw(arc(60)).geometry();

    expect(paint).toEqual({ kind: "stroke", width: 5 });
    expect(path[0].op).toBe("M");
    expect(path.slice(1).every((command) => command.op === "C")).toBe(true);
  });

  it("passes through the first and the last sample", () => {
    const samples = arc(60);
    const { path } = draw(samples).geometry();

    expect(path[0]).toMatchObject({ op: "M", x: samples[0].x, y: samples[0].y });
    const end = endpointOf(path[path.length - 1]);
    expect(end?.x).toBeCloseTo(samples[59].x, 6);
    expect(end?.y).toBeCloseTo(samples[59].y, 6);
  });

  it("draws a dot as a filled disc of the pen's width", () => {
    const { path, paint } = draw([sample(120, 90, 6)]).geometry();

    expect(paint).toEqual({ kind: "fill" });
    expect(path.map((command) => command.op)).toEqual(["M", "C", "C", "C", "C"]);
    expect(path[0]).toMatchObject({ op: "M", x: 123, y: 90 });
  });

  it("draws a stroke made at varying pressure as one closed outline", () => {
    const { path, paint } = draw(arc(70, (t) => 1.5 + 6 * Math.sin(t * Math.PI))).geometry();

    expect(paint).toEqual({ kind: "fill" });
    // One loop out along an edge, round the end and back: a single move.
    expect(path.filter((command) => command.op === "M")).toHaveLength(1);
  });

  it("keeps a deliberate corner as a corner", () => {
    const vee = [
      ...Array.from({ length: 12 }, (_, step) => sample(20 + step * 8, 200 - step * 8, 4, step * 8)),
      ...Array.from({ length: 12 }, (_, step) => sample(108 + step * 8, 112 + step * 8, 4, 96 + step * 8)),
    ];
    const { path } = draw(vee).geometry();

    // A kept point at the bottom of the turn, with the curve arriving and
    // leaving along the two strokes rather than rounding it.
    const apex = path.some((command) => {
      const end = endpointOf(command);
      return end !== null && Math.abs(end.x - 100) < 9 && Math.abs(end.y - 112) < 9;
    });
    expect(apex).toBe(true);
  });

  it("reports where the line it drew ends, and not before it drew one", () => {
    const pen = draw(arc(60));
    expect(pen.liveTip()).toBeNull();

    pen.geometry();
    const tip = pen.liveTip();
    expect(tip?.width).toBeCloseTo(5, 6);
    expect(tip?.x).toBeCloseTo(150, 3);
    expect(tip?.y).toBeCloseTo(300, 3);
  });

  it("grows the bounding box by half the stroke width", () => {
    const { points, margin } = draw([sample(10, 10, 8), sample(60, 40, 8, 8)]).extent();

    expect(margin).toBe(4);
    expect(points[0]).toMatchObject({ x: 10, y: 10 });
  });

  describe("straightening", () => {
    const wobble = Array.from({ length: 40 }, (_, index) =>
      sample(30 + index * 7.5, 60 + index * 0.35 + Math.sin(index * 2.1) * 0.8, 5, index * 8)
    );

    it("snaps a stroke that was meant to be a line", () => {
      const pen = draw(wobble);
      const line = pen.straighten();

      expect(line?.paint).toEqual({ kind: "stroke", width: 5 });
      expect(line?.path.map((command) => command.op)).toEqual(["M", "L"]);
      // It stays a line: another call has nothing to offer.
      expect(pen.straighten()).toBeNull();
    });

    /** A flat stroke 300 px long, bowed `depth` px to one side all the way along. */
    const bowed = (depth: number) =>
      Array.from({ length: 40 }, (_, index) => {
        const t = index / 39;
        return sample(30 + t * 300, 60 + Math.sin(t * Math.PI) * depth, 5, index * 8);
      });

    it("snaps a flat line bent the way a wrist bends it", () => {
      // 10 px over 300: never crossing its line, so it scores as an arc, but
      // too shallow to be one.
      expect(draw(bowed(10)).straighten()).not.toBeNull();
      expect(draw(bowed(20)).straighten()).not.toBeNull();
    });

    it("leaves a shallow but deliberate curve alone", () => {
      expect(draw(bowed(36)).straighten()).toBeNull();
    });

    it("leaves a curve as it was drawn", () => {
      const pen = draw(arc(40));
      expect(pen.straighten()).toBeNull();
      expect(pen.geometry().path.length).toBeGreaterThan(2);
    });

    it("aims the far end at the pen once snapped, and has no tip to predict from", () => {
      const pen = draw(wobble);
      pen.straighten();
      pen.addPoint(sample(300, 300, 5, 500));

      const { path } = pen.geometry();
      expect(path).toHaveLength(2);
      expect(path[0]).toMatchObject({ op: "M", x: wobble[0].x, y: wobble[0].y });
      expect(pen.liveTip()).toBeNull();
      expect(pen.extent().points).toHaveLength(2);
    });

    it("only levels the aimed end when snapping to guides is on", () => {
      const aim = (snapToGuides: boolean) => {
        const pen = draw(wobble, { ...FEEL, snapToGuides });
        pen.straighten();
        // A couple of degrees off flat, from where the line starts.
        pen.addPoint(sample(30 + 300, wobble[0].y + 9, 5, 500));
        const end = pen.geometry().path[1];
        return end.op === "L" ? end : null;
      };

      expect(aim(false)?.y).toBeCloseTo(wobble[0].y + 9, 6);
      expect(aim(true)?.y).toBeLessThan(wobble[0].y + 9);
    });
  });
});

describe("ink once drawn", () => {
  /** A slow, pressured hand: loops like an 'e', with a little tremor, 240 samples a second. */
  function slowLoops(count = 420): InkPenSample[] {
    let seed = 11;
    const wobble = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 0.6;
    };
    return Array.from({ length: count }, (_, index) => {
      const t = index / (count - 1);
      return sample(
        200 + t * 120 + 14 * Math.cos(t * 6 * Math.PI) + wobble(),
        200 - 14 * Math.sin(t * 6 * Math.PI) + wobble(),
        2 + 2 * Math.sin(t * Math.PI) + 0.3 * Math.sin(t * 23),
        index * (1000 / 240)
      );
    });
  }

  const polyline = (path: InkPathCommand[]) => inkFlattenPath(path, 0.05).flatMap((line) => line.points);
  function distanceToPolyline(point: { x: number; y: number }, line: { x: number; y: number }[]) {
    let best = Infinity;
    for (let index = 1; index < line.length; index += 1) {
      const a = line[index - 1];
      const b = line[index];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
    }
    return best;
  }

  it("does not change shape well behind the pen as the stroke goes on", () => {
    const samples = slowLoops();
    const pen = createInkPenBuilder(samples[0], { feel: FEEL, pixelSize: 1, tapered: true });
    let before = polyline(pen.geometry().path);
    let worst = 0;
    for (let index = 1; index < samples.length; index += 1) {
      pen.addPoint(samples[index]);
      // Safari's packets: four samples at a time.
      if (index % 4 !== 0) continue;
      const after = polyline(pen.geometry().path);
      const tip = samples[index];
      for (const point of before) {
        if (Math.hypot(point.x - tip.x, point.y - tip.y) < 12) continue;
        worst = Math.max(worst, distanceToPolyline(point, after));
      }
      before = after;
    }
    // About 0.04px now. Curves up to 24px long bending into shape behind the
    // pen moved it by 0.15px here, and by over a pixel in the session, where a
    // pressured stroke also turned from a plain line into its outline.
    expect(worst).toBeLessThan(0.08);
  });

  it("is its tapered outline from the first samples when it writes with pressure", () => {
    const samples = slowLoops(12);
    const pen = createInkPenBuilder(samples[0], { feel: FEEL, pixelSize: 1, tapered: true });
    for (const next of samples.slice(1)) {
      pen.addPoint(next);
      expect(pen.geometry().paint).toEqual({ kind: "fill" });
    }
  });
});

describe("lib/ink/geometry", () => {
  it("imports nothing from js-draw", () => {
    const folder = resolve(__dirname, "../lib/ink/geometry");
    const files = readdirSync(folder).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);

    for (const name of files) {
      const text = readFileSync(resolve(folder, name), "utf8");
      expect(text, name).not.toMatch(/from\s+["'](?:@js-draw|js-draw)/);
      expect(text, name).not.toMatch(/import\(\s*["'](?:@js-draw|js-draw)/);
      expect(text, name).not.toMatch(/require\(\s*["'](?:@js-draw|js-draw)/);
    }
  });
});
