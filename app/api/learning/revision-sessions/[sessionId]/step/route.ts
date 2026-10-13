import type { NextRequest } from "next/server";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { matchesExpectedAnswer, type RevisionMarking } from "@/lib/revision/lesson";
import {
  advanceRevisionSession,
  currentRevisionStep,
  isRevisionAnswerStep,
  isRevisionSessionFinished,
  type RevisionSessionEvent,
} from "@/lib/revision/session-machine";
import type { RevisionSessionRecord, RevisionStepRecord } from "@/lib/revision/types";
import { revisionTaskFor } from "@/lib/revision/view";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import {
  MAX_REVISION_ANSWER_LENGTH,
  markRevisionAnswer,
  writeRevisionRetry,
} from "@/services/ai/revision-session.server";
import { checkAiBudget, refundAiBudget } from "@/services/ai/budgets";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import {
  loadRevisionConceptContext,
  revisionSessionResponse,
  revisionSessionsUnavailable,
} from "@/services/learning/revision-session-context.server";
import {
  claimRevisionWork,
  loadRevisionSession,
  releaseRevisionWork,
  saveRevisionSession,
} from "@/services/learning/revision-sessions.server";
import { planNextStepsForSession } from "@/services/learning/revision-options.server";

export const runtime = "nodejs";
/** Marking allows fifteen seconds and a second explanation thirty. */
export const maxDuration = 45;

const log = createLogger({ route: "learning.revision-sessions.step" });

type StepRequest =
  | { type: "continue" }
  | { type: "hint" }
  | { type: "skip" }
  | { type: "answer"; answer: string }
  | { type: "self-grade"; correct: boolean };

function readStepRequest(body: unknown): StepRequest | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  switch (record.type) {
    case "continue":
    case "hint":
    case "skip":
      return { type: record.type };
    case "answer": {
      const answer = typeof record.answer === "string" ? record.answer.trim() : "";
      return answer ? { type: "answer", answer: answer.slice(0, MAX_REVISION_ANSWER_LENGTH) } : null;
    }
    case "self-grade":
      return typeof record.correct === "boolean" ? { type: "self-grade", correct: record.correct } : null;
    default:
      return null;
  }
}

/** Said when an exact match needs no marker. */
const EXACT_MATCH_FEEDBACK = "Yes — that's it.";

/**
 * The session's end: finished, and its lesson -- the answers to its questions
 * -- deleted. What stays is the text-free record of how each step went, which
 * is the evidence.
 */
function completed(record: RevisionSessionRecord, now: number): RevisionSessionRecord {
  const { lesson, ...rest } = record;
  void lesson;
  return { ...rest, status: "completed", completedAt: now };
}

/**
 * One thing the student did, applied to their session.
 *
 * Every move goes through the state machine; this route only supplies what the
 * machine cannot -- a mark from the model, or a second explanation -- and
 * stores the result. Nothing the student typed outlives the request.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const unavailable = revisionSessionsUnavailable();
  if (unavailable) return unavailable;
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");
  const { sessionId } = await params;

  let input: StepRequest | null;
  try {
    input = readStepRequest(await request.json());
  } catch {
    input = null;
  }
  if (!input) return apiFailure("That request could not be read.", 400, "bad_request");

  const record = await loadRevisionSession(uid, sessionId.slice(0, 120));
  if (!record) return apiFailure("That session could not be found.", 404, "not_found");
  if (record.status !== "active" || !record.lesson || isRevisionSessionFinished(record)) {
    return revisionSessionResponse(record, {}, 409);
  }
  const lesson = record.lesson;
  const now = Date.now();

  /** Store the machine's next state, or answer with the session as it now stands. */
  const commit = async (
    next: RevisionSessionRecord,
    extra: Parameters<typeof revisionSessionResponse>[1] = {}
  ) => {
    const saved = await saveRevisionSession(uid, next, record.updatedAt, now);
    if (saved === "conflict") {
      const current = await loadRevisionSession(uid, record.id);
      return current
        ? revisionSessionResponse(current, {}, 409)
        : apiFailure("That session could not be found.", 404, "not_found");
    }
    return revisionSessionResponse(saved, extra);
  };

  const apply = (event: RevisionSessionEvent) => advanceRevisionSession(record, event);

  if (input.type === "hint" || input.type === "skip" || input.type === "self-grade") {
    const transition = apply(
      input.type === "hint"
        ? { type: "hint" }
        : input.type === "skip"
          ? { type: "skipped", at: now }
          : { type: "self-graded", correct: input.correct, at: now }
    );
    if (!transition.ok) return revisionSessionResponse(record, {}, 409);
    return commit({ ...record, steps: transition.steps, position: transition.position });
  }

  if (input.type === "answer") {
    const step = currentRevisionStep(record);
    if (!step || !isRevisionAnswerStep(step.kind) || step.resolvedAt !== undefined) {
      return revisionSessionResponse(record, {}, 409);
    }
    const task = revisionTaskFor(lesson, step.kind);
    if (!task) return revisionSessionResponse(record, {}, 409);
    const selfGrade = { selfGrade: { answer: task.answer, solution: task.solution } };

    let marking: RevisionMarking | null = matchesExpectedAnswer(input.answer, task.answer)
      ? { verdict: "correct", score: 1, feedback: EXACT_MATCH_FEEDBACK }
      : null;

    if (!marking) {
      const claim = await claimRevisionWork(uid, record.id, now);
      if (claim.kind !== "claimed") return revisionSessionResponse(record, {}, 409);
      const budget = await checkAiBudget({ uid, action: "revisionMarking" });
      if (!budget.allowed) {
        // Out of marking for today: the student judges this one themselves,
        // and it is kept out of the evidence like any other self-grade.
        await releaseRevisionWork(uid, record.id);
        return revisionSessionResponse(record, selfGrade);
      }
      enterAiSpendContext(aiSpendContextFor(uid, "revisionMarking"));
      marking = await markRevisionAnswer({
        context: await loadRevisionConceptContext(uid, record.target),
        kind: step.kind,
        task,
        answer: input.answer,
      });
      if (!marking) {
        await refundAiBudget(budget.grant).catch(() => undefined);
        await releaseRevisionWork(uid, record.id);
        return revisionSessionResponse(record, selfGrade);
      }
    }

    const transition = apply({
      type: "answered",
      verdict: marking.verdict,
      score: marking.score,
      ...(marking.errorCategory ? { errorCategory: marking.errorCategory } : {}),
      ...(marking.mistake ? { mistake: marking.mistake } : {}),
      at: now,
    });
    if (!transition.ok) return revisionSessionResponse(record, {}, 409);
    log.info("step.marked", { sessionId: record.id, kind: step.kind, verdict: marking.verdict });
    return commit(
      { ...record, steps: transition.steps, position: transition.position },
      { feedback: marking.feedback }
    );
  }

  // Continue.
  const transition = apply({ type: "continue" });
  if (!transition.ok) return revisionSessionResponse(record, {}, 409);
  let steps: RevisionStepRecord[] = transition.steps;
  let nextLesson = lesson;

  if (transition.retryAdded) {
    /*
     * The second explanation, written now that it is needed. If it cannot be
     * written the retry is simply dropped and the session moves on -- a
     * student waiting on a lesson that is not coming is worse than one fewer
     * guided question.
     */
    const dropRetry = () => steps.filter((_step, index) => index !== transition.position);
    const claim = await claimRevisionWork(uid, record.id, now);
    if (claim.kind !== "claimed") return revisionSessionResponse(record, {}, 409);
    // The second explanation is part of a session already counted when it
    // started, so it spends no Revision Session allowance of its own.
    const budget = await checkAiBudget({ uid, action: "revisionLesson", allowance: null });
    if (!budget.allowed) {
      steps = dropRetry();
    } else {
      enterAiSpendContext(aiSpendContextFor(uid, "revisionLesson"));
      const retry = await writeRevisionRetry({
        // Explained another way, in their course's terms where their material has it.
        context: await loadRevisionConceptContext(uid, record.target, { materialQuery: record.target.conceptLabel }),
        lesson,
      });
      if (retry) {
        nextLesson = { ...lesson, retry };
      } else {
        await refundAiBudget(budget.grant).catch(() => undefined);
        steps = dropRetry();
      }
    }
  }

  const next: RevisionSessionRecord = {
    ...record,
    lesson: nextLesson,
    steps,
    position: transition.position,
  };
  if (isRevisionSessionFinished(next)) {
    // Chosen once, from how it went; a failure costs the suggestions, not the finish.
    const nextSteps = await planNextStepsForSession(uid, next).catch((error: unknown) => {
      log.warn("next_steps.failed", { sessionId: record.id, error });
      return [];
    });
    log.info("session.completed", {
      sessionId: record.id,
      steps: steps.length,
      nextSteps: nextSteps.map((step) => step.kind),
    });
    return commit({ ...completed(next, now), ...(nextSteps.length > 0 ? { nextSteps } : {}) });
  }
  return commit(next);
}
