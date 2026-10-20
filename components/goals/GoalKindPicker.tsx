"use client";

import { useId } from "react";
import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import type { GoalMeasure } from "@/lib/goals/model";

const KINDS: readonly { measure: GoalMeasure; title: string; detail: string }[] = [
  { measure: "cards", title: "Flashcards", detail: "Review a number of cards" },
  { measure: "questions", title: "Practice questions", detail: "Answer exam questions Jami marks" },
  { measure: "topic", title: "A topic", detail: "Get one topic to strong" },
];

/** The first choice in making a goal: what it is going to count. */
export default function GoalKindPicker({
  value,
  onChange,
}: {
  value: GoalMeasure;
  onChange: (measure: GoalMeasure) => void;
}) {
  const labelId = useId();
  return (
    <fieldset className="min-w-0">
      <legend id={labelId} className="mb-3 text-sm font-semibold text-text-primary">
        What do you want to aim at?
      </legend>
      <div role="radiogroup" aria-labelledby={labelId} className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((kind) => {
          const selected = kind.measure === value;
          return (
            <button
              key={kind.measure}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(kind.measure)}
              className={`flex min-w-0 items-center gap-3 rounded-xl border px-3 py-3 text-left transition duration-fast ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 sm:flex-col sm:items-start sm:gap-2.5 sm:px-4 sm:py-4 ${
                selected
                  ? "border-accent/55 bg-accent/10 shadow-e1"
                  : "border-[var(--color-border)] bg-[var(--color-surface-panel)] hover:border-[var(--color-border-strong)]"
              }`}
            >
              <GoalMeasureBadge measure={kind.measure} size="sm" />
              <span className="min-w-0">
                <span className="block text-sm font-bold text-text-primary">{kind.title}</span>
                <span className="mt-0.5 block text-xs leading-5 text-text-muted">{kind.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
