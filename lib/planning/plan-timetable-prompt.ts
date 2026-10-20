import type { PlanSubjectOption } from "@/lib/ai/assistant-plan";
import { PLAN_ACTIVITY_METHOD_LABELS, normalizePlanActivities } from "@/lib/planning/plan-activities";
import { shortPlanDate } from "@/lib/planning/plan-format";
import { isPlanDayKey, planDaysBetween, planWeekStartDayKey } from "@/lib/planning/plan-schedule";
import { planScopeKey, type PlanActivity } from "@/lib/planning/types";
import { shiftStudyDayKey } from "@/lib/study/day";

/**
 * The timetable and the calendar, written for the model.
 *
 * Two things the model gets wrong if it is left to work them out, so it never
 * is. Dates: told only "today is 2026-10-20", it has to compute which date
 * "next Thursday" is, and a model off by one weekday puts an exam or a session
 * on the wrong day -- so it is handed every date it may need, with its weekday.
 * Activities: it refers to them by a ref (A1, A2) handed out here and resolved
 * back here, never by an id it could invent.
 */

/** One day of the timetable as the student's screen shows it. */
export type PlanTimetableDay = {
  dayKey: string;
  activities: PlanActivity[];
  /** Activities already done, which the model may not change. */
  doneIds: string[];
};

/** The most days of timetable one planning message carries: the week on screen, and either side of it. */
export const MAX_PLAN_TIMETABLE_DAYS = 21;
/** How far the calendar reaches, past which the model is told to ask rather than guess. */
const CALENDAR_WEEKS = 8;

/**
 * The days a client sent, bounded and cleaned. Nothing from the request reaches
 * the prompt without passing through here.
 */
export function readPlanTimetableDays(raw: unknown): PlanTimetableDay[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const days: PlanTimetableDay[] = [];
  for (const item of raw) {
    if (days.length >= MAX_PLAN_TIMETABLE_DAYS) break;
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (!isPlanDayKey(entry.dayKey) || seen.has(entry.dayKey)) continue;
    seen.add(entry.dayKey);
    const activities = normalizePlanActivities(entry.activities);
    const ids = new Set(activities.map((activity) => activity.id));
    const doneIds = Array.isArray(entry.doneIds)
      ? entry.doneIds.filter((id): id is string => typeof id === "string" && ids.has(id))
      : [];
    days.push({ dayKey: entry.dayKey, activities, doneIds });
  }
  return days.sort((left, right) => left.dayKey.localeCompare(right.dayKey));
}

/**
 * Every date the model may need, a week to a line, from the Monday of this
 * week to the plan's end or eight weeks on, whichever is sooner.
 */
export function planCalendarLines(todayDayKey: string, planEndDayKey?: string) {
  const start = planWeekStartDayKey(todayDayKey);
  const weeksToEnd =
    planEndDayKey && isPlanDayKey(planEndDayKey) ? Math.ceil((planDaysBetween(start, planEndDayKey) + 1) / 7) : 0;
  const weeks = Math.min(CALENDAR_WEEKS, Math.max(4, weeksToEnd));
  return Array.from({ length: weeks }, (_, week) => {
    const days = Array.from({ length: 7 }, (_, offset) => {
      const dayKey = shiftStudyDayKey(start, week * 7 + offset);
      return `${shortPlanDate(dayKey).split(" ")[0]} ${dayKey}`;
    });
    return `${week === 0 ? "This week" : week === 1 ? "Next week" : `Week of ${shortPlanDate(shiftStudyDayKey(start, week * 7)).slice(4)}`}: ${days.join(", ")}`;
  });
}

function describeActivity(
  activity: PlanActivity,
  subjectRef: (scopeKey: string | undefined) => string,
  done: boolean
) {
  const parts = [activity.startTime ?? "any time", `${activity.minutes} min`, subjectRef(activity.scopeKey)];
  if (activity.open) {
    parts.push("free session, nothing chosen yet");
  } else {
    parts.push(JSON.stringify(activity.title), PLAN_ACTIVITY_METHOD_LABELS[activity.method].toLowerCase());
    parts.push(activity.mode === "adaptive" ? "Jami's pick (adaptive)" : "fixed");
  }
  if (done) parts.push("done");
  return parts.join(" · ");
}

/**
 * The timetable as lines, and the map from each line's ref back to its activity.
 *
 * Refs run in date and time order across every day shown, so "A3" means the
 * same activity in the prompt and in the model's answer, and nowhere else.
 */
export function describePlanTimetable(days: readonly PlanTimetableDay[], subjects: readonly PlanSubjectOption[]) {
  const refByScope = new Map(
    subjects.map((subject) => [
      planScopeKey(subject.folderId ? { folderId: subject.folderId } : { deckId: subject.deckId }),
      subject.ref,
    ])
  );
  const subjectRef = (scopeKey: string | undefined) =>
    scopeKey ? (refByScope.get(scopeKey) ?? "another subject") : "no subject";
  const refs = new Map<string, { dayKey: string; activityId: string; done: boolean }>();
  const lines: string[] = [];
  for (const day of days) {
    const label = shortPlanDate(day.dayKey);
    if (day.activities.length === 0) {
      lines.push(`- ${label} (${day.dayKey}): nothing planned`);
      continue;
    }
    for (const activity of day.activities) {
      const ref = `A${refs.size + 1}`;
      const done = day.doneIds.includes(activity.id);
      refs.set(ref, { dayKey: day.dayKey, activityId: activity.id, done });
      lines.push(`- ${ref} · ${label} (${day.dayKey}) · ${describeActivity(activity, subjectRef, done)}`);
    }
  }
  return { text: lines.join("\n"), refs };
}
