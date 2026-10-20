import { MAX_PLAN_SESSION_MINUTES } from "@/lib/planning/plan-activities";
import type { TimetableActivity, TimetableDay } from "@/lib/planning/timetable";

/**
 * Planned notebook work, in the notebook it is for.
 *
 * A student who plans "Notebook work · Enzymes · 30 min" should find it waiting
 * when they open that notebook, start it there, and finish it there -- and the
 * plan should know. So a notebook offers today's planned notebook work that
 * belongs to it: activities set in this very notebook first, then those set
 * for any notebook in its folder. Finishing writes the tick and how long it
 * ran (`by: "activity"`), the record the planner, Today and Jami's planning
 * all read.
 *
 * It is a clock and a tick. Nothing on the page is read for it, and nothing
 * about it is learner evidence: like any plan tick, it says the student sat
 * down to the work, not what they know.
 */

export type PlanNotebookRef = { id: string; folderId: string };

/** Today's planned work for this notebook, its own first. */
export function notebookPlanActivities(
  day: Pick<TimetableDay, "activities"> | null | undefined,
  notebook: PlanNotebookRef
): TimetableActivity[] {
  if (!day) return [];
  const notebookWork = day.activities.filter((activity) => !activity.open && activity.method === "notebook");
  const folderKey = `folder:${notebook.folderId}`;
  return [
    ...notebookWork.filter((activity) => activity.notebookId === notebook.id),
    ...notebookWork.filter((activity) => !activity.notebookId && activity.scopeKey === folderKey),
  ];
}

/** A session started in a notebook, kept until it is finished or stopped. */
export type PlanNotebookSession = {
  planId: string;
  dayKey: string;
  activityId: string;
  startedAt: number;
};

/** How long a session has run, in whole minutes: at least one, never past what a sitting could be. */
export function planSessionMinutes(startedAt: number, now: number) {
  return Math.min(MAX_PLAN_SESSION_MINUTES, Math.max(1, Math.round((now - startedAt) / 60_000)));
}

/** Seconds left of the planned length; negative once it has run over. */
export function planSessionSecondsLeft(startedAt: number, minutes: number, now: number) {
  return Math.round((startedAt + minutes * 60_000 - now) / 1000);
}

/** "12:04" to go, or "+2:10" over. */
export function formatPlanSessionClock(seconds: number) {
  const total = Math.abs(Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  const clock = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
  return seconds < 0 ? `+${clock}` : clock;
}

/**
 * A stored session read back. Null when what is stored is not one, or is one
 * nobody finished: a session older than any sitting could be was abandoned,
 * and offering to finish it would tick work at the wrong length.
 */
export function readPlanNotebookSession(value: unknown, now: number): PlanNotebookSession | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const startedAt = Number(raw.startedAt);
  const text = (field: unknown) => (typeof field === "string" && field.trim() && field.length <= 128 ? field : null);
  const planId = text(raw.planId);
  const dayKey = text(raw.dayKey);
  const activityId = text(raw.activityId);
  if (!planId || !dayKey || !activityId || !Number.isFinite(startedAt) || startedAt > now) return null;
  if (now - startedAt > MAX_PLAN_SESSION_MINUTES * 60_000) return null;
  return { planId, dayKey, activityId, startedAt };
}
