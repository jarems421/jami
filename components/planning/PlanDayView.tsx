"use client";

import { PlanActivityRow } from "@/components/planning/PlanActivityItem";
import type { PlanCalendarHandlers } from "@/components/planning/PlanWeekView";
import { Button, JamiTutorIcon } from "@/components/ui";
import type { PlanRefreshSuggestion } from "@/lib/planning/plan-drafting";
import { formatPlanMinutes, longPlanDate } from "@/lib/planning/plan-format";
import type { TimetableActivity, TimetableDay } from "@/lib/planning/timetable";

/**
 * One day in full, for working through it in detail: every activity with the
 * way to start it, Jami's suggestions where its picks have gone stale, and the
 * whole-day choices -- fill the free time, make it a rest day, or hand it back
 * to the usual week.
 */

export type PlanDayHandlers = PlanCalendarHandlers & {
  onAcceptSuggestion: (suggestion: PlanRefreshSuggestion) => void;
  onKeep: (dayKey: string, activityId: string) => void;
  onClearDay: (dayKey: string) => void;
  onResetDay: (dayKey: string) => void;
  /** Whether the usual week asks anything of this weekday, so handing a day back to it means something. */
  hasUsualWeek: (dayKey: string) => boolean;
  /** The running goal an activity moves, by name. */
  goalFor?: (activity: TimetableActivity) => string | undefined;
};

function summary(day: TimetableDay) {
  const parts: string[] = [];
  if (day.taskCount > 0) parts.push(`${day.taskCount} ${day.taskCount === 1 ? "activity" : "activities"}`);
  if (day.openCount > 0) parts.push(`${day.openCount} free ${day.openCount === 1 ? "session" : "sessions"}`);
  if (day.minutes > 0) parts.push(formatPlanMinutes(day.minutes));
  if (day.doneCount > 0) parts.push(`${day.doneCount} done`);
  return parts.join(" · ");
}

export default function PlanDayView({ day, handlers }: { day: TimetableDay; handlers: PlanDayHandlers }) {
  const fillable = !day.isPast && day.activities.some((activity) => activity.open && activity.scopeKey);
  const canTick = day.isToday || day.isPast;
  return (
    <section aria-label={longPlanDate(day.dayKey)} className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xl font-bold tracking-tight text-text-primary">
          {day.isToday ? "Today" : longPlanDate(day.dayKey)}
        </h2>
        <p className="text-sm text-text-muted">
          {summary(day) || (day.kind === "flexible" ? "Free time from your usual week" : day.withinPlan ? "A rest day" : "Outside your plan's dates")}
        </p>
      </div>

      {day.exams.map((exam) => (
        <p key={exam.id} className="app-warning rounded-2xl px-4 py-3 text-sm font-semibold">
          Exam today · {exam.label}
        </p>
      ))}

      {day.kind === "flexible" ? (
        <p className="rounded-2xl border border-dashed border-[var(--color-border-strong)] px-4 py-3 text-sm leading-6 text-text-secondary">
          This day isn&rsquo;t planned yet. Its sessions come from your usual week — fill them yourself, or let Jami pick
          tasks from your recent work.
        </p>
      ) : null}

      {day.activities.length > 0 ? (
        <ol className="space-y-1.5">
          {day.activities.map((activity) => {
            const suggestion = handlers.suggestions.get(`${day.dayKey}|${activity.id}`);
            const goal = handlers.goalFor?.(activity);
            return (
              <PlanActivityRow
                key={activity.id}
                activity={activity}
                subject={handlers.scopeName(activity.scopeKey)}
                color={handlers.scopeColor(activity.scopeKey)}
                canTick={canTick}
                upNext={day.isToday && activity.id === handlers.upNextId}
                {...(suggestion ? { suggestion } : {})}
                {...(goal ? { goal } : {})}
                onOpen={() => handlers.onOpenActivity(day.dayKey, activity)}
                onToggle={(done) => handlers.onToggle(day, activity, done)}
                onFill={() => handlers.onFillDay(day.dayKey)}
                {...(suggestion ? { onAcceptSuggestion: () => handlers.onAcceptSuggestion(suggestion) } : {})}
                onKeep={() => handlers.onKeep(day.dayKey, activity.id)}
              />
            );
          })}
        </ol>
      ) : (
        <p className="app-subtle-panel rounded-2xl px-4 py-3 text-sm text-text-secondary">
          {day.isPast ? "Nothing was planned for this day." : "Nothing planned. Rest counts — or add something."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-4">
        {!day.isPast ? (
          <Button type="button" size="sm" onClick={() => handlers.onAdd(day.dayKey)}>
            Add an activity
          </Button>
        ) : null}
        {fillable ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => handlers.onFillDay(day.dayKey)}>
            <JamiTutorIcon className="mr-1.5 h-3.5 w-3.5 text-warm-accent" />
            Let Jami fill the free time
          </Button>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {!day.isPast && day.activities.length > 0 ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => handlers.onClearDay(day.dayKey)}>
              Make it a rest day
            </Button>
          ) : null}
          {!day.isPast && day.kind !== "flexible" && handlers.hasUsualWeek(day.dayKey) ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => handlers.onResetDay(day.dayKey)}>
              Use my usual week
            </Button>
          ) : null}
        </span>
      </div>
    </section>
  );
}
