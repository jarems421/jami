import {
  cleanActivityTitle,
  normalizePlanActivities,
  normalizePlanActivityDone,
  planActivitiesMinutes,
} from "@/lib/planning/plan-activities";
import {
  planDayCompletion,
  type PlanActivityCompletion,
  type PlanCompletionEvidence,
} from "@/lib/planning/plan-completion";
import {
  clampPlanMinutes,
  clampPlanWeight,
  isWithinPlanHorizon,
  planDaysBetween,
  planSessionsOn,
  planWeekStartDayKey,
  planWeekdayOf,
} from "@/lib/planning/plan-schedule";
import {
  PLAN_MINUTES_PER_ITEM,
  isOwnPlanTask,
  planScopeKey,
  type PlanActivity,
  type PlanActivityDone,
  type PlanActivityMethod,
  type PlanWeekday,
  type RevisionPlan,
  type RevisionPlanEntry,
  type RevisionPlanExam,
} from "@/lib/planning/types";
import { shiftStudyDayKey } from "@/lib/study/day";

/**
 * A day of the plan as the student reads it.
 *
 * A day with a timetable of its own shows exactly that, every activity where
 * it was put. A day without one -- a week nobody has planned yet -- shows the
 * usual week's sittings as free sessions: time set aside, honestly empty,
 * waiting for the student or Jami to say what it is for. Nothing here promises
 * that a task will appear on its own.
 *
 * Pure. The caller hands in the plan, the stored days and whatever evidence of
 * work it has, so the same function serves Today, the planner and the tests.
 */

export type PlanFreeSession = {
  routineId: string;
  startTime?: string;
  minutes: number;
  /** The subject it goes to: the sitting's own, or its turn in the week's rotation. */
  scopeKey?: string;
  label?: string;
};

/** The id a free session carries, the same whether it is shown from the usual week or stored. */
export function freeSessionActivityId(routineId: string) {
  return `routine-${routineId}`;
}

/** Whether a subject still has an exam ahead on this day, or never had one. */
function stillRevising(plan: Pick<RevisionPlan, "exams">, scopeKey: string, dayKey: string) {
  const exams = (plan.exams ?? []).filter((exam) => exam.scopeKey === scopeKey);
  return exams.length === 0 || exams.some((exam) => planDaysBetween(dayKey, exam.dayKey) >= 0);
}

/**
 * The usual week's sittings on one date, each with the subject it goes to.
 *
 * Unpinned sittings take turns between the plan's subjects across the week, by
 * weight (highest averages, as `planScopeSequence`), so three Biology-heavy
 * evenings read Biology, Chemistry, Biology rather than Biology three times. A
 * subject whose last exam has gone drops out of the rotation: nobody should be
 * timetabled for Chemistry the day after the Chemistry paper. A sitting the
 * student pinned to a subject keeps it whatever.
 */
export function planFreeSessionsOn(
  plan: Pick<RevisionPlan, "status" | "startDayKey" | "endDayKey" | "sessions" | "scopes" | "exams">,
  dayKey: string
): PlanFreeSession[] {
  if (plan.status !== "active" || !isWithinPlanHorizon(plan, dayKey)) return [];
  const weekStart = planWeekStartDayKey(dayKey);
  const scopes = plan.scopes.map((scope) => ({ key: planScopeKey(scope), weight: clampPlanWeight(scope.weight) }));
  const taken = new Map<string, number>();

  for (let offset = 0; offset < 7; offset += 1) {
    const day = shiftStudyDayKey(weekStart, offset);
    const sittings = isWithinPlanHorizon(plan, day) ? planSessionsOn(plan.sessions, day) : [];
    const sessions: PlanFreeSession[] = [];
    for (const sitting of sittings) {
      let scopeKey = sitting.scopeKey;
      if (!scopeKey) {
        let best: { key: string; score: number } | null = null;
        for (const scope of scopes) {
          if (!stillRevising(plan, scope.key, day)) continue;
          const score = scope.weight / (2 * (taken.get(scope.key) ?? 0) + 1);
          // Ties go to the earlier subject, which is the order the student set.
          if (!best || score > best.score) best = { key: scope.key, score };
        }
        if (best) {
          taken.set(best.key, (taken.get(best.key) ?? 0) + 1);
          scopeKey = best.key;
        }
      }
      sessions.push({
        routineId: sitting.id,
        minutes: clampPlanMinutes(sitting.minutes),
        ...(sitting.startTime ? { startTime: sitting.startTime } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        ...(sitting.label ? { label: sitting.label } : {}),
      });
    }
    // Later days never change an earlier one's turn.
    if (day === dayKey) return sessions;
  }
  return [];
}

/** A free session as an activity: open, its subject's if it has one, adaptable by Jami. */
export function openActivityFromFreeSession(session: PlanFreeSession): PlanActivity {
  return {
    id: freeSessionActivityId(session.routineId),
    title: "",
    method: "other",
    minutes: session.minutes,
    ...(session.startTime ? { startTime: session.startTime } : {}),
    ...(session.scopeKey ? { scopeKey: session.scopeKey } : {}),
    mode: session.scopeKey ? "adaptive" : "fixed",
    origin: "student",
    open: true,
    routineId: session.routineId,
  };
}

/** How a version 2 pinned task was done, read from where its link went. */
function methodFromHref(href: string | undefined): PlanActivityMethod {
  if (!href) return "other";
  if (href.startsWith("/dashboard/study")) return "flashcards";
  if (href.startsWith("/dashboard/practice") || href.includes("tab=practice")) return "practice";
  if (href.startsWith("/dashboard/revision")) return "revision";
  if (href.startsWith("/dashboard/notebooks")) return "notebook";
  if (href.startsWith("/dashboard/topics") || href.startsWith("/dashboard/decks")) return "notes";
  return "other";
}

/**
 * A version 2 day with tasks pinned to it, read as a timetable.
 *
 * Its sittings become free sessions, less the time its pinned tasks take, and
 * each pinned task becomes a fixed activity in the sitting it was added to. A
 * tick on a pinned task is kept; a tick on one of the engine's positional
 * slots cannot be -- the slot it pointed at no longer exists.
 */
function legacyDay(plan: RevisionPlan, entry: RevisionPlanEntry) {
  const pinned = entry.pinned ?? [];
  const free = planFreeSessionsOn(plan, entry.dayKey);
  const ticks = new Set(entry.completedSlotIds ?? []);
  const tasks: PlanActivity[] = [];
  const done: Record<string, PlanActivityDone> = {};
  const usedMinutes = new Map<string, number>();

  pinned.forEach((item, index) => {
    const sitting = free.find((session) => session.routineId === item.sessionId) ?? free[0];
    const own = isOwnPlanTask(item);
    const id = `legacy-${index}`;
    tasks.push({
      id,
      title: cleanActivityTitle(item.label) || "Study",
      method: own ? "other" : methodFromHref(item.href),
      minutes: PLAN_MINUTES_PER_ITEM,
      ...(sitting?.startTime ? { startTime: sitting.startTime } : {}),
      ...(sitting?.scopeKey ? { scopeKey: sitting.scopeKey } : {}),
      mode: "fixed",
      origin: own ? "student" : "jami",
      ...(item.href?.startsWith("/dashboard") ? { href: item.href } : {}),
      ...(!own && item.actionId ? { actionId: item.actionId } : {}),
      ...(sitting ? { routineId: sitting.routineId } : {}),
    });
    if (sitting) usedMinutes.set(sitting.routineId, (usedMinutes.get(sitting.routineId) ?? 0) + PLAN_MINUTES_PER_ITEM);
    if (ticks.has(`pin:${item.actionId}`)) done[id] = { by: "manual", at: entry.updatedAt ?? 0 };
  });

  const open = free.flatMap((session) => {
    const left = session.minutes - (usedMinutes.get(session.routineId) ?? 0);
    return left >= 5 ? [openActivityFromFreeSession({ ...session, minutes: left })] : [];
  });
  return { activities: normalizePlanActivities([...open, ...tasks]), done };
}

/**
 * A day's own timetable, or null when the usual week applies.
 *
 * Stored activities win; a version 2 day with pinned tasks is read into one; a
 * version 2 day off is a rest day. Anything else has nothing of its own.
 */
export function storedPlanDay(
  plan: RevisionPlan,
  entry: RevisionPlanEntry | null | undefined
): { activities: PlanActivity[]; done: Record<string, PlanActivityDone> } | null {
  if (!entry) return null;
  if (Array.isArray(entry.activities)) {
    return { activities: normalizePlanActivities(entry.activities), done: normalizePlanActivityDone(entry.done) };
  }
  if (entry.pinned && entry.pinned.length > 0) return legacyDay(plan, entry);
  if (entry.skipped) return { activities: [], done: {} };
  return null;
}

export type TimetableActivity = PlanActivity & {
  /** Present when it was done: ticked, or seen done. */
  completion?: PlanActivityCompletion;
  /** A free session shown from the usual week; nothing about it is stored yet. */
  computed?: true;
};

/**
 * planned: the day has its own timetable. flexible: the usual week's free
 * sessions, not planned yet. rest: nothing asked of this day.
 */
export type TimetableDayKind = "planned" | "flexible" | "rest";

export type TimetableDay = {
  dayKey: string;
  weekday: PlanWeekday;
  withinPlan: boolean;
  isToday: boolean;
  isPast: boolean;
  kind: TimetableDayKind;
  activities: TimetableActivity[];
  minutes: number;
  /** Activities with something to do in them; a free session is time, not a task. */
  taskCount: number;
  doneCount: number;
  openCount: number;
  exams: RevisionPlanExam[];
  /** Activities seen done on this read that are not written down yet, for the caller to keep. */
  observed: string[];
};

export function resolveTimetableDay(input: {
  plan: RevisionPlan;
  dayKey: string;
  entry?: RevisionPlanEntry | null;
  todayDayKey: string;
  evidence?: PlanCompletionEvidence;
  now?: number;
}): TimetableDay {
  const { plan, dayKey, todayDayKey } = input;
  const own = storedPlanDay(plan, input.entry);
  const withinPlan = plan.status === "active" && isWithinPlanHorizon(plan, dayKey);
  const base: PlanActivity[] = own ? own.activities : planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession);
  const completion = planDayCompletion(dayKey, base, own?.done, input.evidence, input.now);
  const activities: TimetableActivity[] = base.map((activity) => {
    const done = completion.get(activity.id);
    return { ...activity, ...(done ? { completion: done } : {}), ...(own ? {} : { computed: true as const }) };
  });
  const tasks = activities.filter((activity) => !activity.open);
  const distance = planDaysBetween(todayDayKey, dayKey);
  return {
    dayKey,
    weekday: planWeekdayOf(dayKey),
    withinPlan,
    isToday: distance === 0,
    isPast: distance < 0,
    kind: own ? (own.activities.length > 0 ? "planned" : "rest") : activities.length > 0 ? "flexible" : "rest",
    activities,
    minutes: planActivitiesMinutes(activities),
    taskCount: tasks.length,
    doneCount: tasks.filter((activity) => activity.completion).length,
    openCount: activities.length - tasks.length,
    exams: (plan.exams ?? []).filter((exam) => exam.dayKey === dayKey),
    observed: [...completion.entries()].filter(([, done]) => done.observed).map(([id]) => id),
  };
}

/** Several days, each resolved the same way. */
export function resolveTimetableDays(input: {
  plan: RevisionPlan;
  dayKeys: readonly string[];
  entries: readonly RevisionPlanEntry[];
  todayDayKey: string;
  evidence?: PlanCompletionEvidence;
  now?: number;
}): TimetableDay[] {
  const byDayKey = new Map(input.entries.map((entry) => [entry.dayKey, entry]));
  return input.dayKeys.map((dayKey) =>
    resolveTimetableDay({
      plan: input.plan,
      dayKey,
      entry: byDayKey.get(dayKey) ?? null,
      todayDayKey: input.todayDayKey,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    })
  );
}

/** A resolved activity as the stored thing it was read from, for an op or a fill. */
export function planActivityOf(activity: TimetableActivity): PlanActivity {
  const plain: PlanActivity & { completion?: unknown; computed?: unknown } = { ...activity };
  delete plain.completion;
  delete plain.computed;
  return plain;
}

/** The next thing to do on a day: the first task not yet done, in the order the day runs. */
export function timetableUpNext(day: TimetableDay | null | undefined): TimetableActivity | null {
  if (!day) return null;
  return day.activities.find((activity) => !activity.open && !activity.completion) ?? null;
}

/** A day in a word or two, for a list of the week: "Done", "2 of 3", "1h 15m", "Free", "Rest". */
export function timetableDayState(day: TimetableDay): { text: string; done: boolean } {
  if (day.kind === "rest") return { text: "Rest", done: false };
  if (day.taskCount > 0 && day.doneCount >= day.taskCount) return { text: "Done", done: true };
  if (day.isToday) return { text: "Today", done: false };
  if (day.doneCount > 0) return { text: `${day.doneCount} of ${day.taskCount}`, done: false };
  if (day.kind === "flexible") return { text: "Free", done: false };
  const hours = Math.floor(day.minutes / 60);
  const minutes = day.minutes % 60;
  return { text: hours > 0 ? `${hours}h${minutes ? ` ${minutes}m` : ""}` : `${minutes}m`, done: false };
}
