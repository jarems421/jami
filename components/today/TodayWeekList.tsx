import Link from "next/link";
import type { RevisionPlanTodayState } from "@/hooks/useRevisionPlanToday";
import { planWeekOfPlan } from "@/lib/planning/plan-countdown";
import { timetableDayState } from "@/lib/planning/timetable";
import { PLAN_WEEKDAY_FULL_LABELS, PLAN_WEEKDAY_LABELS } from "@/lib/planning/types";

/**
 * The plan's week, down the side of Today: one line a day, what it holds, and
 * whether it is done. A reading of the week rather than a place to work in it;
 * every line opens the planner, where any day can be changed.
 */
export default function TodayWeekList({
  planToday,
  planHref,
}: {
  planToday: RevisionPlanTodayState;
  planHref: string;
}) {
  const { plan, week, scopeNames, todayDayKey } = planToday;
  if (!plan || week.length === 0) return null;
  const { current, total } = planWeekOfPlan(plan, todayDayKey);

  return (
    <nav aria-label="This week in your plan" className="app-panel rounded-3xl p-4">
      <div className="flex items-baseline justify-between gap-2 px-1 pb-2">
        <h2 className="text-sm font-bold tracking-tight text-text-primary">This week</h2>
        <span className="text-2xs text-text-muted">
          Week {current} of {total}
        </span>
      </div>
      <ol className="space-y-0.5">
        {week.map((day) => {
          const subjects = [
            ...new Set(day.activities.map((activity) => (activity.scopeKey ? scopeNames.get(activity.scopeKey) : undefined) ?? "Study")),
          ];
          const state = timetableDayState(day);
          const resting = day.kind === "rest";
          return (
            <li key={day.dayKey}>
              <Link
                href={planHref}
                aria-current={day.isToday ? "date" : undefined}
                aria-label={`${PLAN_WEEKDAY_FULL_LABELS[day.weekday]}: ${resting ? "rest" : subjects.join(", ")}, ${state.text}`}
                className={`flex items-center gap-3 rounded-xl px-2 py-2 transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                  day.isToday ? "bg-[var(--color-accent-muted)]" : "hover:bg-[var(--color-glass-subtle)]"
                }`}
              >
                <span className={`w-9 shrink-0 text-xs font-bold ${day.isToday ? "text-text-primary" : "text-text-muted"}`}>
                  {PLAN_WEEKDAY_LABELS[day.weekday]}
                </span>
                <span className={`min-w-0 flex-1 truncate text-xs ${resting ? "text-text-muted" : "text-text-secondary"}`}>
                  {resting ? "Rest" : subjects.join(", ")}
                </span>
                {!resting ? (
                  <span
                    className={`shrink-0 text-2xs font-semibold ${
                      state.done ? "text-[var(--color-success)]" : day.isToday ? "text-[var(--color-accent)]" : "text-text-muted"
                    }`}
                  >
                    {state.text}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
