"use client";

import { Button } from "@/components/ui";
import { formatPlanMinutes } from "@/lib/planning/plan-format";
import type { TimetableDay } from "@/lib/planning/timetable";

/**
 * The foot of the planner: what the week in view adds up to, the way back from
 * the last change, and -- while a plan is being built -- the one button that
 * keeps it. A running plan saves as it changes, so it says that instead.
 */
export default function PlanSummaryBar({
  days,
  building,
  saving,
  canSave,
  undoLabel,
  note,
  onUndo,
  onSave,
}: {
  days: readonly TimetableDay[];
  building: boolean;
  saving: boolean;
  canSave: boolean;
  undoLabel: string | null;
  /** What just changed, when it was Jami that changed it, so it is never done quietly. */
  note?: string;
  onUndo: () => void;
  onSave: () => void;
}) {
  const tasks = days.reduce((total, day) => total + day.taskCount, 0);
  const free = days.reduce((total, day) => total + day.openCount, 0);
  const minutes = days.reduce((total, day) => total + day.minutes, 0);
  const parts = [
    `${tasks} scheduled ${tasks === 1 ? "activity" : "activities"}`,
    ...(free > 0 ? [`${free} free ${free === 1 ? "session" : "sessions"}`] : []),
    ...(minutes > 0 ? [formatPlanMinutes(minutes)] : []),
  ];
  return (
    <div className="sticky bottom-3 z-20">
      <div className="app-panel flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-3 shadow-e3 sm:px-5">
        {note ? (
          <p className="w-full text-xs leading-5 text-text-muted" role="status">
            {note}
          </p>
        ) : null}
        <p className="min-w-0 flex-1 text-sm tabular-nums text-text-secondary">
          <span className="font-semibold text-text-primary">{parts[0]}</span>
          {parts.length > 1 ? ` · ${parts.slice(1).join(" · ")}` : ""}
          <span className="hidden sm:inline"> {building ? "so far" : "in view"}</span>
        </p>
        <div className="flex items-center gap-2">
          {undoLabel ? (
            <Button type="button" size="sm" variant="ghost" onClick={onUndo} aria-label={`Undo ${undoLabel}`}>
              Undo
            </Button>
          ) : null}
          {building ? (
            <Button type="button" size="sm" disabled={!canSave || saving} onClick={onSave}>
              {saving ? "Saving…" : "Save plan"}
            </Button>
          ) : (
            <span className="text-xs text-text-muted" role="status">
              {saving ? "Saving…" : "Saved"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
