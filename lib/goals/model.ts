import type { LearningDemonstration } from "@/lib/learning/types";
import { studyDaysLeft } from "@/lib/goals/deadlines";

/**
 * A goal: a target a student sets themselves, which earns a star when it is met.
 *
 * Goals used to be one thing -- review this many flashcards, at this accuracy,
 * maybe by a deadline -- which left out most of what a student actually does in
 * Jami and most of what they actually want to aim at. A goal now says what it
 * counts and how:
 *
 * - `cards`: flashcard reviews, counted on the device as each answer saves.
 * - `questions`: exam-style answers Jami marked, counted on the server where
 *   the mark is written, so only real marked work moves it.
 * - `topic`: one topic reaching "strong", as the Learning Engine judges it from
 *   the student's own results. The goal reads the engine's answer; it never
 *   estimates anything itself, and nothing about a goal ever reaches the
 *   engine. A goal is something a student wants, not evidence of what they know.
 *
 * Counted goals are either a total to reach (`total`) or an amount to hit on a
 * number of days (`daily`), which is how a habit becomes something that can be
 * finished -- and so earn a star -- rather than a streak that only breaks.
 *
 * Goals written before any of this (`schemaVersion` 1) keep exactly the rule
 * they were made with, accuracy gate included, and keep their stored fields.
 */

export type GoalStatus = "active" | "completed" | "failed" | "cancelled";
export type GoalScopeType = "all" | "deck" | "topic" | "folder";

export type GoalScope = {
  type: GoalScopeType;
  id?: string;
  label?: string;
};

export const GOAL_MEASURES = ["cards", "questions", "topic"] as const;
export type GoalMeasure = (typeof GOAL_MEASURES)[number];

export type GoalCadence = "total" | "daily";

/** The topic a topic goal is about: the engine's own key, and the name it showed. */
export type GoalTopic = { key: string; label: string };

/** The exam in a revision plan that set this goal's deadline. */
export type GoalExamLink = { planId: string; examId: string; label: string; dayKey: string };

export type GoalProgress = {
  /** What has counted: reviews, or marked answers. For a daily goal, across every day. */
  count: number;
  /** Answers behind `correct`: the same as `count` except on the oldest goals. */
  answered: number;
  /** Flashcards answered right, for showing accuracy. */
  correct: number;
  /** Each marked answer's share of its marks, summed, for showing an average. */
  scoreSum: number;
  /** Daily goals: the study day being counted, its count so far, and days the target was hit. */
  dayKey?: string;
  dayCount: number;
  daysHit: number;
  /** Topic goals: what the engine last said, and when it was asked. */
  demonstration?: LearningDemonstration;
  checkedAt?: number;
};

export type Goal = {
  id: string;
  /** 1 for goals made before kinds, which store their count in the old fields. */
  schemaVersion: 1 | 2;
  name: string;
  measure: GoalMeasure;
  cadence: GoalCadence;
  /** The total to reach; for a daily goal the amount each day; 1 for a topic. */
  target: number;
  /** Daily goals: on how many days the target has to be hit. 0 otherwise. */
  days: number;
  scope: GoalScope;
  topic?: GoalTopic;
  exam?: GoalExamLink;
  /**
   * The oldest goals also asked for this share of answers to be right, and
   * keep asking. 0 means no such condition, which is every goal made since.
   */
  accuracyGate: number;
  /** Epoch ms; 0 for no deadline. */
  deadline: number;
  progress: GoalProgress;
  status: GoalStatus;
  createdAt: number;
  completedAt?: number;
  /** Finished away from anywhere that can light its star; the next screen to load does. */
  rewardPending?: boolean;
};

/** Everything a student chooses when making a goal. */
export type GoalDraft = {
  /** Empty means the goal is named for what it counts. */
  name: string;
  measure: GoalMeasure;
  cadence: GoalCadence;
  target: number;
  days: number;
  scope: GoalScope;
  topic?: GoalTopic;
  exam?: GoalExamLink;
  deadline: number;
};

export const GOAL_SCHEMA_VERSION = 2;
export const MAX_GOAL_NAME_LENGTH = 120;
export const MAX_GOAL_DAYS = 30;

/** The largest amount a goal may ask for, by what it counts and how. */
export const GOAL_TARGET_LIMITS: Record<Exclude<GoalMeasure, "topic">, Record<GoalCadence, number>> = {
  cards: { total: 5000, daily: 500 },
  questions: { total: 500, daily: 50 },
};

/**
 * Written for every goal made since kinds, as its `targetAccuracy`.
 *
 * An installed copy of the app from before kinds still reads that field, and
 * finishes any goal whose reviews meet `targetCards` at `targetAccuracy` -- so
 * without this an old copy could finish a practice-question goal on flashcards,
 * or finish anything on its first answer if the field were missing. No share of
 * answers is above one, so on an old copy a new goal simply never finishes,
 * until the copy updates itself. Nothing current reads it on a new goal.
 */
export const LEGACY_UNREACHABLE_ACCURACY = 2;

/** How much work a marked exam answer stands for, in flashcard reviews, when sizing its star. */
const QUESTION_STAR_EFFORT = 6;
/** Getting a topic to strong takes real, varied evidence: about a long evening of cards' worth. */
const TOPIC_STAR_EFFORT = 150;
/** Every star earned since kinds glows the same; size is what tells them apart. */
export const GOAL_STAR_GLOW = 0.85;

function readCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function readDemonstration(value: unknown): LearningDemonstration | undefined {
  return value === "none" ||
    value === "insufficient" ||
    value === "weak" ||
    value === "developing" ||
    value === "strong"
    ? value
    : undefined;
}

function normalizeGoalScope(value: unknown): GoalScope {
  if (!value || typeof value !== "object") return { type: "all" };
  const data = value as Record<string, unknown>;
  const type: GoalScopeType =
    data.type === "deck" || data.type === "topic" || data.type === "folder" ? data.type : "all";
  const id = readText(data.id, 160);
  const label = readText(data.label, 120);
  if (type === "all" || !id) return { type: "all" };
  return { type, id, ...(label ? { label } : {}) };
}

function normalizeGoalTopic(value: unknown): GoalTopic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const key = readText(data.key, 400);
  const label = readText(data.label, 120);
  return key && label ? { key, label } : undefined;
}

function normalizeGoalExam(value: unknown): GoalExamLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const planId = readText(data.planId, 160);
  const examId = readText(data.examId, 160);
  const label = readText(data.label, 120);
  const dayKey = readText(data.dayKey, 10);
  return planId && examId && label && /^\d{4}-\d{2}-\d{2}$/.test(dayKey)
    ? { planId, examId, label, dayKey }
    : undefined;
}

function normalizeStatus(value: unknown): GoalStatus {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : "active";
}

export function normalizeGoal(id: string, data: Record<string, unknown>): Goal {
  const progress = (data.progress && typeof data.progress === "object"
    ? data.progress
    : {}) as Record<string, unknown>;
  const scope = normalizeGoalScope(data.scope);
  const status = normalizeStatus(data.status);
  const deadline = typeof data.deadline === "number" && data.deadline > 0 ? data.deadline : 0;
  const createdAt = typeof data.createdAt === "number" ? data.createdAt : 0;
  const completedAt = typeof data.completedAt === "number" ? data.completedAt : undefined;
  const shared = {
    id,
    scope,
    status,
    deadline,
    createdAt,
    ...(completedAt ? { completedAt } : {}),
    ...(data.rewardPending === true ? { rewardPending: true } : {}),
  };

  if (data.schemaVersion !== GOAL_SCHEMA_VERSION) {
    // A goal from before kinds: flashcard reviews against `targetCards`.
    const target = readCount(data.targetCards);
    const count = readCount(progress.cardsCompleted);
    const name = readText(data.name, MAX_GOAL_NAME_LENGTH);
    return {
      ...shared,
      schemaVersion: 1,
      name: name || `Review ${target} cards`,
      measure: "cards",
      cadence: "total",
      target,
      days: 0,
      accuracyGate: readCount(data.targetAccuracy),
      progress: {
        count,
        answered: readCount(progress.totalAnswers),
        correct: readCount(progress.correctAnswers),
        scoreSum: 0,
        dayCount: 0,
        daysHit: 0,
      },
    };
  }

  const measure: GoalMeasure =
    data.measure === "questions" || data.measure === "topic" ? data.measure : "cards";
  const cadence: GoalCadence = measure !== "topic" && data.cadence === "daily" ? "daily" : "total";
  const topic = measure === "topic" ? normalizeGoalTopic(data.topic) : undefined;
  const exam = normalizeGoalExam(data.exam);
  const dayKey = readText(progress.dayKey, 10);
  const demonstration = readDemonstration(progress.demonstration);
  const goal: Goal = {
    ...shared,
    schemaVersion: 2,
    name: "",
    measure,
    cadence,
    target: measure === "topic" ? 1 : Math.max(1, Math.round(readCount(data.target))),
    days: cadence === "daily" ? Math.max(1, Math.min(MAX_GOAL_DAYS, Math.round(readCount(data.days)))) : 0,
    ...(topic ? { topic } : {}),
    ...(exam ? { exam } : {}),
    accuracyGate: 0,
    progress: {
      count: readCount(progress.count),
      answered: readCount(progress.answered),
      correct: readCount(progress.correct),
      scoreSum: readCount(progress.scoreSum),
      ...(dayKey ? { dayKey } : {}),
      dayCount: readCount(progress.dayCount),
      daysHit: readCount(progress.daysHit),
      ...(demonstration ? { demonstration } : {}),
      ...(typeof progress.checkedAt === "number" ? { checkedAt: progress.checkedAt } : {}),
    },
  };
  goal.name = readText(data.name, MAX_GOAL_NAME_LENGTH) || defaultGoalName(goal);
  return goal;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "card" or "question", for whatever a goal counts. */
export function goalUnit(goal: Pick<Goal, "measure">, count: number) {
  if (goal.measure === "questions") return count === 1 ? "question" : "questions";
  return count === 1 ? "card" : "cards";
}

/** What a goal is called when the student did not name it. */
export function defaultGoalName(
  goal: Pick<GoalDraft, "measure" | "cadence" | "target" | "topic">
): string {
  if (goal.measure === "topic") return `Get ${goal.topic?.label ?? "a topic"} to strong`;
  if (goal.measure === "questions") {
    return goal.cadence === "daily"
      ? `${plural(goal.target, "practice question")} a day`
      : `Answer ${plural(goal.target, "practice question")}`;
  }
  return goal.cadence === "daily" ? `${plural(goal.target, "card")} a day` : `Review ${plural(goal.target, "card")}`;
}

export function getGoalDisplayName(goal: Pick<Goal, "name" | "measure" | "cadence" | "target" | "topic">) {
  return goal.name.trim() || defaultGoalName(goal);
}

/** Where a goal's work has to come from, in a few words. */
export function goalScopeLabel(goal: Pick<Goal, "scope" | "measure">) {
  if (goal.scope.type === "all") {
    return goal.measure === "questions" ? "Any practice" : "All flashcards";
  }
  const kind = goal.scope.type === "deck" ? "Deck" : goal.scope.type === "topic" ? "Topic" : "Folder";
  return goal.scope.label || kind;
}

/** How much work a goal asks for, in flashcard reviews: what sizes its star. */
export function goalStarEffort(
  goal: Pick<Goal, "measure" | "cadence" | "target" | "days"> & { schemaVersion?: 1 | 2 }
) {
  if (goal.measure === "topic") return TOPIC_STAR_EFFORT;
  const total = goal.cadence === "daily" ? goal.target * Math.max(1, goal.days) : goal.target;
  return goal.measure === "questions" ? total * QUESTION_STAR_EFFORT : total;
}

/** How brightly a goal's star glows: the old accuracy target, or one level for every goal since. */
export function goalStarGlow(goal: Pick<Goal, "schemaVersion" | "accuracyGate">) {
  return goal.schemaVersion === 1 ? goal.accuracyGate : GOAL_STAR_GLOW;
}

/** What a star in the sky was earned for. */
export function goalStarLabel(
  goal: Pick<Goal, "measure" | "cadence" | "target" | "days" | "topic">
) {
  if (goal.measure === "topic") return `Earned for getting ${goal.topic?.label ?? "a topic"} to strong`;
  const unit = goal.measure === "questions" ? "question" : "card";
  if (goal.cadence === "daily") {
    return `Earned for ${plural(goal.target, unit)} a day on ${plural(goal.days, "day")}`;
  }
  return `Earned for a ${goal.target}-${unit} goal`;
}

/**
 * Why a draft cannot be saved yet, or null when it can.
 *
 * `daysHit` is for editing a daily goal already under way: only the days it
 * still needs have to fit before its deadline.
 */
export function goalDraftProblem(draft: GoalDraft, now: number, daysHit = 0): string | null {
  if (draft.name.trim().length > MAX_GOAL_NAME_LENGTH) return "Keep the name under 120 characters.";
  if (draft.measure === "topic") {
    if (draft.scope.type !== "folder" || !draft.scope.id) return "Choose the folder the topic is in.";
    if (!draft.topic) return "Choose a topic.";
  } else {
    const limit = GOAL_TARGET_LIMITS[draft.measure][draft.cadence];
    if (!Number.isInteger(draft.target) || draft.target < 1) return "Choose how many.";
    if (draft.target > limit) return `Keep it to ${limit.toLocaleString("en-GB")} or fewer.`;
    if (draft.cadence === "daily" && (!Number.isInteger(draft.days) || draft.days < 1 || draft.days > MAX_GOAL_DAYS)) {
      return `Choose between 1 and ${MAX_GOAL_DAYS} days.`;
    }
    if (draft.scope.type !== "all" && !draft.scope.id) return `Choose a ${draft.scope.type}.`;
    if (draft.measure === "questions" && draft.scope.type !== "all" && draft.scope.type !== "folder") {
      return "Practice questions can count from everything or one folder.";
    }
  }
  if (draft.deadline !== 0 && draft.deadline <= now) return "Choose a deadline that has not passed.";
  if (draft.measure !== "topic" && draft.cadence === "daily" && draft.deadline > 0) {
    const daysLeft = studyDaysLeft(draft.deadline, now);
    if (draft.days - daysHit > daysLeft) {
      return `There ${daysLeft === 1 ? "is only 1 day" : `are only ${daysLeft} days`} before the deadline.`;
    }
  }
  return null;
}

/** The stored document for a new goal. */
export function goalDocument(draft: GoalDraft, now: number) {
  const name = draft.name.trim().slice(0, MAX_GOAL_NAME_LENGTH);
  const target = draft.measure === "topic" ? 1 : Math.round(draft.target);
  return {
    schemaVersion: GOAL_SCHEMA_VERSION,
    name: name || defaultGoalName({ ...draft, target }),
    measure: draft.measure,
    cadence: draft.measure === "topic" ? ("total" as const) : draft.cadence,
    target,
    days: draft.measure !== "topic" && draft.cadence === "daily" ? Math.round(draft.days) : 0,
    scope: draft.scope.type === "all" ? { type: "all" as const } : draft.scope,
    ...(draft.measure === "topic" && draft.topic ? { topic: draft.topic } : {}),
    ...(draft.exam ? { exam: draft.exam } : {}),
    deadline: draft.deadline > 0 ? draft.deadline : 0,
    progress: { count: 0, answered: 0, correct: 0, scoreSum: 0, dayCount: 0, daysHit: 0 },
    status: "active" as const,
    createdAt: now,
    // Read only by copies of the app from before kinds; see LEGACY_UNREACHABLE_ACCURACY.
    targetCards: target,
    targetAccuracy: LEGACY_UNREACHABLE_ACCURACY,
  };
}

/** A new goal as it reads back, without a round trip. */
export function goalFromDraft(id: string, draft: GoalDraft, now: number): Goal {
  return normalizeGoal(id, goalDocument(draft, now));
}

/** The draft a goal was made from, for editing it or starting it again. */
export function goalToDraft(goal: Goal): GoalDraft {
  return {
    name: goal.name,
    measure: goal.measure,
    cadence: goal.cadence,
    target: goal.target,
    days: goal.days,
    scope: goal.scope,
    ...(goal.topic ? { topic: goal.topic } : {}),
    ...(goal.exam ? { exam: goal.exam } : {}),
    deadline: goal.deadline,
  };
}

/**
 * What can change on a goal already running: its name, how much it asks for
 * and by when. What it counts and where from stay fixed, because changing
 * those would make the progress it has already made mean something else.
 */
export type GoalEdit = Pick<GoalDraft, "name" | "target" | "days" | "deadline"> & {
  exam?: GoalExamLink | null;
};

/** The goal after an edit, as it will read back. */
export function applyGoalEdit(goal: Goal, edit: GoalEdit): Goal {
  const target = goal.measure === "topic" ? 1 : Math.max(1, Math.round(edit.target));
  const exam = edit.exam === undefined ? goal.exam : edit.exam ?? undefined;
  const next: Goal = {
    ...goal,
    name: edit.name.trim().slice(0, MAX_GOAL_NAME_LENGTH) || defaultGoalName({ ...goal, target }),
    target,
    days: goal.cadence === "daily" ? Math.max(1, Math.min(MAX_GOAL_DAYS, Math.round(edit.days))) : goal.days,
    deadline: edit.deadline > 0 ? edit.deadline : 0,
  };
  if (exam) next.exam = exam;
  else delete next.exam;
  return next;
}

/** The stored fields an edit changes, in the shape the goal's version keeps. */
export function goalEditFields(goal: Goal, edit: GoalEdit) {
  const next = applyGoalEdit(goal, edit);
  if (goal.schemaVersion === 1) {
    return { name: next.name, targetCards: next.target, deadline: next.deadline };
  }
  return {
    name: next.name,
    ...(goal.measure === "topic" ? {} : { target: next.target, targetCards: next.target }),
    ...(goal.cadence === "daily" ? { days: next.days } : {}),
    deadline: next.deadline,
    ...(edit.exam === undefined ? {} : { exam: next.exam ?? null }),
  };
}

/** The stored fields that record a goal's progress and state, in the shape its version keeps. */
export function goalProgressFields(goal: Goal) {
  const finished = goal.completedAt ? { completedAt: goal.completedAt } : {};
  if (goal.schemaVersion === 1) {
    return {
      progress: {
        cardsCompleted: goal.progress.count,
        correctAnswers: goal.progress.correct,
        totalAnswers: goal.progress.answered,
      },
      status: goal.status,
      ...finished,
    };
  }
  const { dayKey, demonstration, checkedAt, ...counts } = goal.progress;
  return {
    progress: {
      ...counts,
      ...(dayKey ? { dayKey } : {}),
      ...(demonstration ? { demonstration } : {}),
      ...(checkedAt ? { checkedAt } : {}),
    },
    status: goal.status,
    ...finished,
  };
}
