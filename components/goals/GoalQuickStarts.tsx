"use client";

import { useId } from "react";
import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import { sameGoalDraft } from "@/lib/goals/drafts";
import type { GoalDraft } from "@/lib/goals/model";
import { goalIdeaTiming, type GoalSuggestion } from "@/lib/goals/suggestions";

/**
 * Goals ready to go, across the top of the composer: Jami's suggestions first,
 * then a few plain ones. A tap fills every field below in, and the idea the
 * composer is showing stays marked until something is changed.
 */
export default function GoalQuickStarts({
  ideas,
  draft,
  now,
  onPick,
}: {
  ideas: readonly GoalSuggestion[];
  draft: GoalDraft;
  now: number;
  onPick: (draft: GoalDraft) => void;
}) {
  const labelId = useId();
  if (ideas.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p id={labelId} className="text-sm font-semibold text-text-primary">
          Quick start
        </p>
        <p className="text-xs text-text-muted">Fills everything in below</p>
      </div>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {ideas.map((idea) => {
          const selected = sameGoalDraft(draft, idea.draft);
          return (
            <button
              key={idea.id}
              type="button"
              aria-pressed={selected}
              title={idea.reason}
              onClick={() => onPick(idea.draft)}
              className={`inline-flex min-h-[2.75rem] max-w-full items-center gap-2.5 rounded-xl border py-1.5 pl-1.5 pr-3.5 text-left text-sm transition duration-fast ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                selected
                  ? "border-accent/55 bg-accent/10 shadow-e1"
                  : "border-[var(--color-border)] bg-[var(--color-surface-panel)] hover:-translate-y-px hover:border-[var(--color-border-strong)]"
              }`}
            >
              <GoalMeasureBadge measure={idea.draft.measure} size="sm" />
              <span className="min-w-0 truncate font-semibold text-text-primary">{idea.title}</span>
              <span className="shrink-0 text-xs text-text-muted">{goalIdeaTiming(idea.draft, now)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
