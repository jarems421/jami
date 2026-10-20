"use client";

import type { ReactNode } from "react";
import { JamiTutorIcon } from "@/components/ui";

/**
 * A word from Jami about the timetable: what a pick will do, or why it could
 * not. Warm and quiet rather than an alert, because nothing has gone wrong --
 * Jami is saying what it can and cannot do.
 */
export default function PlanJamiNote({
  children,
  onDismiss,
  className = "",
}: {
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2.5 rounded-2xl border border-warm-border bg-warm-glow px-4 py-3 text-sm leading-6 text-text-secondary ${className}`}
    >
      <JamiTutorIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-warm-accent" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-muted transition hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
