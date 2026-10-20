"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";
import PlanExamsEditor from "@/components/planning/PlanExamsEditor";
import { WeekdayToggles, type PlanScopeOption } from "@/components/planning/RevisionPlanBuilder";
import type { PlanNotice } from "@/lib/ai/assistant-plan";
import {
  normalizeRevisionPlanDraft,
  PLAN_PROBLEM_MESSAGES,
  unusedPlanExamId,
} from "@/lib/planning/normalize-plan";
import {
  describeExamChoice,
  describeSubjectChoice,
  describeWeekChoice,
  PLAN_PRIORITY_LABELS,
  PLAN_SESSION_LENGTHS,
  planStudyDays,
  planUsualMinutes,
  planWithDayToggled,
  planWithExams,
  planWithNoExams,
  planWithSessionLength,
  planWithSubjectPriority,
  type PlanInterviewStep,
} from "@/lib/planning/plan-interview";
import { planScopeKey, type RevisionPlanDraft, type RevisionPlanExam } from "@/lib/planning/types";

/**
 * The answers to Jami's current question that can be given by tapping.
 *
 * Every question has them, so a plan can be made start to finish without
 * typing a word -- or without the model answering at all. Each tap changes the
 * plan beside the conversation straight away, which is what makes it build in
 * front of the student rather than arrive; the step's own button then says the
 * answer back in words and moves on.
 */

type StepAnswersProps = {
  step: PlanInterviewStep;
  draft: RevisionPlanDraft;
  options: readonly PlanScopeOption[];
  notices: readonly PlanNotice[];
  scopeNames: ReadonlyMap<string, string>;
  onDraft: (draft: RevisionPlanDraft) => void;
  onAnswer: (summary: string, draft: RevisionPlanDraft) => void;
  onStart: () => void;
  onEditByHand: () => void;
  saving: boolean;
  /** Whether the plan, timetable included, has what it needs to be saved. */
  canStart: boolean;
  startLabel: string;
};

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">{children}</div>;
}

/**
 * Exams, typed in as rows.
 *
 * The rows are kept here rather than read back from the plan, because the plan
 * only holds exams with a name and a date: reading it back would make a row
 * disappear the moment its name was cleared to be retyped. The plan is worked
 * out from the step's starting point each time, so a title taken from the
 * first exam follows the name as it is typed rather than keeping its first
 * letter.
 */
function GoalAnswers({ draft, options, onDraft, onAnswer }: StepAnswersProps) {
  const [base] = useState(draft);
  const [exams, setExams] = useState<RevisionPlanExam[]>(() =>
    draft.exams && draft.exams.length > 0
      ? draft.exams
      : [{ id: unusedPlanExamId([]), label: "", dayKey: draft.endDayKey }]
  );
  const complete = exams.some((exam) => exam.label.trim() && exam.dayKey);
  const subjects = useMemo(
    () => options.map((option) => ({ key: option.key, label: option.label })),
    [options]
  );

  return (
    <div className="space-y-4">
      <PlanExamsEditor
        layout="stacked"
        exams={exams}
        subjects={subjects}
        defaultDayKey={base.endDayKey}
        onChange={(next) => {
          setExams(next);
          onDraft(
            next.some((exam) => exam.label.trim() && exam.dayKey)
              ? planWithExams(base, next)
              : normalizeRevisionPlanDraft({ ...base, exams: [] }).draft
          );
        }}
      />
      <ActionRow>
        <Button
          type="button"
          variant="secondary"
          onClick={() => onAnswer("No exams coming up", planWithNoExams(base))}
        >
          No exams coming up
        </Button>
        <Button
          type="button"
          disabled={!complete}
          onClick={() => {
            const next = planWithExams(base, exams);
            onAnswer(describeExamChoice(next), next);
          }}
        >
          That&rsquo;s all of them
        </Button>
      </ActionRow>
    </div>
  );
}

const PRIORITIES = [0, 1, 2, 3] as const;

/** Skip, light, normal or most: one subject's share of the week. */
function PriorityControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: 0 | 1 | 2 | 3;
  onChange: (value: 0 | 1 | 2 | 3) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`How much time for ${label}`}
      className="grid grid-cols-4 gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-1"
    >
      {PRIORITIES.map((priority) => {
        const selected = priority === value;
        return (
          <button
            key={priority}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(priority)}
            className={`min-h-10 rounded-xl px-2 text-sm font-semibold transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
              selected
                ? priority === 0
                  ? "bg-[var(--color-surface-panel-strong)] text-text-primary shadow-e1"
                  : "app-selected shadow-e1"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {PLAN_PRIORITY_LABELS[priority]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Every subject the student has, each with how much of the week it gets.
 *
 * What the Learning Engine has noticed about a subject is written under its
 * name, where it bears on the choice being made -- not above the conversation
 * as chips that looked like buttons and did nothing. The name sits above its
 * control in Jami's column, and beside it only where the answers have room
 * (`.plan-subject-row`): side by side in the panel, the name got two rem.
 */
function SubjectAnswers({ draft, options, notices, scopeNames, onDraft, onAnswer }: StepAnswersProps) {
  const weights = new Map(draft.scopes.map((scope) => [planScopeKey(scope), scope.weight]));
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)]">
        {options.map((option) => {
          const weight = Math.min(3, Math.max(0, weights.get(option.key) ?? 0)) as 0 | 1 | 2 | 3;
          const notice = notices.find((candidate) => candidate.scopeKey === option.key);
          return (
            <li key={option.key} className="plan-subject-row grid gap-3 px-4 py-4">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold leading-6 text-text-primary">{option.label}</p>
                {notice ? (
                  <p className="mt-0.5 text-xs leading-5 text-text-muted">{notice.detail}</p>
                ) : null}
              </div>
              <PriorityControl
                label={option.label}
                value={weight}
                onChange={(priority) =>
                  onDraft(
                    planWithSubjectPriority(
                      draft,
                      option.folderId ? { folderId: option.folderId } : { deckId: option.deckId },
                      priority
                    )
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      <ActionRow>
        <Button
          type="button"
          disabled={draft.scopes.length === 0}
          onClick={() => onAnswer(describeSubjectChoice(draft, scopeNames), draft)}
        >
          These are my subjects
        </Button>
      </ActionRow>
    </div>
  );
}

function WeekAnswers({ draft, onDraft, onAnswer }: StepAnswersProps) {
  const lengthLabel = useId();
  const [length, setLength] = useState(() => planUsualMinutes(draft));
  const days = planStudyDays(draft);
  return (
    <div className="space-y-5">
      <WeekdayToggles
        active={days}
        onToggle={(weekday) => onDraft(planWithDayToggled(draft, weekday, length))}
      />
      <div className="space-y-2.5">
        <span id={lengthLabel} className="block text-sm font-medium text-text-secondary">
          Each sitting
        </span>
        <div role="radiogroup" aria-labelledby={lengthLabel} className="flex flex-wrap gap-2">
          {PLAN_SESSION_LENGTHS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="radio"
              aria-checked={length === minutes}
              onClick={() => {
                setLength(minutes);
                onDraft(planWithSessionLength(draft, minutes));
              }}
              className={`min-h-10 rounded-xl border px-3.5 text-sm font-semibold transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                length === minutes
                  ? "app-selected"
                  : "border-[var(--color-border)] text-text-secondary hover:border-[var(--color-border-strong)]"
              }`}
            >
              {minutes} min
            </button>
          ))}
        </div>
      </div>
      <ActionRow>
        <Button
          type="button"
          disabled={draft.sessions.length === 0}
          onClick={() => onAnswer(describeWeekChoice(draft), draft)}
        >
          That&rsquo;s my week
        </Button>
      </ActionRow>
    </div>
  );
}

function ReviewAnswers({ draft, onStart, onEditByHand, saving, canStart, startLabel }: StepAnswersProps) {
  const { problems } = normalizeRevisionPlanDraft(draft);
  return (
    <div className="space-y-2">
      {problems.length > 0 && !canStart ? (
        <ul className="space-y-1">
          {problems.map((problem) => (
            <li key={problem} className="text-xs leading-5 text-text-secondary">
              {PLAN_PROBLEM_MESSAGES[problem]}
            </li>
          ))}
        </ul>
      ) : null}
      <ActionRow>
        <Button type="button" variant="secondary" onClick={onEditByHand}>
          Plan settings
        </Button>
        <Button type="button" disabled={!canStart || saving} onClick={onStart}>
          {saving ? "Saving…" : startLabel}
        </Button>
      </ActionRow>
    </div>
  );
}

export default function PlanStepAnswers(props: StepAnswersProps) {
  if (props.step === "goal") return <GoalAnswers {...props} />;
  if (props.step === "subjects") return <SubjectAnswers {...props} />;
  if (props.step === "time") return <WeekAnswers {...props} />;
  if (props.step === "extras") {
    return (
      <ActionRow>
        <Button type="button" variant="secondary" onClick={() => props.onAnswer("Nothing else", props.draft)}>
          Nothing else
        </Button>
      </ActionRow>
    );
  }
  return <ReviewAnswers {...props} />;
}
