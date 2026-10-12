import { describe, expect, it } from "vitest";
import { createPenOutliner, type PenOutlineInput } from "@/lib/ink/geometry/pen-outline";
import { Vec } from "@/lib/ink/geometry/vector";

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stroke's outline inputs as they settle: a wandering centreline with now
 * and then a hairpin or a sharp corner, wide enough that its edges fold.
 */
function strokeFor(seed: number, count: number): PenOutlineInput {
  const random = seeded(seed);
  const shape: Vec[] = [];
  const halfWidths: number[] = [];
  const corners: boolean[] = [];
  const along: Vec[] = [];
  let x = 0;
  let y = 0;
  let heading = random() * 6.28;
  for (let index = 0; index < count; index += 1) {
    const sharp = index > 2 && random() < 0.08;
    heading += sharp ? (random() < 0.5 ? 1 : -1) * (1.6 + random() * 1.5) : (random() - 0.5) * 0.7;
    const step = 0.4 + random() * 5;
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    shape.push(Vec.of(x, y));
    halfWidths.push(0.4 + random() * (random() < 0.2 ? 9 : 3));
    corners.push(sharp && random() < 0.6);
    along.push(Vec.of(Math.cos(heading), Math.sin(heading)));
  }
  corners[0] = false;
  return { shape, halfWidths, corners, along };
}

describe("the pen outliner", () => {
  it("draws exactly what working it all out draws, packet after packet, however the unsettled end changes", () => {
    let windowed = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = seeded(seed * 31);
      const final = strokeFor(seed, 140);
      const outliner = createPenOutliner();
      let stable = 0;
      for (let count = 2; count <= final.shape.length; count += 1 + Math.floor(random() * 3)) {
        // Everything before `stable` is final; the rest is still moving, as the
        // points by the pen are.
        stable = Math.max(stable, Math.min(count - 1, count - 3 - Math.floor(random() * 6)));
        const input: PenOutlineInput = {
          shape: final.shape.slice(0, count).map((point, index) =>
            index < stable ? point : point.plus(Vec.of(random() - 0.5, random() - 0.5))
          ),
          halfWidths: final.halfWidths.slice(0, count).map((width, index) =>
            index < stable ? width : width * (0.8 + random() * 0.4)
          ),
          corners: final.corners.slice(0, count).map((corner, index) =>
            index < stable || index === 0 || index === count - 1 ? corner && index !== count - 1 : random() < 0.1
          ),
          along: final.along.slice(0, count),
        };
        if (stable > 20) windowed += 1;
        expect(outliner.outline(input, stable)).toEqual(createPenOutliner().outline(input, 0));
      }
    }
    expect(windowed).toBeGreaterThan(1000);
  });
});
