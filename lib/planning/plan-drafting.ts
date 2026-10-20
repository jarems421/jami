import {
  getCustomStudyHref,
  getDeckHref,
  getFolderHref,
  getNotebookHref,
  getQuestionPracticeSetupHref,
  getRevisionStartHref,
  getTopicHref,
} from "@/lib/app/routes";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import {
  PLAN_ACTIVITY_MINUTES_MIN,
  newPlanActivityId,
  planActivityTaskFromAction,
  planTimeAfter,
  sortPlanActivities,
  type PlanActivityTask,
} from "@/lib/planning/plan-activities";
import { planWeekStartDayKey } from "@/lib/planning/plan-schedule";
import { shiftStudyDayKey } from "@/lib/study/day";
import type { TimetableDay } from "@/lib/planning/timetable";
import type { TimetableOp } from "@/lib/planning/timetable-ops";
import {
  planScopeFromKey,
  planScopeKey,
  type PlanActivity,
  type PlanActivityDone,
  type PlanActivityMethod,
  type PlanActivityTopic,
  type RevisionPlanScope,
} from "@/lib/planning/types";

/**
 * Jami filling free sessions with work, when the student asks it to.
 *
 * Deterministic, and every task in it comes from somewhere a student can check.
 * A free session is split into one to four activities by its length, and each
 * gets the Learning Engine's next action for its subject, in the engine's own
 * order, used at most once across the days being filled -- so a week reads
 * homeostasis, then enzymes, then cell division, not homeostasis five times.
 * When the engine has nothing more for a subject, the task falls back to what
 * that subject certainly has: its due cards, or its exam questions. When it
 * has neither, the time stays an honest free session rather than a task that
 * pretends.
 *
 * No language model chooses content here. A conversation can ask for a fill;
 * it cannot say what goes in it.
 */

/** What a subject can always be revised with, when the engine has nothing to add. */
export type PlanSubjectSupport = {
  /** Decks in the subject, for a review of its cards. */
  deckIds: readonly string[];
  cardCount: number;
  /** A real question bank to practise from, by its folder. */
  questionPracticeFolderId?: string;
};

export type PlanDraftingContext = {
  actionsByScope: ReadonlyMap<string, readonly StudyAction[]>;
  support: ReadonlyMap<string, PlanSubjectSupport>;
  random?: () => number;
};

/**
 * What each of the plan's subjects can fall back on.
 *
 * Built from what the planner already holds -- decks, their cards, the folder's
 * course -- so it costs nothing to know.
 */
export function buildPlanSubjectSupport(input: {
  scopes: readonly Pick<RevisionPlanScope, "folderId" | "deckId">[];
  decks: readonly { id: string; folderIds?: readonly string[] }[];
  cards: readonly { deckId: string }[];
  /** Folders with a verified exam course, where Past Paper Practice can serve questions. */
  questionPracticeFolderIds: ReadonlySet<string>;
}): Map<string, PlanSubjectSupport> {
  const cardsByDeck = new Map<string, number>();
  for (const card of input.cards) cardsByDeck.set(card.deckId, (cardsByDeck.get(card.deckId) ?? 0) + 1);
  const support = new Map<string, PlanSubjectSupport>();
  for (const scope of input.scopes) {
    const deckIds = scope.folderId
      ? input.decks.filter((deck) => deck.folderIds?.includes(scope.folderId as string)).map((deck) => deck.id)
      : scope.deckId
        ? [scope.deckId]
        : [];
    const withCards = deckIds.filter((id) => (cardsByDeck.get(id) ?? 0) > 0);
    support.set(planScopeKey(scope), {
      deckIds: withCards,
      cardCount: withCards.reduce((total, id) => total + (cardsByDeck.get(id) ?? 0), 0),
      ...(scope.folderId && input.questionPracticeFolderIds.has(scope.folderId)
        ? { questionPracticeFolderId: scope.folderId }
        : {}),
    });
  }
  return support;
}

function roundToFive(minutes: number) {
  return Math.max(PLAN_ACTIVITY_MINUTES_MIN, Math.round(minutes / 5) * 5);
}

/**
 * How a sitting's time is shared out: one piece up to half an hour, a main
 * piece and a shorter one up to an hour (45 is 30 and 15), and two to four even
 * pieces beyond that. Past four, a session stops reading as a plan and starts
 * reading as a list.
 */
export function splitSessionMinutes(minutes: number): number[] {
  const total = Math.max(PLAN_ACTIVITY_MINUTES_MIN, Math.round(minutes));
  if (total <= 30) return [total];
  if (total <= 60) {
    const first = Math.min(total - PLAN_ACTIVITY_MINUTES_MIN, roundToFive((total * 2) / 3));
    return [first, total - first];
  }
  const count = Math.min(4, Math.max(2, Math.round(total / 35)));
  const each = Math.floor(total / count / 5) * 5;
  const parts = Array.from({ length: count }, () => each);
  let left = total - each * count;
  for (let index = 0; left > 0; index = (index + 1) % count) {
    const step = Math.min(5, left);
    parts[index] = (parts[index] as number) + step;
    left -= step;
  }
  return parts;
}

/** Due cards, or exam questions: what a subject always has, taken in turn. */
export function fallbackPlanTask(support: PlanSubjectSupport | undefined, turn: number): PlanActivityTask | null {
  if (!support) return null;
  const options: PlanActivityTask[] = [];
  if (support.cardCount > 0) {
    options.push({
      title: "Review your cards",
      method: "flashcards",
      href: getCustomStudyHref({ mode: "custom", deckIds: [...support.deckIds] }),
    });
  }
  if (support.questionPracticeFolderId) {
    options.push({
      title: "Exam questions",
      method: "practice",
      href: getQuestionPracticeSetupHref({ folderId: support.questionPracticeFolderId }),
    });
  }
  return options.length > 0 ? (options[turn % options.length] as PlanActivityTask) : null;
}

/**
 * Where a task the student set up goes when they start it.
 *
 * Built from what they chose -- the method, the subject, a topic, a notebook --
 * onto pages that exist: a session over their own cards, the question bank, a
 * Revision Session, the notebook, the folder. A task like "finish my homework"
 * has nowhere to go and says so by having no link.
 */
export function studentTaskHref(input: {
  method: PlanActivityMethod;
  scopeKey?: string;
  topic?: PlanActivityTopic;
  notebookId?: string;
  support: ReadonlyMap<string, PlanSubjectSupport>;
}): string | undefined {
  const scope = input.scopeKey ? planScopeFromKey(input.scopeKey) : null;
  const support = input.scopeKey ? input.support.get(input.scopeKey) : undefined;
  const topic = input.topic;
  switch (input.method) {
    case "flashcards":
      if (topic?.kind === "topic") return getCustomStudyHref({ mode: "custom", topicIds: [topic.id] });
      if (topic?.kind === "deck") return getCustomStudyHref({ mode: "custom", deckIds: [topic.id] });
      if (support && support.deckIds.length > 0) return getCustomStudyHref({ mode: "custom", deckIds: [...support.deckIds] });
      if (scope?.deckId) return getCustomStudyHref({ mode: "custom", deckIds: [scope.deckId] });
      return scope ? undefined : getCustomStudyHref({ mode: "daily" });
    case "practice":
      if (support?.questionPracticeFolderId) return getQuestionPracticeSetupHref({ folderId: support.questionPracticeFolderId });
      return scope?.folderId ? getFolderHref(scope.folderId, "practice") : undefined;
    case "revision":
      return getRevisionStartHref(scope?.folderId ? { folderId: scope.folderId } : {});
    case "notebook":
      if (input.notebookId) return getNotebookHref(input.notebookId);
      return scope?.folderId ? getFolderHref(scope.folderId) : undefined;
    case "notes":
      if (topic?.kind === "topic") return getTopicHref(topic.id);
      if (topic?.kind === "deck") return getDeckHref(topic.id);
      if (scope?.folderId) return getFolderHref(scope.folderId, "sources");
      return scope?.deckId ? getDeckHref(scope.deckId) : undefined;
    default:
      return undefined;
  }
}

/** Hands out a subject's next task, never the same action twice. */
function taskDealer(context: PlanDraftingContext, alreadyPlanned: ReadonlySet<string>) {
  const used = new Set(alreadyPlanned);
  const cursor = new Map<string, number>();
  const fallbackTurn = new Map<string, number>();
  return (scopeKey: string): PlanActivityTask | null => {
    const actions = context.actionsByScope.get(scopeKey) ?? [];
    let index = cursor.get(scopeKey) ?? 0;
    while (index < actions.length) {
      const action = actions[index] as StudyAction;
      index += 1;
      // Only work that leads somewhere: a task the student cannot start is worse than an honest gap.
      if (!action.destination || used.has(action.id)) continue;
      used.add(action.id);
      cursor.set(scopeKey, index);
      return planActivityTaskFromAction(action);
    }
    cursor.set(scopeKey, index);
    const turn = fallbackTurn.get(scopeKey) ?? 0;
    fallbackTurn.set(scopeKey, turn + 1);
    return fallbackPlanTask(context.support.get(scopeKey), turn);
  };
}

/** Engine actions already on a set of days, so a fill elsewhere does not repeat them. */
export function plannedActionIds(days: readonly { activities: readonly Pick<PlanActivity, "actionId">[] }[]) {
  const ids = new Set<string>();
  for (const day of days) for (const activity of day.activities) if (activity.actionId) ids.add(activity.actionId);
  return ids;
}

/**
 * Free sessions on some days, filled.
 *
 * Takes each day's activities as they stand -- stored, or the usual week's free
 * sessions -- and returns the new list for every day that changed. Activities
 * that already have a task are left exactly where they are; only open time is
 * filled, and only open time with a subject, because choosing the subject is
 * the student's (or their plan's weighting), not this function's. `only`
 * narrows it to particular free sessions: "Let Jami pick" on one of them fills
 * that one, not the rest of its day.
 */
export function fillFreeSessions(input: {
  days: readonly { dayKey: string; activities: readonly PlanActivity[] }[];
  context: PlanDraftingContext;
  alreadyPlanned?: ReadonlySet<string>;
  only?: ReadonlySet<string>;
}): Map<string, PlanActivity[]> {
  const deal = taskDealer(input.context, input.alreadyPlanned ?? new Set());
  const random = input.context.random ?? Math.random;
  const changed = new Map<string, PlanActivity[]>();
  const ordered = [...input.days].sort((left, right) => left.dayKey.localeCompare(right.dayKey));

  for (const day of ordered) {
    let touched = false;
    const next: PlanActivity[] = [];
    for (const activity of sortPlanActivities(day.activities)) {
      if (!activity.open || !activity.scopeKey || (input.only && !input.only.has(activity.id))) {
        next.push(activity);
        continue;
      }
      const parts = splitSessionMinutes(activity.minutes);
      let startTime = activity.startTime;
      let unfilled = 0;
      let filled = false;
      for (const minutes of parts) {
        const task = deal(activity.scopeKey);
        if (!task) {
          unfilled += minutes;
          continue;
        }
        touched = true;
        filled = true;
        next.push({
          id: newPlanActivityId(random),
          ...task,
          minutes,
          ...(startTime ? { startTime } : {}),
          scopeKey: activity.scopeKey,
          mode: "adaptive",
          origin: "jami",
          ...(activity.routineId ? { routineId: activity.routineId } : {}),
        });
        startTime = planTimeAfter(startTime, minutes);
      }
      if (!filled) {
        next.push(activity);
        continue;
      }
      // What could not be filled stays free time, at the end of the session, rather than vanishing.
      if (unfilled > 0) {
        next.push({
          ...activity,
          id: newPlanActivityId(random),
          minutes: unfilled,
          ...(startTime ? { startTime } : {}),
        });
      }
    }
    if (touched) changed.set(day.dayKey, sortPlanActivities(next));
  }
  return changed;
}

/**
 * The days Jami keeps filled for a plan that asks it to: the rest of this week
 * and all of next. Far enough ahead that next Thursday already says what it is;
 * near enough that what it says is still what the evidence would choose.
 */
export function planAutoFillWindow(todayDayKey: string) {
  return { fromDayKey: todayDayKey, toDayKey: shiftStudyDayKey(planWeekStartDayKey(todayDayKey), 13) };
}

export type PlanFillOutcome = {
  ops: TimetableOp[];
  /** How many tasks Jami put in. */
  added: number;
  /**
   * Subjects with free time Jami could find nothing for: no recommendation
   * left, no cards, no exam questions. Said to the student, so a fill that
   * leaves time free never looks like a button that did nothing.
   */
  unfilledScopeKeys: string[];
};

/**
 * A fill, as ops: each changed day set whole, but only if it still holds what
 * the fill was worked out from. Shared by the Fill buttons, by Jami keeping the
 * coming days filled, and by a fill Jami proposed in conversation.
 */
export function planFill(
  days: readonly { dayKey: string; activities: readonly PlanActivity[] }[],
  context: PlanDraftingContext,
  options: { alreadyPlanned?: ReadonlySet<string>; only?: ReadonlySet<string> } = {}
): PlanFillOutcome {
  const filled = fillFreeSessions({
    days,
    context,
    alreadyPlanned: options.alreadyPlanned ?? plannedActionIds(days),
    ...(options.only ? { only: options.only } : {}),
  });
  let added = 0;
  const unfilled = new Set<string>();
  for (const day of days) {
    const before = new Set(day.activities.map((activity) => activity.id));
    const after = filled.get(day.dayKey) ?? day.activities;
    added += after.filter((activity) => !activity.open && !before.has(activity.id)).length;
    for (const activity of day.activities) {
      if (!activity.open || !activity.scopeKey || (options.only && !options.only.has(activity.id))) continue;
      // A free session left whole keeps its id; one Jami filled even partly does not.
      if (after.some((item) => item.id === activity.id)) unfilled.add(activity.scopeKey);
    }
  }
  return {
    ops: [...filled].map(([dayKey, activities]) => ({
      type: "setDay" as const,
      dayKey,
      activities,
      ifIds: (days.find((day) => day.dayKey === dayKey)?.activities ?? []).map((activity) => activity.id),
    })),
    added,
    unfilledScopeKeys: [...unfilled],
  };
}

/**
 * What the student is told when Jami was asked to pick and some of that time
 * is still free: which subjects it had nothing for. Null when it filled
 * everything it was asked to.
 */
export function planFillNotice(
  outcome: { picked: number; unfilledScopeKeys: readonly string[] },
  scopeName: (scopeKey: string) => string
) {
  if (outcome.unfilledScopeKeys.length === 0) return null;
  const names = outcome.unfilledScopeKeys.map(scopeName);
  const list = names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return outcome.picked > 0
    ? `Jami filled what it could. There's nothing more to pick from in ${list} yet, so the rest stays free time.`
    : `Jami has nothing to pick from in ${list} yet: no cards, exam questions or marked work there. Choose the task yourself instead.`;
}

/** The ops of a fill, for the callers that need nothing else from it. */
export function planFillOps(
  days: readonly { dayKey: string; activities: readonly PlanActivity[] }[],
  context: PlanDraftingContext,
  alreadyPlanned: ReadonlySet<string> = plannedActionIds(days)
): TimetableOp[] {
  return planFill(days, context, { alreadyPlanned }).ops;
}

/**
 * Whether a day is still exactly as Jami drafted it: nothing done, nothing the
 * student chose or kept, only free time and Jami's adaptive picks. Such a day
 * may be drafted again when the usual week changes; any other day is the
 * student's, and is left alone.
 */
export function isUntouchedDraftDay(
  activities: readonly PlanActivity[],
  done: Readonly<Record<string, PlanActivityDone>> | undefined
) {
  return activities.every(
    (activity) =>
      !done?.[activity.id] && (activity.open || (activity.origin === "jami" && activity.mode === "adaptive"))
  );
}

export type PlanRefreshSuggestion = {
  dayKey: string;
  activityId: string;
  /** What Jami would put there now. */
  task: PlanActivityTask;
};

/**
 * Where Jami would now choose differently, said rather than done.
 *
 * Only adaptive tasks still to do -- Jami's picks, and any the student said
 * Jami may adapt -- in a subject the engine has just answered for, so a failed
 * read never reads as "everything has changed". A
 * task the engine still recommends is left alone, however it now ranks it:
 * churn is worse than a slightly older order. A suggestion is made only when
 * the planned work is no longer recommended at all (learnt, resting after a
 * recent attempt) or was a fallback the engine now has something specific for.
 */
export function planRefreshSuggestions(input: {
  days: readonly TimetableDay[];
  actionsByScope: ReadonlyMap<string, readonly StudyAction[]>;
  answeredScopes: ReadonlySet<string>;
}): PlanRefreshSuggestion[] {
  const used = plannedActionIds(input.days);
  const suggestions: PlanRefreshSuggestion[] = [];
  for (const day of input.days) {
    if (day.isPast) continue;
    for (const activity of day.activities) {
      if (
        activity.open ||
        activity.completion ||
        activity.mode !== "adaptive" ||
        !activity.scopeKey ||
        !input.answeredScopes.has(activity.scopeKey)
      ) {
        continue;
      }
      const current = (input.actionsByScope.get(activity.scopeKey) ?? []).filter((action) => action.destination);
      if (activity.actionId && current.some((action) => action.id === activity.actionId)) continue;
      const replacement = current.find((action) => !used.has(action.id));
      if (!replacement) continue;
      used.add(replacement.id);
      suggestions.push({ dayKey: day.dayKey, activityId: activity.id, task: planActivityTaskFromAction(replacement) });
    }
  }
  return suggestions;
}
