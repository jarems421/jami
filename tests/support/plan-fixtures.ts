import type { StudyAction } from "@/lib/learning/actions/study-actions";
import type { PlanActivity, RevisionPlan } from "@/lib/planning/types";

/**
 * Plans, activities and engine actions for the planner's tests.
 *
 * Monday 19 October 2026 is the week most tests read: today is the Tuesday.
 */

export const MONDAY = "2026-10-19";
export const TUESDAY = "2026-10-20";
export const WEDNESDAY = "2026-10-21";
export const THURSDAY = "2026-10-22";
export const FRIDAY = "2026-10-23";
export const SATURDAY = "2026-10-24";
export const SUNDAY = "2026-10-25";
export const NEXT_MONDAY = "2026-10-26";

export function revisionPlan(overrides: Partial<RevisionPlan> = {}): RevisionPlan {
  return {
    id: "plan-1",
    schemaVersion: 3,
    title: "Summer exams",
    status: "active",
    origin: "manual",
    startDayKey: MONDAY,
    endDayKey: "2026-11-30",
    scopes: [
      { folderId: "biology", weight: 2 },
      { folderId: "chemistry", weight: 1 },
    ],
    sessions: [
      { id: "mon", weekday: 1, minutes: 45, startTime: "17:00" },
      { id: "wed", weekday: 3, minutes: 30, startTime: "18:00" },
      { id: "fri", weekday: 5, minutes: 45, startTime: "17:00" },
    ],
    emphasis: [],
    autoFill: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function planActivity(overrides: Partial<PlanActivity> & { id: string }): PlanActivity {
  return {
    title: overrides.id,
    method: "practice",
    minutes: 30,
    scopeKey: "folder:biology",
    mode: "fixed",
    origin: "student",
    ...overrides,
  };
}

/** One of the engine's actions for a topic in a folder, leading somewhere. */
export function studyAction(
  id: string,
  overrides: Partial<StudyAction> & { folderId?: string } = {}
): StudyAction {
  const { folderId = "biology", ...rest } = overrides;
  return {
    id: `folder:${folderId}|low_mastery|topic:${id}`,
    reason: "low_mastery",
    action: "practice",
    priority: 0.5,
    target: { kind: "topic", topicKey: `topic:${id}`, source: "student-topic", label: id },
    evidence: { count: 4, uniqueItems: 3, sources: ["practice"] },
    scope: { folderId },
    explanationCode: "low_mastery.practice",
    destination: {
      kind: "question-practice",
      href: `/dashboard/practice/questions/new?folderId=${folderId}&topics=${id}`,
      selection: { topicIds: [id] },
    },
    spec: { emphasis: "application", targetItems: 6 },
    ...rest,
  } as StudyAction;
}
