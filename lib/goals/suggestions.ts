import { describeGoalDeadline, endOfStudyDay, examDeadline, goalDeadlineDayKey } from "@/lib/goals/deadlines";
import { defaultGoalName, type Goal, type GoalDraft } from "@/lib/goals/model";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import type { LearningRecommendationReason } from "@/lib/learning/types";
import type { RevisionPlan } from "@/lib/planning/types";
import { getStudyDayKey, shiftStudyDayKey, studyDaysBetween } from "@/lib/study/day";

/**
 * Goals worth suggesting, from what Jami already knows.
 *
 * A blank form asks a student to invent a target from nothing, which is the
 * hardest part of setting one. Every suggestion here comes from something real:
 * the next exam in their revision plan, a topic the Learning Engine is already
 * recommending, cards waiting today, or how much they have actually been
 * reviewing. Nothing is created until the student picks one and confirms it;
 * a suggestion only fills the form in. A few ready-made goals follow them
 * (`goalIdeas`), so a student with little history still has more than one
 * place to start.
 *
 * The engine's topics are passed in as it ranked them and are not re-ranked
 * here: a goal suggestion is another place to act on its advice, never a
 * second opinion on what matters.
 */

export type GoalSuggestionExam = {
  planId: string;
  examId: string;
  label: string;
  dayKey: string;
  folderId?: string;
  folderName?: string;
};

export type GoalSuggestionTopic = {
  folderId: string;
  folderName?: string;
  topicKey: string;
  label: string;
};

export type GoalSuggestion = {
  id: string;
  /** Why this one, in a few words: "Before Chemistry Paper 1". */
  reason: string;
  title: string;
  draft: GoalDraft;
};

export type GoalSuggestionInput = {
  now: number;
  activeGoals: readonly Goal[];
  /** Cards Daily Review has waiting today. */
  dueCardCount?: number;
  /** Reviews on each recent study day, any order; days with none may be left out. */
  recentReviewCounts?: readonly number[];
  nextExam?: GoalSuggestionExam;
  /** Topics the engine currently recommends, in its own order. */
  engineTopics?: readonly GoalSuggestionTopic[];
  limit?: number;
};

/**
 * Recommendations that say a topic is not yet where it could be.
 *
 * "Due for retrieval" is left out: it is about when cards fall due, which a
 * strong topic can be too, so it says nothing about a topic worth aiming at.
 */
const AIMABLE_REASONS: ReadonlySet<LearningRecommendationReason> = new Set([
  "declining_mastery",
  "knowledge_decay",
  "low_mastery",
  "low_confidence",
  "recent_improvement_needs_reinforcement",
  "untested_exposure",
  "not_yet_assessed",
]);

/** The engine's topic recommendations that could become a topic goal, in its own order. */
export function engineTopicsFromActions(
  actions: readonly Pick<StudyAction, "reason" | "target" | "scope">[],
  folders: readonly { id: string; name: string }[]
): GoalSuggestionTopic[] {
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const seen = new Set<string>();
  const topics: GoalSuggestionTopic[] = [];
  for (const action of actions) {
    const folderId = action.scope.folderId;
    if (action.target.kind !== "topic" || !folderId || !AIMABLE_REASONS.has(action.reason)) continue;
    if (seen.has(action.target.topicKey)) continue;
    seen.add(action.target.topicKey);
    const folderName = names.get(folderId);
    topics.push({
      folderId,
      ...(folderName ? { folderName } : {}),
      topicKey: action.target.topicKey,
      label: action.target.label,
    });
  }
  return topics;
}

/**
 * A revision plan's exams still to come, soonest first, as goals can use them.
 *
 * An exam today is left out: a goal set for it would be due before it was set.
 */
export function upcomingPlanExams(
  plan: Pick<RevisionPlan, "id" | "exams"> | null,
  todayKey: string,
  folders: readonly { id: string; name: string }[]
): GoalSuggestionExam[] {
  if (!plan) return [];
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  return (plan.exams ?? [])
    .filter((exam) => studyDaysBetween(todayKey, exam.dayKey) >= 1)
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey))
    .map((exam) => {
      const folderId = exam.scopeKey?.startsWith("folder:") ? exam.scopeKey.slice("folder:".length) : undefined;
      const folderName = folderId ? names.get(folderId) : undefined;
      return {
        planId: plan.id,
        examId: exam.id,
        label: exam.label,
        dayKey: exam.dayKey,
        ...(folderId ? { folderId } : {}),
        ...(folderName ? { folderName } : {}),
      };
    });
}

const EXAM_WINDOW_DAYS = 120;
const HABIT_DAYS = 5;
const WEEK_SPAN_DAYS = 7;
const MIN_DUE_FOR_SUGGESTION = 10;
/** Suggestions and quick starts together, at most: two rows of three on a wide screen. */
const MAX_IDEAS = 6;

function roundToFive(value: number) {
  return Math.max(5, Math.round(value / 5) * 5);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sameShape(goal: Goal, draft: GoalDraft) {
  if (goal.measure !== draft.measure) return false;
  if (draft.measure === "topic") return goal.topic?.key === draft.topic?.key;
  return (
    goal.cadence === draft.cadence &&
    goal.scope.type === draft.scope.type &&
    (goal.scope.id ?? "") === (draft.scope.id ?? "")
  );
}

function folderScope(folderId: string | undefined, folderName: string | undefined): GoalDraft["scope"] {
  return folderId ? { type: "folder", id: folderId, ...(folderName ? { label: folderName } : {}) } : { type: "all" };
}

function suggestion(id: string, reason: string, draft: Omit<GoalDraft, "name">): GoalSuggestion {
  return { id, reason, title: defaultGoalName(draft), draft: { ...draft, name: "" } };
}

/**
 * The goal for an exam: a topic the engine recommends in the exam's folder,
 * when there is one, else practice questions in that folder -- about two for
 * each day left -- due the evening before.
 */
export function examGoalDraft(
  exam: GoalSuggestionExam,
  todayKey: string,
  topic?: GoalSuggestionTopic
): GoalDraft {
  const link = { planId: exam.planId, examId: exam.examId, label: exam.label, dayKey: exam.dayKey };
  const deadline = examDeadline(exam.dayKey);
  if (topic) {
    return {
      name: "",
      measure: "topic",
      cadence: "total",
      target: 1,
      days: 0,
      scope: folderScope(topic.folderId, topic.folderName ?? exam.folderName),
      topic: { key: topic.topicKey, label: topic.label },
      exam: link,
      deadline,
    };
  }
  const daysToExam = Math.max(1, studyDaysBetween(todayKey, exam.dayKey));
  return {
    name: "",
    measure: "questions",
    cadence: "total",
    target: clamp(roundToFive(daysToExam * 2), 10, 60),
    days: 0,
    scope: folderScope(exam.folderId, exam.folderName),
    exam: link,
    deadline,
  };
}

export function suggestGoals(input: GoalSuggestionInput): GoalSuggestion[] {
  const todayKey = getStudyDayKey(input.now);
  const candidates: GoalSuggestion[] = [];
  const usedTopics = new Set<string>();

  const exam = input.nextExam;
  const daysToExam = exam ? studyDaysBetween(todayKey, exam.dayKey) : -1;
  if (exam && daysToExam >= 1 && daysToExam <= EXAM_WINDOW_DAYS) {
    const topic = exam.folderId
      ? input.engineTopics?.find((candidate) => candidate.folderId === exam.folderId)
      : undefined;
    if (topic) usedTopics.add(topic.topicKey);
    const draft = examGoalDraft(exam, todayKey, topic);
    candidates.push(suggestion(`exam-${draft.measure}:${exam.examId}`, `Before ${exam.label}`, draft));
  }

  const topic = input.engineTopics?.find((candidate) => !usedTopics.has(candidate.topicKey));
  if (topic) {
    candidates.push(
      suggestion(`topic:${topic.folderId}:${topic.topicKey}`, topic.folderName ? `Jami suggests · ${topic.folderName}` : "Jami suggests", {
        measure: "topic",
        cadence: "total",
        target: 1,
        days: 0,
        scope: folderScope(topic.folderId, topic.folderName),
        topic: { key: topic.topicKey, label: topic.label },
        deadline: 0,
      })
    );
  }

  const due = Math.round(input.dueCardCount ?? 0);
  if (due >= MIN_DUE_FOR_SUGGESTION) {
    candidates.push(
      suggestion("due-today", "Waiting today", {
        measure: "cards",
        cadence: "total",
        target: due,
        days: 0,
        scope: { type: "all" },
        deadline: endOfStudyDay(todayKey),
      })
    );
  }

  const studied = (input.recentReviewCounts ?? []).filter((count) => count > 0);
  const usual = studied.length > 0 ? studied.reduce((sum, count) => sum + count, 0) / studied.length : 20;
  candidates.push(
    suggestion("habit", "A week-long habit", {
      measure: "cards",
      cadence: "daily",
      target: clamp(roundToFive(usual), 10, 50),
      days: HABIT_DAYS,
      scope: { type: "all" },
      deadline: endOfStudyDay(shiftStudyDayKey(todayKey, WEEK_SPAN_DAYS - 1)),
    })
  );

  return candidates
    .filter((candidate) => !input.activeGoals.some((goal) => goal.status === "active" && sameShape(goal, candidate.draft)))
    .slice(0, input.limit ?? 3);
}

/** The same kind of work, from the same place, due the same day: whatever the amount, one is the other. */
function sameAim(goal: Pick<GoalDraft, "measure" | "cadence" | "scope" | "deadline">, draft: GoalDraft) {
  const day = (deadline: number) => (deadline > 0 ? goalDeadlineDayKey(deadline) : "");
  return (
    goal.measure === draft.measure &&
    goal.cadence === draft.cadence &&
    goal.scope.type === draft.scope.type &&
    (goal.scope.id ?? "") === (draft.scope.id ?? "") &&
    day(goal.deadline) === day(draft.deadline)
  );
}

/**
 * Ready-made goals, for the times Jami has little of the student's own to go
 * on: a session's worth of cards today, a week of reviewing, a week of
 * practice, and a few practice questions a day.
 *
 * Unlike the suggestions these come from nothing the student has done, and
 * they say so by being plain round amounts the composer can adjust. They sit
 * after the suggestions, and one is left out when a suggestion or a running
 * goal is already the same aim -- cards waiting today make "a session today"
 * say the same thing twice.
 */
function goalStarters(todayKey: string, taken: readonly Pick<GoalDraft, "measure" | "cadence" | "scope" | "deadline">[]) {
  const weekEnd = endOfStudyDay(shiftStudyDayKey(todayKey, WEEK_SPAN_DAYS - 1));
  const all: GoalDraft["scope"] = { type: "all" };
  const starters = [
    suggestion("starter:today", "A session today", {
      measure: "cards",
      cadence: "total",
      target: 20,
      days: 0,
      scope: all,
      deadline: endOfStudyDay(todayKey),
    }),
    suggestion("starter:week-cards", "A week of reviewing", {
      measure: "cards",
      cadence: "total",
      target: 100,
      days: 0,
      scope: all,
      deadline: weekEnd,
    }),
    suggestion("starter:week-questions", "A week of practice", {
      measure: "questions",
      cadence: "total",
      target: 10,
      days: 0,
      scope: all,
      deadline: weekEnd,
    }),
    suggestion("starter:question-habit", "A practice habit", {
      measure: "questions",
      cadence: "daily",
      target: 3,
      days: HABIT_DAYS,
      scope: all,
      deadline: weekEnd,
    }),
  ];
  return starters.filter((starter) => !taken.some((other) => sameAim(other, starter.draft)));
}

/**
 * Everything the goals page offers to start from: the suggestions first, as
 * Jami ranked them, then the ready-made goals to fill the rest. Each only
 * fills the composer in.
 */
export function goalIdeas(input: GoalSuggestionInput): GoalSuggestion[] {
  const suggested = suggestGoals({ ...input, limit: Math.min(input.limit ?? 3, MAX_IDEAS) });
  const running = input.activeGoals.filter((goal) => goal.status === "active");
  const starters = goalStarters(getStudyDayKey(input.now), [...suggested.map((idea) => idea.draft), ...running]);
  return [...suggested, ...starters].slice(0, MAX_IDEAS);
}

/** When an idea is due, in a few words: "Due today", "On 5 days". */
export function goalIdeaTiming(draft: GoalDraft, now: number): string {
  if (draft.measure !== "topic" && draft.cadence === "daily") return `On ${draft.days} ${draft.days === 1 ? "day" : "days"}`;
  return describeGoalDeadline(draft.deadline, now).label;
}
