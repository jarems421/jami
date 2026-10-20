import type { LearningDemonstration } from "@/lib/learning/types";
import { describeGoalDeadline, goalDeadlineDayKey, studyDaysLeft, type GoalDeadlineTone } from "@/lib/goals/deadlines";
import { goalUnit, type Goal } from "@/lib/goals/model";
import { goalAccuracy, isGoalMet } from "@/lib/goals/progress";
import { getStudyDayKey, studyDaysBetween } from "@/lib/study/day";

/**
 * Where a goal stands, worded for the student.
 *
 * The useful part of a goal is not the counter but the answer to "am I going
 * to make it?", so every running goal is read against its own pace: what share
 * of the target should be done by now if the work were spread evenly from the
 * day it was set to the day it is due. That is a sum, not a prediction -- it
 * says nothing about how the student will study, only what the rest asks of
 * each remaining day.
 *
 * Topic goals have no pace. Their progress is the engine's own ladder, and
 * pretending the climb from weak to strong happens at a steady rate would be
 * inventing a forecast the evidence does not support.
 */

export type GoalTone =
  /** Met. */
  | "done"
  /** A daily goal whose amount is done for today. */
  | "done_today"
  | "ahead"
  | "on_track"
  | "behind"
  | "due_today"
  /** A daily goal that can no longer fit its days before the deadline. */
  | "out_of_reach"
  /** No deadline, or nothing to pace against. */
  | "open"
  /** A topic goal the engine has not been asked about yet. */
  | "unchecked";

export type GoalLadderStep = { demonstration: LearningDemonstration; label: string };

/** The engine's demonstrations, as a climb. Kept in the engine's own order and meaning. */
export const GOAL_TOPIC_LADDER: readonly GoalLadderStep[] = [
  { demonstration: "none", label: "Not tested" },
  { demonstration: "insufficient", label: "Too early to tell" },
  { demonstration: "weak", label: "Weak" },
  { demonstration: "developing", label: "Developing" },
  { demonstration: "strong", label: "Strong" },
];

export type GoalStanding = {
  /** 0 to 100: how much of the whole goal is done. */
  percent: number;
  /** The headline number: "34 of 50 cards", "Today: 12 of 20", "Developing". */
  headline: string;
  /** One line on what the rest asks for: "On track · about 6 a day". */
  pace: string;
  tone: GoalTone;
  deadline: { label: string; tone: GoalDeadlineTone };
  /** Left of a total, or of today's amount on a daily goal. */
  remaining: number;
  /** What each remaining day needs, for a total goal with a deadline. */
  perDay?: number;
  /** Daily goals: days hit against days asked, and today's own share. */
  days?: { hit: number; of: number; doneToday: boolean; todayCount: number; todayPercent: number };
  /** Topic goals: where on the ladder the engine last put it, when it has. */
  ladder?: { step: number; label: string };
  /** Due within two days and not on course, so Today may lead with it. */
  atRisk: boolean;
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function totalStanding(goal: Goal, now: number): GoalStanding {
  const deadline = describeGoalDeadline(goal.deadline, now);
  const { count } = goal.progress;
  const remaining = Math.max(0, goal.target - count);
  const unit = goalUnit(goal, goal.target);
  const percent = clampPercent((count / Math.max(1, goal.target)) * 100);
  const headline = `${count.toLocaleString("en-GB")} of ${goal.target.toLocaleString("en-GB")} ${unit}`;

  if (remaining === 0) {
    // Only the oldest goals can reach their count and still be running: they
    // also asked for an accuracy, and that is what is left.
    const accuracy = goalAccuracy(goal);
    return {
      percent,
      headline,
      pace: isGoalMet(goal)
        ? "Done"
        : `Accuracy ${Math.round((accuracy ?? 0) * 100)}% · this goal needs ${Math.round(goal.accuracyGate * 100)}%`,
      tone: isGoalMet(goal) ? "done" : "behind",
      deadline,
      remaining,
      atRisk: false,
    };
  }

  if (goal.deadline <= 0) {
    return { percent, headline, pace: `${remaining.toLocaleString("en-GB")} to go`, tone: "open", deadline, remaining, atRisk: false };
  }

  const daysLeft = studyDaysLeft(goal.deadline, now);
  if (daysLeft <= 0) {
    return { percent, headline, pace: `${remaining.toLocaleString("en-GB")} short`, tone: "behind", deadline, remaining, atRisk: false };
  }

  const perDay = Math.ceil(remaining / daysLeft);
  if (daysLeft === 1) {
    return { percent, headline, pace: `${remaining.toLocaleString("en-GB")} to go today`, tone: "due_today", deadline, remaining, perDay, atRisk: true };
  }

  const startKey = getStudyDayKey(goal.createdAt > 0 ? Math.min(goal.createdAt, now) : now);
  const todayKey = getStudyDayKey(now);
  const totalDays = Math.max(1, studyDaysBetween(startKey, goalDeadlineDayKey(goal.deadline)) + 1);
  const elapsedDays = Math.max(0, Math.min(totalDays, studyDaysBetween(startKey, todayKey)));
  const dueBeforeToday = (goal.target * elapsedDays) / totalDays;
  const dueByTonight = (goal.target * (elapsedDays + 1)) / totalDays;

  const tone: GoalTone =
    count >= dueByTonight ? "ahead" : count + 0.5 >= dueBeforeToday ? "on_track" : "behind";
  const pace =
    tone === "ahead"
      ? `Ahead of pace · ${remaining.toLocaleString("en-GB")} to go`
      : tone === "on_track"
        ? `On track · about ${perDay.toLocaleString("en-GB")} a day`
        : `${perDay.toLocaleString("en-GB")} a day to make it`;
  return {
    percent,
    headline,
    pace,
    tone,
    deadline,
    remaining,
    perDay,
    atRisk: daysLeft <= 2 && tone !== "ahead",
  };
}

function dailyStanding(goal: Goal, now: number): GoalStanding {
  const deadline = describeGoalDeadline(goal.deadline, now);
  const todayKey = getStudyDayKey(now);
  const todayCount = goal.progress.dayKey === todayKey ? goal.progress.dayCount : 0;
  const doneToday = todayCount >= goal.target;
  const hit = Math.min(goal.days, goal.progress.daysHit);
  const remaining = Math.max(0, goal.target - todayCount);
  const todayPercent = clampPercent((todayCount / Math.max(1, goal.target)) * 100);
  const percent = clampPercent(((hit + (doneToday ? 0 : Math.min(1, todayCount / Math.max(1, goal.target)))) / Math.max(1, goal.days)) * 100);
  const days = { hit, of: goal.days, doneToday, todayCount, todayPercent };
  const unit = goalUnit(goal, goal.target);
  const headline = `Today: ${todayCount.toLocaleString("en-GB")} of ${goal.target.toLocaleString("en-GB")} ${unit}`;
  const tally = `${hit} of ${goal.days} ${goal.days === 1 ? "day" : "days"}`;

  if (hit >= goal.days) {
    return { percent: 100, headline, pace: "Done", tone: "done", deadline, remaining: 0, days, atRisk: false };
  }

  const needed = goal.days - hit;
  if (goal.deadline > 0) {
    const daysLeft = studyDaysLeft(goal.deadline, now);
    const available = Math.max(0, doneToday ? daysLeft - 1 : daysLeft);
    if (needed > available) {
      return {
        percent,
        headline,
        pace: `${needed} more ${needed === 1 ? "day" : "days"} needed, ${available} left`,
        tone: "out_of_reach",
        deadline,
        remaining,
        days,
        atRisk: false,
      };
    }
  }

  return {
    percent,
    headline,
    pace: doneToday ? `Done for today · ${tally}` : `${remaining.toLocaleString("en-GB")} to go today · ${tally}`,
    tone: doneToday ? "done_today" : "open",
    deadline,
    remaining,
    days,
    atRisk: false,
  };
}

const TOPIC_PACE: Record<LearningDemonstration, string> = {
  none: "Answer a few questions on it so Jami can tell",
  insufficient: "A few more answers and Jami can tell",
  weak: "Jami's next step for it will help",
  developing: "Getting there · keep it going",
  strong: "Done",
};

function topicStanding(goal: Goal, now: number): GoalStanding {
  const deadline = describeGoalDeadline(goal.deadline, now);
  const demonstration = goal.progress.demonstration;
  const daysLeft = goal.deadline > 0 ? studyDaysLeft(goal.deadline, now) : Number.POSITIVE_INFINITY;
  if (!demonstration) {
    return {
      percent: 0,
      headline: "Not checked yet",
      pace: "Jami reads this from your results",
      tone: "unchecked",
      deadline,
      remaining: 1,
      atRisk: false,
    };
  }
  const step = Math.max(0, GOAL_TOPIC_LADDER.findIndex((item) => item.demonstration === demonstration));
  const label = GOAL_TOPIC_LADDER[step]?.label ?? "Not tested";
  const done = demonstration === "strong";
  return {
    percent: clampPercent((step / (GOAL_TOPIC_LADDER.length - 1)) * 100),
    headline: label,
    pace: TOPIC_PACE[demonstration],
    tone: done ? "done" : daysLeft === 1 ? "due_today" : "open",
    deadline,
    remaining: done ? 0 : 1,
    ladder: { step, label },
    atRisk: !done && daysLeft <= 2,
  };
}

export function goalStanding(goal: Goal, now: number): GoalStanding {
  if (goal.measure === "topic") return topicStanding(goal, now);
  if (goal.cadence === "daily") return dailyStanding(goal, now);
  return totalStanding(goal, now);
}

/** How a goal ended up, in a few words, for the list of past goals. */
export function goalOutcomeLine(goal: Goal) {
  if (goal.measure === "topic") {
    if (goal.status === "completed") return "Reached strong";
    const step = GOAL_TOPIC_LADDER.find((item) => item.demonstration === goal.progress.demonstration);
    return step ? `Got to ${step.label.toLowerCase()}` : "Not checked";
  }
  if (goal.cadence === "daily") {
    return `${Math.min(goal.days, goal.progress.daysHit)} of ${goal.days} ${goal.days === 1 ? "day" : "days"}`;
  }
  return `${goal.progress.count.toLocaleString("en-GB")} of ${goal.target.toLocaleString("en-GB")} ${goalUnit(goal, goal.target)}`;
}

/**
 * Running goals in the order a student should see them: anything due soonest
 * first, then the ones with no deadline, newest first.
 */
export function sortGoalsForDisplay(goals: readonly Goal[]) {
  return [...goals].sort((left, right) => {
    const leftDue = left.deadline > 0 ? left.deadline : Number.MAX_SAFE_INTEGER;
    const rightDue = right.deadline > 0 ? right.deadline : Number.MAX_SAFE_INTEGER;
    if (leftDue !== rightDue) return leftDue - rightDue;
    return right.createdAt - left.createdAt;
  });
}
