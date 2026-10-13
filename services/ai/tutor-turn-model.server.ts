import "server-only";

import { getAiInputTokenCap } from "@/lib/ai/budgets";
import type { AiGenerationRole, AiReasoningEffort, AiRouteReason } from "@/lib/ai/provider-policy";
import {
  countAiInputTokens,
  generateAiText,
  streamAiText,
  type AiResponseDiagnostics,
  type AiRouterOptions,
} from "@/lib/ai/provider-router";
import type { TutorTurnContents } from "@/lib/ai/tutor-turn-prompt";
import type { Logger } from "@/lib/observability/logger";

/**
 * The call that writes a Tutor answer: its time budget, the streamed attempt
 * the student watches arrive, and the buffered attempts used to recover one.
 */

/**
 * The answer's own budget, thinking included.
 *
 * It was thirty seconds, which a thinking model reading a long problem sheet or
 * a whole past paper spends before it writes a word -- so the hardest questions
 * failed at twenty to forty seconds with "could not answer". A long budget is
 * safe because of the stall watchdog below: a hung endpoint is still dropped in
 * seconds, and only an answer that is visibly working gets the time.
 */
const REQUEST_TIMEOUT_MS = 90_000;
/** The answer is abandoned after this long without a token, reasoning included. */
const ANSWER_STALL_TIMEOUT_MS = 30_000;
/** Optional work before the answer: reading, routing, research, a second opinion. */
const PRE_ANSWER_BUDGET_MS = 20_000;
const REQUEST_DEADLINE_MS = PRE_ANSWER_BUDGET_MS + REQUEST_TIMEOUT_MS;
/**
 * The answer's reserved share of the deadline.
 *
 * Everything before the answer -- reading a document, choosing a route,
 * researching, asking for a second opinion -- is optional work that improves an
 * answer. Their timeouts add up to more than the whole deadline, so on the
 * requests that ran several of them the answer itself was reached with nothing
 * left and failed instantly on a deadline the optional work had spent. They get
 * a deadline of their own now, and the answer keeps the rest.
 */
const ANSWER_RESERVE_MS = REQUEST_TIMEOUT_MS;
/**
 * Above this, a request is worth counting before it is sent. Below it, the
 * input is prose and the counting call would cost more than it could save.
 */
const TOKEN_COUNT_SOURCE_BYTES = 1024 * 1024;

/**
 * Extra time a turn gets when the agent looks things up before the answer
 * (`TUTOR_AGENT_LIMITS.budgetMs` of look-ups, less what routing already
 * spent), so the answer keeps its own reserve. Still inside the route's
 * `maxDuration`, with room to save.
 */
export const TUTOR_AGENT_EXTRA_MS = 25_000;

/** When the whole turn must finish, and when optional work before the answer must stop. */
export function tutorTurnDeadlines(startedAt: number) {
  const deadlineAt = startedAt + REQUEST_DEADLINE_MS;
  // Optional pre-answer work stops here, whatever its own timeout says.
  const preAnswerDeadlineAt = deadlineAt - ANSWER_RESERVE_MS;
  return { deadlineAt, preAnswerDeadlineAt };
}

/** Everything the answer is asked with, shared by the streamed and buffered attempts. */
export type TutorAnswerCall = {
  /** From the question's thinking tier (`tutorThinkingRoute`), not the student's raw setting. */
  reasoningEffort: AiReasoningEffort;
  /** Whether the thinking role's fastest model goes first. */
  preferStandby: boolean;
  role: AiGenerationRole;
  routeReason: AiRouteReason;
  deadlineAt: number;
  signal: AbortSignal;
  responseSchema: NonNullable<AiRouterOptions["generationConfig"]>["responseSchema"];
  systemInstruction: string;
  contents: TutorTurnContents;
  providerDiagnostics: AiResponseDiagnostics[];
  log: Logger;
};

/** The answer, streamed as the model writes it. */
export function streamTutorAnswer(call: TutorAnswerCall, maxOutputTokens: number) {
  const { providerDiagnostics, log } = call;
  return streamAiText({
    reasoningEffort: call.reasoningEffort,
    preferStandby: call.preferStandby,
    role: call.role,
    routeReason: call.routeReason,
    timeoutMs: REQUEST_TIMEOUT_MS,
    stallTimeoutMs: ANSWER_STALL_TIMEOUT_MS,
    deadlineAt: call.deadlineAt,
    signal: call.signal,
    generationConfig: {
      temperature: 0.2,
      topP: 0.85,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: call.responseSchema,
    },
    request: { systemInstruction: call.systemInstruction, contents: call.contents },
    onResponse: (diagnostics) => {
      providerDiagnostics.push(diagnostics);
    },
    onRetry: ({ error, provider, modelName, nextProvider, nextModelName }) => {
      log.warn("provider.model_fallback", {
        attempt: "stream",
        provider,
        modelName,
        nextProvider,
        nextModelName,
        error,
      });
    },
  });
}

/** The answer asked for again in one piece, to recover a streamed one that fell short. */
export function generateTutorAnswer(
  call: TutorAnswerCall,
  input: {
    maxOutputTokens: number;
    structuredRetry?: boolean;
    /** Asked again because a graph was requested and none came back. */
    graphRetry?: boolean;
  }
) {
  const { providerDiagnostics, log } = call;
  return generateAiText({
    reasoningEffort: call.reasoningEffort,
    preferStandby: call.preferStandby,
    role: call.role,
    routeReason: call.routeReason,
    timeoutMs: REQUEST_TIMEOUT_MS,
    stallTimeoutMs: ANSWER_STALL_TIMEOUT_MS,
    deadlineAt: call.deadlineAt,
    signal: call.signal,
    generationConfig: {
      temperature: 0.2,
      topP: 0.85,
      maxOutputTokens: input.maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: call.responseSchema,
    },
    request: {
      systemInstruction: `${call.systemInstruction}${
        input.structuredRetry
          ? "\nThis is a structured-output retry. Return one complete, valid JSON object and finish every required field."
          : ""
      }${
        input.graphRetry
          ? "\nThe student asked for a graph and the last answer had none. Put the graph in the graphs field as a JSON object written as a string, and write [graph 1] in the answer where it belongs."
          : ""
      }`,
      contents: call.contents,
    },
    onResponse: (diagnostics) => {
      providerDiagnostics.push(diagnostics);
    },
    onRetry: ({ error, provider, modelName, nextProvider, nextModelName }) => {
      log.warn("provider.model_fallback", {
        attempt: "buffered",
        provider,
        modelName,
        nextProvider,
        nextModelName,
        error,
      });
    },
  });
}

/*
 * A ceiling on what this request costs to send.
 *
 * Only the output was ever capped. The input is whatever the student
 * attached, and a set of large PDFs re-sent on every turn has no bound at
 * all -- the daily limit caps how many requests they make, not how big one
 * gets. Counting is a separate provider call, so it is skipped entirely
 * unless the payload is large enough for the answer to be in doubt.
 */
export async function exceedsTutorInputCap(input: {
  role: AiGenerationRole;
  systemInstruction: string;
  contents: TutorTurnContents;
  combinedSourceBytes: number;
  sourceCount: number;
  log: Logger;
}) {
  const { combinedSourceBytes, log } = input;
  const inputTokenCap = getAiInputTokenCap("assistant");
  if (inputTokenCap !== null && combinedSourceBytes > TOKEN_COUNT_SOURCE_BYTES) {
    try {
      const inputTokens = await countAiInputTokens({
        role: input.role,
        request: { systemInstruction: input.systemInstruction, contents: input.contents },
      });
      if (inputTokens > inputTokenCap) {
        log.warn("request.input_too_large", {
          inputTokens,
          inputTokenCap,
          combinedSourceBytes,
          sourceCount: input.sourceCount,
        });
        return true;
      }
    } catch (error) {
      // Counting is a guard, not the work. If it fails, let the request through
      // rather than refusing an answer over a check that could not be made.
      log.warn("request.input_count_failed", { error, combinedSourceBytes });
    }
  }
  return false;
}
