"use client";

import { Button, ButtonLink } from "@/components/ui";
import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import { GoalPaceLine, GoalProgressVisual } from "@/components/goals/GoalProgress";
import type { GoalDeadlineTone } from "@/lib/goals/deadlines";
import { getGoalDisplayName, goalScopeLabel, type Goal } from "@/lib/goals/model";
import type { GoalNextStep } from "@/lib/goals/next-step";
import { goalAccuracy, goalAverageScore } from "@/lib/goals/progress";
import type { GoalStanding } from "@/lib/goals/standing";

const DEADLINE_CLASS: Record<GoalDeadlineTone, string> = {
  none: "app-chip",
  calm: "app-chip",
  soon: "app-warning",
  today: "app-warning",
  passed: "app-danger",
};

function statLine(goal: Goal) {
  const average = goalAverageScore(goal);
  if (average !== null) return `Averaging ${Math.round(average * 100)}%`;
  const accuracy = goal.measure === "cards" ? goalAccuracy(goal) : null;
  return accuracy !== null ? `${Math.round(accuracy * 100)}% right` : null;
}

/**
 * One running goal: what it is, where it stands, whether it is on pace, and the
 * way to the work that moves it.
 */
export default function GoalCard({
  goal,
  standing,
  nextStep,
  busy = false,
  onEdit,
  onEnd,
}: {
  goal: Goal;
  standing: GoalStanding;
  nextStep: GoalNextStep | null;
  busy?: boolean;
  onEdit: () => void;
  onEnd: () => void;
}) {
  const name = getGoalDisplayName(goal);
  const stat = statLine(goal);
  const titleId = `goal-${goal.id}-title`;

  return (
    <article
      aria-labelledby={titleId}
      className="app-panel flex h-full flex-col gap-4 p-4 transition duration-fast ease-spring hover:-translate-y-0.5 hover:shadow-e2 sm:p-5"
    >
      <header className="flex items-start gap-3">
        <GoalMeasureBadge measure={goal.measure} />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="line-clamp-2 break-words text-base font-bold leading-snug tracking-tight text-text-primary">
            {name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {goalScopeLabel(goal)}
            {goal.exam ? ` · For ${goal.exam.label}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-2xs font-semibold uppercase tracking-[0.08em] ${DEADLINE_CLASS[standing.deadline.tone]}`}
        >
          {standing.deadline.label}
        </span>
      </header>

      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold tabular-nums text-text-primary">{standing.headline}</p>
          {stat ? <p className="shrink-0 text-xs tabular-nums text-text-muted">{stat}</p> : null}
        </div>
        <GoalProgressVisual standing={standing} />
        <GoalPaceLine standing={standing} />
      </div>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
        {nextStep ? (
          <ButtonLink href={nextStep.href} size="sm" variant="secondary">
            {nextStep.label}
            <span aria-hidden="true" className="ml-1.5">
              →
            </span>
          </ButtonLink>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onEdit} aria-label={`Edit ${name}`}>
            Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onEnd} aria-label={`End ${name}`}>
            End
          </Button>
        </div>
      </footer>
    </article>
  );
}
