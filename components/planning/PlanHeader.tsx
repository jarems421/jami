"use client";

import { Button, JamiTutorIcon } from "@/components/ui";
import type { PlanCountdownItem } from "@/lib/planning/plan-countdown";
import { PLANNER_VIEWS, type PlannerView } from "@/lib/planning/planner-view";

/**
 * The top of the planner: which plan, which days, and how to move between them.
 *
 * Kept to one band so the timetable starts high on the page. The countdown is
 * part of it because it is part of reading the week -- three days to an exam
 * is a different week from thirty.
 */

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function PlanHeader({
  eyebrow,
  title,
  rangeTitle,
  view,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  showingToday,
  onOpenSettings,
  onOpenAssistant,
  countdown,
  scopeColor,
  note,
}: {
  eyebrow: string;
  title: string;
  rangeTitle: string;
  view: PlannerView;
  onViewChange: (view: PlannerView) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  showingToday: boolean;
  onOpenSettings: () => void;
  /** Where Jami sits in a drawer rather than beside the timetable. */
  onOpenAssistant?: () => void;
  countdown: readonly PlanCountdownItem[];
  scopeColor: (scopeKey?: string) => string;
  note?: string;
}) {
  const navButton =
    "grid h-9 w-9 place-items-center rounded-full border border-[var(--color-border)] text-text-secondary transition hover:border-[var(--color-border-strong)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45";
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <p className="text-2xs font-bold uppercase tracking-[0.18em] text-text-muted">{eyebrow}</p>
          <h2 className="truncate text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">{title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onOpenAssistant ? (
            <Button type="button" variant="warm" size="sm" onClick={onOpenAssistant}>
              <JamiTutorIcon className="mr-1.5 h-3.5 w-3.5" />
              Plan with Jami
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" onClick={onOpenSettings}>
            <GearIcon />
            <span className="ml-1.5">Plan settings</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onPrevious} aria-label={`Previous ${view}`} className={navButton}>
            <Chevron direction="left" />
          </button>
          <button type="button" onClick={onNext} aria-label={`Next ${view}`} className={navButton}>
            <Chevron direction="right" />
          </button>
          <p className="ml-1.5 text-base font-semibold text-text-primary" aria-live="polite">
            {rangeTitle}
          </p>
          {!showingToday ? (
            <Button type="button" variant="ghost" size="sm" onClick={onToday}>
              Today
            </Button>
          ) : null}
        </div>
        <div role="group" aria-label="Show the plan by" className="flex rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-0.5">
          {PLANNER_VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={view === option.value}
              onClick={() => onViewChange(option.value)}
              className={`min-h-8 rounded-full px-3.5 text-xs font-semibold transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                view === option.value ? "bg-[var(--color-surface-panel-strong)] text-text-primary shadow-e1" : "text-text-muted hover:text-text-primary"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {countdown.length > 0 ? (
        <p aria-label="Counting down" className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-text-secondary">
          {countdown.map((item) => (
            <span key={item.id} className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: scopeColor(item.scopeKey) }} />
              <span className="font-semibold tabular-nums text-text-primary">
                {item.daysLeft === 0 ? "Today" : `${item.daysLeft} ${item.daysLeft === 1 ? "day" : "days"}`}
              </span>
              <span className="min-w-0 truncate">{item.label}</span>
            </span>
          ))}
        </p>
      ) : null}

      {note ? <p className="app-subtle-panel rounded-xl px-3 py-2 text-xs leading-5 text-text-secondary">{note}</p> : null}
    </header>
  );
}
