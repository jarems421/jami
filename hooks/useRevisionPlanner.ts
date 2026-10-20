"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JAMI_FILL_LABEL, usePlanAutoFill } from "@/hooks/usePlanAutoFill";
import { usePlanCompletion } from "@/hooks/usePlanCompletion";
import { usePlanDrafting } from "@/hooks/usePlanDrafting";
import { usePlanEdits } from "@/hooks/usePlanEdits";
import { usePlanTimetable } from "@/hooks/usePlanTimetable";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import {
  isUntouchedDraftDay,
  planFillOps,
  planRefreshSuggestions,
  type PlanRefreshSuggestion,
} from "@/lib/planning/plan-drafting";
import { MAX_PLAN_TIMETABLE_DAYS, type PlanTimetableDay } from "@/lib/planning/plan-timetable-prompt";
import { planDayKeysBetween, planDaysBetween } from "@/lib/planning/plan-schedule";
import {
  openActivityFromFreeSession,
  planActivityOf,
  planFreeSessionsOn,
  resolveTimetableDays,
  storedPlanDay,
} from "@/lib/planning/timetable";
import type { TimetableOp } from "@/lib/planning/timetable-ops";
import { plannerRange, type PlannerView } from "@/lib/planning/planner-view";
import {
  REVISION_PLAN_SCHEMA_VERSION,
  type PlanActivity,
  type RevisionPlan,
  type RevisionPlanDraft,
  type RevisionPlanEntry,
} from "@/lib/planning/types";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";
import { createRevisionPlan, saveRevisionPlan } from "@/services/planning/revision-plans";

/**
 * The planner, as one controller: which days are on screen, what is on them,
 * and every way they change.
 *
 * Building a plan and running one are the same screen. Built, the plan is the
 * interview's draft and the timetable lives in memory until it is saved; run,
 * both are saved as they change. Every edit -- a tap, a proposal from Jami, a
 * fill -- goes through the same ops (`usePlanEdits`), with the same undo.
 */

/** The days Jami drafts and keeps filled ahead: the first fortnight of a new plan, and a fortnight on. */
const FILL_AHEAD_DAYS = 14;

function draftAsPlan(draft: RevisionPlanDraft): RevisionPlan {
  const { draft: safe } = normalizeRevisionPlanDraft(draft);
  return {
    ...safe,
    id: "draft",
    schemaVersion: REVISION_PLAN_SCHEMA_VERSION,
    autoFill: safe.autoFill ?? safe.origin === "tutor",
    createdAt: 0,
    updatedAt: 0,
  };
}

function newPlanId() {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useRevisionPlanner(input: {
  uid: string;
  /** The running plan, or null while one is being built from `draft`. */
  savedPlan: RevisionPlan | null;
  initialEntries?: readonly RevisionPlanEntry[];
  draft: RevisionPlanDraft;
  onDraftChange: (draft: RevisionPlanDraft) => void;
  onPlanSaved: (plan: RevisionPlan, days?: ReadonlyMap<string, PlanActivity[]>) => void;
  folders: readonly { id: string; name: string; examCourse?: unknown }[];
  decks: readonly { id: string; folderIds?: readonly string[] }[];
  cards: readonly { id: string; deckId: string; topicIds?: readonly string[]; lastReview?: number }[];
}) {
  const { uid, savedPlan, onDraftChange, onPlanSaved } = input;
  const mode = savedPlan ? "live" : "draft";
  const todayDayKey = getStudyDayKey();
  const plan = useMemo(() => savedPlan ?? draftAsPlan(input.draft), [input.draft, savedPlan]);
  const [view, setView] = useState<PlannerView>("week");
  const [anchor, setAnchor] = useState(() =>
    planDaysBetween(todayDayKey, plan.startDayKey) > 0 ? plan.startDayKey : todayDayKey
  );
  const range = plannerRange(view, anchor);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");

  /*
   * The plan itself, changed alongside the timetable: settings, a subject an
   * activity brought in, a date past the plan's end, a proposal from Jami.
   * Saved straight away for a running plan; kept in the draft for one being built.
   */
  const changePlan = useCallback(
    async (next: RevisionPlanDraft) => {
      if (!savedPlan) {
        onDraftChange(next);
        return true;
      }
      try {
        onPlanSaved(await saveRevisionPlan(uid, savedPlan.id, next, { activityCount: 1 }));
        return true;
      } catch {
        setProblem("Your plan could not be saved. Try again.");
        return false;
      }
    },
    [onDraftChange, onPlanSaved, savedPlan, uid]
  );

  const timetable = usePlanTimetable({
    uid,
    plan,
    mode,
    fromDayKey: range.fromDayKey,
    toDayKey: range.toDayKey,
    ...(input.initialEntries ? { initialEntries: input.initialEntries } : {}),
    onRestorePlan: (before) => void changePlan(before),
  });

  const evidence = usePlanCompletion({
    uid,
    enabled: mode === "live",
    fromDayKey: range.fromDayKey,
    toDayKey: range.toDayKey,
    todayDayKey,
    cards: input.cards,
    decks: input.decks,
  });

  const { entries, apply } = timetable;
  const days = useMemo(
    () =>
      resolveTimetableDays({
        plan,
        dayKeys: planDayKeysBetween(range.fromDayKey, range.toDayKey),
        entries: [...entries.values()],
        todayDayKey,
        ...(evidence ? { evidence } : {}),
      }),
    [entries, evidence, plan, range.fromDayKey, range.toDayKey, todayDayKey]
  );

  // One request for the plan's subjects, kept for the visit: fills, suggestions and proposals all draw on it.
  const drafting = usePlanDrafting({
    scopes: plan.scopes,
    decks: input.decks,
    cards: input.cards,
    folders: input.folders,
    enabled: plan.scopes.length > 0,
  });

  const edits = usePlanEdits({ plan, timetable, days, drafting, todayDayKey, changePlan });

  const fillAhead = useMemo(
    () => days.filter((day) => day.dayKey >= todayDayKey && planDaysBetween(todayDayKey, day.dayKey) < FILL_AHEAD_DAYS),
    [days, todayDayKey]
  );
  usePlanAutoFill({ plan: mode === "live" ? plan : null, days: fillAhead, drafting: drafting.context, ready: timetable.synced, apply });

  /*
   * Building with Jami: as soon as there is a usual week to draft from, Jami
   * fills the first fortnight, in front of the student, before anything is
   * saved. When the usual week changes, the days still exactly as Jami drafted
   * them are drafted again; any day the student touched is theirs and stays.
   */
  const draftedFrom = useRef("");
  const routineKey = JSON.stringify([plan.sessions, plan.scopes, plan.startDayKey, plan.exams ?? []]);
  useEffect(() => {
    const context = drafting.context;
    if (mode !== "draft" || !context || !plan.autoFill || plan.sessions.length === 0 || plan.scopes.length === 0) return;
    if (draftedFrom.current === routineKey) return;
    draftedFrom.current = routineKey;
    const first = planDaysBetween(todayDayKey, plan.startDayKey) > 0 ? plan.startDayKey : todayDayKey;
    const reset: TimetableOp[] = [];
    const base = planDayKeysBetween(first, shiftStudyDayKey(first, FILL_AHEAD_DAYS - 1)).flatMap((dayKey) => {
      const own = storedPlanDay(plan, entries.get(dayKey));
      if (own && !isUntouchedDraftDay(own.activities, own.done)) return [];
      if (own) reset.push({ type: "setDay", dayKey, activities: null });
      return [{ dayKey, activities: planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession) }];
    });
    apply([...reset, ...planFillOps(base, context)], { label: JAMI_FILL_LABEL });
  }, [apply, drafting.context, entries, mode, plan, routineKey, todayDayKey]);

  const suggestions = useMemo(() => {
    const map = new Map<string, PlanRefreshSuggestion>();
    if (!drafting.context) return map;
    for (const suggestion of planRefreshSuggestions({
      days,
      actionsByScope: drafting.context.actionsByScope,
      answeredScopes: drafting.answered,
    })) {
      map.set(`${suggestion.dayKey}|${suggestion.activityId}`, suggestion);
    }
    return map;
  }, [days, drafting.answered, drafting.context]);

  const { ownDays } = timetable;
  const savePlan = useCallback(async () => {
    if (savedPlan) return false;
    setSaving(true);
    setProblem("");
    try {
      const planned = ownDays();
      const saved = await createRevisionPlan(uid, newPlanId(), { ...input.draft, autoFill: plan.autoFill }, planned);
      onPlanSaved(saved, planned);
      return true;
    } catch {
      setProblem("That plan could not be saved. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [input.draft, onPlanSaved, ownDays, plan.autoFill, savedPlan, uid]);

  /** What Jami is shown of the timetable: the week in view, as it stands. */
  const promptDays = useMemo<PlanTimetableDay[]>(
    () =>
      days
        .filter((day) => day.dayKey >= range.focusFromDayKey && day.dayKey <= range.focusToDayKey)
        .slice(0, MAX_PLAN_TIMETABLE_DAYS)
        .map((day) => ({
          dayKey: day.dayKey,
          activities: day.activities.map(planActivityOf),
          doneIds: day.activities.filter((activity) => activity.completion).map((activity) => activity.id),
        })),
    [days, range.focusFromDayKey, range.focusToDayKey]
  );

  const activityCount = [...entries.values()].reduce((total, entry) => total + (entry.activities?.length ?? 0), 0);
  const validity = normalizeRevisionPlanDraft(input.draft, undefined, { activityCount });

  return {
    mode,
    plan,
    view,
    setView,
    anchor,
    setAnchor,
    days,
    todayDayKey,
    loading: timetable.loading,
    saving: saving || timetable.saving,
    problem: problem || timetable.problem,
    clearProblem: () => {
      setProblem("");
      timetable.clearProblem();
    },
    undo: timetable.undo,
    undoLabel: timetable.undoLabel,
    suggestions,
    ops: edits.ops,
    applyProposal: edits.applyProposal,
    changePlan,
    savePlan,
    canSave: mode === "draft" && validity.valid,
    promptDays,
  };
}

export type RevisionPlanner = ReturnType<typeof useRevisionPlanner>;
