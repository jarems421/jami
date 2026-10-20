import {
  addDoc,
  collection,
  deleteField,
  doc,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";
import { invalidateDashboardData } from "@/services/dashboard/cache";
import { createStarForGoalIfMissing } from "@/services/constellation/stars";
import {
  applyGoalEdit,
  getGoalDisplayName,
  goalDocument,
  goalEditFields,
  goalProgressFields,
  normalizeGoal,
  type Goal,
  type GoalDraft,
  type GoalEdit,
} from "@/lib/goals/model";
import {
  applyGoalEvent,
  applyTopicReading,
  getGoalStatusAtTime,
  isGoalMet,
  type GoalCardContext,
} from "@/lib/goals/progress";
import type { TopicStanding } from "@/lib/goals/topic-standing";
import type { Star } from "@/lib/constellation/stars";
import { commitStudyEffect } from "@/services/study/commit-effect";
import { reportTutorialAction } from "@/lib/onboarding/tutorial";

/** A finished goal and the star it earned, for the screen to celebrate. */
export type GoalReward = { star: Star; goalName: string };

export type GoalProgressResult = {
  completedGoals: number;
  starsEarned: number;
  rewards: GoalReward[];
};

export type DashboardGoalSummary = {
  activeGoals: Goal[];
  hasEarnedStars: boolean;
};

export type GoalHistoryCursor = { createdAt: number; id: string };

const QUERY_MS = 30_000;
const UPDATE_MS = 30_000;
/** Rewards waiting at once is rare; more than this can wait for the next load. */
const PENDING_REWARD_LIMIT = 10;

function goalsCollection(userId: string) {
  return collection(db, "users", userId, "goals");
}

function goalRef(userId: string, goalId: string) {
  return doc(db, "users", userId, "goals", goalId);
}

export async function getGoals(userId: string): Promise<Goal[]> {
  const snapshot = await getDocs(goalsCollection(userId));

  return snapshot.docs.map((goalDoc) =>
    normalizeGoal(goalDoc.id, goalDoc.data() as Record<string, unknown>)
  );
}

async function loadActiveGoals(userId: string) {
  const snapshot = await getDocs(
    query(goalsCollection(userId), where("status", "==", "active"))
  );
  return snapshot.docs.map((goalDoc) =>
    normalizeGoal(goalDoc.id, goalDoc.data() as Record<string, unknown>)
  );
}

export async function getDashboardGoalSummary(
  userId: string,
  now = Date.now()
): Promise<DashboardGoalSummary> {
  /*
   * Whether a star exists, not whether a goal was completed.
   *
   * This asked for one completed goal and reported it as an earned star, and
   * the two are not the same: a goal that completes while the constellation is
   * full mints nothing (createStarForGoalIfMissing returns null at its
   * starCount check). Today then told the student "Your latest goal reward is
   * waiting" and sent them to a sky that had not changed.
   *
   * lib/study/study-feedback.ts already draws this distinction correctly, and
   * acknowledges that case in words instead.
   */
  const [activeGoals, starSnapshot] = await Promise.all([
    loadActiveGoals(userId),
    getDocs(query(collection(db, "users", userId, "stars"), limit(1))),
  ]);

  return {
    activeGoals: activeGoals
      .filter(
        (goal) =>
          goal.status === "active" &&
          (goal.deadline <= 0 || goal.deadline > now)
      )
      .sort((left, right) => right.createdAt - left.createdAt),
    hasEarnedStars: !starSnapshot.empty,
  };
}

export async function getActiveGoalsWithCurrentStatuses(
  userId: string,
  now = Date.now()
) {
  const goals = await loadActiveGoals(userId);
  const updates: Promise<void>[] = [];
  const currentGoals = goals.map((goal) => {
    const status = getGoalStatusAtTime(goal, now);
    if (status === goal.status) return goal;
    updates.push(updateDoc(goalRef(userId, goal.id), { status }));
    return { ...goal, status };
  });

  if (updates.length > 0) {
    await Promise.all(updates);
    invalidateDashboardData(userId);
  }

  return currentGoals
    .filter((goal) => goal.status === "active")
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function getGoalHistoryPage(
  userId: string,
  options: { cursor?: GoalHistoryCursor | null; pageSize?: number } = {}
) {
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 30));
  const snapshot = await getDocs(
    query(
      goalsCollection(userId),
      where("status", "in", ["completed", "failed", "cancelled"]),
      orderBy("createdAt", "desc"),
      orderBy(documentId(), "desc"),
      ...(options.cursor
        ? [startAfter(options.cursor.createdAt, options.cursor.id)]
        : []),
      limit(pageSize + 1)
    )
  );
  const pageDocs = snapshot.docs.slice(0, pageSize);

  const items = pageDocs.map((goalDoc) =>
    normalizeGoal(goalDoc.id, goalDoc.data() as Record<string, unknown>)
  );

  const finalDoc = pageDocs[pageDocs.length - 1];

  return {
    items,
    nextCursor:
      snapshot.docs.length > pageSize && finalDoc
        ? {
            createdAt: finalDoc.data().createdAt as number,
            id: finalDoc.id,
          }
        : null,
  };
}

export async function createGoal(
  userId: string,
  draft: GoalDraft,
  now = Date.now()
): Promise<Goal> {
  const stored = goalDocument(draft, now);
  const created = await addDoc(goalsCollection(userId), stored);
  invalidateDashboardData(userId);
  reportTutorialAction("create-goal");
  return normalizeGoal(created.id, stored);
}

/**
 * Lights the stars of goals that finished somewhere a star could not be shown:
 * a practice answer marked on the server, a topic the engine now calls strong,
 * an edit that brought the target within reach.
 *
 * Star creation is keyed by goal, so two screens claiming the same goal at once
 * light one star between them.
 */
export async function claimGoalRewards(userId: string): Promise<GoalReward[]> {
  const snapshot = await withTimeout(
    getDocs(query(goalsCollection(userId), where("rewardPending", "==", true), limit(PENDING_REWARD_LIMIT))),
    QUERY_MS,
    "Load finished goals"
  );
  const rewards: GoalReward[] = [];
  for (const goalDoc of snapshot.docs) {
    const goal = normalizeGoal(goalDoc.id, goalDoc.data() as Record<string, unknown>);
    if (goal.status === "completed") {
      const star = await createStarForGoalIfMissing(userId, goal);
      if (star) rewards.push({ star, goalName: getGoalDisplayName(goal) });
    }
    await updateDoc(goalDoc.ref, { rewardPending: deleteField() });
  }
  if (snapshot.docs.length > 0) invalidateDashboardData(userId);
  return rewards;
}

/** Marks a goal finished with its star still to light, then lights it. */
async function finishAndClaim(userId: string, goal: Goal, fields: Record<string, unknown>) {
  await withTimeout(
    updateDoc(goalRef(userId, goal.id), { ...fields, rewardPending: true }),
    UPDATE_MS,
    "Finish goal"
  );
  return claimGoalRewards(userId);
}

/**
 * Saves a change to a running goal's name, amount or deadline.
 *
 * An edit that brings the target within what is already done finishes the goal
 * there and then. Its star is sized by the goal as edited, so lowering a target
 * to finish early earns the smaller star it now describes.
 */
export async function editGoal(
  userId: string,
  goal: Goal,
  edit: GoalEdit,
  now = Date.now()
): Promise<{ goal: Goal; rewards: GoalReward[] }> {
  const edited = applyGoalEdit(goal, edit);
  const fields = goalEditFields(goal, edit);
  if (edited.status === "active" && isGoalMet(edited)) {
    const finished: Goal = { ...edited, status: "completed", completedAt: now };
    const rewards = await finishAndClaim(userId, finished, { ...fields, ...goalProgressFields(finished) });
    return { goal: finished, rewards };
  }
  await withTimeout(updateDoc(goalRef(userId, goal.id), fields), UPDATE_MS, "Save goal");
  invalidateDashboardData(userId);
  return { goal: edited, rewards: [] };
}

/** Ends a goal early. It keeps its progress and moves to past goals. */
export async function endGoal(userId: string, goalId: string) {
  await withTimeout(updateDoc(goalRef(userId, goalId), { status: "cancelled" }), UPDATE_MS, "End goal");
  invalidateDashboardData(userId);
}

/**
 * Topic goals after reading where the engine now puts their topics.
 *
 * Only a changed reading is written. A topic the engine calls strong finishes
 * its goal and lights the star at once, since the student is on the screen
 * that just found out.
 */
export async function recordTopicReadings(
  userId: string,
  goals: readonly Goal[],
  standingsByFolder: ReadonlyMap<string, readonly TopicStanding[]>,
  now = Date.now()
): Promise<{ changed: Goal[]; rewards: GoalReward[] }> {
  const rewards: GoalReward[] = [];
  const changed: Goal[] = [];
  for (const goal of goals) {
    const folderId = goal.scope.type === "folder" ? goal.scope.id : undefined;
    const standing =
      goal.measure === "topic" && folderId
        ? standingsByFolder.get(folderId)?.find((topic) => topic.key === goal.topic?.key)
        : undefined;
    const read = standing ? applyTopicReading(goal, standing.demonstration, now) : goal;
    if (read === goal) continue;
    if (read.status === "completed") {
      rewards.push(...(await finishAndClaim(userId, read, goalProgressFields(read))));
    } else {
      await withTimeout(updateDoc(goalRef(userId, goal.id), goalProgressFields(read)), UPDATE_MS, "Save topic progress");
      invalidateDashboardData(userId);
    }
    changed.push(read);
  }
  return { changed, rewards };
}

export async function applyGoalProgressForAnswer(
  userId: string,
  isCorrect: boolean,
  now = Date.now(),
  context: GoalCardContext = {},
  commitId?: string
): Promise<GoalProgressResult> {
  // Use the same compatibility-aware active set as the read surfaces. A goal
  // created before `status` was persisted must not appear active in Today and
  // then silently miss answer progress.
  const activeGoals = await withTimeout(
    loadActiveGoals(userId),
    QUERY_MS,
    "Load active goals"
  );
  const answered = (goal: Goal) =>
    applyGoalEvent(goal, { kind: "card", correct: isCorrect, at: now, ...context });

  if (commitId) {
    const completed = await commitStudyEffect({ userId, commitId }, "goals", async (transaction) => {
      const snapshots = await Promise.all(activeGoals.map((goal) => transaction.get(goalRef(userId, goal.id))));
      const completedGoals: Goal[] = [];
      for (const snapshot of snapshots) {
        if (!snapshot.exists()) continue;
        const goal = normalizeGoal(snapshot.id, snapshot.data());
        const updated = answered(goal);
        if (updated === goal) continue;
        transaction.update(snapshot.ref, goalProgressFields(updated));
        if (goal.status === "active" && updated.status === "completed") completedGoals.push(updated);
      }
      return completedGoals;
    });
    // Star creation already deduplicates by goal. Keep it outside the transaction
    // and retry it even when the progress receipt was saved before a failure.
    const rewards: GoalReward[] = [];
    for (const goal of completed) {
      const star = await createStarForGoalIfMissing(userId, goal);
      if (star) rewards.push({ star, goalName: getGoalDisplayName(goal) });
    }
    invalidateDashboardData(userId);
    return { completedGoals: completed.length, starsEarned: rewards.length, rewards };
  }

  const results = await Promise.all(
    activeGoals.map(async (goal): Promise<GoalProgressResult> => {
      const updated = answered(goal);
      if (updated === goal) return { completedGoals: 0, starsEarned: 0, rewards: [] };

      await withTimeout(
        updateDoc(goalRef(userId, goal.id), goalProgressFields(updated)),
        UPDATE_MS,
        "Update goal progress"
      );
      if (goal.status !== "active" || updated.status !== "completed") {
        return { completedGoals: 0, starsEarned: 0, rewards: [] };
      }
      const star = await createStarForGoalIfMissing(userId, updated);
      // Carried back so the session can show the star that was actually
      // written, with its own size, rather than a stand-in.
      return {
        completedGoals: 1,
        starsEarned: star ? 1 : 0,
        rewards: star ? [{ star, goalName: getGoalDisplayName(updated) }] : [],
      };
    })
  );
  // An active goal can gain progress without completing, so any active goal means a write.
  if (activeGoals.length > 0) invalidateDashboardData(userId);

  return results.reduce<GoalProgressResult>(
    (totals, result) => ({
      completedGoals: totals.completedGoals + result.completedGoals,
      starsEarned: totals.starsEarned + result.starsEarned,
      rewards: [...totals.rewards, ...result.rewards],
    }),
    { completedGoals: 0, starsEarned: 0, rewards: [] }
  );
}
