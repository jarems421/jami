"use client";

import { useId, type ReactNode } from "react";

export type GoalChipOption<Value extends string> = {
  value: Value;
  label: ReactNode;
  /** Read out instead of the label, when the label alone would be unclear. */
  ariaLabel?: string;
  disabled?: boolean;
};

/**
 * A row of one-tap choices: an amount, a deadline, where a goal counts from.
 *
 * The composer is mostly these, which is what keeps it from being a form. A
 * chip is a radio: one is chosen, the rest stay readable, and the row wraps
 * rather than scrolling sideways on a phone.
 */
export default function GoalChips<Value extends string>({
  label,
  hideLabel = false,
  value,
  options,
  onChange,
}: {
  label: string;
  hideLabel?: boolean;
  value: Value | null;
  options: readonly GoalChipOption<Value>[];
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <div className="min-w-0">
      <span id={labelId} className={hideLabel ? "sr-only" : "mb-2 block text-sm font-semibold text-text-primary"}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.ariaLabel}
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
              className={`inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition duration-fast ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "border-accent/55 bg-accent/10 text-text-primary shadow-e1"
                  : "border-[var(--color-border)] bg-[var(--color-surface-panel)] text-text-secondary hover:border-[var(--color-border-strong)] hover:text-text-primary"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
