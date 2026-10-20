import type { LearningDemonstration } from "@/lib/learning/types";
import type { Goal, GoalStatus } from "@/lib/goals/model";
import { getStudyDayKey } from "@/lib/study/day";

/**
 * How work moves a goal.
 *
 * One rule for every kind of work, run wherever that work is recorded: on the
 * device as a flashcard answer saves, and on the server as an exam answer is
 * marked. Both sides call the same function, so a goal cannot count a
 * flashcard one way here and a marked answer another way there.
 */

/** Where an answered flashcard sits, for matching it against a goal's scope. */
export type GoalCardContext = {
  deckId?: string;
  topicIds?: string[];
  folderIds?: string[];
};

export type GoalEvent =
  | ({ kind: "card"; correct: boolean; at: number } & GoalCardContext)
  /** One exam-style answer Jami marked; `score` is the share of its marks it earned. */
  | { kind: "question"; score: number; at: number; folderId?: string };

function cardMatchesScope(goal: Goal, context: GoalCardContext) {
  if (goal.scope.type === "all") return true;
  if (!goal.scope.id) return false;
  if (goal.scope.type === "deck") return context.deckId === goal.scope.id;
  if (goal.scope.type === "topic") return context.topicIds?.includes(goal.scope.id) === true;
  return context.folderIds?.includes(goal.scope.id) === true;
}

/** Whether this piece of work is the kind the goal counts, from where it counts it. */
export function goalCountsEvent(goal: Goal, event: GoalEvent) {
  if (event.kind === "card") return goal.measure === "cards" && cardMatchesScope(goal, event);
  if (goal.measure !== "questions") return false;
  if (goal.scope.type === "all") return true;
  return goal.scope.type === "folder" && Boolean(goal.scope.id) && event.folderId === goal.scope.id;
}

/** What a goal's status really is at `now`: an active goal past its deadline has run out. */
export function getGoalStatusAtTime(goal: Goal, now: number): GoalStatus {
  if (goal.status !== "active") return goal.status;
  if (goal.deadline > 0 && now > goal.deadline) return "failed";
  return "active";
}

/** The share of counted flashcards answered right, or null before there are any. */
export function goalAccuracy(goal: Goal) {
  return goal.progress.answered > 0 ? goal.progress.correct / goal.progress.answered : null;
}

/** The average share of marks across counted answers, or null before there are any. */
export function goalAverageScore(goal: Goal) {
  return goal.measure === "questions" && goal.progress.count > 0
    ? goal.progress.scoreSum / goal.progress.count
    : null;
}

/** Whether a goal has reached what it asked for. */
export function isGoalMet(goal: Goal) {
  if (goal.measure === "topic") return goal.progress.demonstration === "strong";
  if (goal.cadence === "daily") return goal.progress.daysHit >= goal.days;
  if (goal.progress.count < goal.target) return false;
  if (goal.accuracyGate <= 0) return true;
  return (goalAccuracy(goal) ?? 0) >= goal.accuracyGate;
}

function settle(goal: Goal, at: number): Goal {
  if (goal.status !== "active" || !isGoalMet(goal)) return goal;
  return { ...goal, status: "completed", completedAt: at };
}

/**
 * The goal after one piece of work.
 *
 * Returns the same object when the work does not count, so a caller can tell
 * "nothing to write" from a change. Work done after the deadline ends the goal
 * instead of counting towards it.
 */
export function applyGoalEvent(goal: Goal, event: GoalEvent): Goal {
  if (goal.status !== "active") return goal;
  if (getGoalStatusAtTime(goal, event.at) === "failed") return { ...goal, status: "failed" };
  if (!goalCountsEvent(goal, event)) return goal;

  const progress = { ...goal.progress };
  progress.count += 1;
  progress.answered += 1;
  if (event.kind === "card" && event.correct) progress.correct += 1;
  if (event.kind === "question") progress.scoreSum += Math.max(0, Math.min(1, event.score));

  if (goal.cadence === "daily") {
    const dayKey = getStudyDayKey(event.at);
    if (!progress.dayKey || dayKey > progress.dayKey) {
      progress.dayKey = dayKey;
      progress.dayCount = 0;
    }
    /*
     * An answer from an earlier day -- one queued offline and synced after
     * today's study began -- still counts towards the total, but that day's
     * own count is gone, so it cannot be told whether it finished the day.
     * Counting it into today instead would finish today early.
     */
    if (dayKey === progress.dayKey) {
      progress.dayCount += 1;
      // Only the answer that reaches the day's amount marks the day as hit.
      if (progress.dayCount === goal.target) progress.daysHit += 1;
    }
  }

  return settle({ ...goal, progress }, event.at);
}

/**
 * A topic goal after reading what the Learning Engine now says about its topic.
 *
 * The engine's demonstration is the whole of it: strong finishes the goal,
 * anything else is where the student currently stands. Returns the same object
 * when nothing changed, so an unchanged reading is not written again.
 */
export function applyTopicReading(goal: Goal, demonstration: LearningDemonstration, at: number): Goal {
  if (goal.measure !== "topic" || goal.status !== "active") return goal;
  if (getGoalStatusAtTime(goal, at) === "failed") return { ...goal, status: "failed" };
  if (goal.progress.demonstration === demonstration) return goal;
  return settle({ ...goal, progress: { ...goal.progress, demonstration, checkedAt: at } }, at);
}
