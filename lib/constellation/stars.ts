export type StarPosition = {
  x: number;
  y: number;
};

export type Star = {
  id: string;
  goalId: string;
  constellationId: string;
  size: number;
  glow: number;
  position: StarPosition;
  createdAt: number;
  rewardKind?: "goal" | "onboarding";
  rewardLabel?: string;
  /** The colour of a gifted figure's light. Earned stars are always white. */
  tint?: StarTint;
};

export type StarTint = "pink";

export type NormalizedStar = Star & {
  needsBackfill: boolean;
  isLegacyStar?: boolean;
};

const STAR_VISUAL_MIN_TARGET_CARDS = 1;
const STAR_VISUAL_REFERENCE_TARGET_CARDS = 500;
const STAR_MIN_VISUAL_SIZE = 18;
const STAR_MAX_VISUAL_SIZE = 52;
const STAR_SIZE_CURVE_EXPONENT = 2.9;

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampPercentage(value: number) {
  return Math.max(0, Math.min(100, value));
}

/** The Stars page's sky, which star positions are percentages of. */
export const SKY_CONTAINER_ID = "constellation-container";

function areTooClose(a: StarPosition, b: StarPosition) {
  return Math.abs(a.x - b.x) < 8 && Math.abs(a.y - b.y) < 8;
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function getSeededRandom(value: string, index: number) {
  const seed = hashString(`${value}:${index}`);
  const random = Math.sin(seed * 9301 + index * 49297) * 233280;
  return random - Math.floor(random);
}

function getDeterministicPositionValue(value: string, index: number) {
  return 10 + getSeededRandom(value, index) * 80;
}

/*
 * Stars used to come in white, blue and gold, warming as goals were completed.
 * Drawn, the colour sat at the 24 per cent stop of the star's own gradient, so
 * a gold star was gold through its core rather than white-hot with warm light
 * around it, and it simply looked wrong. Every star is white now.
 *
 * Existing documents keep their `color` field; nothing reads it. That is the
 * same treatment `presetId` got, except presetId has to stay because its
 * absence is what dates a legacy star.
 */

/**
 * Where a star sits when it has never been placed.
 *
 * Seeded from the star's own id, so the same star lands in the same spot every
 * time it is read. Both service write paths use this rather than Math.random,
 * which used to give a star one position on the server and another on backfill.
 */
/**
 * Stamped on every star written, so its `size` can be read on the right scale.
 *
 * It replaces `presetId`, which carried this meaning by accident: a field for
 * something else entirely, whose absence happened to date a star. That is a
 * dangerous way to store a schema version, and deleting the presets proved it.
 */
export const STAR_SCHEMA_VERSION = 2;

export function getDefaultStarPosition(seed = "default-star"): StarPosition {
  return {
    x: getDeterministicPositionValue(seed, 1),
    y: getDeterministicPositionValue(seed, 2),
  };
}

export function getStarRewardSize(targetCards: number) {
  return Math.log(Math.max(0, targetCards) + 1);
}

export function getStarVisualSize(starSize: number) {
  const minRewardSize = getStarRewardSize(STAR_VISUAL_MIN_TARGET_CARDS);
  const maxRewardSize = getStarRewardSize(STAR_VISUAL_REFERENCE_TARGET_CARDS);
  const normalizedSize = clampNumber(
    maxRewardSize > minRewardSize
      ? (starSize - minRewardSize) / (maxRewardSize - minRewardSize)
      : 0,
    0,
    1
  );
  const curvedSize = normalizedSize ** STAR_SIZE_CURVE_EXPONENT;

  return (
    STAR_MIN_VISUAL_SIZE +
    curvedSize * (STAR_MAX_VISUAL_SIZE - STAR_MIN_VISUAL_SIZE)
  );
}

function getLegacyStarVisualSize(starSize: number) {
  const normalizedSize = clampNumber(starSize, 0, 1);
  return (
    STAR_MIN_VISUAL_SIZE +
    normalizedSize * (STAR_MAX_VISUAL_SIZE - STAR_MIN_VISUAL_SIZE)
  );
}

export function getEffectiveStarVisualSize(star: {
  size: number;
  isLegacyStar?: boolean;
}) {
  const shouldUseLegacyScale =
    star.isLegacyStar &&
    star.size >= 0 &&
    star.size <= 1;

  return shouldUseLegacyScale
    ? getLegacyStarVisualSize(star.size)
    : getStarVisualSize(star.size);
}

export function buildPreviewStar({
  targetCards,
  targetAccuracy,
  constellationId = "preview-constellation",
  id = "preview-star",
  goalId = "preview-goal",
  createdAt = 0,
  position = { x: 50, y: 50 },
}: {
  targetCards: number;
  targetAccuracy: number;
  constellationId?: string;
  id?: string;
  goalId?: string;
  createdAt?: number;
  position?: StarPosition;
}) {
  return normalizeStar({
    id,
    goalId,
    constellationId,
    size: getStarRewardSize(targetCards),
    glow: targetAccuracy,
    createdAt,
    position,
  });
}

export function normalizeStar(star: {
  id: string;
  goalId: string;
  constellationId?: string;
  size: number;
  glow: number;
  createdAt: number;
  position?: Partial<StarPosition>;
  isLegacyStar?: boolean;
  rewardKind?: "goal" | "onboarding";
  rewardLabel?: string;
  tint?: StarTint;
}): NormalizedStar {
  const hasValidPosition =
    typeof star.position?.x === "number" &&
    typeof star.position?.y === "number";
  const existingPosition = star.position;
  const position = hasValidPosition
    ? {
        x: existingPosition!.x!,
        y: existingPosition!.y!,
      }
    : getDefaultStarPosition(star.id);

  return {
    ...star,
    constellationId: typeof star.constellationId === "string" ? star.constellationId : "",
    position,
    needsBackfill: !hasValidPosition,
    isLegacyStar: star.isLegacyStar === true,
    rewardKind: star.rewardKind ?? "goal",
    rewardLabel: star.rewardLabel,
  };
}

export function parseStarData(
  id: string,
  data: Record<string, unknown>
): NormalizedStar {
  return normalizeStar({
    id,
    goalId: typeof data.goalId === "string" ? data.goalId : "",
    constellationId:
      typeof data.constellationId === "string" ? data.constellationId : "",
    size: typeof data.size === "number" ? data.size : 0,
    glow: typeof data.glow === "number" ? data.glow : 0,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    position:
      typeof data.position === "object" && data.position !== null
        ? (data.position as Partial<StarPosition>)
        : undefined,
    /*
     * Which scale this star's `size` is on, which the number itself cannot say.
     *
     * Stars written before the rarity presets existed hold `size` as a 0..1
     * fraction; every star since holds ln(targetCards + 1). Those ranges
     * overlap -- a one-card goal gives ln(2) = 0.69 -- so reading an old star
     * on the new scale draws it far too small, and reading a new one on the old
     * scale draws it far too big.
     *
     * This read `presetId === undefined` alone, and presetId stopped being
     * written when the presets were deleted -- which quietly dated every new
     * star as ancient and drew the onboarding star, whose size is ln(2), at
     * 42px instead of 18px. STAR_SCHEMA_VERSION is now written in its place and
     * says only what it means. Either marker is enough to date a star as
     * modern; neither is ever written to an old one.
     */
    isLegacyStar:
      data.presetId === undefined && data.starSchemaVersion === undefined,
    rewardKind: data.rewardKind === "onboarding" ? "onboarding" : "goal",
    rewardLabel:
      typeof data.rewardLabel === "string"
        ? data.rewardLabel.trim().slice(0, 120) || undefined
        : undefined,
    ...(data.tint === "pink" ? { tint: "pink" as const } : {}),
  });
}

export function spreadBackfilledStars(stars: NormalizedStar[]) {
  const placed: StarPosition[] = [];

  return stars.map((star) => {
    if (!star.needsBackfill) {
      placed.push(star.position);
      return star;
    }

    let nextPosition = star.position;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const overlaps = placed.some((position) => areTooClose(position, nextPosition));
      if (!overlaps) break;

      nextPosition = {
        x: clampPercentage(nextPosition.x + 10),
        y: clampPercentage(nextPosition.y + 10),
      };
    }

    placed.push(nextPosition);

    return {
      ...star,
      position: nextPosition,
    };
  });
}
