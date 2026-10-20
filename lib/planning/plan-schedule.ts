import {
  PLAN_MAX_SESSIONS_PER_DAY,
  PLAN_MINUTES_MAX,
  PLAN_MINUTES_MIN,
  PLAN_TIME_PATTERN,
  type PlanWeekday,
  type RevisionPlan,
  type RevisionPlanScope,
  type RevisionPlanSession,
} from "@/lib/planning/types";
import { shiftStudyDayKey, studyDaysBetween } from "@/lib/study/day";

/**
 * Calendar and clock arithmetic for a plan.
 *
 * All of it treats a day key as the plain date it prints, never as a moment: a
 * plan that says Monday means the student's Monday wherever they are, and
 * converting through a timestamp to find out which weekday that is would make
 * it depend on a timezone it has nothing to do with.
 */

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isPlanDayKey(value: unknown): value is string {
  return typeof value === "string" && DAY_KEY_PATTERN.test(value);
}

/**
 * The weekday a day key falls on, 0 for Sunday.
 *
 * Read through `Date.UTC` rather than the local constructor, so the answer is
 * the calendar's and not the reader's.
 */
export function planWeekdayOf(dayKey: string): PlanWeekday {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay() as PlanWeekday;
}

/** Whole days from one key to another, negative if the second is earlier. Goals count days the same way. */
export const planDaysBetween = studyDaysBetween;

export function isWithinPlanHorizon(plan: Pick<RevisionPlan, "startDayKey" | "endDayKey">, dayKey: string) {
  return (
    planDaysBetween(plan.startDayKey, dayKey) >= 0 &&
    planDaysBetween(dayKey, plan.endDayKey) >= 0
  );
}

/** Every day key from one to another, both included. Empty when the second is earlier. */
export function planDayKeysBetween(fromDayKey: string, toDayKey: string, max = 400) {
  const count = Math.min(max, planDaysBetween(fromDayKey, toDayKey) + 1);
  return Array.from({ length: Math.max(0, count) }, (_, offset) => shiftStudyDayKey(fromDayKey, offset));
}

/** Whether a string is a wall-clock time this plan can use. */
export function isPlanTime(value: unknown): value is string {
  return typeof value === "string" && PLAN_TIME_PATTERN.test(value);
}

/** "16:30" as 990. */
export function planTimeMinutes(startTime: string) {
  const [hours, minutes] = startTime.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** 990 as "16:30", wrapped onto the clock. */
export function planTimeFromMinutes(total: number) {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/**
 * Where a clock time falls in a study day, in minutes from its start.
 *
 * A study day runs from 4am to 4am (`lib/study/day.ts`), so half past midnight
 * belongs at the end of the evening before rather than at the top of the list
 * -- sorting by the clock alone put a student's 00:30 session above their
 * 17:00 one on the same day.
 */
export const STUDY_DAY_START_MINUTES = 4 * 60;

export function studyDayMinutes(startTime: string) {
  return (planTimeMinutes(startTime) - STUDY_DAY_START_MINUTES + 1440) % 1440;
}

/**
 * When a sitting finishes, for reading.
 *
 * Clamped at the end of the study day rather than rolling over, because a
 * session that started at 03:30 and ran an hour is a student who mistyped, and
 * printing a time after 4am under it would look like the plan had moved it to
 * the next day.
 */
export function planSessionEndTime(startTime: string, minutes: number) {
  if (!isPlanTime(startTime)) return undefined;
  const start = studyDayMinutes(startTime);
  const end = Math.min(1439, start + Math.max(0, Math.round(minutes)));
  return planTimeFromMinutes(end + STUDY_DAY_START_MINUTES);
}

/**
 * The sittings this day of the usual week asks for, in the order they are read.
 *
 * Timed sessions come first, in time order, and untimed ones follow in the
 * order the student set them. Mixing the two by position instead would put a
 * session with no time above one at nine in the morning purely because it was
 * added first, which is not what anybody means by a timetable.
 */
export function planSessionsOn(
  sessions: readonly RevisionPlanSession[],
  dayKey: string
): RevisionPlanSession[] {
  const weekday = planWeekdayOf(dayKey);
  return sessions
    .filter((session) => session.weekday === weekday)
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const leftTimed = isPlanTime(left.session.startTime);
      const rightTimed = isPlanTime(right.session.startTime);
      if (leftTimed && rightTimed) {
        const difference =
          studyDayMinutes(left.session.startTime as string) -
          studyDayMinutes(right.session.startTime as string);
        // A tie keeps the order the student set rather than the sort's.
        return difference !== 0 ? difference : left.index - right.index;
      }
      if (leftTimed !== rightTimed) return leftTimed ? -1 : 1;
      return left.index - right.index;
    })
    .slice(0, PLAN_MAX_SESSIONS_PER_DAY)
    .map(({ session }) => session);
}

export function clampPlanMinutes(minutes: number) {
  if (!Number.isFinite(minutes)) return PLAN_MINUTES_MIN;
  return Math.round(Math.min(PLAN_MINUTES_MAX, Math.max(PLAN_MINUTES_MIN, minutes)));
}

/**
 * Which subject each sitting goes to.
 *
 * Highest averages (Sainte-Lague): each place goes to whichever scope has the
 * best weight-per-place-already-taken. Two subjects weighted 2 and 1 over three
 * sittings come out A, B, A rather than A, A, B -- the same share, spread
 * through the week instead of blocked at the front, which is both better
 * revision and what anyone would have written by hand.
 *
 * Deterministic: the same plan and the same week always give the same order.
 */
export function planScopeSequence(
  scopes: readonly RevisionPlanScope[],
  slots: number,
  scopeKeyOf: (scope: RevisionPlanScope) => string
) {
  const usable = scopes.filter((scope) => clampPlanWeight(scope.weight) > 0);
  if (usable.length === 0 || slots <= 0) return [];

  const taken = usable.map(() => 0);
  const sequence: string[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    let best = 0;
    let bestScore = -Infinity;
    usable.forEach((scope, index) => {
      const score = clampPlanWeight(scope.weight) / (2 * (taken[index] ?? 0) + 1);
      // Ties go to the earlier scope, which is the order the student set.
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    taken[best] = (taken[best] ?? 0) + 1;
    sequence.push(scopeKeyOf(usable[best] as RevisionPlanScope));
  }
  return sequence;
}

/**
 * The day key the week containing this one starts on.
 *
 * Monday by default. `PLAN_WEEKDAYS` is Sunday-first because `Date#getDay` is,
 * but a week a student reads starts on a Monday, and the two are different
 * questions.
 */
export function planWeekStartDayKey(dayKey: string, firstWeekday: PlanWeekday = 1) {
  const offset = (planWeekdayOf(dayKey) - firstWeekday + 7) % 7;
  return shiftStudyDayKey(dayKey, -offset);
}

/** The first day of the month a day key is in. */
export function planMonthStartDayKey(dayKey: string) {
  return `${dayKey.slice(0, 7)}-01`;
}

/** The first day of the month after the one a day key is in. */
export function planNextMonthStartDayKey(dayKey: string) {
  const [year, month] = dayKey.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 1970, month ?? 1, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function clampPlanWeight(weight: number) {
  if (!Number.isFinite(weight)) return 1;
  return Math.round(Math.min(3, Math.max(1, weight)));
}
