import {
  PLAN_MAX_ITEMS_PER_DAY,
  PLAN_MAX_SESSIONS_PER_DAY,
  PLAN_MAX_SLOTS_PER_DAY,
  PLAN_MINUTES_MAX,
  PLAN_MINUTES_MIN,
  PLAN_MINUTES_PER_ITEM,
  PLAN_TIME_PATTERN,
  type PlanWeekday,
  type RevisionPlan,
  type RevisionPlanScope,
  type RevisionPlanSession,
} from "@/lib/planning/types";
import { shiftStudyDayKey, studyDaysBetween } from "@/lib/study/day";

/**
 * Which days a plan asks for, and how the time on one is divided.
 *
 * All calendar arithmetic here treats a day key as the plain date it prints,
 * never as a moment: a plan that says Monday means the student's Monday
 * wherever they are, and converting through a timestamp to find out which
 * weekday that is would make it depend on a timezone it has nothing to do with.
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

/** Whether a string is a wall-clock time this plan can use. */
export function isPlanTime(value: unknown): value is string {
  return typeof value === "string" && PLAN_TIME_PATTERN.test(value);
}

function planTimeMinutes(startTime: string) {
  const [hours, minutes] = startTime.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * When a sitting finishes, for reading.
 *
 * Clamped at the end of the day rather than rolling over, because a session
 * that started at 23:30 and ran an hour is a student who mistyped, and printing
 * "00:30" under a Monday would look like the plan had moved it to Tuesday.
 */
export function planSessionEndTime(startTime: string, minutes: number) {
  if (!isPlanTime(startTime)) return undefined;
  const end = Math.min(23 * 60 + 59, planTimeMinutes(startTime) + clampPlanMinutes(minutes));
  const hours = Math.floor(end / 60);
  return `${String(hours).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

/**
 * The sittings this day asks for, in the order they should be read.
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
          planTimeMinutes(left.session.startTime as string) -
          planTimeMinutes(right.session.startTime as string);
        // A tie keeps the order the student set rather than the sort's.
        return difference !== 0 ? difference : left.index - right.index;
      }
      if (leftTimed !== rightTimed) return leftTimed ? -1 : 1;
      return left.index - right.index;
    })
    .slice(0, PLAN_MAX_SESSIONS_PER_DAY)
    .map(({ session }) => session);
}

/** How long the plan asks for on this day, or 0 if it asks for nothing. */
export function planMinutesOn(sessions: readonly RevisionPlanSession[], dayKey: string) {
  return planSessionsOn(sessions, dayKey).reduce(
    (total, session) => total + clampPlanMinutes(session.minutes),
    0
  );
}

export function clampPlanMinutes(minutes: number) {
  if (!Number.isFinite(minutes)) return PLAN_MINUTES_MIN;
  return Math.round(Math.min(PLAN_MINUTES_MAX, Math.max(PLAN_MINUTES_MIN, minutes)));
}

/**
 * How many things to put in a session of this length.
 *
 * Time divided by roughly how long one thing takes, then capped -- because past
 * a handful, a session stops reading as a plan and starts reading as a list,
 * and the point of the cap is the feeling rather than the arithmetic. A long
 * session gets fewer, longer pieces of work rather than more of them.
 */
export function planItemCount(minutes: number) {
  const fits = Math.round(clampPlanMinutes(minutes) / PLAN_MINUTES_PER_ITEM);
  return Math.max(1, Math.min(PLAN_MAX_ITEMS_PER_DAY, fits));
}

/**
 * Which subject each slot of the day belongs to.
 *
 * Highest averages (Sainte-Lague): each slot goes to whichever scope has the
 * best weight-per-slot-already-taken. Two subjects weighted 2 and 1 over three
 * slots come out A, B, A rather than A, A, B -- the same share, spread through
 * the session instead of blocked at the front, which is both better revision
 * and what anyone would have written by hand.
 *
 * Deterministic: the same plan and the same day always give the same order, so
 * a slot id means the same thing from one read to the next.
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
 * How many pieces of work each sitting gets.
 *
 * Each session is sized from its own length, not from the day's total -- an
 * evening of 45 minutes then 30 is three things and two, not five spread evenly
 * across 75. The day is then capped, trimming the later sittings first, because
 * a day that has run past eight things has stopped being a plan; and the cap
 * never cuts below the pinned items, which the student put there on purpose.
 */
export function planSlotCounts(
  sessions: readonly RevisionPlanSession[],
  pinnedCount = 0
): number[] {
  const counts = sessions.map((session) => planItemCount(session.minutes));
  let total = counts.reduce((sum, count) => sum + count, 0);

  // Pinned work the sittings cannot hold grows the first one rather than being
  // dropped: a pin is a decision, and silently losing it is the worst outcome.
  if (total < pinnedCount && counts.length > 0) {
    counts[0] = (counts[0] as number) + (pinnedCount - total);
    total = pinnedCount;
  }

  const ceiling = Math.max(PLAN_MAX_SLOTS_PER_DAY, pinnedCount);
  for (let index = counts.length - 1; index >= 0 && total > ceiling; index -= 1) {
    const count = counts[index] as number;
    const trimmed = Math.max(1, count - (total - ceiling));
    total -= count - trimmed;
    counts[index] = trimmed;
  }
  return counts;
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

export function clampPlanWeight(weight: number) {
  if (!Number.isFinite(weight)) return 1;
  return Math.round(Math.min(3, Math.max(1, weight)));
}
