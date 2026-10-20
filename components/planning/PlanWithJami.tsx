"use client";

import { useCallback, useRef, useState } from "react";
import { JamiTutorIcon } from "@/components/ui";
import {
  MicrophoneIcon,
  SendIcon,
  StopDictationIcon,
} from "@/components/ai/JamiAssistantIcons";
import PlanProposalCard from "@/components/planning/PlanProposalCard";
import PlanStepAnswers from "@/components/planning/PlanStepAnswers";
import type { PlanScopeOption } from "@/components/planning/RevisionPlanBuilder";
import type { PlanAssistantProposal, PlanInterview } from "@/hooks/usePlanInterview";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import type { PlanNotice } from "@/lib/ai/assistant-plan";
import {
  PLAN_QUESTION_STEPS,
  PLAN_STEP_TITLES,
  planStepStatus,
  type PlanInterviewStep,
  type PlanInterviewTurn,
} from "@/lib/planning/plan-interview";

/**
 * Planning with Jami, beside the timetable it is planning.
 *
 * Building a plan, Jami asks four questions in order -- what you're working
 * towards, which subjects, when you can study, anything else -- and the
 * timetable beside this fills in as each is answered: exams appear, the usual
 * week appears, and Jami's first fortnight of tasks appears in it. Every
 * question can be answered by tapping, right under it, or in the student's own
 * words.
 *
 * At any point -- building or running -- a student can say exactly what they
 * want on particular days ("20 minutes of homeostasis on Monday at 5, then
 * flashcards"), and Jami answers with a proposal: the changes, in full, to
 * apply or discard. Nothing on the timetable moves until they apply it.
 */

const PLACEHOLDERS: Record<PlanInterviewStep, string> = {
  goal: "e.g. Chemistry paper 1 on 12 November, biology on the 14th",
  subjects: "e.g. Mostly biology, a bit of physics",
  time: "e.g. Weekday evenings after 5, never Thursdays",
  extras: "e.g. Start with chemistry, I have football on Wednesdays",
  review: "Ask for a change, or add something",
};

const CHANGE_STARTERS = [
  "Move today's work to tomorrow",
  "I'm busy on Thursday",
  "Fill next week with your picks",
  "An exam date changed",
] as const;

/** Where the questions have got to; a finished one can be gone back to, to change what it decided. */
function StepProgress({ step, onJumpTo }: { step: PlanInterviewStep; onJumpTo: (step: PlanInterviewStep) => void }) {
  const reviewing = step === "review";
  const position = PLAN_QUESTION_STEPS.indexOf(step as (typeof PLAN_QUESTION_STEPS)[number]);
  return (
    <div className="space-y-2.5">
      <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
        {reviewing ? "Last check" : `Step ${position + 1} of ${PLAN_QUESTION_STEPS.length} · ${PLAN_STEP_TITLES[step]}`}
      </p>
      <ol className="grid grid-cols-4 gap-1.5">
        {PLAN_QUESTION_STEPS.map((entry) => {
          const status = planStepStatus(entry, step);
          const bar = `block h-1 w-full rounded-full transition-colors duration-slow ${
            status === "done"
              ? "bg-[var(--color-accent)]"
              : status === "current"
                ? "bg-[var(--color-accent)] opacity-60"
                : "bg-[var(--color-border-strong)]"
          }`;
          return (
            <li key={entry}>
              {status === "done" ? (
                <button
                  type="button"
                  onClick={() => onJumpTo(entry)}
                  aria-label={`Go back to ${PLAN_STEP_TITLES[entry].toLowerCase()}`}
                  className="block w-full rounded-full py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  <span aria-hidden="true" className={bar} />
                </button>
              ) : (
                <span aria-hidden="true" className={`${bar} my-1.5`} />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Turn({
  turn,
  proposal,
  describe,
  onApply,
  onDiscard,
}: {
  turn: PlanInterviewTurn;
  proposal?: PlanAssistantProposal;
  describe: (proposal: PlanAssistantProposal) => { headline: string; lines: string[] };
  onApply: (proposal: PlanAssistantProposal) => Promise<boolean>;
  onDiscard: (proposal: PlanAssistantProposal) => void;
}) {
  if (turn.role === "student") {
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] animate-slide-up rounded-2xl rounded-br-md bg-[var(--color-glass-medium)] px-4 py-2.5 text-sm leading-6 text-text-primary">
          {turn.text}
        </p>
      </li>
    );
  }
  const summary = proposal ? describe(proposal) : null;
  return (
    <li className="flex animate-slide-up items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-warm-border bg-warm-glow text-warm-accent"
      >
        <JamiTutorIcon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        {turn.text ? (
          <p className={`pt-0.5 text-sm leading-6 ${turn.question ? "font-medium text-text-primary" : "text-text-secondary"}`}>
            {turn.text}
          </p>
        ) : null}
        {proposal && summary && (summary.lines.length > 0 || proposal.plan) ? (
          <PlanProposalCard
            proposal={proposal}
            headline={summary.headline}
            lines={summary.lines}
            onApply={() => onApply(proposal)}
            onDiscard={() => onDiscard(proposal)}
          />
        ) : null}
      </div>
    </li>
  );
}

export default function PlanWithJami({
  interview,
  options,
  notices,
  saving,
  canSave,
  onSave,
  onOpenSettings,
  describeProposal,
  onApplyProposal,
  onDiscardProposal,
}: {
  interview: PlanInterview;
  options: readonly PlanScopeOption[];
  notices: readonly PlanNotice[];
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onOpenSettings: () => void;
  describeProposal: (proposal: PlanAssistantProposal) => { headline: string; lines: string[] };
  onApplyProposal: (proposal: PlanAssistantProposal) => Promise<boolean>;
  onDiscardProposal: (proposal: PlanAssistantProposal) => void;
}) {
  const [message, setMessage] = useState("");
  const [dictationProblem, setDictationProblem] = useState("");
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useVoiceDictation({ onText: setMessage, onError: setDictationProblem });
  const { turns, step, draft, thinking, mode, proposals } = interview;
  const building = mode === "build";

  const scopeNames = new Map(options.map((option) => [option.key, option.label]));
  // The answers sit under the question they answer, and start afresh with
  // every new question -- including one asked again after a jump back.
  const questionIndex = turns.findLastIndex((turn) => turn.question);

  const submit = useCallback(
    (override?: string) => {
      // Dictation is stopped first and its own reading used: a word the
      // recogniser settles in the same tick would otherwise be lost, because
      // `message` is a render behind at that moment.
      const text = override ?? (dictation.listening ? dictation.stop() : message);
      if (!text.trim() || thinking) return;
      setMessage("");
      setDictationProblem("");
      interview.send(text);
      boxRef.current?.focus();
    },
    [dictation, interview, message, thinking]
  );

  const problem = interview.problem || dictationProblem;
  const studentHasSpoken = turns.some((turn) => turn.role === "student");

  return (
    <div className="flex flex-col gap-5">
      {building ? <StepProgress step={step} onJumpTo={interview.jumpTo} /> : null}

      <ol aria-label="Planning with Jami" aria-live="polite" className="space-y-4">
        {turns.map((turn, index) => (
          <Turn
            key={`${turn.role}-${index}`}
            turn={turn}
            {...(turn.proposalId && proposals[turn.proposalId] ? { proposal: proposals[turn.proposalId] } : {})}
            describe={describeProposal}
            onApply={async (proposal) => {
              const applied = await onApplyProposal(proposal);
              if (applied) interview.settleProposal(proposal.id, "applied");
              return applied;
            }}
            onDiscard={(proposal) => {
              onDiscardProposal(proposal);
              interview.settleProposal(proposal.id, "discarded");
            }}
          />
        ))}
      </ol>

      {thinking ? (
        <p className="flex items-center gap-2 pl-10 text-xs text-text-muted" role="status">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-accent)]" />
          <span>Jami is reading that…</span>
        </p>
      ) : building ? (
        <div className="pl-0 sm:pl-10">
          <PlanStepAnswers
            key={questionIndex}
            step={step}
            draft={draft}
            options={options}
            notices={notices}
            scopeNames={scopeNames}
            onDraft={interview.setDraft}
            onAnswer={interview.answer}
            onStart={onSave}
            onEditByHand={onOpenSettings}
            saving={saving}
            canStart={canSave}
            startLabel="Save plan"
          />
        </div>
      ) : !studentHasSpoken ? (
        <div className="flex flex-wrap gap-1.5 pl-0 sm:pl-10">
          {CHANGE_STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => submit(starter)}
              className="app-chip rounded-full px-3 py-1.5 text-xs font-medium transition hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}

      {/* The Tutor drawer's composer, so a conversation with Jami looks the
          same wherever it happens. */}
      <div className="app-field rounded-2xl transition duration-normal focus-within:shadow-accent">
        <textarea
          ref={boxRef}
          rows={2}
          value={message}
          disabled={thinking}
          aria-label="Tell Jami what you need"
          placeholder={building ? PLACEHOLDERS[step] : "e.g. Move Biology to Wednesday and make Monday a rest day"}
          className="min-h-[4.5rem] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-muted focus-visible:outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-1.5 pb-2 pl-4 pr-2">
          <span className="text-2xs text-text-muted">{building ? "Or answer in your own words" : "Jami shows every change first"}</span>
          <div className="flex items-center gap-1.5">
            {dictation.supported ? (
              <button
                type="button"
                aria-label={dictation.listening ? "Stop dictating" : "Dictate your answer"}
                aria-pressed={dictation.listening}
                disabled={thinking}
                className={`inline-grid h-9 w-9 place-items-center rounded-full transition duration-fast active:scale-95 disabled:cursor-not-allowed disabled:text-text-muted ${
                  dictation.listening
                    ? "bg-error text-text-inverse shadow-e1 hover:brightness-110"
                    : "text-text-secondary hover:bg-[var(--color-glass-subtle)] hover:text-text-primary"
                }`}
                onClick={() => {
                  if (dictation.listening) {
                    dictation.stop();
                    boxRef.current?.focus();
                    return;
                  }
                  setDictationProblem("");
                  dictation.start(message);
                }}
              >
                {dictation.listening ? <StopDictationIcon /> : <MicrophoneIcon />}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Send to Jami"
              disabled={thinking || (!message.trim() && !dictation.listening)}
              className="inline-grid h-9 w-9 place-items-center rounded-full bg-accent text-accent-on shadow-accent transition duration-fast hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:bg-[var(--color-glass-medium)] disabled:text-text-muted disabled:shadow-none"
              onClick={() => submit()}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>

      {dictation.listening ? (
        <p className="flex items-center gap-2 px-1 text-xs text-text-secondary" role="status">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-error" />
          <span>Listening. Stop to edit what you said, or send it straight away.</span>
        </p>
      ) : null}

      {problem ? (
        <p role="alert" className="text-sm leading-6 text-[var(--color-error-text)]">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
