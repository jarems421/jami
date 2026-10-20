"use client";

import { Button, DateField, Input, Select } from "@/components/ui";
import { MAX_PLAN_EXAMS, MAX_PLAN_EXAM_LABEL_LENGTH, unusedPlanExamId } from "@/lib/planning/normalize-plan";
import type { RevisionPlanExam } from "@/lib/planning/types";

/**
 * The exams a plan counts down to: a name, a date, and which subject, if the
 * student wants to say. Optional -- a plan with no exams counts down to its
 * own finish instead.
 */

export default function PlanExamsEditor({
  exams,
  subjects,
  defaultDayKey,
  onChange,
  layout = "row",
}: {
  exams: readonly RevisionPlanExam[];
  subjects: readonly { key: string; label: string }[];
  /** Where a new exam's date starts: the plan's finish is the usual answer. */
  defaultDayKey: string;
  onChange: (exams: RevisionPlanExam[]) => void;
  /**
   * `row` puts an exam's four controls side by side, for the full builder.
   * `stacked` gives each field the card's width, for the column of Jami's
   * questions: date and subject share a line only where the card has room
   * for both (`.plan-dates-grid`), which beside the timetable it does not.
   */
  layout?: "row" | "stacked";
}) {
  const update = (index: number, patch: Partial<RevisionPlanExam>) =>
    onChange(exams.map((exam, position) => (position === index ? { ...exam, ...patch } : exam)));
  const stacked = layout === "stacked";

  return (
    <div className={stacked ? "space-y-4" : "space-y-3"}>
      {exams.map((exam, index) => {
        const name = (
          <Input
            label={stacked ? "Name" : "Exam"}
            value={exam.label}
            maxLength={MAX_PLAN_EXAM_LABEL_LENGTH}
            placeholder="Chemistry Paper 1"
            onChange={(event) => update(index, { label: event.target.value })}
          />
        );
        const date = (
          <DateField label="Date" value={exam.dayKey} onValueChange={(dayKey) => update(index, { dayKey })} />
        );
        const subject = (
          <Select
            label="Subject"
            value={exam.scopeKey ?? ""}
            onChange={(event) => {
              const scopeKey = event.target.value;
              // "Not one subject" has to take the key away, not leave an empty one behind.
              const unscoped: RevisionPlanExam = { id: exam.id, label: exam.label, dayKey: exam.dayKey };
              onChange(
                exams.map((item, position) =>
                  position === index ? (scopeKey ? { ...unscoped, scopeKey } : unscoped) : item
                )
              );
            }}
          >
            <option value="">Not one subject</option>
            {subjects.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        );
        const remove = (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Remove ${exam.label || "this exam"}`}
            onClick={() => onChange(exams.filter((_, position) => position !== index))}
          >
            Remove
          </Button>
        );

        return stacked ? (
          <div
            key={exam.id}
            className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4"
          >
            <div className="-my-1 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
                {exams.length > 1 ? `Exam ${index + 1}` : "Your exam"}
              </p>
              <button
                type="button"
                aria-label={`Remove ${exam.label || "this exam"}`}
                onClick={() => onChange(exams.filter((_, position) => position !== index))}
                className="-mr-1.5 grid h-8 w-8 place-items-center rounded-full text-text-muted transition hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {name}
            <div className="plan-dates-layout">
              <div className="plan-dates-grid grid gap-4">
                {date}
                {subject}
              </div>
            </div>
          </div>
        ) : (
          <div
            key={exam.id}
            className="grid gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          >
            {name}
            {date}
            {subject}
            {remove}
          </div>
        );
      })}
      {exams.length < MAX_PLAN_EXAMS ? (
        stacked ? (
          <button
            type="button"
            onClick={() => onChange([...exams, { id: unusedPlanExamId(exams), label: "", dayKey: defaultDayKey }])}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--color-border-strong)] text-sm font-semibold text-text-secondary transition hover:border-solid hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            {exams.length > 0 ? "Add another exam" : "Add an exam"}
          </button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              onChange([...exams, { id: unusedPlanExamId(exams), label: "", dayKey: defaultDayKey }])
            }
          >
            Add an exam
          </Button>
        )
      ) : null}
    </div>
  );
}
