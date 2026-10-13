"use client";

import type { TutorAgentStepView } from "@/lib/ai/tutor-agent";

/**
 * What Jami looked up or worked out before answering (docs/tutor-agent.md).
 *
 * While the student waits, the steps already taken sit above the one under
 * way, so the wait reads as work being done; under a finished answer they fold
 * into one quiet line that opens to the list.
 */
export function TutorAgentStepsDone({ steps }: { steps: readonly TutorAgentStepView[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="mb-2 space-y-1 text-xs text-text-muted" aria-label="Done so far">
      {steps.map((step, index) => (
        <li key={`${step.tool}-${index}`} className="flex items-start gap-1.5">
          <CheckIcon />
          <span>{step.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function TutorAgentStepsSummary({ steps }: { steps: readonly TutorAgentStepView[] }) {
  if (steps.length === 0) return null;
  const summary = steps.length === 1 ? steps[0].label : `Looked into ${steps.length} things first`;
  return (
    <details className="group mb-1.5 text-xs text-text-muted">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 outline-none hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-accent/55 [&::-webkit-details-marker]:hidden">
        <CheckIcon />
        <span>{summary}</span>
        {steps.length > 1 ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 transition-transform group-open:rotate-180">
            <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </summary>
      {steps.length > 1 ? (
        <ul className="mt-1 space-y-1 pl-5">
          {steps.map((step, index) => (
            <li key={`${step.tool}-${index}`}>{step.label}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="mt-px h-3.5 w-3.5 shrink-0 text-accent">
      <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
