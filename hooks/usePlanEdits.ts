"use client";

import { useCallback, useMemo } from "react";
import { JAMI_FILL_LABEL } from "@/hooks/usePlanAutoFill";
import type { PlanDrafting } from "@/hooks/usePlanDrafting";
import type { PlanAssistantProposal } from "@/hooks/usePlanInterview";
import type { PlanTimetable } from "@/hooks/usePlanTimetable";
import { newPlanActivityId } from "@/lib/planning/plan-activities";
import {
  planFillOps,
  plannedActionIds,
  studentTaskHref,
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
  mode: PlanActivityMode;
  /** Leave the task to Jami: the time is set aside and Jami fills it from the student's work. */
  jamiPicks?: boolean;
};

type Addition = { dayKey: string; scopeKey?: string };

export function usePlanEdits(input: {
  plan: RevisionPlan;
  timetable: Pick<PlanTimetable, "apply" | "setDone" | "entries">;
  /** The days on screen, resolved. */
  days: readonly TimetableDay[];
  drafting: Pick<PlanDrafting, "context" | "support">;
  todayDayKey: string;
  /** Saves a change to the plan itself; false when it could not be made. */
  changePlan: (next: RevisionPlanDraft) => Promise<boolean>;
}) {
  const { plan, timetable, days, drafting, todayDayKey, changePlan } = input;
  const { apply, setDone, entries } = timetable;
  /** What a fill draws on right now: the engine's answer, or the subjects' own material until it comes. */
  const fillContext = useMemo(
    () => drafting.context ?? { actionsByScope: new Map(), support: drafting.support },
    [drafting.context, drafting.support]
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

  const add = useCallback(
    (dayKey: string, activity: PlannerActivityInput) => {
      const base = {
        id: newPlanActivityId(),
        minutes: activity.minutes,
        ...(activity.startTime ? { startTime: activity.startTime } : {}),
        ...(activity.scopeKey ? { scopeKey: activity.scopeKey } : {}),
      };
      let ops: TimetableOp[];
      if (activity.jamiPicks && activity.scopeKey) {
        const open: PlanActivity = { ...base, title: "", method: "other", mode: "adaptive", origin: "student", open: true };
        const filled = planFillOps([{ dayKey, activities: [open] }], fillContext, plannedActionIds(days))[0];
        ops =
          filled?.type === "setDay" && filled.activities
            ? filled.activities.map((item) => ({ type: "add" as const, dayKey, activity: item }))
            : [{ type: "add", dayKey, activity: open }];
      } else {
        const href = studentTaskHref({
          method: activity.method,
          scopeKey: activity.scopeKey,
          topic: activity.topic,
          support: drafting.support,
        });
        ops = [
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
              ...(href ? { href } : {}),
            },
          },
        ];
      }
      return applyWithRoom(ops, "adding that", [{ dayKey, ...(activity.scopeKey ? { scopeKey: activity.scopeKey } : {}) }]);
    },
    [applyWithRoom, days, drafting.support, fillContext]
  );

  const update = useCallback(
    (dayKey: string, activity: PlanActivity, patch: PlanActivityPatch & { dayKey?: string }) => {
      const { dayKey: toDayKey, ...change } = patch;
      const taskChanged = change.title !== undefined || change.method !== undefined || change.topic !== undefined;
      const scopeKey = change.scopeKey === undefined ? activity.scopeKey : (change.scopeKey ?? undefined);
      const href = taskChanged
        ? studentTaskHref({
            method: change.method ?? activity.method,
            scopeKey,
            topic: change.topic === undefined ? activity.topic : (change.topic ?? undefined),
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

  const ops = useMemo(
    () => ({
      add,
      update,
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
      fill: (dayKeys: readonly string[]) => {
        const fillOps = planFillOps(
          dayKeys.map((dayKey) => ({ dayKey, activities: activitiesOn(dayKey) })),
          fillContext,
          plannedActionIds(days)
        );
        return fillOps.length > 0 && apply(fillOps, { label: JAMI_FILL_LABEL });
      },
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
    [activitiesOn, add, apply, applyWithRoom, days, fillContext, setDone, todayDayKey, update]
  );

  /** A proposal from Jami, applied: the plan's own change first, then the same ops a tap would make. */
  const applyProposal = useCallback(
    async (proposal: PlanAssistantProposal) => {
      if (proposal.plan && !(await changePlan(proposal.plan))) return false;
      const proposalOps = planProposalOps(proposal.changes, { activitiesOn, drafting: fillContext });
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
      apply(proposalOps, { label: "Jami's change", planBefore: plan });
      return true;
    },
    [activitiesOn, apply, changePlan, fillContext, plan, planCovering]
  );

  return { ops, applyProposal, fillContext };
}
