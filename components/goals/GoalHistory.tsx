"use client";

import { useId, useState } from "react";
import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import { Button, Skeleton } from "@/components/ui";
import { goalDayLabel } from "@/lib/goals/deadlines";
import { getGoalDisplayName, goalScopeLabel, type Goal } from "@/lib/goals/model";
import { goalOutcomeLine } from "@/lib/goals/standing";
import { getStudyDayKey } from "@/lib/study/day";

const STATUS: Record<Exclude<Goal["status"], "active">, { label: string; className: string }> = {
  completed: { label: "Completed", className: "app-success" },
  failed: { label: "Time ran out", className: "app-warning" },
  cancelled: { label: "Ended early", className: "app-chip" },
};

/**
 * Goals that are over: finished, ended early, or out of time, newest first.
 *
 * Closed until asked for, and read only then. Any of them can be started
 * again with the same shape, which is usually the point of looking back.
 */
export default function GoalHistory({
  items,
  loaded,
  loading,
  unavailable,
  hasMore,
  onLoad,
  onRepeat,
}: {
  items: readonly Goal[];
  loaded: boolean;
  loading: boolean;
  unavailable: boolean;
  hasMore: boolean;
  onLoad: (options?: { append?: boolean }) => void;
  onRepeat: (goal: Goal) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section aria-label="Past goals" className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !loaded) onLoad();
        }}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3 text-left transition duration-fast hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <span className="min-w-0">
          <span className="block text-sm font-bold text-text-primary">Past goals</span>
          <span className="block text-xs text-text-muted">Finished, ended early or out of time</span>
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-text-muted transition duration-fast ${open ? "rotate-180" : ""}`}
        >
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div id={panelId} className="space-y-3">
          {loading && !loaded ? (
            <div className="space-y-2" aria-label="Loading past goals">
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
            </div>
          ) : unavailable ? (
            <div className="app-subtle-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm">
              <span>Your past goals could not load.</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => onLoad()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="app-subtle-panel rounded-2xl px-4 py-3 text-sm leading-6">
              Nothing here yet. Goals you finish, end or run out of time on will collect here.
            </p>
          ) : (
            <>
              <ul className="app-panel divide-y divide-[var(--color-border)] p-0">
                {items.map((goal) => {
                  const status = goal.status === "active" ? STATUS.cancelled : STATUS[goal.status];
                  const when = goal.completedAt ?? goal.createdAt;
                  return (
                    <li key={goal.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <GoalMeasureBadge measure={goal.measure} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-text-primary">{getGoalDisplayName(goal)}</p>
                        <p className="truncate text-xs text-text-muted">
                          {goalScopeLabel(goal)} · {goalOutcomeLine(goal)}
                          {when > 0 ? ` · ${goalDayLabel(getStudyDayKey(when))}` : ""}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-2xs font-semibold ${status.className}`}>
                        {status.label}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onRepeat(goal)}
                        aria-label={`Go again: ${getGoalDisplayName(goal)}`}
                      >
                        Go again
                      </Button>
                    </li>
                  );
                })}
              </ul>
              {hasMore ? (
                <Button type="button" variant="secondary" disabled={loading} onClick={() => onLoad({ append: true })}>
                  {loading ? "Loading..." : "Show more"}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
