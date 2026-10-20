import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/client";
import { getActiveOrCreateInitialConstellation } from "@/services/constellation/constellations";
import { goalStarEffort, goalStarGlow, type Goal } from "@/lib/goals/model";
import {
  getDefaultStarPosition,
  getStarRewardSize,
  STAR_SCHEMA_VERSION,
} from "@/lib/constellation/stars";
import { parseStarData, type NormalizedStar } from "@/lib/constellation/stars";
import { withTimeout } from "@/services/firebase/firestore";

const QUERY_MS = 30_000;
const CREATE_MS = 30_000;
const UPDATE_MS = 30_000;
/** The onboarding star, which is always the same document. */
const ONBOARDING_STAR_ID = "onboarding-first-loop";

const STAR_COUNT_FIELD = "starCount";

function getStarsCollection(userId: string) {
  return collection(db, "users", userId, "stars");
}

export async function getStars(userId: string): Promise<NormalizedStar[]> {
  const snapshot = await getDocs(getStarsCollection(userId));

  return snapshot.docs.map((starDoc) =>
    parseStarData(starDoc.id, starDoc.data() as Record<string, unknown>)
  );
}

export async function backfillStarPositions(
  userId: string,
  stars: NormalizedStar[]
) {
  const starsNeedingBackfill = stars.filter((star) => star.needsBackfill);

  if (starsNeedingBackfill.length === 0) {
    return;
  }

  await withTimeout(
    Promise.all(
      starsNeedingBackfill.map((star) =>
        updateDoc(doc(db, "users", userId, "stars", star.id), {
          position: star.position,
        })
      )
    ),
    UPDATE_MS,
    "Backfill star positions"
  );
}

export async function createStarForGoalIfMissing(userId: string, goal: Goal) {
  const starsCollection = getStarsCollection(userId);
  const starRef = doc(starsCollection, goal.id);
  const exactStarSnapshot = await withTimeout(
    getDoc(starRef),
    QUERY_MS,
    "Load existing quest star"
  );
  if (exactStarSnapshot.exists()) {
    return null;
  }
  // Historical stars predate deterministic goal document IDs. Keep a bounded
  // fallback until those records have all been observed and migrated.
  const legacyStarSnapshot = await withTimeout(
    getDocs(
      query(starsCollection, where("goalId", "==", goal.id), limit(1))
    ),
    QUERY_MS,
    "Load legacy quest star"
  );
  if (!legacyStarSnapshot.empty) return null;

  const activeConstellation = await getActiveOrCreateInitialConstellation(userId);
  if (!activeConstellation) {
    return null;
  }

  const constellationRef = doc(
    db,
    "users",
    userId,
    "constellations",
    activeConstellation.id
  );

  const initialConstellationStarCount = activeConstellation.starCount;

  if (initialConstellationStarCount >= activeConstellation.maxStars) {
    return null;
  }

  /*
   * The completed-goal count used to be read here, and only ever to choose
   * between a white, blue and gold star. Stars are all white now, so this is
   * one aggregate query off the path every time a goal turns into a star.
   */
  const createdAt = Date.now();

  const star = {
    goalId: goal.id,
    constellationId: activeConstellation.id,
    // The same two numbers the goal's preview star was drawn from.
    size: getStarRewardSize(goalStarEffort(goal)),
    glow: goalStarGlow(goal),
    // Says which scale `size` is on. Without it the star reads as pre-preset,
    // whose sizes were 0..1, and is drawn on the wrong curve.
    starSchemaVersion: STAR_SCHEMA_VERSION,
    // Seeded from the star's own id rather than Math.random, so a star lands in
    // the same place whether it is read from this write or placed later by a
    // backfill. The goal id is the star id, which is what makes it stable.
    position: getDefaultStarPosition(goal.id),
    createdAt,
  };

  const didCreate = await withTimeout(
    runTransaction(db, async (transaction) => {
      const [constellationSnapshot, starSnapshot] = await Promise.all([
        transaction.get(constellationRef),
        transaction.get(starRef),
      ]);

      if (!constellationSnapshot.exists() || starSnapshot.exists()) {
        return false;
      }

      const constellationData = constellationSnapshot.data() as Record<string, unknown>;
      const maxStars =
        typeof constellationData.maxStars === "number" && constellationData.maxStars > 0
          ? constellationData.maxStars
          : activeConstellation.maxStars;
      const currentCount =
        typeof constellationData[STAR_COUNT_FIELD] === "number"
          ? (constellationData[STAR_COUNT_FIELD] as number)
          : initialConstellationStarCount;

      if (currentCount >= maxStars) {
        return false;
      }

      transaction.set(starRef, star);
      transaction.update(constellationRef, {
        [STAR_COUNT_FIELD]: currentCount + 1,
      });

      return true;
    }),
    CREATE_MS,
    "Create star"
  );

  if (!didCreate) {
    return null;
  }

  return {
    id: starRef.id,
    ...star,
  };
}

export async function saveStarPosition(
  userId: string,
  starId: string,
  position: { x: number; y: number }
) {
  await withTimeout(
    updateDoc(doc(db, "users", userId, "stars", starId), {
      position,
    }),
    UPDATE_MS,
    "Save star position"
  );
}

export async function createOnboardingStarIfMissing(userId: string): Promise<
  | { status: "awarded"; star: NormalizedStar }
  | { status: "exists"; star: NormalizedStar }
  | { status: "pending" }
> {
  const starsCollection = getStarsCollection(userId);
  const starRef = doc(starsCollection, ONBOARDING_STAR_ID);
  const existing = await withTimeout(
    getDoc(starRef),
    QUERY_MS,
    "Load first-loop star"
  );
  if (existing.exists()) {
    return {
      status: "exists",
      star: parseStarData(
        existing.id,
        existing.data() as Record<string, unknown>
      ),
    };
  }

  const activeConstellation = await getActiveOrCreateInitialConstellation(userId);
  if (!activeConstellation || activeConstellation.starCount >= activeConstellation.maxStars) {
    return { status: "pending" };
  }

  const constellationRef = doc(
    db,
    "users",
    userId,
    "constellations",
    activeConstellation.id
  );
  const createdAt = Date.now();
  const star = {
    goalId: "",
    constellationId: activeConstellation.id,
    size: getStarRewardSize(1),
    glow: 0.85,
    starSchemaVersion: STAR_SCHEMA_VERSION,
    rewardKind: "onboarding" as const,
    rewardLabel: "First study loop",
    position: getDefaultStarPosition(ONBOARDING_STAR_ID),
    createdAt,
  };

  const didCreate = await withTimeout(
    runTransaction(db, async (transaction) => {
      const [constellationSnapshot, starSnapshot] = await Promise.all([
        transaction.get(constellationRef),
        transaction.get(starRef),
      ]);
      if (!constellationSnapshot.exists() || starSnapshot.exists()) return false;
      const data = constellationSnapshot.data() as Record<string, unknown>;
      const currentCount =
        typeof data[STAR_COUNT_FIELD] === "number"
          ? (data[STAR_COUNT_FIELD] as number)
          : activeConstellation.starCount;
      const maxStars =
        typeof data.maxStars === "number"
          ? (data.maxStars as number)
          : activeConstellation.maxStars;
      if (currentCount >= maxStars) return false;
      transaction.set(starRef, star);
      transaction.update(constellationRef, {
        [STAR_COUNT_FIELD]: currentCount + 1,
      });
      return true;
    }),
    CREATE_MS,
    "Create first-loop star"
  );

  if (!didCreate) {
    const after = await getDoc(starRef);
    if (after.exists()) {
      return {
        status: "exists",
        star: parseStarData(
          after.id,
          after.data() as Record<string, unknown>
        ),
      };
    }
    return { status: "pending" };
  }

  return {
    status: "awarded",
    star: parseStarData(starRef.id, star),
  };
}
