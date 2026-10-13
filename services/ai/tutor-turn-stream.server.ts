import "server-only";

import type { NextRequest } from "next/server";
import {
  isExplicitTutorGraphRequest,
  parseJamiAssistantModelAnswer,
  type JamiAssistantResponseDepth,
} from "@/lib/ai/jami-assistant";
import type { AiResponseDiagnostics } from "@/lib/ai/provider-router";
import { longestCopiedRun, type SourceEvidencePlan } from "@/lib/ai/source-evidence";
import { extractStreamingAnswer } from "@/lib/ai/streaming-answer";
import type { TutorAgentLiveStep, TutorAgentStepView } from "@/lib/ai/tutor-agent";
import { buildTutorAnswerPackage, type TutorAnswerPackageInput } from "@/lib/ai/tutor-turn-answer";
import type { Logger } from "@/lib/observability/logger";
import { getAiTokenCap } from "@/services/ai/budgets";
import {
  generateTutorAnswer,
  streamTutorAnswer,
  type TutorAnswerCall,
} from "@/services/ai/tutor-turn-model.server";
import {
  recordTutorTurnAssessments,
  rememberFromTutorTurn,
  saveTutorTurn,
  savedTutorThread,
  type TutorTurnRecord,
} from "@/services/ai/tutor-turn-save.server";

/**
 * The answer as the student receives it: newline-delimited JSON events --
 * the agent's steps as they start, text as it is written -- and then one
 * terminal event, either the finished answer with its saved chat or an error
 * raised after the response began.
 */

/**
 * Stops the work when the reader goes away.
 *
 * Closing the drawer or navigating off used to leave the provider generating
 * to the end: the tokens were still spent, and the request was still charged,
 * for an answer nobody would see. `request.signal` fires on disconnect and
 * the stream's `cancel` covers a reader that stops consuming without dropping
 * the socket.
 */
export type TutorTurnCancellation = {
  signal: AbortSignal;
  /** Stops the turn because the reader has gone. */
  abort: () => void;
  /** Stops listening for the reader going, once the stream has finished. */
  release: () => void;
};

export function watchTutorTurnCancellation(request: NextRequest): TutorTurnCancellation {
  const cancellation = new AbortController();
  const abortForClient = () => cancellation.abort("client_gone");
  request.signal.addEventListener("abort", abortForClient, { once: true });
  if (request.signal.aborted) abortForClient();
  return {
    signal: cancellation.signal,
    abort: abortForClient,
    release: () => request.signal.removeEventListener("abort", abortForClient),
  };
}

/** What the answer is asked with once the agent has looked things up. */
export type TutorTurnPrepared = {
  call: TutorAnswerCall;
  allowedSourceRefs: string[];
  answer: TutorAnswerPackageInput;
  agentSteps: TutorAgentStepView[];
};

export type TutorTurnStreamInput = {
  call: TutorAnswerCall;
  maxOutputTokens: number;
  allowedSourceRefs: string[];
  depth: JamiAssistantResponseDepth;
  /** What the finished answer is read against. */
  answer: TutorAnswerPackageInput;
  /** Where the finished turn is saved. */
  record: TutorTurnRecord;
  /** Counts for the completion log. */
  report: {
    startedAt: number;
    sourceCount: number;
    sourceFailureCount: number;
    sourcesConsidered: number;
    evidencePlans: readonly SourceEvidencePlan[];
    evidenceBySourceRef: ReadonlyMap<string, string[]>;
    combinedSourceBytes: number;
  };
  providerDiagnostics: AiResponseDiagnostics[];
  /** Hands the charged request back; every path that leaves the student with nothing goes through it. */
  refund: (why: string) => Promise<void>;
  cancellation: TutorTurnCancellation;
  log: Logger;
  /**
   * Work inside the stream before the answer: the agent's look-ups
   * (`runTutorAgent`), each step shown to the student as it starts. Returns
   * what the answer is then asked with; failing, other than by the student
   * leaving, it leaves the answer to go ahead as planned.
   */
  prepare?: (onStep: (step: TutorAgentLiveStep) => void) => Promise<TutorTurnPrepared>;
};

export function createTutorTurnStream(input: TutorTurnStreamInput) {
  const { record, report, providerDiagnostics, refund, cancellation, log } = input;
  const message = input.answer.message;
  // Replaced by what the agent gathered, when it runs.
  let { call, allowedSourceRefs } = input;
  let answerInput = input.answer;
  let agentSteps: TutorAgentStepView[] = [];
  let webResearchAvailable = answerInput.research.ok;
  const encoder = new TextEncoder();
  const event = (payload: Record<string, unknown>) =>
    encoder.encode(`${JSON.stringify(payload)}\n`);

  /**
   * Recovers from a malformed structured response using the existing
   * non-streaming retry. Nothing was shown to the student, because text is only
   * emitted while the first attempt still parses as a growing JSON object.
   */
  const retryWithoutStreaming = async (generated: string) => {
    log.warn("provider.invalid_structured_output", {
      depth: input.depth,
      generatedCharacters: generated.length,
      providerDiagnostics,
    });
    const retried = await generateTutorAnswer(call, {
      maxOutputTokens: getAiTokenCap("assistant"),
      structuredRetry: true,
    });
    return parseJamiAssistantModelAnswer(retried, allowedSourceRefs, {
      webResearchAvailable,
    });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let emitted = "";

      try {
        if (input.prepare) {
          try {
            const prepared = await input.prepare((step) => controller.enqueue(event({ type: "step", ...step })));
            ({ call, allowedSourceRefs, agentSteps } = prepared);
            answerInput = prepared.answer;
            webResearchAvailable = answerInput.research.ok;
          } catch (error) {
            if (cancellation.signal.aborted) throw error;
            log.warn("agent.failed", { error });
          }
        }

        for await (const chunk of streamTutorAnswer(call, input.maxOutputTokens)) {
          buffer += chunk;
          const answerSoFar = extractStreamingAnswer(buffer);
          if (answerSoFar.length > emitted.length) {
            controller.enqueue(
              event({ type: "text", value: answerSoFar.slice(emitted.length) })
            );
            emitted = answerSoFar;
          }
        }

        let parsedAnswer = parseJamiAssistantModelAnswer(buffer, allowedSourceRefs, {
          webResearchAvailable,
        });
        if (!parsedAnswer) {
          parsedAnswer = await retryWithoutStreaming(buffer);
        }

        /*
         * A graph was asked for and none came back: asked once more, for the
         * graph. Kept only if the retry actually has one, so a failed retry
         * costs the student nothing but the wait.
         */
        if (parsedAnswer && parsedAnswer.graphs.length === 0 && isExplicitTutorGraphRequest(message)) {
          try {
            const retried = parseJamiAssistantModelAnswer(
              await generateTutorAnswer(call, { maxOutputTokens: getAiTokenCap("assistant"), graphRetry: true }),
              allowedSourceRefs,
              { webResearchAvailable }
            );
            if (retried && retried.graphs.length > 0) parsedAnswer = retried;
          } catch (error) {
            log.warn("provider.graph_retry_failed", { error });
          }
        }

        if (!parsedAnswer) {
          log.error("provider.structured_retry_failed", {
            depth: input.depth,
            generatedCharacters: buffer.length,
            providerDiagnostics,
            durationMs: Date.now() - report.startedAt,
          });
          await refund("structured_retry_failed");
          controller.enqueue(
            event({
              type: "error",
              error: "Jami could not produce a reliable answer just now. Try again.",
              code: "invalid_provider_response",
            })
          );
          return;
        }

        const payload = buildTutorAnswerPackage(parsedAnswer, answerInput);
        if (!payload) {
          log.warn("provider.empty_answer", {
            depth: input.depth,
            generatedCharacters: buffer.length,
            providerDiagnostics,
            durationMs: Date.now() - report.startedAt,
          });
          await refund("empty_answer");
          controller.enqueue(
            event({
              type: "error",
              error: "Jami could not produce a reliable answer just now. Try again.",
              code: "invalid_provider_response",
            })
          );
          return;
        }

        const saved = await saveTutorTurn(record, payload, parsedAnswer, agentSteps);
        const assessments = await recordTutorTurnAssessments(record, parsedAnswer, saved.now);

        // The retry path, and any cleanup applied to the streamed text, can
        // leave what was shown out of step with the final answer. Sending the
        // whole reply lets the client settle on it rather than trusting deltas.
        controller.enqueue(
          event({
            type: "done",
            ...payload,
            ...(agentSteps.length > 0 ? { agentSteps } : {}),
            ...(assessments.completedActionId ? { completedActionId: assessments.completedActionId } : {}),
            savedThread: savedTutorThread(record, payload, saved),
          })
        );

        await rememberFromTutorTurn(record, parsedAnswer, saved.now);

        // The token counts were already collected for the failure paths and
        // then discarded on success, which left the usual questions — what a
        // request costs, how long it takes, whether fallbacks are routine —
        // answerable only from the times it went wrong.
        log.info("request.completed", {
          depth: input.depth,
          durationMs: Date.now() - report.startedAt,
          sourceCount: report.sourceCount,
          sourceFailureCount: report.sourceFailureCount,
          sourcesConsidered: report.sourcesConsidered,
          sourcesSearchedWhole: report.evidencePlans.filter((plan) => plan.kind === "whole").length,
          sourcesNotRelevant: report.evidencePlans.filter(
            (plan) => plan.kind === "skip" && plan.reason === "not_relevant"
          ).length,
          /*
           * The longest run of words the reply shares with its sources. How
           * often answers read as a source quoted back is measured here
           * rather than judged from the odd transcript.
           */
          longestCopiedRunWords: longestCopiedRun(
            payload.reply,
            [...report.evidenceBySourceRef.values()].flat()
          ),
          studyMaterialRequested: payload.studyMaterialRequest?.kind ?? null,
          studyMaterialOffered: payload.studyMaterialOffers?.length ?? 0,
          // How often Tutor suggests a next step at all, and which, so the
          // buttons can be checked against how sparing they are meant to be.
          followUpsOffered: payload.followUps?.map((followUp) => followUp.label) ?? [],
          practiceOffered: Boolean(payload.practiceOffer),
          // Alongside the token counts, so what a big attachment actually costs
          // can be read off the logs rather than guessed at.
          combinedSourceBytes: report.combinedSourceBytes,
          providerDiagnostics,
        });
      } catch (error) {
        // A reader who left is not a failure to report to them, and the work
        // stopping is the point -- but the request still bought nothing.
        if (cancellation.signal.aborted) {
          log.info("request.cancelled", {
            depth: input.depth,
            durationMs: Date.now() - report.startedAt,
            generatedCharacters: buffer.length,
            providerDiagnostics,
          });
          await refund("cancelled");
          return;
        }

        log.error("provider.failed", {
          error,
          depth: input.depth,
          durationMs: Date.now() - report.startedAt,
          combinedSourceBytes: report.combinedSourceBytes,
          providerDiagnostics,
        });
        await refund("provider_failed");
        controller.enqueue(
          event({
            type: "error",
            error: "Jami could not finish that answer just now. Try again in a moment.",
            code: "provider_failure",
          })
        );
      } finally {
        cancellation.release();
        try {
          controller.close();
        } catch {
          // Already closed by a cancelled reader; nothing left to close.
        }
      }
    },
    cancel() {
      cancellation.abort();
    },
  });
}

/** The streamed answer as the route's response. */
export function tutorTurnResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
