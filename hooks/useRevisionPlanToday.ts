"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlanAutoFill } from "@/hooks/usePlanAutoFill";
import { usePlanCompletion } from "@/hooks/usePlanCompletion";
import { usePlanDrafting, type PlanDrafting } from "@/hooks/usePlanDrafting";
import { usePlanTimetable, type PlanTimetable } from "@/hooks/usePlanTimetable";
import type { PlanCompletionCard, PlanCompletionDeck } from "@/lib/planning/plan-completion";
import { planAutoFillWindow } from "@/lib/planning/plan-drafting";
import { planDayKeysBetween, planWeekStartDayKey } from "@/lib/planning/plan-schedule";
import { resolveTimetableDays, type TimetableDay } from "@/lib/planning/timetable";
import type { RevisionPlan, RevisionPlanDraft } from "@/lib/planning/types";
import {
  loadActiveRevisionPlan,
  readStoredTodayRevisionPlan,
  saveRevisionPlan,
  storeTodayRevisionPlan,
} from "@/services/planning/revision-plans";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";

/**
 * Today's part of the revision plan: this week's days as they stand, today
 * picked out of them, and the same controls the planner has.
 *
 * The plan's days are stored now, so Today shows what was planned -- Jami's
 * picks as they were put there, the student's own tasks where they put them --
 * and never asks the engine what a slot means on the day. A plan that asked
 * Jami to fill its free sessions gets them filled here too, so a student who
 * only ever opens Today still finds work in every session.
 *
 * Failing quietly is deliberate. A plan is decoration on top of Today, and
 * Today has to work without it -- the same rule the Learning Engine follows
 * about Tutor and studying.
 */

export type RevisionPlanTodayState = {
  plan: RevisionPlan | null;
  loading: boolean;
  /** Monday to Sunday of this week. */
  week: TimetableDay[];
  today: TimetableDay | null;
  todayDayKey: string;
  scopeNames: Map<string, string>;
  timetable: PlanTimetable;
  drafting: PlanDrafting;
  /** Saves a change to the plan itself, such as a subject a new task brought in. */
  changePlan: (next: RevisionPlanDraft) => Promise<boolean>;
  refresh: () => Promise<void>;
};

export function useRevisionPlanToday(input: {
  uid: string;
  enabled: boolean;
  folders: readonly { id: string; name: string; examCourse?: unknown }[];
  cards: readonly PlanCompletionCard[];
  decks: readonly (PlanCompletionDeck & { name?: string })[];
}): RevisionPlanTodayState {
  const { uid, enabled } = input;
  const todayDayKey = getStudyDayKey();
  const weekStartDayKey = planWeekStartDayKey(todayDayKey);
  const window = planAutoFillWindow(todayDayKey);
  /*
   * What this device kept of the plan at the last launch, if anything: drawn
   * at once and read again behind it. See `readStoredTodayRevisionPlan`.
   */
  const [kept] = useState(() => (enabled && uid ? readStoredTodayRevisionPlan(uid, weekStartDayKey) : null));
  const [plan, setPlan] = useState<RevisionPlan | null>(kept?.plan ?? null);
  const [planRead, setPlanRead] = useState(Boolean(kept) || !enabled);
  const readCount = useRef(0);

  const readPlan = useCallback(async () => {
    if (!enabled || !uid) return;
    readCount.current += 1;
    const read = readCount.current;
    try {
      const active = await loadActiveRevisionPlan(uid);
      if (read === readCount.current) setPlan(active);
    } catch {
      // Today must render without a plan. A plan already on the page from this
      // device's copy stays there: it is the last thing known, not a guess.
    } finally {
      if (read === readCount.current) setPlanRead(true);
    }
  }, [enabled, uid]);

  useEffect(() => {
    void readPlan();
  }, [readPlan]);

  const timetable = usePlanTimetable({
    uid,
    plan,
    mode: "live",
    fromDayKey: weekStartDayKey,
    toDayKey: window.toDayKey,
    ...(kept?.plan ? { initialEntries: kept.entries } : {}),
  });

  const evidence = usePlanCompletion({
    uid,
    enabled: Boolean(plan),
    fromDayKey: weekStartDayKey,
    toDayKey: todayDayKey,
    todayDayKey,
    cards: input.cards,
    decks: input.decks,
  });

  const entries = timetable.entries;
  const days = useMemo(
    () =>
      plan
        ? resolveTimetableDays({
            plan,
            dayKeys: planDayKeysBetween(weekStartDayKey, window.toDayKey),
            entries: [...entries.values()],
            todayDayKey,
            ...(evidence ? { evidence } : {}),
          })
        : [],
    [entries, evidence, plan, todayDayKey, weekStartDayKey, window.toDayKey]
  );
  const week = useMemo(() => days.slice(0, 7), [days]);
  const today = days.find((day) => day.isToday) ?? null;
  const fillDays = useMemo(() => days.filter((day) => day.dayKey >= todayDayKey), [days, todayDayKey]);

  /*
   * Asked of the engine only when something needs it: a free session Jami has
   * been asked to fill, or one of today's picks it may have a better idea for.
   */
  const wantsEngine =
    (Boolean(plan?.autoFill) && fillDays.some((day) => day.openCount > 0)) ||
    Boolean(today?.activities.some((activity) => activity.mode === "adaptive" && !activity.open && !activity.completion));
  const drafting = usePlanDrafting({
    scopes: plan?.scopes ?? [],
    decks: input.decks,
    cards: input.cards,
    folders: input.folders,
    enabled: wantsEngine,
  });
  usePlanAutoFill({ plan, days: fillDays, drafting: drafting.context, ready: timetable.synced, apply: timetable.apply });

  // Work seen done today is written down today, so it is still done tomorrow.
  const observed = today?.observed.join(",") ?? "";
  const { recordSeen } = timetable;
  useEffect(() => {
    if (observed) recordSeen(todayDayKey, observed.split(","));
  }, [observed, recordSeen, todayDayKey]);

  // The next launch opens on the plan as it stands now.
  useEffect(() => {
    if (!uid || !planRead || timetable.loading) return;
    const weekEnd = shiftStudyDayKey(weekStartDayKey, 6);
    storeTodayRevisionPlan(uid, weekStartDayKey, {
      plan,
      entries: [...entries.values()].filter((entry) => entry.dayKey >= weekStartDayKey && entry.dayKey <= weekEnd),
    });
  }, [entries, plan, planRead, timetable.loading, uid, weekStartDayKey]);

  const scopeNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const folder of input.folders) names.set(`folder:${folder.id}`, folder.name);
    for (const deck of input.decks) {
      if (deck.name) names.set(`deck:${deck.id}`, deck.name);
    }
    return names;
  }, [input.decks, input.folders]);

  const { reload } = timetable;
  const refresh = useCallback(async () => {
    await readPlan();
    await reload();
  }, [readPlan, reload]);

  const changePlan = useCallback(
    async (next: RevisionPlanDraft) => {
      if (!plan) return false;
      try {
        setPlan(await saveRevisionPlan(uid, plan.id, next, { activityCount: 1 }));
        return true;
      } catch {
        return false;
      }
    },
    [plan, uid]
  );

  return {
    plan,
    loading: enabled && (!planRead || (Boolean(plan) && timetable.loading && !kept?.plan)),
    week,
    today,
    todayDayKey,
    scopeNames,
    timetable,
    drafting,
    changePlan,
    refresh,
  };
}
