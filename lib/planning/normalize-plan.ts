import {
  clampPlanMinutes,
  clampPlanWeight,
  isPlanDayKey,
  isPlanTime,
  planDaysBetween,
} from "@/lib/planning/plan-schedule";
import {
  PLAN_MAX_HORIZON_DAYS,
  PLAN_MAX_SESSIONS_PER_DAY,
  PLAN_WEEKDAYS,
  planScopeKey,
  type PlanWeekday,
  type RevisionPlanDraft,
  type RevisionPlanEmphasis,
  type RevisionPlanExam,
  type RevisionPlanScope,
  type RevisionPlanSession,
} from "@/lib/planning/types";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";

/**
 * A plan forced into a shape the rest of the app can rely on.
 *
 * One function for both ways a plan is made. The student's own builder is
 * bounded by its controls, so most of this never fires for them; a plan drafted
 * by Jami arrives as whatever a language model produced, and is not trusted at
 * all. Running both through the same gate means the builder can never be the
 * only thing standing between a bad value and Firestore.
 */

export const MAX_PLAN_SCOPES = 6;
export const MAX_PLAN_TITLE_LENGTH = 80;
export const MAX_PLAN_NOTE_LENGTH = 240;
export const MAX_PLAN_SESSION_LABEL_LENGTH = 40;

export type PlanValidationProblem =
  | "no-scopes"
  | "no-sessions"
  | "bad-dates"
  | "horizon-too-long"
  | "overlapping-sessions";

export type NormalizedPlanDraft = {
  draft: RevisionPlanDraft;
  problems: PlanValidationProblem[];
  /**
   * Problems that stop a plan being saved.
   *
   * Overlapping sittings are told to the student and then allowed: two things
   * booked at half four is usually a student rearranging their week, and
   * refusing to save it would trap them halfway through the edit.
   */
  valid: boolean;
};

const BLOCKING_PROBLEMS: ReadonlySet<PlanValidationProblem> = new Set([
  "no-scopes",
  "no-sessions",
  "bad-dates",
  "horizon-too-long",
]);

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeScopes(input: unknown): RevisionPlanScope[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const scopes: RevisionPlanScope[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Partial<RevisionPlanScope>;
    const folderId = cleanText(candidate.folderId, 128);
    const deckId = cleanText(candidate.deckId, 128);
    // One or the other, never both: a scope is one profile, and the Learning
    // Engine builds a profile for a folder or for a deck.
    if (!folderId && !deckId) continue;
    const scope: RevisionPlanScope = folderId
      ? { folderId, weight: clampPlanWeight(candidate.weight ?? 1) }
      : { deckId, weight: clampPlanWeight(candidate.weight ?? 1) };
    const key = planScopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push(scope);
    if (scopes.length >= MAX_PLAN_SCOPES) break;
  }
  return scopes;
}

/**
 * The week's sittings, bounded.
 *
 * Version 1 kept one entry per weekday and silently merged any others, because
 * the shape could not hold a second sitting. It can now, so the de-duplication
 * is gone and the cap is per day instead -- four sittings in one evening is
 * already further than anybody plans, and past that the arithmetic in
 * `resolvePlanDay` starts producing days nobody could do.
 *
 * A bad `startTime` costs the time, not the session: a student who typed
 * something odd into the clock still meant to study that day, and dropping the
 * whole sitting would quietly delete it.
 */
function normalizeSessions(
  input: unknown,
  scopes: readonly RevisionPlanScope[]
): RevisionPlanSession[] {
  if (!Array.isArray(input)) return [];
  const allowedScopes = new Set(scopes.map(planScopeKey));
  const perWeekday = new Map<PlanWeekday, number>();
  const usedIds = new Set<string>();
  const sessions: RevisionPlanSession[] = [];

  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Partial<RevisionPlanSession>;
    const weekday = Number(candidate.weekday);
    if (!PLAN_WEEKDAYS.includes(weekday as PlanWeekday)) continue;

    const day = weekday as PlanWeekday;
    const onDay = perWeekday.get(day) ?? 0;
    if (onDay >= PLAN_MAX_SESSIONS_PER_DAY) continue;
    perWeekday.set(day, onDay + 1);

    // An id that arrived twice is not an id. Regenerating the duplicate keeps
    // React keys and per-session editing honest without losing the sitting.
    const given = cleanText(candidate.id, 64);
    const id = given && !usedIds.has(given) ? given : `w${day}-${onDay}-${sessions.length}`;
    usedIds.add(id);

    const scopeKey = cleanText(candidate.scopeKey, 160);
    const label = cleanText(candidate.label, MAX_PLAN_SESSION_LABEL_LENGTH);

    sessions.push({
      id,
      weekday: day,
      minutes: clampPlanMinutes(Number(candidate.minutes)),
      ...(isPlanTime(candidate.startTime) ? { startTime: candidate.startTime } : {}),
      // A sitting pinned to a subject the plan does not cover is a stray
      // reference, exactly as a stray emphasis would be, and a drafted plan is
      // where one would appear.
      ...(scopeKey && allowedScopes.has(scopeKey) ? { scopeKey } : {}),
      ...(label ? { label } : {}),
    });
  }

  return sessions.sort((left, right) => left.weekday - right.weekday);
}

/**
 * Whether two timed sittings on the same day collide.
 *
 * Only timed ones can: two sessions with no clock times are a morning and an
 * afternoon, and saying they overlap would be inventing a conflict the student
 * never expressed.
 */
function hasOverlappingSessions(sessions: readonly RevisionPlanSession[]) {
  const byWeekday = new Map<PlanWeekday, { start: number; end: number }[]>();
  for (const session of sessions) {
    if (!isPlanTime(session.startTime)) continue;
    const [hours, minutes] = session.startTime.split(":").map(Number);
    const start = (hours ?? 0) * 60 + (minutes ?? 0);
    const span = { start, end: start + clampPlanMinutes(session.minutes) };
    const existing = byWeekday.get(session.weekday) ?? [];
    if (existing.some((other) => span.start < other.end && other.start < span.end)) return true;
    existing.push(span);
    byWeekday.set(session.weekday, existing);
  }
  return false;
}

function normalizeEmphasis(
  input: unknown,
  scopes: readonly RevisionPlanScope[]
): RevisionPlanEmphasis[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(scopes.map(planScopeKey));
  const seen = new Set<string>();
  const emphasis: RevisionPlanEmphasis[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Partial<RevisionPlanEmphasis>;
    const scopeKey = cleanText(candidate.scopeKey, 160);
    // Emphasis on a subject the plan does not cover is not emphasis, it is a
    // stray reference -- and a drafted plan is exactly where one would appear.
    if (!allowed.has(scopeKey) || seen.has(scopeKey)) continue;
    seen.add(scopeKey);
    const note = cleanText(candidate.note, MAX_PLAN_NOTE_LENGTH);
    emphasis.push({
      scopeKey,
      wants: candidate.wants === "practice" ? "practice" : "diagnose",
      ...(note ? { note } : {}),
    });
  }
  return emphasis;
}

export const MAX_PLAN_EXAMS = 12;
export const MAX_PLAN_EXAM_LABEL_LENGTH = 60;

/**
 * The exams a plan counts down to, in date order.
 *
 * Kept even when they fall outside the plan's own dates: a plan that stops a
 * week before the exam is a real choice, and the countdown should still know
 * when the exam is. A subject the plan does not cover is dropped from the exam
 * rather than dropping the exam.
 */
/**
 * An exam id no exam in the list has.
 *
 * Numbered from the count, a new id repeated a saved one whenever an earlier
 * exam had been removed -- and the id is the form row's key as well as the
 * exam's identity, so the two rows then edited each other.
 */
export function unusedPlanExamId(exams: readonly Pick<RevisionPlanExam, "id">[]) {
  const taken = new Set(exams.map((exam) => exam.id));
  let number = exams.length + 1;
  while (taken.has(`exam-${number}`)) number += 1;
  return `exam-${number}`;
}

function normalizeExams(input: unknown, scopes: readonly RevisionPlanScope[]): RevisionPlanExam[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(scopes.map(planScopeKey));
  const exams: RevisionPlanExam[] = [];
  for (const raw of input) {
    if (exams.length >= MAX_PLAN_EXAMS) break;
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Partial<RevisionPlanExam>;
    const label = cleanText(candidate.label, MAX_PLAN_EXAM_LABEL_LENGTH);
    if (!label || !isPlanDayKey(candidate.dayKey)) continue;
    const scopeKey = cleanText(candidate.scopeKey, 160);
    const id = cleanText(candidate.id, 60);
    exams.push({
      id: id && !exams.some((exam) => exam.id === id) ? id : unusedPlanExamId(exams),
      label,
      dayKey: candidate.dayKey,
      ...(allowed.has(scopeKey) ? { scopeKey } : {}),
    });
  }
  return exams.sort((left, right) => left.dayKey.localeCompare(right.dayKey));
}

/**
 * Anything at all, turned into a plan and told what is wrong with it.
 *
 * Returns the draft even when it is invalid, so a half-finished plan in the
 * builder still renders what the student has set so far and the problems read
 * as guidance rather than as a wall.
 *
 * A plan needs either a usual week or something on its timetable: a student
 * who placed three activities by hand has a plan, with no weekly pattern at
 * all. Subjects are needed only for the usual week, whose sittings take turns
 * between them; an activity carries its own.
 */
export function normalizeRevisionPlanDraft(
  input: Partial<RevisionPlanDraft> | null | undefined,
  now = Date.now(),
  options: { activityCount?: number } = {}
): NormalizedPlanDraft {
  const today = getStudyDayKey(now);
  const scopes = normalizeScopes(input?.scopes);
  const sessions = normalizeSessions(input?.sessions, scopes);
  const startDayKey = isPlanDayKey(input?.startDayKey) ? input.startDayKey : today;
  const endDayKey = isPlanDayKey(input?.endDayKey)
    ? input.endDayKey
    : shiftStudyDayKey(startDayKey, 27);
  const activityCount = Math.max(0, options.activityCount ?? 0);

  const exams = normalizeExams(input?.exams, scopes);
  const problems: PlanValidationProblem[] = [];
  if (scopes.length === 0 && (sessions.length > 0 || activityCount === 0)) problems.push("no-scopes");
  if (sessions.length === 0 && activityCount === 0) problems.push("no-sessions");
  if (hasOverlappingSessions(sessions)) problems.push("overlapping-sessions");
  const span = planDaysBetween(startDayKey, endDayKey);
  if (span < 0) problems.push("bad-dates");
  else if (span >= PLAN_MAX_HORIZON_DAYS) problems.push("horizon-too-long");

  return {
    draft: {
      title: cleanText(input?.title, MAX_PLAN_TITLE_LENGTH) || "Revision plan",
      status: input?.status === "archived" ? "archived" : "active",
      origin: input?.origin === "tutor" ? "tutor" : "manual",
      startDayKey,
      endDayKey,
      scopes,
      sessions,
      emphasis: normalizeEmphasis(input?.emphasis, scopes),
      ...(exams.length > 0 ? { exams } : {}),
      ...(typeof input?.autoFill === "boolean" ? { autoFill: input.autoFill } : {}),
    },
    problems,
    valid: problems.every((problem) => !BLOCKING_PROBLEMS.has(problem)),
  };
}

export const PLAN_PROBLEM_MESSAGES: Record<PlanValidationProblem, string> = {
  "no-scopes": "Choose at least one subject to revise.",
  "no-sessions": "Add something to your timetable, or pick the days you usually study.",
  "bad-dates": "The finish date is before the start date.",
  "horizon-too-long": "A plan can run for up to about a year.",
  "overlapping-sessions": "Two sessions clash. You can save it, but check the times.",
};
