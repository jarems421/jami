"use client";

import { useMemo, useState, type ReactNode } from "react";
import GoalAmountField from "@/components/goals/GoalAmountField";
import GoalDeadlineField from "@/components/goals/GoalDeadlineField";
import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import GoalKindPicker from "@/components/goals/GoalKindPicker";
import GoalScopeField, { type GoalScopeOption } from "@/components/goals/GoalScopeField";
import GoalStarPreview from "@/components/goals/GoalStarPreview";
import GoalTopicPicker from "@/components/goals/GoalTopicPicker";
import { Button, Input, OptionSwitch } from "@/components/ui";
import {
  GOAL_AMOUNT_PRESETS,
  GOAL_DAY_PRESETS,
  applyDeadlineChoice,
  deadlineChoiceOf,
  goalPaceHint,
  goalPlanSentence,
  withCadence,
  withMeasure,
} from "@/lib/goals/drafts";
import {
  GOAL_STAR_GLOW,
  GOAL_TARGET_LIMITS,
  MAX_GOAL_DAYS,
  defaultGoalName,
  goalDraftProblem,
  goalScopeLabel,
  goalStarEffort,
  goalStarGlow,
  type Goal,
  type GoalCadence,
  type GoalDraft,
  type GoalEdit,
  type GoalExamLink,
} from "@/lib/goals/model";
import type { GoalSuggestion } from "@/lib/goals/suggestions";

export type GoalComposerOptions = {
  folders: readonly GoalScopeOption[];
  decks: readonly GoalScopeOption[];
  topics: readonly GoalScopeOption[];
  exams: readonly GoalExamLink[];
};

const CADENCE_OPTIONS = [
  { value: "total", label: "A total", detail: "Reach a number, by a date if you like" },
  { value: "daily", label: "Every day", detail: "Hit an amount on a number of days" },
] as const;

function Section({ children }: { children: ReactNode }) {
  return <div className="min-w-0 space-y-3 border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0">{children}</div>;
}

/**
 * Making a goal, or changing one.
 *
 * Every field starts filled in, so a goal can be made in two taps: what to aim
 * at, then Create. The rest is there to adjust, and the panel beside it reads
 * the draft back as a sentence with the star it will earn, which grows as the
 * goal does.
 *
 * Editing keeps what a goal counts and where from, because changing those
 * would make its progress so far mean something else; it changes how much,
 * by when, and the name.
 */
export default function GoalComposer({
  editing,
  initialDraft,
  options,
  suggestions = [],
  saving,
  onCancel,
  onCreate,
  onSave,
}: {
  editing?: Goal;
  initialDraft: GoalDraft;
  options: GoalComposerOptions;
  suggestions?: readonly GoalSuggestion[];
  saving: boolean;
  onCancel: () => void;
  onCreate: (draft: GoalDraft) => void;
  onSave: (goal: Goal, edit: GoalEdit) => void;
}) {
  const [draft, setDraft] = useState<GoalDraft>(initialDraft);
  const [now] = useState(() => Date.now());
  const change = (patch: Partial<GoalDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const problem = goalDraftProblem(draft, now, editing?.progress.daysHit ?? 0);
  const choice = deadlineChoiceOf(draft, now);
  const title = draft.name.trim() || defaultGoalName(draft);
  const pace = goalPaceHint(draft, now, editing?.progress);
  const effort = goalStarEffort(draft);
  const glow = editing ? goalStarGlow(editing) : GOAL_STAR_GLOW;
  const scopeOptions = useMemo(
    () => ({ folder: options.folders, deck: options.decks, topic: options.topics }),
    [options.decks, options.folders, options.topics]
  );
  const countable = draft.measure !== "topic" ? draft.measure : null;

  const submit = () => {
    if (problem || saving) return;
    if (editing) {
      const examChanged = (draft.exam?.examId ?? "") !== (editing.exam?.examId ?? "");
      onSave(editing, {
        name: draft.name,
        target: draft.target,
        days: draft.days,
        deadline: draft.deadline,
        ...(examChanged ? { exam: draft.exam ?? null } : {}),
      });
    } else {
      onCreate(draft);
    }
  };

  return (
    <section
      id="goal-composer"
      aria-labelledby="goal-composer-title"
      className="app-panel-warm scroll-mt-24 p-4 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
            {editing ? "Edit goal" : "New goal"}
          </p>
          <h2 id="goal-composer-title" className="mt-1 text-xl font-bold tracking-tight text-text-primary">
            {editing ? "Adjust this target" : "Set a target"}
          </h2>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>

      {!editing && suggestions.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-text-muted">Start from an idea</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => setDraft(suggestion.draft)}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-panel)] py-1.5 pl-1.5 pr-3.5 text-left text-sm transition duration-fast hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              >
                <GoalMeasureBadge measure={suggestion.draft.measure} size="sm" />
                <span className="min-w-0 truncate font-semibold text-text-primary">{suggestion.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-8">
        <div className="min-w-0 space-y-5">
          {editing ? (
            <div className="flex items-center gap-3">
              <GoalMeasureBadge measure={editing.measure} />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-text-primary">{goalScopeLabel(editing)}</p>
                <p className="text-xs text-text-muted">
                  What a goal counts stays fixed once it has started. Start a new goal to count something else.
                </p>
              </div>
            </div>
          ) : (
            <Section>
              <GoalKindPicker value={draft.measure} onChange={(measure) => setDraft(withMeasure(draft, measure, now))} />
            </Section>
          )}

          {countable ? (
            <Section>
              {!editing ? (
                <OptionSwitch<GoalCadence>
                  label="How?"
                  value={draft.cadence}
                  options={CADENCE_OPTIONS}
                  onChange={(cadence) => setDraft(withCadence(draft, cadence))}
                />
              ) : null}
              <GoalAmountField
                label={draft.cadence === "daily" ? "How many each day?" : "How many?"}
                unit={countable === "questions" ? "questions" : "cards"}
                value={draft.target}
                max={GOAL_TARGET_LIMITS[countable][draft.cadence]}
                presets={GOAL_AMOUNT_PRESETS[countable][draft.cadence]}
                onChange={(target) => change({ target })}
              />
              {draft.cadence === "daily" ? (
                <GoalAmountField
                  label="On how many days?"
                  unit="days"
                  value={draft.days}
                  max={MAX_GOAL_DAYS}
                  presets={GOAL_DAY_PRESETS}
                  onChange={(days) => change({ days })}
                />
              ) : null}
            </Section>
          ) : null}

          {!editing ? (
            <Section>
              {countable ? (
                <GoalScopeField
                  measure={countable}
                  value={draft.scope}
                  options={scopeOptions}
                  onChange={(scope) => change({ scope })}
                />
              ) : (
                <GoalTopicPicker
                  folders={options.folders}
                  scope={draft.scope}
                  topic={draft.topic}
                  onChange={(next) => setDraft((current) => ({ ...current, scope: next.scope, topic: next.topic }))}
                />
              )}
            </Section>
          ) : null}

          <Section>
            <GoalDeadlineField
              choice={choice}
              exams={options.exams}
              optional={
                draft.cadence === "daily" && draft.measure !== "topic"
                  ? "Optional for a daily goal: the days are its finish line."
                  : undefined
              }
              onChange={(next) => setDraft(applyDeadlineChoice(draft, next, now, options.exams))}
            />
          </Section>

          <Section>
            <Input
              label="Name (optional)"
              value={draft.name}
              maxLength={120}
              placeholder={defaultGoalName(draft)}
              onChange={(event) => change({ name: event.target.value })}
              className="min-h-11 !rounded-xl !px-4 !py-2.5"
            />
          </Section>
        </div>

        <aside aria-label="Your goal" className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="space-y-1.5">
            <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">Your goal</p>
            <p className="text-lg font-bold leading-snug tracking-tight text-text-primary">{title}</p>
            <p className="text-sm leading-6 text-text-secondary">{goalPlanSentence(draft)}</p>
            {pace ? <p className="text-sm font-semibold text-text-primary">{pace}</p> : null}
          </div>
          <GoalStarPreview
            effort={effort}
            glow={glow}
            caption="Finish it to earn this star. Bigger goals earn bigger stars."
          />
          <div className="space-y-2">
            <Button
              type="button"
              variant="warm"
              size="lg"
              className="w-full"
              disabled={Boolean(problem) || saving}
              onClick={submit}
              data-tutorial-target="create-goal"
            >
              {saving ? (editing ? "Saving..." : "Creating...") : editing ? "Save goal" : "Create goal"}
            </Button>
            {problem ? (
              <p role="status" className="text-xs leading-5 text-text-muted">
                {problem}
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}
