import { describe, expect, it } from "vitest";
import {
  getEffectiveStarVisualSize,
  getStarRewardSize,
  parseStarData,
  STAR_SCHEMA_VERSION,
} from "@/lib/constellation/stars";

/**
 * A star's `size` is stored on one of two scales and the number cannot say
 * which.
 *
 * Before the rarity presets it was a 0..1 fraction; since then it has been
 * ln(targetCards + 1). Those ranges overlap for small goals -- a one-card goal
 * gives ln(2) = 0.69 -- so a star read on the wrong scale is drawn at entirely
 * the wrong size, silently and with no error anywhere.
 *
 * That has now happened twice. The marker was `presetId`, a field for something
 * else whose absence happened to date a star, and deleting the rarity presets
 * stopped it being written: every new star was dated as ancient and the
 * onboarding star was drawn at 42px instead of 18px. These tests exist so the
 * third time is caught here rather than in the sky.
 */
describe("which scale a star's size is read on", () => {
  const base = {
    goalId: "goal-1",
    constellationId: "constellation-1",
    glow: 0.5,
    createdAt: 1,
    position: { x: 50, y: 50 },
  };

  it("dates a star written today as modern, so ln(2) is the smallest star", () => {
    const star = parseStarData("star-1", {
      ...base,
      size: getStarRewardSize(1),
      starSchemaVersion: STAR_SCHEMA_VERSION,
    });

    expect(star.isLegacyStar).toBe(false);
    expect(getEffectiveStarVisualSize(star)).toBeCloseTo(18, 1);
  });

  it("still dates a star from the preset era by its presetId", () => {
    const star = parseStarData("star-2", {
      ...base,
      size: getStarRewardSize(1),
      presetId: "classic",
    });

    expect(star.isLegacyStar).toBe(false);
    expect(getEffectiveStarVisualSize(star)).toBeCloseTo(18, 1);
  });

  it("reads a star carrying neither marker on the old 0..1 scale", () => {
    const star = parseStarData("star-3", { ...base, size: 0.5 });

    expect(star.isLegacyStar).toBe(true);
    // Midway along the old linear 18..52 range, not the log curve.
    expect(getEffectiveStarVisualSize(star)).toBeCloseTo(35, 1);
  });

  it("draws a big goal much larger than a small one", () => {
    const sizeOf = (targetCards: number) =>
      getEffectiveStarVisualSize(
        parseStarData(`star-${targetCards}`, {
          ...base,
          size: getStarRewardSize(targetCards),
          starSchemaVersion: STAR_SCHEMA_VERSION,
        })
      );

    expect(sizeOf(500)).toBeGreaterThan(sizeOf(100));
    expect(sizeOf(100)).toBeGreaterThan(sizeOf(10));
    expect(sizeOf(500)).toBeCloseTo(52, 1);
  });
});

describe("star tint", () => {
  it("keeps a pink tint and ignores anything else", () => {
    expect(parseStarData("a", { tint: "pink" }).tint).toBe("pink");
    expect(parseStarData("b", { tint: "gold" }).tint).toBeUndefined();
    expect(parseStarData("c", {}).tint).toBeUndefined();
  });
});
