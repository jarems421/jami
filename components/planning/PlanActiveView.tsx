"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Skeleton } from "@/components/ui";
import PlanChangeWithJami from "@/components/planning/PlanChangeWithJami";
import PlanCountdown from "@/components/planning/PlanCountdown";
import PlanGoals from "@/components/planning/PlanGoals";
import PlanTodayTimeline from "@/components/planning/PlanTodayTimeline";
import PlanWeekRow from "@/components/planning/PlanWeekRow";
import { useRevisionPlanToday } from "@/hooks/useRevisionPlanToday";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import { planScopeColor } from "@/lib/planning/plan-colors";
import { planCountdown, planWeekOfPlan } from "@/lib/planning/plan-countdown";
import { planUpNext } from "@/lib/planning/plan-tasks";
import { PLAN_WEEKDAY_FULL_LABELS } from "@/lib/planning/types";
import type { Card } from "@/lib/study/cards";
import { getStudyDayKey } from "@/lib/study/day";
import type { Deck } from "@/lib/study/decks";
import { loadUserCards } from "@/services/study/cards";

/**
 * A plan that is running: the week across the top, a day in full below it,
 * and beside that what the plan is counting down to and a way to change it.
 *
 * Today is shown first. Picking another day shows that one -- its sittings,
 * its subjects and anything the student has added to it -- because a plan is
 * also where next Saturday gets its own task written in.
 */

export function formatPlanMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function longDayLabel(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, day as number)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export default function PlanActiveView({
  uid,
  planVersion,
  actions,
  folders,
  decks,
  onEdit,
  onArchive,
  onChangeWithJami,
}: {
  uid: string;
  /** The plan's last save, so an edit made above this view is read again here. */
  planVersion: number;
  actions: readonly StudyAction[];
  folders: readonly { id: string; name: string }[];
  decks: readonly Deck[];
  onEdit: () => void;
  onArchive: () => void;
  onChangeWithJami: (message: string) => void;
}) {
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => {
    let live = true;
    // Only to see what was studied today; the plan draws without it.
    void loadUserCards(uid)
      .then((loaded) => {
        if (live) setCards(loaded);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [uid]);

  const planToday = useRevisionPlanToday({ uid, enabled: true, actions, folders, cards, decks });
  const { refresh } = planToday;
  // Read again only when a save changed the plan; the hook already read it once on mount.
  const seenVersion = useRef(planVersion);
  useEffect(() => {
    if (planVersion === seenVersion.current) return;
    seenVersion.current = planVersion;
    void refresh();
  }, [planVersion, refresh]);

  const todayDayKey = getStudyDayKey();
  const [selectedDayKey, setSelectedDayKey] = useState(todayDayKey);
  const { plan, week, days, scopeNames } = planToday;
  const scopeColor = useMemo(() => (scopeKey: string) => planScopeColor(plan, scopeKey), [plan]);

  if (planToday.loading && !plan) return <Skeleton className="h-[32rem] w-full rounded-2xl" />;
  if (!plan || !week) return null;

  const selectedIndex = Math.max(0, week.days.findIndex((day) => day.dayKey === selectedDayKey));
  const selectedDay = days[selectedIndex];
  const selectedWeekDay = week.days[selectedIndex];
  const isToday = selectedWeekDay?.isToday ?? false;
  const { current, total } = planWeekOfPlan(plan, todayDayKey);
  const countdown = planCountdown(plan, todayDayKey);
  const upNext = isToday ? planUpNext(selectedDay) : null;
  const expected = week.days.reduce((sum, day) => sum + day.expectedCount, 0);
  const done = week.days.reduce((sum, day) => sum + Math.min(day.doneCount, day.expectedCount), 0);
  const sessionCount = selectedDay?.sessions.length ?? 0;

  return (
    <div className="space-y-8 sm:space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-2xs font-bold uppercase tracking-[0.18em] text-text-muted">
            {plan.title} · week {current} of {total}
          </p>
          <p className="text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">{longDayLabel(selectedDayKey)}</p>
        </div>
        <Button type="button" variant="secondary" onClick={onEdit}>
          Edit plan
        </Button>
      </header>

      <section aria-labelledby="plan-week-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="plan-week-title" className="text-xl font-bold tracking-tight text-text-primary">
              This week
            </h2>
            <p className="text-sm text-text-muted">
              {formatPlanMinutes(week.minutes)} planned
              {/* Progress once there is some: "0 of 16 done" reads as a debt. */}
              {done > 0 ? ` · ${done} of ${expected} done` : ""}
            </p>
          </div>
          <p className="text-sm text-text-muted">Pick a day to see it below</p>
        </div>
        <PlanWeekRow
          week={week}
          days={days}
          scopeNames={scopeNames}
          scopeColor={scopeColor}
          selectedDayKey={selectedDayKey}
          onSelect={setSelectedDayKey}
        />
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        <div className="app-panel rounded-2xl p-5 sm:p-7">
          {selectedDay ? (
            <PlanTodayTimeline
              day={selectedDay}
              title={isToday ? "Today" : PLAN_WEEKDAY_FULL_LABELS[selectedWeekDay!.weekday]}
              summary={
                sessionCount > 0
                  ? `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"} · ${formatPlanMinutes(selectedDay.minutes)}${
                      selectedDay.doneCount > 0 ? ` · ${selectedDay.doneCount} of ${selectedDay.slots.length} done` : ""
                    }`
                  : undefined
              }
              scopeNames={scopeNames}
              scopeColor={scopeColor}
              isToday={isToday}
              isPast={selectedWeekDay?.isPast ?? false}
              {...(upNext ? { upNextSlotId: upNext.task.slot.id } : {})}
              onToggle={(slot) => {
                // A day still to come has nothing done in it yet.
                if (!selectedWeekDay || selectedWeekDay.isPast || selectedWeekDay.isToday) {
                  planToday.toggleSlot(slot, selectedDayKey);
                }
              }}
              onAddOwnTask={(sessionId, label) => planToday.addOwnTask(selectedDayKey, sessionId, label)}
              onAskJami={planToday.addJamiTask}
              onRemoveTask={(actionId) => planToday.removeTask(selectedDayKey, actionId)}
            />
          ) : null}
        </div>
        <aside className="space-y-5">
          <PlanCountdown items={countdown} scopeColor={scopeColor} />
          <PlanGoals uid={uid} plan={plan} folders={folders} />
          <PlanChangeWithJami onStart={onChangeWithJami} />
          {/* Ending a plan is rare and final, so it is not a button at the top
              of it beside the one everybody wants. */}
          <p className="px-1 text-xs text-text-muted">
            Done with this plan early?{" "}
            <button
              type="button"
              onClick={onArchive}
              className="rounded font-semibold text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              Finish it
            </button>
          </p>
        </aside>
      </div>
    </div>
  );
}
