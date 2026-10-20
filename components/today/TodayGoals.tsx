import Link from "next/link";
import { GoalMeasureIcon } from "@/components/goals/GoalIcons";
import { GoalPaceLine } from "@/components/goals/GoalProgress";
import { ProgressBar } from "@/components/ui";
import type { TodayGoalSummary } from "@/lib/dashboard/today-plan";

/**
 * Running goals, in Today's side column: where each stands and whether it is
 * on pace, the one most in need of attention first. Each opens Goals, where the
 * way to the work is.
 */
export default function TodayGoals({ goals }: { goals: readonly TodayGoalSummary[] }) {
  if (goals.length === 0) return null;
  return (
    <section aria-labelledby="today-goals-title" className="app-panel rounded-3xl p-4">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 id="today-goals-title" className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
          {goals.length === 1 ? "Goal" : "Goals"}
        </h2>
        <Link
          href="/dashboard/goals"
          className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
        >
          All goals
        </Link>
      </div>
      <ul className="mt-2 space-y-1">
        {goals.map((goal) => (
          <li key={goal.goalId}>
            <Link
              href={goal.href}
              className="block space-y-2 rounded-2xl px-1 py-2 transition duration-fast hover:bg-[var(--color-glass-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              <span className="flex items-center gap-2">
                <GoalMeasureIcon measure={goal.measure} className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 truncate text-sm font-bold text-text-primary">{goal.title}</span>
              </span>
              <span className="block">
                <ProgressBar progress={goal.progressPercent} size="sm" variant="warm" />
              </span>
              <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="text-xs tabular-nums text-text-muted">{goal.headline}</span>
                <GoalPaceLine standing={{ pace: goal.detail, tone: goal.tone }} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
