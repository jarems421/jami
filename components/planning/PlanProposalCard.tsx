"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { PlanAssistantProposal } from "@/hooks/usePlanInterview";

/**
 * A change Jami proposed, in full, before anything happens.
 *
 * The headline is what the student asked for -- "Move 2 activities · Mon →
 * Wed" -- and every line under it is one thing that would change. Nothing on
 * the timetable moves until they apply it, and applying it is undoable like any
 * other change.
 */
export default function PlanProposalCard({
  proposal,
  headline,
  lines,
  onApply,
  onDiscard,
}: {
  proposal: PlanAssistantProposal;
  headline: string;
  lines: readonly string[];
  onApply: () => Promise<boolean>;
  onDiscard: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const settled = proposal.status !== "open";
  return (
    <section
      aria-label="Proposed change"
      className={`rounded-2xl border p-3.5 transition duration-normal ${
        settled ? "border-[var(--color-border)] opacity-70" : "border-[var(--color-border-strong)] bg-[var(--color-glass-subtle)] shadow-e1"
      }`}
    >
      <p className="text-2xs font-bold uppercase tracking-[0.16em] text-text-muted">
        {proposal.status === "applied" ? "Applied" : proposal.status === "discarded" ? "Discarded" : "Proposed change"}
      </p>
      <p className="mt-1 text-sm font-semibold text-text-primary">{headline}</p>
      {lines.length > 1 || (lines.length === 1 && lines[0] !== headline) ? (
        <ul className="mt-2 space-y-1">
          {lines.map((line, index) => (
            <li key={`${index}-${line}`} className="flex gap-2 text-xs leading-5 text-text-secondary">
              <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--color-text-muted)]" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!settled ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onApply().finally(() => setBusy(false));
            }}
          >
            {busy ? "Applying…" : "Apply changes"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
        </div>
      ) : null}
    </section>
  );
}
