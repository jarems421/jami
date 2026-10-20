"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  answerPlanStep,
  applyJamiReply,
  jumpToPlanStep,
  mergePlanStepProposal,
  recordJamiTurn,
  recordStudentMessage,
  samePlanShape,
  startPlanInterview,
  withPlanDraft,
  type PlanInterviewContext,
  type PlanInterviewState,
  type PlanInterviewStep,
} from "@/lib/planning/plan-interview";
import type { PlanProposalChange } from "@/lib/planning/plan-proposal";
import type { PlanTimetableDay } from "@/lib/planning/plan-timetable-prompt";
import type { RevisionPlanDraft } from "@/lib/planning/types";
import { draftPlanWithJami, PlanDraftError } from "@/services/planning/plan-draft";

/**
 * The conversation with Jami about a plan, held where the timetable can read it.
 *
 * Two modes. Building a plan, Jami's questions fill the plan in as they are
 * answered, as they always have. Changing a running plan, nothing moves until
 * the student says so: every reply that would change something carries a
 * proposal -- the changes to particular days, and any change to the plan
 * itself -- which they apply or discard. Changes to particular days are
 * proposals in both modes.
 *
 * What happens next in the questions is always decided by
 * `lib/planning/plan-interview.ts`; this only carries it, and makes the one
 * network call typed answers need.
 */

export type PlanAssistantProposal = {
  id: string;
  changes: PlanProposalChange[];
  /** The plan as Jami would leave it, when the change is to the plan itself. */
  plan?: RevisionPlanDraft;
  /** The plan as it was when proposed, to say what would change. */
  planBefore?: RevisionPlanDraft;
  status: "open" | "applied" | "discarded";
};

export type PlanInterviewMode = "build" | "change";

export function usePlanInterview(
  context: PlanInterviewContext,
  options: {
    mode?: PlanInterviewMode;
    /** The days on screen when a message is sent, so Jami can change particular ones. */
    timetable?: () => PlanTimetableDay[];
    /** A running plan's conversation starts from that plan, at the last check. */
    startFrom?: RevisionPlanDraft;
  } = {}
) {
  const mode = options.mode ?? "build";
  const [state, setState] = useState<PlanInterviewState>(() =>
    startPlanInterview({
      context,
      ...(options.startFrom ? { draft: options.startFrom, reshaping: true } : {}),
    })
  );
  const [proposals, setProposals] = useState<Record<string, PlanAssistantProposal>>({});
  const [thinking, setThinking] = useState(false);
  const [problem, setProblem] = useState("");
  const proposalCount = useRef(0);
  const timetableRef = useRef(options.timetable);
  const { timetable } = options;
  useEffect(() => {
    timetableRef.current = timetable;
  }, [timetable]);

  const propose = useCallback((proposal: Omit<PlanAssistantProposal, "id" | "status">) => {
    proposalCount.current += 1;
    const id = `proposal-${proposalCount.current}`;
    setProposals((current) => ({ ...current, [id]: { ...proposal, id, status: "open" } }));
    return id;
  }, []);

  /** Jami's reading of something typed, applied to the state it was typed into. */
  const sendFrom = useCallback(
    async (base: PlanInterviewState, text: string) => {
      const said = text.trim();
      if (!said) return;
      setProblem("");
      setState(recordStudentMessage(base, said));
      setThinking(true);
      try {
        const answer = await draftPlanWithJami({
          message: said,
          history: base.turns.map(({ role, text: turnText }) => ({ role, text: turnText })),
          draft: base.draft,
          timetable: timetableRef.current?.() ?? [],
          ...(mode === "build" ? { step: base.step } : {}),
        });
        if (mode === "build") {
          const proposalId = answer.changes.length > 0 ? propose({ changes: answer.changes }) : undefined;
          setState((current) =>
            applyJamiReply(current, { text: answer.reply, proposal: answer.plan, ...(proposalId ? { proposalId } : {}) }, context)
          );
          return;
        }
        const merged = answer.plan
          ? { ...mergePlanStepProposal("review", base.draft, answer.plan), origin: base.draft.origin }
          : null;
        const plan = merged && !samePlanShape(merged, base.draft) ? merged : undefined;
        const proposalId =
          answer.changes.length > 0 || plan
            ? propose({ changes: answer.changes, ...(plan ? { plan, planBefore: base.draft } : {}) })
            : undefined;
        setState((current) => recordJamiTurn(current, answer.reply, proposalId));
      } catch (error) {
        /*
         * Never a dead end. Every question can still be answered by tapping,
         * and every change made by hand, so that is what the message offers.
         */
        setProblem(
          error instanceof PlanDraftError
            ? error.message
            : "Jami couldn't answer just now. You can still change the timetable yourself."
        );
      } finally {
        setThinking(false);
      }
    },
    [context, mode, propose]
  );

  const send = useCallback(
    (text: string) => {
      if (thinking) return;
      void sendFrom(state, text);
    },
    [sendFrom, state, thinking]
  );

  /**
   * Start again: from the first question, or -- for a running plan -- with that
   * plan on screen, sending what the student already said about changing it.
   */
  const begin = useCallback(
    (input: { draft?: RevisionPlanDraft | null; reshaping?: boolean; message?: string } = {}) => {
      const fresh = startPlanInterview({
        ...(input.draft ? { draft: input.draft } : {}),
        reshaping: input.reshaping ?? false,
        context,
      });
      setState(fresh);
      setProposals({});
      setProblem("");
      if (input.message) void sendFrom(fresh, input.message);
    },
    [context, sendFrom]
  );

  /** The plan changed without a turn: a tap, the settings, an applied proposal. */
  const setDraft = useCallback((draft: RevisionPlanDraft) => {
    setState((current) => withPlanDraft(current, draft));
  }, []);

  /** A tapped answer: said back in words, and on to the next question. */
  const answer = useCallback(
    (summary: string, draft: RevisionPlanDraft) => {
      setProblem("");
      setState((current) => answerPlanStep(current, summary, draft, context));
    },
    [context]
  );

  const jumpTo = useCallback(
    (step: PlanInterviewStep) => {
      setProblem("");
      setState((current) => jumpToPlanStep(current, step, context));
    },
    [context]
  );

  const settleProposal = useCallback((id: string, status: "applied" | "discarded") => {
    setProposals((current) => (current[id] ? { ...current, [id]: { ...current[id], status } } : current));
  }, []);

  return {
    ...state,
    mode,
    proposals,
    thinking,
    problem,
    begin,
    send,
    setDraft,
    answer,
    jumpTo,
    settleProposal,
  };
}

export type PlanInterview = ReturnType<typeof usePlanInterview>;
