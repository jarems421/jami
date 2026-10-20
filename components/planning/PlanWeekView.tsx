"use client";

import { PlanActivityChip } from "@/components/planning/PlanActivityItem";
import { JamiTutorIcon } from "@/components/ui";
import type { PlanRefreshSuggestion } from "@/lib/planning/plan-drafting";
import { formatPlanMinutes } from "@/lib/planning/plan-format";
import type { TimetableActivity, TimetableDay } from "@/lib/planning/timetable";
import { PLAN_WEEKDAY_FULL_LABELS, PLAN_WEEKDAY_LABELS } from "@/lib/planning/types";

/**
 * The week, as seven days of real activities.
 *
 * The timetable is the page: every activity where it was put, every free
 * session drawn as the empty time it is, each day's exams marked on it. Tap an
 * activity to change it, a day's name to read it in full, or the plus to add to
 * it. Seven columns wherever they fit; on a phone the same week reads down the
 * screen, a day at a time.
 */

export type PlanCalendarHandlers = {
  scopeName: (scopeKey?: string) => string | undefined;
  scopeColor: (scopeKey?: string) => string;
  suggestions: ReadonlyMap<string, PlanRefreshSuggestion>;
  upNextId?: string;
  onOpenDay: (dayKey: string) => void;
  onOpenActivity: (dayKey: string, activity: TimetableActivity) => void;
  onAdd: (dayKey: string) => void;
  onToggle: (day: TimetableDay, activity: TimetableActivity, done: boolean) => void;
  onFillDay: (dayKey: string) => void;
  /** Jami picks for one free session. */
  onPick: (dayKey: string, activity: TimetableActivity) => void;
};

function dayNumber(dayKey: string) {
  return Number(dayKey.slice(-2));
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function DayColumn({ day, handlers }: { day: TimetableDay; handlers: PlanCalendarHandlers }) {
  const fillable = !day.isPast && day.activities.some((activity) => activity.open && activity.scopeKey);
  const label = `${PLAN_WEEKDAY_FULL_LABELS[day.weekday]} ${dayNumber(day.dayKey)}`;
  return (
    <li
      className={`flex min-w-0 flex-col gap-2 rounded-2xl border p-2 transition duration-fast md:min-h-[10rem] ${
        day.isToday
          ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
          : day.kind === "flexible"
            ? "border-dashed border-[var(--color-border)]"
            : "border-[var(--color-border)] bg-[var(--color-glass-subtle)]"
      } ${day.withinPlan ? "" : "opacity-60"}`}
    >
      <button
        type="button"
        onClick={() => handlers.onOpenDay(day.dayKey)}
        aria-label={`${label}: open the day`}
        className="flex items-baseline justify-between gap-1 rounded-lg px-1 pt-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <span className="flex items-baseline gap-1.5">
          <span className={`text-2xs font-bold uppercase tracking-[0.12em] ${day.isToday ? "text-[var(--color-accent)]" : "text-text-muted"}`}>
            {PLAN_WEEKDAY_LABELS[day.weekday]}
          </span>
          <span className={`text-lg font-bold tabular-nums leading-none ${day.isToday ? "text-text-primary" : "text-text-secondary"}`}>
            {dayNumber(day.dayKey)}
          </span>
        </span>
        <span className="text-2xs tabular-nums text-text-muted">
          {day.minutes > 0 ? formatPlanMinutes(day.minutes) : day.withinPlan ? "Rest" : ""}
        </span>
      </button>

      {day.exams.map((exam) => (
        <p key={exam.id} className="app-warning truncate rounded-lg px-2 py-1 text-2xs font-semibold" title={exam.label}>
          Exam · {exam.label}
        </p>
      ))}

      <ul className="flex flex-col gap-1.5">
        {day.activities.map((activity) => (
          <li key={activity.id}>
            <PlanActivityChip
              activity={activity}
              subject={handlers.scopeName(activity.scopeKey)}
              color={handlers.scopeColor(activity.scopeKey)}
              canTick={day.isToday || day.isPast}
              upNext={activity.id === handlers.upNextId && day.isToday}
              {...(handlers.suggestions.get(`${day.dayKey}|${activity.id}`) ? { suggestion: handlers.suggestions.get(`${day.dayKey}|${activity.id}`) } : {})}
              onOpen={() => handlers.onOpenActivity(day.dayKey, activity)}
              onToggle={(done) => handlers.onToggle(day, activity, done)}
            />
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-wrap items-center gap-x-1 gap-y-0.5 pt-1">
        {!day.isPast ? (
          <button
            type="button"
            onClick={() => handlers.onAdd(day.dayKey)}
            aria-label={`Add to ${label}`}
            className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-2xs font-semibold text-text-muted transition hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <PlusIcon />
            Add
          </button>
        ) : null}
        {fillable ? (
          <button
            type="button"
            onClick={() => handlers.onFillDay(day.dayKey)}
            aria-label={`Let Jami fill the free sessions on ${label}`}
            className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-2xs font-semibold text-[var(--color-accent)] transition hover:bg-[var(--color-glass-medium)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <JamiTutorIcon className="h-2.5 w-2.5" />
            Fill
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function PlanWeekView({ days, handlers }: { days: readonly TimetableDay[]; handlers: PlanCalendarHandlers }) {
  // Columns follow the grid's own width (`.plan-week-grid` in globals.css), so beside Jami it wraps rather than crushes.
  return (
    <div className="plan-week-layout">
      <ol aria-label="Your week" className="app-rise plan-week-grid grid gap-2">
        {days.map((day) => (
          <DayColumn key={day.dayKey} day={day} handlers={handlers} />
        ))}
      </ol>
    </div>
  );
}
