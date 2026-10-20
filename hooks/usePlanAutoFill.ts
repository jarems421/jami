"use client";

import { useEffect, useRef } from "react";
import type { PlanTimetable } from "@/hooks/usePlanTimetable";
import { planFillOps, plannedActionIds, type PlanDraftingContext } from "@/lib/planning/plan-drafting";
import { planActivityOf, type TimetableDay } from "@/lib/planning/timetable";
import type { RevisionPlan } from "@/lib/planning/types";

/** What a fill by Jami is called wherever it can be undone, so a screen can say that Jami did it. */
export const JAMI_FILL_LABEL = "Jami filling your free sessions";

/**
 * "Let Jami fill my free sessions", carried out.
 *
 * For a plan that asked for it, any free session in the days Jami keeps filled
 * (`planAutoFillWindow`) gets real tasks as soon as there is something to fill
 * it from -- so a day the student has not planned still arrives with work in
 * it, never as an empty promise. Each day is tried once a visit, and only if it
 * still holds what the fill was worked out from (`ifIds`), so two devices never
 * fill the same day twice. It is an ordinary change: shown, and undoable.
 */
export function usePlanAutoFill(input: {
  plan: RevisionPlan | null;
  /** The days Jami keeps filled, resolved. */
  days: readonly TimetableDay[];
  drafting: PlanDraftingContext | null;
  /** Whether the days have been read, so a fill never runs on what was only guessed. */
  ready: boolean;
  apply: PlanTimetable["apply"];
}) {
  const { plan, days, drafting, ready, apply } = input;
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!ready || !plan || plan.status !== "active" || !plan.autoFill || !drafting) return;
    const due = days.filter(
      (day) =>
        !day.isPast &&
        day.withinPlan &&
        day.activities.some((activity) => activity.open && activity.scopeKey) &&
        !tried.current.has(`${plan.id}|${day.dayKey}`)
    );
    if (due.length === 0) return;
    for (const day of due) tried.current.add(`${plan.id}|${day.dayKey}`);
    const ops = planFillOps(
      due.map((day) => ({ dayKey: day.dayKey, activities: day.activities.map(planActivityOf) })),
      drafting,
      plannedActionIds(days)
    );
    if (ops.length > 0) apply(ops, { label: JAMI_FILL_LABEL });
  }, [apply, days, drafting, plan, ready]);
}
