import {
  endOfStudyDay,
  examDeadline,
  goalDeadlineDayKey,
  studyDaysLeft,
  thisWeekDeadline,
} from "@/lib/goals/deadlines";
import { goalToDraft, type Goal, type GoalCadence, type GoalDraft, type GoalExamLink, type GoalMeasure } from "@/lib/goals/model";
import { getStudyDayKey, shiftStudyDayKey, studyDaysBetween } from "@/lib/study/day";

/**
 * The goal composer's choices, as pure rules.
 *
 * What a fresh goal of each kind starts as, the amounts offered as one tap,
 * what each deadline chip means, and the plain sentence that reads a draft
 * back to the student before they commit to it.
 */

export const GOAL_AMOUNT_PRESETS: Record<Exclude<GoalMeasure, "topic">, Record<GoalCadence, readonly number[]>> = {
  cards: { total: [20, 50, 100, 200], daily: [10, 20, 30, 50] },
  questions: { total: [5, 10, 20, 40], daily: [2, 3, 5, 10] },
};

export const GOAL_DAY_PRESETS: readonly number[] = [3, 5, 7, 14];

const DEFAULT_AMOUNT: Record<Exclude<GoalMeasure, "topic">, Record<GoalCadence, number>> = {
  cards: { total: 50, daily: 20 },
  questions: { total: 10, daily: 3 },
};

const DEFAULT_DAYS = 5;

/** A new goal of one kind, before the student has changed anything. */
export function blankGoalDraft(measure: GoalMeasure, now: number): GoalDraft {
  if (measure === "topic") {
    return { name: "", measure, cadence: "total", target: 1, days: 0, scope: { type: "all" }, deadline: 0 };
  }
  return {
    name: "",
    measure,
    cadence: "total",
    target: DEFAULT_AMOUNT[measure].total,
    days: 0,
    scope: { type: "all" },
    deadline: thisWeekDeadline(now),
  };
}

/**
 * The draft after choosing a different kind of goal.
 *
 * The deadline and name carry over; everything that only makes sense for the
 * old kind -- its amount, its scope, a topic -- starts again.
 */
export function withMeasure(draft: GoalDraft, measure: GoalMeasure, now: number): GoalDraft {
  if (draft.measure === measure) return draft;
  const fresh = blankGoalDraft(measure, now);
  return {
    ...fresh,
    name: draft.name,
    deadline: draft.deadline,
    ...(draft.exam ? { exam: draft.exam } : {}),
    // A folder chosen for one kind is very likely the subject meant for the next.
    ...(draft.scope.type === "folder" && measure !== "cards" ? { scope: draft.scope } : {}),
  };
}

/** The draft after choosing a total or a daily amount. */
export function withCadence(draft: GoalDraft, cadence: GoalCadence): GoalDraft {
  if (draft.measure === "topic" || draft.cadence === cadence) return draft;
  return {
    ...draft,
    cadence,
    target: DEFAULT_AMOUNT[draft.measure][cadence],
    days: cadence === "daily" ? DEFAULT_DAYS : 0,
    // A daily goal is usually open-ended: the days are the finish line.
    deadline: cadence === "daily" ? 0 : draft.deadline || 0,
  };
}

export type GoalDeadlineChoice =
  | { kind: "none" }
  | { kind: "today" }
  | { kind: "week" }
  | { kind: "date"; dayKey: string }
  | { kind: "exam"; examId: string };

/** Which deadline chip a draft's deadline is. */
export function deadlineChoiceOf(draft: Pick<GoalDraft, "deadline" | "exam">, now: number): GoalDeadlineChoice {
  if (draft.exam) return { kind: "exam", examId: draft.exam.examId };
  if (draft.deadline <= 0) return { kind: "none" };
  if (draft.deadline === endOfStudyDay(getStudyDayKey(now))) return { kind: "today" };
  if (draft.deadline === thisWeekDeadline(now)) return { kind: "week" };
  return { kind: "date", dayKey: goalDeadlineDayKey(draft.deadline) };
}

/** The draft with a deadline chip chosen. An exam sets the deadline to the evening before it. */
export function applyDeadlineChoice(
  draft: GoalDraft,
  choice: GoalDeadlineChoice,
  now: number,
  exams: readonly GoalExamLink[]
): GoalDraft {
  const withoutExam: GoalDraft = { ...draft };
  delete withoutExam.exam;
  if (choice.kind === "exam") {
    const exam = exams.find((candidate) => candidate.examId === choice.examId);
    return exam ? { ...withoutExam, exam, deadline: examDeadline(exam.dayKey) } : draft;
  }
  if (choice.kind === "none") return { ...withoutExam, deadline: 0 };
  if (choice.kind === "today") return { ...withoutExam, deadline: endOfStudyDay(getStudyDayKey(now)) };
  if (choice.kind === "week") return { ...withoutExam, deadline: thisWeekDeadline(now) };
  return { ...withoutExam, deadline: choice.dayKey ? endOfStudyDay(choice.dayKey) : 0 };
}

/**
 * A past goal, set up to run again from today.
 *
 * It keeps its shape and gets the same length of time it had, counted from
 * now; an exam it was for keeps it only while that exam is still to come.
 */
export function repeatGoalDraft(goal: Goal, now: number): GoalDraft {
  const draft = goalToDraft(goal);
  const todayKey = getStudyDayKey(now);
  if (draft.exam && studyDaysBetween(todayKey, draft.exam.dayKey) >= 1) {
    return { ...draft, deadline: examDeadline(draft.exam.dayKey) };
  }
  delete draft.exam;
  if (goal.deadline <= 0) return { ...draft, deadline: 0 };
  const span = Math.max(0, studyDaysBetween(getStudyDayKey(goal.createdAt || now), goalDeadlineDayKey(goal.deadline)));
  return { ...draft, deadline: endOfStudyDay(shiftStudyDayKey(todayKey, span)) };
}

function scopeText(draft: Pick<GoalDraft, "scope">) {
  if (draft.scope.type === "all") return "";
  return draft.scope.label ? ` in ${draft.scope.label}` : "";
}

/** What a draft counts, in one sentence. */
export function goalPlanSentence(draft: GoalDraft): string {
  if (draft.measure === "topic") {
    return draft.topic
      ? `Done when your results show ${draft.topic.label} is strong. Jami judges that from your marked answers and reviews.`
      : "Choose a topic, and Jami will track it until your results show it is strong.";
  }
  if (draft.measure === "questions") {
    return draft.scope.type === "all"
      ? "Counts every exam-style answer Jami marks for you in Practice."
      : `Counts exam-style answers Jami marks for you${scopeText(draft)}.`;
  }
  return `Counts every flashcard you review${scopeText(draft)}.`;
}

function daysText(count: number) {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/**
 * What a draft asks of each day, when that can be said.
 *
 * `done` is the progress of a goal being edited, so the sum is over what is
 * left rather than over the whole target.
 */
export function goalPaceHint(
  draft: GoalDraft,
  now: number,
  done: { count: number; daysHit: number } = { count: 0, daysHit: 0 }
): string | null {
  if (draft.measure === "topic") return null;
  const daysLeft = draft.deadline > 0 ? studyDaysLeft(draft.deadline, now) : 0;
  if (draft.cadence === "daily") {
    const needed = Math.max(0, draft.days - done.daysHit);
    if (needed === 0) return "Already reached: saving finishes it.";
    const more = done.daysHit > 0 ? `${needed} more ${needed === 1 ? "day" : "days"}` : null;
    if (draft.deadline <= 0) return `${more ?? `Any ${daysText(needed)}`}, in a row or not.`;
    if (needed > daysLeft) return `Only ${daysText(daysLeft)} before the deadline.`;
    return more ? `${more}, within the next ${daysText(daysLeft)}.` : `On ${draft.days} of the next ${daysText(daysLeft)}.`;
  }
  const remaining = Math.max(0, draft.target - done.count);
  if (remaining === 0 && done.count > 0) return "Already reached: saving finishes it.";
  if (draft.deadline <= 0 || draft.target < 1) return null;
  if (daysLeft <= 1) return done.count > 0 ? "The rest today." : "All of it today.";
  const perDay = Math.ceil(remaining / daysLeft);
  return `About ${perDay.toLocaleString("en-GB")} a day for ${daysText(daysLeft)}.`;
}
