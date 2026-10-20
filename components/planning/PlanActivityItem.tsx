"use client";

import Link from "next/link";
import { JamiTutorIcon } from "@/components/ui";
import { PLAN_ACTIVITY_METHOD_LABELS, PLAN_ACTIVITY_START_LABELS, planActivityEndTime } from "@/lib/planning/plan-activities";
import type { PlanRefreshSuggestion } from "@/lib/planning/plan-drafting";
import type { TimetableActivity } from "@/lib/planning/timetable";

/**
 * One activity on the timetable, wherever it is shown.
 *
 * Read the way a calendar entry is read: when, how long, the subject's colour,
 * what it is. Two marks carry the rest. Jami's three-sparkle mark means Jami
 * chose this and may suggest something better as the student's work changes;
 * no mark means it is fixed, exactly as set. A free session is drawn as what it
 * is -- time with nothing in it yet -- with the way to fill it beside it.
 */

export type PlanActivityItemProps = {
  activity: TimetableActivity;
  subject?: string;
  color: string;
  /** Ticking is for today and the days gone; a day to come has nothing done in it. */
  canTick: boolean;
  upNext?: boolean;
  suggestion?: PlanRefreshSuggestion;
  /** The running goal doing this moves, by name. */
  goal?: string;
  onOpen: () => void;
  onToggle: (done: boolean) => void;
  onFill?: () => void;
  onAcceptSuggestion?: () => void;
  onKeep?: () => void;
};

function TickButton({
  done,
  label,
  disabled,
  onToggle,
  small = false,
}: {
  done: boolean;
  label: string;
  disabled: boolean;
  onToggle: (done: boolean) => void;
  /** For the week grid, where every pixel of a column is the task's name. */
  small?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`${done ? "Not done" : "Mark done"}: ${label}`}
      disabled={disabled}
      onClick={() => onToggle(!done)}
      className="relative z-[1] -m-1 grid shrink-0 place-items-center rounded-full p-1 transition duration-fast ease-spring active:scale-90 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
    >
      <span
        aria-hidden="true"
        className={`grid ${small ? "h-4 w-4" : "h-5 w-5"} place-items-center rounded-full border transition duration-normal ease-spring ${
          done
            ? "scale-105 border-transparent bg-[var(--color-success)] text-text-inverse"
            : disabled
              ? "border-dashed border-[var(--color-border)] text-transparent"
              : "border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-success)]"
        }`}
      >
        <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
          <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
}

function timeLine(activity: TimetableActivity) {
  const end = planActivityEndTime(activity);
  if (!activity.startTime) return `${activity.minutes} min`;
  return `${activity.startTime}${end ? `–${end}` : ""} · ${activity.minutes} min`;
}

/** The one-line name of a free session: its subject's time, or simply time set aside. */
function freeName(subject?: string) {
  return subject ? `Free · ${subject}` : "Free time";
}

/** A compact entry for the week grid: the whole card opens it; the tick sits apart. */
export function PlanActivityChip({ activity, subject, color, canTick, upNext, suggestion, onOpen, onToggle }: PlanActivityItemProps) {
  const done = Boolean(activity.completion);
  const name = activity.open ? freeName(subject) : activity.title;
  return (
    <div
      className={`group relative flex min-w-0 gap-2 rounded-xl border px-2 py-1.5 text-left transition duration-fast ease-spring hover:-translate-y-[1px] focus-within:ring-2 focus-within:ring-accent/45 ${
        activity.open
          ? "border-dashed border-[var(--color-border-strong)] bg-transparent"
          : upNext
            ? "border-[var(--color-success)] bg-[var(--color-success-muted)]"
            : "border-[var(--color-border)] bg-[var(--color-glass-subtle)] hover:border-[var(--color-border-strong)]"
      }`}
    >
      <span aria-hidden="true" className="mt-0.5 w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: color, opacity: activity.open ? 0.45 : 1 }} />
      <button type="button" onClick={onOpen} aria-label={`${name}${activity.startTime ? ` at ${activity.startTime}` : ""}, ${activity.minutes} minutes. Open`} className="absolute inset-0 rounded-xl focus-visible:outline-none" />
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="flex items-center gap-1 text-2xs tabular-nums text-text-muted">
          <span className="truncate">{activity.startTime ? `${activity.startTime} · ${activity.minutes}m` : `${activity.minutes}m`}</span>
          {activity.mode === "adaptive" && !activity.open ? <JamiTutorIcon className="h-2.5 w-2.5 shrink-0 text-warm-accent" /> : null}
          {suggestion ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warm-accent)]" aria-label="Jami has a suggestion" /> : null}
        </span>
        <span
          className={`mt-0.5 line-clamp-3 break-words text-xs font-semibold leading-snug ${
            done ? "text-text-muted line-through decoration-[var(--color-border-strong)]" : activity.open ? "text-text-secondary" : "text-text-primary"
          }`}
        >
          {name}
        </span>
        {!activity.open && subject ? <span className="mt-0.5 block truncate text-2xs text-text-muted">{subject}</span> : null}
      </span>
      {!activity.open ? (
        <span className="relative z-[1] self-start">
          <TickButton done={done} label={name} disabled={!canTick || activity.completion?.by === "activity"} onToggle={onToggle} small />
        </span>
      ) : null}
    </div>
  );
}

/** A full row, for a day read in detail and for Today: the way to start it, and what Jami would change. */
export function PlanActivityRow({
  activity,
  subject,
  color,
  canTick,
  upNext,
  suggestion,
  goal,
  onOpen,
  onToggle,
  onFill,
  onAcceptSuggestion,
  onKeep,
}: PlanActivityItemProps) {
  const done = Boolean(activity.completion);
  const quiet =
    "rounded-lg px-2 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45";

  if (activity.open) {
    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-dashed border-[var(--color-border-strong)] px-3 py-2.5">
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-text-secondary">{freeName(subject)}</span>
          <span className="block text-xs tabular-nums text-text-muted">{timeLine(activity)} · nothing chosen yet</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {onFill && activity.scopeKey ? (
            <button type="button" onClick={onFill} className={`${quiet} inline-flex items-center gap-1.5 text-[var(--color-accent)] hover:bg-[var(--color-glass-subtle)]`}>
              <JamiTutorIcon className="h-3 w-3" />
              Let Jami pick
            </button>
          ) : null}
          <button type="button" onClick={onOpen} className={`${quiet} text-text-secondary hover:bg-[var(--color-glass-subtle)] hover:text-text-primary`}>
            Choose a task
          </button>
        </span>
      </li>
    );
  }

  return (
    <li
      className={`rounded-2xl px-3 py-2.5 transition duration-fast ${
        upNext ? "bg-[var(--color-success-muted)]" : "hover:bg-[var(--color-glass-subtle)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="pt-0.5">
          <TickButton done={done} label={activity.title} disabled={!canTick || activity.completion?.by === "activity"} onToggle={onToggle} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={`min-w-0 break-words text-sm font-semibold leading-snug ${
                done ? "text-text-muted line-through decoration-[var(--color-border-strong)]" : "text-text-primary"
              }`}
            >
              {activity.title}
            </span>
            {activity.mode === "adaptive" ? (
              <span className="inline-flex items-center gap-1 text-2xs font-semibold text-warm-accent">
                <JamiTutorIcon className="h-3 w-3" />
                Jami&rsquo;s pick
              </span>
            ) : null}
            {upNext ? <span className="text-2xs font-semibold text-[var(--color-success)]">Up next</span> : null}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span>{subject ?? "No subject"}</span>
            <span aria-hidden="true">·</span>
            <span>{PLAN_ACTIVITY_METHOD_LABELS[activity.method]}</span>
            {activity.targetItems ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {activity.targetItems} {activity.method === "flashcards" ? "cards" : "questions"}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{timeLine(activity)}</span>
          </p>
          {activity.writtenOnStart && !done ? (
            <p className="mt-1 text-xs text-text-muted">No questions exist for this yet — Jami writes them when you start.</p>
          ) : null}
          {goal && !done ? (
            <p className="mt-1 text-xs text-text-muted">
              Counts towards <span className="font-semibold text-text-secondary">{goal}</span>
            </p>
          ) : null}
          {activity.completion?.by === "activity" ? (
            <p className="mt-1 text-xs font-semibold text-[var(--color-success)]">Done · Jami saw this</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {activity.href && !done ? (
            <Link
              href={activity.href}
              className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                upNext
                  ? "bg-accent text-accent-on shadow-accent hover:brightness-110"
                  : "border border-[var(--color-border-strong)] text-text-primary hover:bg-[var(--color-glass-subtle)]"
              }`}
            >
              {PLAN_ACTIVITY_START_LABELS[activity.method]}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Edit ${activity.title}`}
            className="grid h-8 w-8 place-items-center rounded-full text-text-muted transition hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      {suggestion && !done ? (
        <div className="ml-8 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-warm-border bg-warm-glow px-3 py-2">
          <JamiTutorIcon className="h-3.5 w-3.5 shrink-0 text-warm-accent" />
          <p className="min-w-0 flex-1 text-xs text-text-secondary">
            Your recent work has moved on. Jami would now pick <span className="font-semibold text-text-primary">{suggestion.task.title}</span>.
          </p>
          <span className="flex items-center gap-1">
            {onAcceptSuggestion ? (
              <button type="button" onClick={onAcceptSuggestion} className={`${quiet} text-[var(--color-accent)] hover:bg-[var(--color-glass-subtle)]`}>
                Use it
              </button>
            ) : null}
            {onKeep ? (
              <button type="button" onClick={onKeep} className={`${quiet} text-text-secondary hover:bg-[var(--color-glass-subtle)]`}>
                Keep mine
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </li>
  );
}
