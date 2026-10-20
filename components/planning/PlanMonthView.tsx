"use client";

import type { TimetableDay } from "@/lib/planning/timetable";
import { PLAN_WEEKDAY_LABELS, type PlanWeekday } from "@/lib/planning/types";

/**
 * The month, for looking ahead: where the exams fall, which days are planned,
 * which still run on the usual week, which are rest. A day opens in full.
 */

const MONDAY_FIRST: readonly PlanWeekday[] = [1, 2, 3, 4, 5, 6, 0];
const SHOWN_PER_DAY = 3;

export default function PlanMonthView({
  days,
  month,
  scopeColor,
  onOpenDay,
}: {
  days: readonly TimetableDay[];
  /** "2026-10": the month whose days are drawn in full; the rest of the grid is faded. */
  month: string;
  scopeColor: (scopeKey?: string) => string;
  onOpenDay: (dayKey: string) => void;
}) {
  return (
    <div className="space-y-2">
      <ol className="grid grid-cols-7 gap-1 text-center" aria-hidden="true">
        {MONDAY_FIRST.map((weekday) => (
          <li key={weekday} className="text-2xs font-bold uppercase tracking-[0.12em] text-text-muted">
            {PLAN_WEEKDAY_LABELS[weekday]}
          </li>
        ))}
      </ol>
      <ol aria-label="This month" className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const inMonth = day.dayKey.startsWith(month);
          const shown = day.activities.slice(0, SHOWN_PER_DAY);
          const more = day.activities.length - shown.length;
          return (
            <li key={day.dayKey} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenDay(day.dayKey)}
                aria-label={`${day.dayKey}: ${day.taskCount} activities${day.openCount ? `, ${day.openCount} free` : ""}${
                  day.exams.length ? `, exam: ${day.exams.map((exam) => exam.label).join(", ")}` : ""
                }`}
                className={`flex aspect-square w-full min-w-0 flex-col gap-1 rounded-xl border p-1 text-left transition duration-fast hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 sm:aspect-auto sm:min-h-[6.5rem] sm:p-1.5 ${
                  day.isToday
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
                    : day.kind === "flexible"
                      ? "border-dashed border-[var(--color-border)]"
                      : day.kind === "planned"
                        ? "border-[var(--color-border)] bg-[var(--color-glass-subtle)]"
                        : "border-transparent"
                } ${inMonth ? "" : "opacity-40"}`}
              >
                <span className="flex items-center justify-between gap-1">
                  <span className={`text-xs font-bold tabular-nums ${day.isToday ? "text-[var(--color-accent)]" : "text-text-secondary"}`}>
                    {Number(day.dayKey.slice(-2))}
                  </span>
                  {day.exams.length > 0 ? (
                    <span className="app-warning hidden truncate rounded px-1 text-2xs font-semibold sm:inline">Exam</span>
                  ) : null}
                </span>
                {day.exams.length > 0 ? <span className="h-1 w-full rounded-full bg-[var(--color-warning)] sm:hidden" /> : null}
                <span className="flex flex-wrap gap-0.5 sm:flex-col sm:flex-nowrap sm:gap-0.5">
                  {shown.map((activity) => (
                    <span key={activity.id} className="flex min-w-0 items-center gap-1">
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: scopeColor(activity.scopeKey), opacity: activity.open ? 0.45 : 1 }}
                      />
                      <span
                        className={`hidden min-w-0 truncate text-2xs sm:block ${
                          activity.completion ? "text-text-muted line-through" : activity.open ? "text-text-muted" : "text-text-secondary"
                        }`}
                      >
                        {activity.open ? "Free" : activity.title}
                      </span>
                    </span>
                  ))}
                  {more > 0 ? <span className="text-2xs text-text-muted">+{more}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
