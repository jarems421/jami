"use client";

import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import { goalScopeLabel } from "@/lib/goals/model";
import { goalIdeaTiming, type GoalSuggestion } from "@/lib/goals/suggestions";

/**
 * Goals to start from: what Jami can suggest from what it already knows -- the
 * next exam, a topic its results point at, today's due cards, a week of steady
 * reviewing -- then a few ready-made ones. Picking one opens the composer with
 * it filled in; nothing is made until the student presses Create.
 */
export default function GoalSuggestions({
  suggestions,
  now,
  title = "Quick starts",
  onPick,
}: {
  suggestions: readonly GoalSuggestion[];
  now: number;
  title?: string;
  onPick: (suggestion: GoalSuggestion) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <section aria-labelledby="goal-ideas-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
        <h2 id="goal-ideas-title" className="text-base font-bold tracking-tight text-text-primary">
          {title}
        </h2>
        <p className="text-xs text-text-muted">Pick one to set it up</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            onClick={() => onPick(suggestion)}
            className="app-panel group flex h-full flex-col items-start gap-3 p-4 text-left transition duration-fast ease-spring hover:-translate-y-0.5 hover:shadow-e2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <span className="flex w-full items-center justify-between gap-2">
              <GoalMeasureBadge measure={suggestion.draft.measure} size="sm" />
              <span className="truncate text-2xs font-semibold uppercase tracking-[0.12em] text-text-muted">
                {suggestion.reason}
              </span>
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold leading-snug text-text-primary">{suggestion.title}</span>
              <span className="mt-1 block truncate text-xs text-text-muted">
                {goalScopeLabel(suggestion.draft)} · {goalIdeaTiming(suggestion.draft, now)}
              </span>
            </span>
            <span className="mt-auto text-xs font-semibold text-[var(--color-accent)] group-hover:text-[var(--color-accent-hover)]">
              Set this up <span aria-hidden="true">→</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
