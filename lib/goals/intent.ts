import { blankGoalDraft } from "@/lib/goals/drafts";
import { GOAL_MEASURES, type GoalDraft, type GoalMeasure } from "@/lib/goals/model";
import { examGoalDraft, type GoalSuggestionExam } from "@/lib/goals/suggestions";
import { getStudyDayKey } from "@/lib/study/day";

/**
 * A link that opens the goal composer already set up.
 *
 * Other screens can offer "set a goal for this" -- the planner does, for an
 * exam -- by linking here with what they know, rather than each building a
 * goal of its own. The link only fills the composer in; the student still
 * creates the goal.
 */

export const GOALS_PATH = "/dashboard/goals";

export type GoalIntent = { measure?: GoalMeasure; exam?: GoalSuggestionExam };

export function goalIntentHref(intent: GoalIntent = {}) {
  const params = new URLSearchParams({ new: intent.measure ?? "1" });
  const exam = intent.exam;
  if (exam) {
    params.set("plan", exam.planId);
    params.set("exam", exam.examId);
    params.set("examLabel", exam.label);
    params.set("examDay", exam.dayKey);
    if (exam.folderId) params.set("folder", exam.folderId);
    if (exam.folderName) params.set("folderName", exam.folderName);
  }
  return `${GOALS_PATH}?${params.toString()}`;
}

function read(params: Pick<URLSearchParams, "get">, key: string, max: number) {
  return (params.get(key) ?? "").trim().slice(0, max);
}

/** What a goals link asked for, or null when it asked for nothing. */
export function readGoalIntent(params: Pick<URLSearchParams, "get">): GoalIntent | null {
  const requested = params.get("new");
  if (!requested) return null;
  const measure = (GOAL_MEASURES as readonly string[]).includes(requested) ? (requested as GoalMeasure) : undefined;
  const planId = read(params, "plan", 160);
  const examId = read(params, "exam", 160);
  const label = read(params, "examLabel", 120);
  const dayKey = read(params, "examDay", 10);
  const folderId = read(params, "folder", 160);
  const folderName = read(params, "folderName", 120);
  const exam =
    planId && examId && label && /^\d{4}-\d{2}-\d{2}$/.test(dayKey)
      ? {
          planId,
          examId,
          label,
          dayKey,
          ...(folderId ? { folderId } : {}),
          ...(folderName ? { folderName } : {}),
        }
      : undefined;
  return { ...(measure ? { measure } : {}), ...(exam ? { exam } : {}) };
}

/** The draft a goals link opens with. */
export function draftForIntent(intent: GoalIntent, now: number): GoalDraft {
  if (intent.exam) return examGoalDraft(intent.exam, getStudyDayKey(now));
  return blankGoalDraft(intent.measure ?? "cards", now);
}
