import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { featureFlags } from "@/lib/app/feature-flags";
import {
  getJamiAssistantContextKey,
  getJamiAssistantSavedContext,
} from "@/lib/ai/jami-assistant-history";
import type { AiResponseDiagnostics } from "@/lib/ai/provider-router";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import {
  buildTutorAttachmentInstruction,
  normalizeTutorAttachments,
} from "@/lib/ai/tutor-attachments";
import { isTutorChatRecallRequest } from "@/lib/ai/tutor-chat-recall";
import { getTutorSuggestionKinds } from "@/lib/ai/tutor-suggestion";
import { TUTOR_AGENT_LIMITS, tutorAgentFoundNoMaterial, type TutorAgentLiveStep } from "@/lib/ai/tutor-agent";
import type { TutorAnswerPackageInput } from "@/lib/ai/tutor-turn-answer";
import { planTutorTurn } from "@/lib/ai/tutor-turn-plan";
import {
  buildTutorSystemInstruction,
  buildTutorTurnContents,
} from "@/lib/ai/tutor-turn-prompt";
import {
  JamiAssistantContextError,
  resolveJamiAssistantContext,
} from "@/services/ai/assistant-context";
import {
  checkAiBudget,
  createAiBudgetLimitResponse,
  getAiTokenCap,
  refundAiBudget,
} from "@/services/ai/budgets";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import { loadTutorChatRecall } from "@/services/ai/tutor-chat-recall.server";
import {
  chosenTutorSourceBytes,
  MAX_COMBINED_SOURCE_BYTES,
  readTutorAttachmentFolders,
  readTutorTurnMaterial,
} from "@/services/ai/tutor-turn-material.server";
import { runTutorAgent, type TutorAgentGathered } from "@/services/ai/tutor-agent.server";
import {
  exceedsTutorInputCap,
  TUTOR_AGENT_EXTRA_MS,
  tutorTurnDeadlines,
  type TutorAnswerCall,
} from "@/services/ai/tutor-turn-model.server";
import { openTutorTurn, tutorFailureResponse } from "@/services/ai/tutor-turn-request.server";
import { researchTutorTurn } from "@/services/ai/tutor-turn-research.server";
import { routeTutorTurn } from "@/services/ai/tutor-turn-routing.server";
import {
  createTutorTurnStream,
  tutorTurnResponse,
  watchTutorTurnCancellation,
  type TutorTurnPrepared,
} from "@/services/ai/tutor-turn-stream.server";
import { loadTutorTurnThread } from "@/services/ai/tutor-turn-thread.server";
import { getAdminDb } from "@/services/firebase/admin";
import { buildAssistantResponseSchema } from "./response-schema";

export const runtime = "nodejs";
/**
 * The platform's budget, which has to be at least the turn's own deadline
 * (`tutorTurnDeadlines`).
 *
 * Without this the function got the account default -- ten to fifteen seconds --
 * while the route planned for fifty, so the platform killed the function
 * mid-stream on any answer that took longer than the shortest ones. The student
 * saw the reply stop partway and the client, never having received the terminal
 * event, reported a timeout. Every other AI route here already declares one.
 * It sits above the request deadline with room to save the turn afterwards.
 */
export const maxDuration = 150;

const sourcesTooLarge = () =>
  tutorFailureResponse(
    "Choose fewer or smaller sources. Jami can read up to 30 MB at once.",
    413,
    "sources_too_large"
  );

/**
 * One Tutor turn, composed from its phases: the gate, the saved chat, the
 * study context, the budget, the material, the prompt, the route to a model,
 * and the streamed answer that saves itself when it is finished.
 */
export async function POST(request: NextRequest) {
  const opened = await openTutorTurn(request);
  if (opened instanceof Response) return opened;
  const { caller, startedAt, log, parsedRequest } = opened;
  const uid = caller.uid;

  const adminDb = getAdminDb();
  const userRef = adminDb.collection("users").doc(uid);
  /*
   * Files attached in this chat, read because the student sent them with a
   * question. Only the student's own chat attachments survive this; anything
   * else on the request is dropped before a byte is read.
   */
  const attachments = normalizeTutorAttachments(parsedRequest.attachments, { uid });
  const newAttachments = attachments.slice(0, parsedRequest.newAttachmentCount ?? 0);
  const savedContext = getJamiAssistantSavedContext(parsedRequest.context);
  const canonicalContextKey = getJamiAssistantContextKey(savedContext);
  // Conversation history is security-sensitive because it controls
  // supervisor/juror escalation. Ignore browser-supplied history and load the
  // server-owned thread instead; a new thread always starts with no history.
  const thread = await loadTutorTurnThread({
    userRef,
    ...(parsedRequest.threadId ? { threadId: parsedRequest.threadId } : {}),
    canonicalContextKey,
    now: startedAt,
  });
  if (!thread) {
    return tutorFailureResponse("That saved chat could not be found.", 404, "thread_not_found");
  }
  const { existingThread, conversationHistory, movedFromSurface, pendingCheck } = thread;

  let resolved;
  try {
    resolved = await resolveJamiAssistantContext({
      uid,
      message: parsedRequest.message,
      context: parsedRequest.context,
      useRelatedSources: parsedRequest.useRelatedSources,
      ...(existingThread ? { threadId: existingThread.id } : {}),
      firstTurn: conversationHistory.length === 0,
    });
  } catch (error) {
    if (error instanceof JamiAssistantContextError) {
      return tutorFailureResponse(error.message, error.status, error.code);
    }
    log.error("context.load_failed", { error });
    return tutorFailureResponse(
      "Jami could not load the current study context.",
      500,
      "context_load_failed"
    );
  }
  const plan = planTutorTurn({
    message: parsedRequest.message,
    context: parsedRequest.context,
    savedContext,
    firstTurn: conversationHistory.length === 0,
    // Practice sets are exam sessions, so they exist only where those do.
    practiceSetsAvailable: featureFlags.enablePastPaperPractice,
    resolved,
  });

  if (chosenTutorSourceBytes(resolved) > MAX_COMBINED_SOURCE_BYTES) return sourcesTooLarge();

  let budgetDecision;
  try {
    budgetDecision = await checkAiBudget({ uid, action: "assistant" });
    // Everything this request spends from here on is billed to this student.
    // Entered here in the handler itself: async-local storage entered inside
    // a helper would not reach the rest of this request.
    enterAiSpendContext(aiSpendContextFor(uid, "assistant"));
  } catch (error) {
    log.error("budget.check_failed", { error });
    return tutorFailureResponse(
      "AI usage limits are temporarily unavailable. Try again shortly.",
      503,
      "budget_unavailable"
    );
  }
  if (!budgetDecision.allowed) {
    return createAiBudgetLimitResponse("assistant", budgetDecision);
  }
  // Captured here so the refund below keeps the narrowing this check performed.
  const budgetGrant = budgetDecision.grant;

  /**
   * Hands the charged request back. Every path that leaves the student with
   * nothing goes through here: a request that produced no answer should not
   * also cost one of the day's allowance.
   */
  const refundRequest = async (why: string) => {
    try {
      await refundAiBudget(budgetGrant);
    } catch (error) {
      // A refund that fails costs the student one request; failing the response
      // over it would cost them the answer as well.
      log.warn("budget.refund_failed", { why, error });
    }
  };
  const { deadlineAt, preAnswerDeadlineAt } = tutorTurnDeadlines(startedAt);
  /*
   * What the student referred back to -- earlier in a long chat, or in another
   * one -- found by searching their saved chats. Only when their words point
   * back, and started now so the read overlaps the source search. Other chats
   * are searched only while the student's memory is on.
   */
  const recallLoading = isTutorChatRecallRequest(parsedRequest.message)
    ? loadTutorChatRecall({
        uid,
        message: parsedRequest.message,
        ...(existingThread ? { currentThreadId: existingThread.id, currentThreadTitle: existingThread.title } : {}),
        earlierInThread: thread.earlierInThread,
        deadlineAt: preAnswerDeadlineAt,
        log,
      })
    : Promise.resolve(null);
  const cancellation = watchTutorTurnCancellation(request);

  const material = await readTutorTurnMaterial({
    request,
    uid,
    message: parsedRequest.message,
    history: conversationHistory,
    resolved,
    attachments,
    preAnswerDeadlineAt,
    signal: cancellation.signal,
    log,
  });
  const { readable, readableAttachments } = material;
  if (material.combinedSourceBytes > MAX_COMBINED_SOURCE_BYTES) {
    // Charged already: only reading the sources showed how large they are.
    cancellation.release();
    await refundRequest("sources_too_large");
    return sourcesTooLarge();
  }

  const research = await researchTutorTurn({
    uid,
    message: parsedRequest.message,
    context: parsedRequest.context,
    hasLocalSources: readable.length > 0,
    sources: resolved.sources,
    preAnswerDeadlineAt,
    signal: cancellation.signal,
    log,
  });
  const webResearch = research.result;

  const attachmentFolders =
    readableAttachments.length > 0 ? await readTutorAttachmentFolders(userRef, log) : [];
  const attachmentInstruction = buildTutorAttachmentInstruction({
    attachmentCount: readableAttachments.length > 0 ? attachments.length : 0,
    folderNames: attachmentFolders.map((folder) => folder.name),
  });
  const recall = await recallLoading;
  /**
   * What the answer is asked with, from what is in hand: once from the
   * up-front reading, and again after the agent's look-ups when it runs.
   */
  const composeAnswer = (gathered: Pick<TutorAgentGathered, "readable" | "research" | "recall" | "workings"> & {
    researchNeeded: boolean;
    researchAllowanceUsed: boolean;
    materialNotFound?: boolean;
  }) => {
    const allowedSourceRefs = gathered.readable.map((result) => result.sourceRef);
    const responseSchema = buildAssistantResponseSchema(
      allowedSourceRefs,
      plan.markingInvited,
      false,
      false,
      resolved.memoryWritable === true,
      plan.studyMaterialKinds,
      readableAttachments.length > 0,
      getTutorSuggestionKinds(plan.practiceSetsAvailable),
      {
        checkInvited: plan.checkInvited,
        ...(pendingCheck ? { pendingCheckPoints: pendingCheck.points.length } : {}),
        nextStepAvailable: plan.nextStepAvailable,
        appActions: { types: plan.app.actions, destinationKeys: plan.app.destinations.map((destination) => destination.key) },
      }
    );
    const systemInstruction = buildTutorSystemInstruction({
      context: resolved,
      research: {
        ok: gathered.research.ok,
        needed: gathered.researchNeeded,
        allowanceUsed: gathered.researchAllowanceUsed,
      },
      movedChat: movedFromSurface ? { from: movedFromSurface, to: savedContext.surface } : null,
      attachmentInstruction,
      recall: gathered.recall,
      independentWorking: gathered.workings.length > 0,
      materialNotFound: gathered.materialNotFound === true,
      workingCheck: plan.workingCheck,
      markingInvited: plan.markingInvited,
      pendingCheck,
      checkInvited: plan.checkInvited,
      studyMaterial: {
        requested:
          plan.requestedStudyMaterial === "practice" && !plan.practiceSetsAvailable
            ? null
            : plan.requestedStudyMaterial,
        practiceAvailable: plan.practiceSetsAvailable,
        askFirst: plan.askStudyMaterialFirst,
      },
      suggestions: { practiceAvailable: plan.practiceSetsAvailable, previous: thread.previousSuggestions },
      app: { destinations: plan.app.destinations, available: plan.app.actions },
      responseInstruction: plan.guidance.instruction,
      newBoundaryToken: randomUUID,
    });
    const contents = buildTutorTurnContents({
      history: conversationHistory,
      research: gathered.research,
      sources: gathered.readable,
      attachments: readableAttachments,
      recall: gathered.recall,
      workings: gathered.workings,
      currentLabel: resolved.currentLabel,
      currentParts: resolved.currentParts,
      message: parsedRequest.message,
      newBoundaryToken: randomUUID,
    });
    return { allowedSourceRefs, responseSchema, systemInstruction, contents };
  };
  const upFront = composeAnswer({
    readable,
    research: webResearch,
    recall,
    workings: [],
    researchNeeded: research.needed,
    researchAllowanceUsed: research.allowanceUsed,
  });
  const { allowedSourceRefs, responseSchema, systemInstruction } = upFront;
  const providerDiagnostics: AiResponseDiagnostics[] = [];
  const route = await routeTutorTurn({
    message: parsedRequest.message,
    context: parsedRequest.context,
    history: conversationHistory,
    trustedRouteState: thread.trustedRouteState,
    existingThread,
    sources: readable,
    currentParts: resolved.currentParts,
    research: webResearch,
    contents: upFront.contents,
    reasoningEffort: resolved.reasoningEffort,
    hasAttachments: readableAttachments.length > 0,
    preAnswerDeadlineAt,
    signal: cancellation.signal,
    providerDiagnostics,
    log,
  });

  const maxOutputTokens = Math.min(
    getAiTokenCap("assistant"),
    plan.guidance.maxOutputTokens
  );

  if (
    await exceedsTutorInputCap({
      role: route.role,
      systemInstruction,
      contents: route.contents,
      combinedSourceBytes: material.combinedSourceBytes,
      sourceCount: readable.length,
      log,
    })
  ) {
    cancellation.release();
    await refundRequest("input_too_large");
    return tutorFailureResponse(
      "That is more material than Jami can read at once. Choose fewer sources and ask again.",
      413,
      "input_too_large"
    );
  }

  const call: TutorAnswerCall = {
    reasoningEffort: route.reasoningEffort,
    preferStandby: route.preferStandby,
    role: route.role,
    routeReason: route.routeReason,
    deadlineAt,
    signal: cancellation.signal,
    responseSchema,
    systemInstruction,
    contents: route.contents,
    providerDiagnostics,
    log,
  };
  const answer: TutorAnswerPackageInput = {
    message: parsedRequest.message,
    context: parsedRequest.context,
    plan,
    current: { id: resolved.currentId, label: resolved.currentLabel },
    sources: readable,
    research: webResearch,
    sourceFailures: material.sourceFailures,
    ...(resolved.practiceOffer ? { practiceOffer: resolved.practiceOffer } : {}),
    ...(resolved.nextStepOffer ? { nextStepOffer: resolved.nextStepOffer } : {}),
    attachments: {
      all: attachments,
      anyReadable: readableAttachments.length > 0,
      folderIds: attachmentFolders.map((folder) => folder.id),
    },
  };
  /*
   * Think and Deep answers look things up first (docs/tutor-agent.md). Quick
   * ones stay one fast call, and a reply already reconciled with the juror's
   * independent review has had its second opinion.
   */
  const agentRuns =
    featureFlags.enableTutorAgent && route.tier !== "quick" && route.routeReason !== "second_correction";
  const prepare = agentRuns
    ? async (onStep: (step: TutorAgentLiveStep) => void): Promise<TutorTurnPrepared> => {
        const gathered = await runTutorAgent({
          uid,
          message: parsedRequest.message,
          history: conversationHistory,
          currentText: resolved.currentParts.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n"),
          checkingWorking: plan.workingCheck,
          scope: { sources: resolved.sources, pinnedSourceIds: resolved.pinnedSourceIds ?? [] },
          inHand: { readable, research: webResearch, recall },
          recallFrom: {
            ...(existingThread ? { currentThreadId: existingThread.id, currentThreadTitle: existingThread.title } : {}),
            earlierInThread: thread.earlierInThread,
          },
          deadlineAt: Math.min(Date.now() + TUTOR_AGENT_LIMITS.budgetMs, deadlineAt),
          signal: cancellation.signal,
          providerDiagnostics,
          onStep,
          log,
        });
        const composed = composeAnswer({
          ...gathered,
          // A search the agent tried counts as needed, so a failed one is said to be unverified.
          researchNeeded: research.needed || gathered.steps.some((step) => step.tool === "search_web"),
          researchAllowanceUsed: research.allowanceUsed || gathered.searchAllowanceUsed,
          materialNotFound: tutorAgentFoundNoMaterial(gathered.ledger),
        });
        return {
          call: {
            ...call,
            responseSchema: composed.responseSchema,
            systemInstruction: composed.systemInstruction,
            contents: composed.contents,
            // The look-ups' time is added, so the answer keeps its own.
            deadlineAt: deadlineAt + TUTOR_AGENT_EXTRA_MS,
          },
          allowedSourceRefs: composed.allowedSourceRefs,
          answer: { ...answer, sources: gathered.readable, research: gathered.research },
          agentSteps: gathered.steps,
        };
      }
    : undefined;

  return tutorTurnResponse(
    createTutorTurnStream({
      call,
      maxOutputTokens,
      allowedSourceRefs,
      depth: plan.guidance.depth,
      answer,
      ...(prepare ? { prepare } : {}),
      record: {
        uid,
        adminDb,
        userRef,
        message: parsedRequest.message,
        contextLabel: parsedRequest.contextLabel,
        context: parsedRequest.context,
        savedContext,
        canonicalContextKey,
        existingThread,
        movedFromSurface,
        newAttachments,
        plan,
        pendingCheck,
        resolved,
        route: { role: route.role, priorAnswerChallenged: route.priorAnswerChallenged },
        log,
      },
      report: {
        startedAt,
        sourceCount: readable.length,
        sourceFailureCount: material.sourceFailures.length,
        sourcesConsidered: resolved.sources.length,
        evidencePlans: material.evidencePlans,
        evidenceBySourceRef: material.evidenceBySourceRef,
        combinedSourceBytes: material.combinedSourceBytes,
      },
      providerDiagnostics,
      refund: refundRequest,
      cancellation,
      log,
    })
  );
}
