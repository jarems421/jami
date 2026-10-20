import {
  getStudyDayKey,
  getStudyDayStartFromKey,
  shiftStudyDayKey,
  studyDaysBetween,
} from "@/lib/study/day";

/**
 * When a goal is due, in study days.
 *
 * A deadline is the end of a study day -- the 4am boundary the rest of the app
 * keys on -- rather than a clock time the student has to pick. Asking for a time
 * as well made every goal a seven-field form, and "by 23:59 on Sunday" is what
 * nearly everyone meant anyway. Goals made with a time keep it.
 */

/** The last moment of a study day. */
export function endOfStudyDay(dayKey: string) {
  return getStudyDayStartFromKey(shiftStudyDayKey(dayKey, 1)) - 1;
}

/** The study day a deadline falls in. */
export function goalDeadlineDayKey(deadline: number) {
  return getStudyDayKey(deadline);
}

/** The end of the coming Sunday, or of today when today is Sunday. */
export function thisWeekDeadline(now: number) {
  const todayKey = getStudyDayKey(now);
  const [year, month, day] = todayKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return endOfStudyDay(shiftStudyDayKey(todayKey, (7 - weekday) % 7));
}

/**
 * The deadline for a goal set for an exam: the end of the day before it.
 *
 * Work on the morning of the exam is not revision for it, so a goal "for the
 * exam" that counted the exam day itself would be due an evening too late.
 */
export function examDeadline(examDayKey: string) {
  return endOfStudyDay(shiftStudyDayKey(examDayKey, -1));
}

/** Study days left including today, up to and including the deadline's own; 0 once it has passed. */
export function studyDaysLeft(deadline: number, now: number) {
  if (deadline <= 0 || deadline < now) return 0;
  return studyDaysBetween(getStudyDayKey(now), goalDeadlineDayKey(deadline)) + 1;
}

function dateLabel(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export type GoalDeadlineTone = "none" | "calm" | "soon" | "today" | "passed";

/** "Due today", "Due tomorrow", "Due Sun 26 Oct", "No deadline", and how pressing that is. */
export function describeGoalDeadline(deadline: number, now: number): { label: string; tone: GoalDeadlineTone } {
  if (deadline <= 0) return { label: "No deadline", tone: "none" };
  if (deadline < now) return { label: "Time's up", tone: "passed" };
  const days = studyDaysLeft(deadline, now);
  if (days <= 1) return { label: "Due today", tone: "today" };
  if (days === 2) return { label: "Due tomorrow", tone: "soon" };
  const label = `Due ${dateLabel(goalDeadlineDayKey(deadline))}`;
  return { label, tone: days <= 4 ? "soon" : "calm" };
}

/** A study day as a short date, "Sun 26 Oct". */
export function goalDayLabel(dayKey: string) {
  return dateLabel(dayKey);
}
