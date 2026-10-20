import {
  CLEARED_PLAN_ACTIVITY_TASK,
  MAX_PLAN_ACTIVITIES_PER_DAY,
  normalizePlanActivity,
  sortPlanActivities,
  type PlanActivityTask,
} from "@/lib/planning/plan-activities";
import type {
  PlanActivity,
  PlanActivityMethod,
  PlanActivityMode,
  PlanActivityTopic,
} from "@/lib/planning/types";

/**
 * Every change to the timetable, as data.
 *
 * One implementation per change, used by everything that changes a plan: the
 * student's own editing, a change Jami proposed and the student applied, undo,
 * a plan still being built and a plan that is running. A chat instruction and
 * a tap therefore cannot make two different versions of the same edit -- they
 * are the same op. And because an op is data, a running plan's write re-applies
 * it to the copy on the server, so an edit made on another device in between is
 * kept rather than overwritten.
 */

/**
 * A change to one activity. `null` clears a field.
 *
 * Changing what an activity *is* -- its title, method or topic -- makes it the
 * student's own fixed task, unless a whole `task` is given: that is a task
 * Jami chose, used when the student accepts a suggestion.
 */
export type PlanActivityPatch = {
  title?: string;
  method?: PlanActivityMethod;
  topic?: PlanActivityTopic | null;
  href?: string | null;
  minutes?: number;
  startTime?: string | null;
  scopeKey?: string | null;
  mode?: PlanActivityMode;
  task?: PlanActivityTask & { origin: "jami" | "student" };
};

export type TimetableOp =
  | { type: "add"; dayKey: string; activity: PlanActivity }
  | { type: "update"; dayKey: string; activityId: string; patch: PlanActivityPatch }
  | {
      type: "move";
      fromDayKey: string;
      toDayKey: string;
      activityId: string;
      startTime?: string | null;
      /** Used only when the target day already has an activity with this id. */
      fallbackId: string;
    }
  | {
      type: "duplicate";
      fromDayKey: string;
      toDayKey: string;
      activityId: string;
      newId: string;
      startTime?: string | null;
    }
  | { type: "remove"; dayKey: string; activityId: string }
  /** A rest day: everything off it. Different from removing each: the usual week does not refill it. */
  | { type: "clearDay"; dayKey: string }
  /**
   * A day set whole, by a fill or an undo. `null` hands it back to the usual week.
   *
   * `ifIds`: the activities the day held when the change was worked out. When
   * the day holds anything else by the time it is applied -- another device
   * planned it a moment ago -- the change is dropped rather than written over
   * what is there. A fill passes it; an undo, which means "put it back", does not.
   */
  | { type: "setDay"; dayKey: string; activities: PlanActivity[] | null; ifIds?: readonly string[] };

/** The days that have a timetable of their own. Absent means the usual week applies. */
export type TimetableDays = ReadonlyMap<string, readonly PlanActivity[]>;

export type TimetableOpContext = {
  /** The usual week's free sessions for a day with no timetable of its own. */
  freeSessionsFor: (dayKey: string) => PlanActivity[];
};

export type TimetableOpResult = {
  days: Map<string, PlanActivity[] | null>;
  /** Every day the ops changed, and what it now is (`null`: back to the usual week). */
  touched: Map<string, PlanActivity[] | null>;
};

function applyPatch(activity: PlanActivity, patch: PlanActivityPatch): PlanActivity {
  let next: PlanActivity = { ...activity };
  if (patch.task) {
    const { origin, ...task } = patch.task;
    next = {
      ...next,
      ...CLEARED_PLAN_ACTIVITY_TASK,
      ...task,
      origin,
      mode: origin === "jami" ? "adaptive" : "fixed",
      open: undefined,
    };
  } else if (patch.title !== undefined || patch.method !== undefined || patch.topic !== undefined) {
    const topic = patch.topic === undefined ? activity.topic : (patch.topic ?? undefined);
    next = {
      ...next,
      ...CLEARED_PLAN_ACTIVITY_TASK,
      title: patch.title ?? next.title,
      method: patch.method ?? next.method,
      ...(topic ? { topic } : {}),
      ...(patch.href ? { href: patch.href } : {}),
      origin: "student",
      mode: "fixed",
      open: undefined,
    };
  } else if (patch.href !== undefined) {
    next = { ...next, href: patch.href ?? undefined };
  }
  if (patch.minutes !== undefined) next.minutes = patch.minutes;
  if (patch.startTime !== undefined) next.startTime = patch.startTime ?? undefined;
  if (patch.scopeKey !== undefined) next.scopeKey = patch.scopeKey ?? undefined;
  if (patch.mode !== undefined) next.mode = patch.mode;
  return next;
}

function clean(activity: PlanActivity) {
  // Normalised after every change, so no op can leave an activity the store would refuse.
  return normalizePlanActivity(activity);
}

/** Applies ops in order. Ops naming an activity that is not there change nothing. */
export function applyTimetableOps(
  days: TimetableDays,
  ops: readonly TimetableOp[],
  context: TimetableOpContext
): TimetableOpResult {
  const state = new Map<string, PlanActivity[] | null>(
    [...days.entries()].map(([dayKey, activities]) => [dayKey, [...activities]])
  );
  const touched = new Map<string, PlanActivity[] | null>();

  /** The day's own list, made from its free sessions the first time it is changed. */
  const own = (dayKey: string): PlanActivity[] => {
    const existing = state.get(dayKey);
    if (existing) return existing;
    const made = context.freeSessionsFor(dayKey).map((activity) => ({ ...activity }));
    state.set(dayKey, made);
    return made;
  };
  const commit = (dayKey: string, activities: PlanActivity[] | null) => {
    const next = activities ? sortPlanActivities(activities).slice(0, MAX_PLAN_ACTIVITIES_PER_DAY) : null;
    state.set(dayKey, next);
    touched.set(dayKey, next);
  };
  const find = (dayKey: string, activityId: string) => {
    const list = own(dayKey);
    return { list, index: list.findIndex((activity) => activity.id === activityId) };
  };

  for (const op of ops) {
    switch (op.type) {
      case "add": {
        const activity = clean(op.activity);
        if (!activity) break;
        const list = own(op.dayKey);
        if (list.some((existing) => existing.id === activity.id)) break;
        commit(op.dayKey, [...list, activity]);
        break;
      }
      case "update": {
        const { list, index } = find(op.dayKey, op.activityId);
        if (index < 0) break;
        const updated = clean(applyPatch(list[index] as PlanActivity, op.patch));
        if (!updated) break;
        commit(op.dayKey, list.map((activity, at) => (at === index ? updated : activity)));
        break;
      }
      case "move": {
        if (op.fromDayKey === op.toDayKey) {
          const { list, index } = find(op.fromDayKey, op.activityId);
          if (index < 0 || op.startTime === undefined) break;
          const moved = clean({ ...(list[index] as PlanActivity), startTime: op.startTime ?? undefined });
          if (moved) commit(op.fromDayKey, list.map((activity, at) => (at === index ? moved : activity)));
          break;
        }
        const { list, index } = find(op.fromDayKey, op.activityId);
        if (index < 0) break;
        const activity = list[index] as PlanActivity;
        const target = own(op.toDayKey);
        const id = target.some((existing) => existing.id === activity.id) ? op.fallbackId : activity.id;
        const moved = clean({
          ...activity,
          id,
          ...(op.startTime !== undefined ? { startTime: op.startTime ?? undefined } : {}),
        });
        if (!moved) break;
        commit(op.fromDayKey, list.filter((_, at) => at !== index));
        commit(op.toDayKey, [...target, moved]);
        break;
      }
      case "duplicate": {
        const { list, index } = find(op.fromDayKey, op.activityId);
        if (index < 0) break;
        const target = own(op.toDayKey);
        if (target.some((existing) => existing.id === op.newId)) break;
        const copy = clean({
          ...(list[index] as PlanActivity),
          id: op.newId,
          ...(op.startTime !== undefined ? { startTime: op.startTime ?? undefined } : {}),
        });
        if (copy) commit(op.toDayKey, [...target, copy]);
        break;
      }
      case "remove": {
        const { list, index } = find(op.dayKey, op.activityId);
        if (index < 0) break;
        commit(op.dayKey, list.filter((_, at) => at !== index));
        break;
      }
      case "clearDay":
        commit(op.dayKey, []);
        break;
      case "setDay": {
        if (op.ifIds) {
          const now = (state.get(op.dayKey) ?? context.freeSessionsFor(op.dayKey)).map((activity) => activity.id).sort();
          const expected = [...op.ifIds].sort();
          if (now.length !== expected.length || now.some((id, index) => id !== expected[index])) break;
        }
        if (op.activities === null) {
          commit(op.dayKey, null);
          break;
        }
        const activities = op.activities.flatMap((activity) => {
          const cleaned = clean(activity);
          return cleaned ? [cleaned] : [];
        });
        commit(op.dayKey, activities);
        break;
      }
    }
  }

  return { days: state, touched };
}

/** The days an op reads or writes, so a write knows which documents to fetch first. */
export function timetableOpDays(op: TimetableOp): string[] {
  switch (op.type) {
    case "move":
    case "duplicate":
      return op.fromDayKey === op.toDayKey ? [op.fromDayKey] : [op.fromDayKey, op.toDayKey];
    default:
      return [op.dayKey];
  }
}
