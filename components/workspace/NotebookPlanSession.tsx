"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { useNotebookPlanSession } from "@/hooks/useNotebookPlanSession";
import { getRevisionPlanHref } from "@/lib/app/routes";
import { formatPlanSessionClock, planSessionSecondsLeft, type PlanNotebookRef } from "@/lib/planning/plan-notebook";
import type { TimetableActivity } from "@/lib/planning/timetable";

/**
 * Today's planned notebook work, waiting in the notebook it is for.
 *
 * One pill in the notebook's bar, only when the plan has notebook work here
 * today: the work and its length, a running clock once started, a tick once
 * finished. Opened, it starts the session, finishes it -- which ticks it off
 * the plan with how long it ran -- or stops it without a tick. A clock and a
 * tick; nothing on the page is read for it.
 */

function SessionIcon({ state }: { state: "planned" | "running" | "done" }) {
  if (state === "running") {
    return <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--color-success)]" />;
  }
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.8 };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[1.125rem] w-[1.125rem] shrink-0">
      {state === "done" ? (
        <path {...common} d="m5.5 12.6 4.2 4.2 8.8-9.4" />
      ) : (
        <>
          <circle {...common} cx="12" cy="13" r="7.2" />
          <path {...common} d="M12 9.6V13l2.4 1.6M9.6 3.6h4.8" />
        </>
      )}
    </svg>
  );
}

function when(activity: TimetableActivity) {
  return activity.startTime ? `${activity.minutes} min · from ${activity.startTime}` : `${activity.minutes} min`;
}

export default function NotebookPlanSession({ uid, notebook }: { uid: string; notebook: PlanNotebookRef }) {
  const planned = useNotebookPlanSession({ uid, notebook });
  const { activities, current, session, now } = planned;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // A session running for other work still shows here, so it can be finished from wherever the student is.
  const shown = current && !activities.some((activity) => activity.id === current.id) ? [current, ...activities] : activities;
  if (shown.length === 0) return null;

  const left = current && session ? planSessionSecondsLeft(session.startedAt, current.minutes, now) : null;
  const allDone = shown.every((activity) => activity.completion);
  const next = shown.find((activity) => !activity.completion) ?? shown[0];
  const state = left !== null ? "running" : allDone ? "done" : "planned";
  const label =
    left !== null && current
      ? `${current.title}: ${formatPlanSessionClock(left)} ${left < 0 ? "over" : "left"}`
      : allDone
        ? "Today's planned notebook work is done"
        : `Planned today: ${next?.title}, ${next?.minutes} minutes`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border px-3 text-sm font-semibold transition duration-200 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
          state === "running"
            ? "border-[var(--color-success)] bg-[var(--color-success-muted)] text-text-primary"
            : state === "done"
              ? "border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] text-[var(--color-success)]"
              : "border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)] hover:border-[var(--button-secondary-border-hover)] hover:bg-[var(--button-secondary-bg-hover)]"
        }`}
      >
        <SessionIcon state={state} />
        <span className={`tabular-nums ${state === "running" ? "" : "hidden lg:inline"}`}>
          {left !== null ? formatPlanSessionClock(left) : allDone ? "Done" : `${next?.minutes} min`}
        </span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Today's planned notebook work"
          className="app-panel absolute right-0 top-full z-50 mt-2 w-[min(21rem,calc(100vw-1.5rem))] space-y-4 rounded-2xl p-4 shadow-e3"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">Today&rsquo;s plan</p>
            <Link
              href={getRevisionPlanHref()}
              className="rounded text-xs font-semibold text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              Open plan
            </Link>
          </div>

          <ul className="space-y-3">
            {shown.slice(0, 3).map((activity) => {
              const running = current?.id === activity.id && left !== null;
              const done = activity.completion;
              return (
                <li
                  key={activity.id}
                  className={`space-y-3 rounded-xl border px-3.5 py-3 ${
                    running ? "border-[var(--color-success)] bg-[var(--color-success-muted)]" : "border-[var(--color-border)] bg-[var(--color-glass-subtle)]"
                  }`}
                >
                  <div className="min-w-0">
                    <p className={`break-words text-sm font-semibold leading-snug ${done ? "text-text-muted line-through" : "text-text-primary"}`}>
                      {activity.title}
                    </p>
                    <p className="mt-0.5 text-xs tabular-nums text-text-muted">
                      {done ? `Done${done.minutes ? ` · ${done.minutes} min` : ""}` : when(activity)}
                    </p>
                  </div>
                  {running && left !== null ? (
                    <div className="space-y-3">
                      <p className="text-3xl font-bold tabular-nums tracking-tight text-text-primary" role="timer" aria-live="off">
                        {formatPlanSessionClock(left)}
                        <span className="ml-2 text-xs font-semibold text-text-muted">{left < 0 ? "over" : "left"}</span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={() => void planned.finish()}>
                          Finish
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={planned.stop}>
                          Stop without ticking
                        </Button>
                      </div>
                    </div>
                  ) : !done && left === null ? (
                    <Button type="button" size="sm" onClick={() => planned.start(activity.id)}>
                      Start · {activity.minutes} min
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {left === null && !allDone ? (
            <p className="text-xs leading-5 text-text-muted">Times it here. Finishing ticks it off your plan.</p>
          ) : null}
          {planned.problem ? (
            <p role="alert" className="text-xs leading-5 text-[var(--color-error-text)]">
              {planned.problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
