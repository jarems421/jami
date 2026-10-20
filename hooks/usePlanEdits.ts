"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { JAMI_FILL_LABEL } from "@/hooks/usePlanAutoFill";
import type { PlanDrafting } from "@/hooks/usePlanDrafting";
import type { PlanAssistantProposal } from "@/hooks/usePlanInterview";
import type { PlanTimetable } from "@/hooks/usePlanTimetable";
import { newPlanActivityId } from "@/lib/planning/plan-activities";
import {
  planFill,
  plannedActionIds,
  studentTaskHref,
  type PlanDraftingContext,
  type PlanRefreshSuggestion,
} from "@/lib/planning/plan-drafting";
import { planProposalOps } from "@/lib/planning/plan-proposal";
import {
  openActivityFromFreeSession,
  planActivityOf,
  planFreeSessionsOn,
  storedPlanDay,
  type TimetableDay,
} from "@/lib/planning/timetable";
import type { PlanActivityPatch, TimetableOp } from "@/lib/planning/timetable-ops";
import {
  planScopeFromKey,
  planScopeKey,
  type PlanActivity,
  type PlanActivityMethod,
  type PlanActivityMode,
  type PlanActivityTopic,
  type RevisionPlan,
  type RevisionPlanDraft,
} from "@/lib/planning/types";

/**
 * Every edit a student can make to a timetable, in one place, for every screen
 * that offers them -- the planner and Today alike -- so a task added on Today
 * is added exactly as one added in the planner.
 */

export type PlannerActivityInput = {
  title: string;
  method: PlanActivityMethod;
  minutes: number;
  startTime?: string;
  scopeKey?: string;
  topic?: PlanActivityTopic;
  /** The notebook notebook work is done in, when the student chose one. */
  notebookId?: string;
  mode: PlanActivityMode;
  /**
   * Who says what it is. Absent: the student, who just did.
   * `jami`: the time is set aside and Jami picks the task from the student's work.
   * `free`: time set aside, with nothing chosen for it yet.
   */
  pick?: "jami" | "free";
  /** A free session this replaces, in the same change: a free session handed to Jami becomes its pick. */
  replacing?: { dayKey: string; activityId: string; routineId?: string };
};

/** What came of an addition or a fill, so the screen can say so rather than appear to do nothing. */
export type PlanEditOutcome = {
  /** Whether the timetable changed. */
  changed: boolean;
  /** Tasks Jami chose and put in. */
  picked: number;
  /** Subjects Jami could find nothing to pick for, by scope key. */
  unfilledScopeKeys: string[];
};

const NOTHING: PlanEditOutcome = { changed: false, picked: 0, unfilledScopeKeys: [] };

type Addition = { dayKey: string; scopeKey?: string };

export function usePlanEdits(input: {
  plan: RevisionPlan;
  timetable: Pick<PlanTimetable, "apply" | "setDone" | "entries">;
  /** The days on screen, resolved. */
  days: readonly TimetableDay[];
  drafting: Pick<PlanDrafting, "context" | "support" | "readyFor" | "forScopes">;
  todayDayKey: string;
  /** Saves a change to the plan itself; false when it could not be made. */
  changePlan: (next: RevisionPlanDraft) => Promise<boolean>;
}) {
  const { plan, timetable, days, drafting, todayDayKey, changePlan } = input;
  const { apply, setDone, entries } = timetable;
  const { readyFor, forScopes } = drafting;
  /** What a fill draws on right now: the engine's answer, or the subjects' own material until it comes. */
  const fillContext = useMemo(
    () => drafting.context ?? { actionsByScope: new Map(), support: drafting.support },
    [drafting.context, drafting.support]
  );
  /** The engine's answer for some subjects: at once when it is in hand, asked for when it is not. */
  const contextFor = useCallback(
    (scopeKeys: readonly string[]): PlanDraftingContext | Promise<PlanDraftingContext> =>
      readyFor(scopeKeys) ?? forScopes(scopeKeys),
    [forScopes, readyFor]
  );

  /** A day's activities as they stand now, own or from the usual week, visible or not. */
  const activitiesOn = useCallback(
    (dayKey: string): PlanActivity[] => {
      const shown = days.find((day) => day.dayKey === dayKey);
      if (shown) return shown.activities.map(planActivityOf);
      const own = storedPlanDay(plan, entries.get(dayKey));
      return own ? own.activities : planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession);
    },
    [days, entries, plan]
  );

  /** The plan with room for new activities: their subjects in it, their dates inside it. Null when it has room. */
  const planCovering = useCallback(
    (additions: readonly Addition[]): RevisionPlanDraft | null => {
      const scopes = [...plan.scopes];
      const have = new Set(scopes.map(planScopeKey));
      let { startDayKey, endDayKey } = plan;
      for (const addition of additions) {
        const scope = addition.scopeKey ? planScopeFromKey(addition.scopeKey) : null;
        if (scope && addition.scopeKey && !have.has(addition.scopeKey)) {
          scopes.push({ ...scope, weight: 1 });
          have.add(addition.scopeKey);
        }
        if (addition.dayKey > endDayKey) endDayKey = addition.dayKey;
        if (addition.dayKey < startDayKey) startDayKey = addition.dayKey;
      }
      if (scopes.length === plan.scopes.length && endDayKey === plan.endDayKey && startDayKey === plan.startDayKey) {
        return null;
      }
      return { ...plan, scopes, startDayKey, endDayKey };
    },
    [plan]
  );

  const applyWithRoom = useCallback(
    (ops: TimetableOp[], label: string, additions: readonly Addition[] = []) => {
      const widened = planCovering(additions);
      if (widened) void changePlan(widened);
      return apply(ops, { label, ...(widened ? { planBefore: plan } : {}) });
    },
    [apply, changePlan, plan, planCovering]
  );

  /*
   * A pick can wait on the engine for a moment. What it then writes goes
   * through the edits as they are by then, not as they were when it was asked:
   * the plan may have taken the subject in, or the student another tap.
   */
  const latest = useRef({ apply, applyWithRoom });
  useEffect(() => {
    latest.current = { apply, applyWithRoom };
  }, [apply, applyWithRoom]);

  const add = useCallback(
    async (dayKey: string, activity: PlannerActivityInput): Promise<PlanEditOutcome> => {
      const base = {
        id: newPlanActivityId(),
        minutes: activity.minutes,
        ...(activity.startTime ? { startTime: activity.startTime } : {}),
        ...(activity.scopeKey ? { scopeKey: activity.scopeKey } : {}),
      };
      const room = [{ dayKey, ...(activity.scopeKey ? { scopeKey: activity.scopeKey } : {}) }];
      const open: PlanActivity = {
        ...base,
        title: "",
        method: "other",
        mode: activity.scopeKey ? "adaptive" : "fixed",
        origin: "student",
        open: true,
        ...(activity.replacing?.routineId ? { routineId: activity.replacing.routineId } : {}),
      };
      const replaced: TimetableOp[] = activity.replacing
        ? [{ type: "remove", dayKey: activity.replacing.dayKey, activityId: activity.replacing.activityId }]
        : [];

      if (activity.pick === "free") {
        return { ...NOTHING, changed: applyWithRoom([{ type: "add", dayKey, activity: open }], "adding that", room) };
      }
      if (activity.pick === "jami") {
        const scopeKey = activity.scopeKey;
        if (!scopeKey) return NOTHING;
        const alreadyPlanned = plannedActionIds(days);
        const context = await contextFor([scopeKey]);
        const outcome = planFill([{ dayKey, activities: [open] }], context, { alreadyPlanned });
        const filled = outcome.ops[0];
        // Nothing to pick from: said, and nothing added, so the student can choose what to do instead.
        if (outcome.added === 0 || filled?.type !== "setDay" || !filled.activities) {
          return { ...NOTHING, unfilledScopeKeys: [scopeKey] };
        }
        const ops = [...replaced, ...filled.activities.map((item) => ({ type: "add" as const, dayKey, activity: item }))];
        return {
          changed: latest.current.applyWithRoom(ops, activity.replacing ? "Jami's pick" : "adding that", room),
          picked: outcome.added,
          unfilledScopeKeys: outcome.unfilledScopeKeys,
        };
      }

      const href = studentTaskHref({
        method: activity.method,
        scopeKey: activity.scopeKey,
        topic: activity.topic,
        ...(activity.notebookId ? { notebookId: activity.notebookId } : {}),
        support: drafting.support,
      });
      const ops: TimetableOp[] = [
        {
          type: "add",
          dayKey,
          activity: {
            ...base,
            title: activity.title,
            method: activity.method,
            mode: activity.scopeKey ? activity.mode : "fixed",
            origin: "student",
            ...(activity.topic ? { topic: activity.topic } : {}),
            ...(activity.notebookId ? { notebookId: activity.notebookId } : {}),
            ...(href ? { href } : {}),
          },
        },
      ];
      return { ...NOTHING, changed: applyWithRoom(ops, "adding that", room) };
    },
    [applyWithRoom, contextFor, days, drafting.support]
  );

  const update = useCallback(
    (dayKey: string, activity: PlanActivity, patch: PlanActivityPatch & { dayKey?: string }) => {
      const { dayKey: toDayKey, ...change } = patch;
      const taskChanged =
        change.title !== undefined ||
        change.method !== undefined ||
        change.topic !== undefined ||
        change.notebookId !== undefined;
      const scopeKey = change.scopeKey === undefined ? activity.scopeKey : (change.scopeKey ?? undefined);
      const notebookId = change.notebookId === undefined ? activity.notebookId : (change.notebookId ?? undefined);
      const href = taskChanged
        ? studentTaskHref({
            method: change.method ?? activity.method,
            scopeKey,
            topic: change.topic === undefined ? activity.topic : (change.topic ?? undefined),
            ...(notebookId ? { notebookId } : {}),
            support: drafting.support,
          })
        : undefined;
      const ops: TimetableOp[] = [];
      if (Object.keys(change).length > 0) {
        ops.push({ type: "update", dayKey, activityId: activity.id, patch: { ...change, ...(taskChanged ? { href: href ?? null } : {}) } });
      }
      if (toDayKey && toDayKey !== dayKey) {
        ops.push({ type: "move", fromDayKey: dayKey, toDayKey, activityId: activity.id, fallbackId: newPlanActivityId() });
      }
      return applyWithRoom(ops, "your edit", [{ dayKey: toDayKey ?? dayKey, ...(scopeKey ? { scopeKey } : {}) }]);
    },
    [applyWithRoom, drafting.support]
  );

  /**
   * Free sessions filled by Jami: every one on some days, or `only` the ones
   * named. Immediate when the engine has answered for their subjects, and a
   * moment later when it has to be asked.
   */
  const fill = useCallback(
    (dayKeys: readonly string[], options: { only?: readonly string[] } = {}): Promise<PlanEditOutcome> => {
      const only = options.only ? new Set(options.only) : undefined;
      const toFill = dayKeys.map((dayKey) => ({ dayKey, activities: activitiesOn(dayKey) }));
      const scopeKeys = [
        ...new Set(
          toFill.flatMap((day) =>
            day.activities.flatMap((activity) =>
              activity.open && activity.scopeKey && (!only || only.has(activity.id)) ? [activity.scopeKey] : []
            )
          )
        ),
      ];
      if (scopeKeys.length === 0) return Promise.resolve(NOTHING);
      const alreadyPlanned = plannedActionIds(days);
      const run = (context: PlanDraftingContext): PlanEditOutcome => {
        const outcome = planFill(toFill, context, { alreadyPlanned, ...(only ? { only } : {}) });
        const changed = outcome.ops.length > 0 && latest.current.apply(outcome.ops, { label: JAMI_FILL_LABEL });
        return { changed, picked: changed ? outcome.added : 0, unfilledScopeKeys: outcome.unfilledScopeKeys };
      };
      const context = contextFor(scopeKeys);
      return context instanceof Promise ? context.then(run) : Promise.resolve(run(context));
    },
    [activitiesOn, contextFor, days]
  );

  const ops = useMemo(
    () => ({
      add,
      update,
      fill,
      move: (fromDayKey: string, activityId: string, toDayKey: string, startTime?: string) =>
        applyWithRoom(
          [{ type: "move", fromDayKey, toDayKey, activityId, ...(startTime ? { startTime } : {}), fallbackId: newPlanActivityId() }],
          "the move",
          [{ dayKey: toDayKey }]
        ),
      duplicate: (fromDayKey: string, activityId: string, toDayKey: string) =>
        applyWithRoom([{ type: "duplicate", fromDayKey, toDayKey, activityId, newId: newPlanActivityId() }], "the copy", [
          { dayKey: toDayKey },
        ]),
      remove: (dayKey: string, activityId: string) => apply([{ type: "remove", dayKey, activityId }], { label: "removing it" }),
      clearDay: (dayKey: string) => apply([{ type: "clearDay", dayKey }], { label: "the rest day" }),
      /** Hands a day back to the usual week: its own timetable goes, its free sessions come back. */
      resetDay: (dayKey: string) => apply([{ type: "setDay", dayKey, activities: null }], { label: "going back to your usual week" }),
      acceptSuggestion: (suggestion: PlanRefreshSuggestion) =>
        apply(
          [{ type: "update", dayKey: suggestion.dayKey, activityId: suggestion.activityId, patch: { task: { ...suggestion.task, origin: "jami" } } }],
          { label: "Jami's suggestion" }
        ),
      setMode: (dayKey: string, activityId: string, mode: PlanActivityMode) =>
        apply([{ type: "update", dayKey, activityId, patch: { mode } }], { label: mode === "fixed" ? "keeping it" : "letting Jami adapt it" }),
      toggleDone: (day: TimetableDay, activityId: string, done: boolean) => {
        // A day still to come has nothing done in it yet.
        if (day.dayKey > todayDayKey) return;
        setDone(day.dayKey, activityId, done);
      },
    }),
    [add, apply, applyWithRoom, fill, setDone, todayDayKey, update]
  );

  /** A proposal from Jami, applied: the plan's own change first, then the same ops a tap would make. */
  const applyProposal = useCallback(
    async (proposal: PlanAssistantProposal) => {
      if (proposal.plan && !(await changePlan(proposal.plan))) return false;
      // A fill Jami proposed, or a time it left Jami to pick for, draws on the engine's answer: waited for if not in yet.
      const picks = proposal.changes.flatMap((change) =>
        change.kind === "fill" ? plan.scopes.map(planScopeKey) : change.kind === "add" && !change.title && change.scopeKey ? [change.scopeKey] : []
      );
      const drafted = picks.length > 0 ? await contextFor(picks) : fillContext;
      const proposalOps = planProposalOps(proposal.changes, { activitiesOn, drafting: drafted });
      if (proposalOps.length === 0) return Boolean(proposal.plan);
      const additions = proposal.changes.flatMap((change): Addition[] =>
        change.kind === "add"
          ? [{ dayKey: change.dayKey, ...(change.scopeKey ? { scopeKey: change.scopeKey } : {}) }]
          : change.kind === "move"
            ? [{ dayKey: change.toDayKey }]
            : []
      );
      const widened = planCovering(additions);
      if (widened) await changePlan(widened);
      latest.current.apply(proposalOps, { label: "Jami's change", planBefore: plan });
      return true;
    },
    [activitiesOn, changePlan, contextFor, fillContext, plan, planCovering]
  );

  return { ops, applyProposal };
}
