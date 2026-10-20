"use client";

import { useId } from "react";

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-panel)] text-lg font-semibold text-text-secondary transition duration-fast hover:border-[var(--color-border-strong)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

/**
 * How many: a number that can be typed, nudged, or picked from a few amounts
 * that suit the kind of goal. Most students tap a preset and move on.
 */
export default function GoalAmountField({
  label,
  unit,
  value,
  max,
  presets,
  onChange,
}: {
  label: string;
  /** What is being counted, after the number: "cards", "days". */
  unit: string;
  value: number;
  max: number;
  presets: readonly number[];
  onChange: (value: number) => void;
}) {
  const inputId = useId();
  const step = value >= 100 ? 10 : value >= 20 ? 5 : 1;
  const set = (next: number) => onChange(Math.max(1, Math.min(max, Math.round(next))));

  return (
    <div className="min-w-0">
      <label htmlFor={inputId} className="mb-2 block text-sm font-semibold text-text-primary">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <StepButton label={`Fewer ${unit}`} disabled={value <= 1} onClick={() => set(value - step)}>
            −
          </StepButton>
          <div className="relative">
            <input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              value={value > 0 ? value : ""}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onChange(Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : 0);
              }}
              className="app-field h-11 w-24 rounded-xl px-3 text-center text-lg font-bold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <StepButton label={`More ${unit}`} disabled={value >= max} onClick={() => set(value + step)}>
            +
          </StepButton>
          <span className="pl-1 text-sm text-text-muted">{unit}</span>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Common amounts of ${unit}`}>
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={preset === value}
              onClick={() => set(preset)}
              className={`min-h-[2rem] rounded-full border px-3 text-xs font-semibold tabular-nums transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                preset === value
                  ? "border-accent/55 bg-accent/10 text-text-primary"
                  : "border-[var(--color-border)] text-text-secondary hover:border-[var(--color-border-strong)] hover:text-text-primary"
              }`}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
