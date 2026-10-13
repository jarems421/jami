import "server-only";

import { randomUUID } from "node:crypto";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import type { ResolvedJamiAssistantContext } from "@/lib/ai/assistant-context.server";
import type { TutorAgentStepView } from "@/lib/ai/tutor-agent";
import type {
  JamiAssistantContext,
  ParsedJamiAssistantModelAnswer,
} from "@/lib/ai/jami-assistant";
import {
  createJamiAssistantThreadTitle,
  type JamiAssistantSavedContext,
  type JamiAssistantThread,
} from "@/lib/ai/jami-assistant-history";
import type { AiGenerationRole } from "@/lib/ai/provider-policy";
import type { TutorAttachment } from "@/lib/ai/tutor-attachments";
import type { TutorAnswerPackage } from "@/lib/ai/tutor-turn-answer";
import type { TutorTurnPlan } from "@/lib/ai/tutor-turn-plan";
import { readTutorCheckProposal, type PendingTutorCheck } from "@/lib/learning/events/tutor-check";
import type { Logger } from "@/lib/observability/logger";
import { applyTutorMemoryFromAnswer } from "@/services/ai/tutor-memory.server";
import { recordNotebookMarking } from "@/services/learning/notebook-markings.server";
import { recordTutorCheck } from "@/services/learning/tutor-checks.server";

/**
 * Saving a finished Tutor turn, and what follows it: the chat, both messages
 * and the route state in one batch, then the quick check and notebook marking
 * the answer carried, and what Tutor proposed remembering.
 */

/** Who and where a turn belongs to, and what the turn decided, for saving it. */
export type TutorTurnRecord = {
  uid: string;
  adminDb: Firestore;
  userRef: DocumentReference;
  message: string;
  /** The label the drawer gave the study context, as it was sent. */
  contextLabel?: string;
  context: JamiAssistantContext;
  savedContext: JamiAssistantSavedContext;
  canonicalContextKey: string;
  existingThread: JamiAssistantThread | null;
  movedFromSurface: JamiAssistantThread["surface"] | null;
  /** The files that came with this message, saved with it. */
  newAttachments: TutorAttachment[];
  plan: Pick<TutorTurnPlan, "checkInvited" | "markingInvited">;
  pendingCheck: PendingTutorCheck | null;
  resolved: Pick<
    ResolvedJamiAssistantContext,
    "checkTarget" | "topicIds" | "notebookLearning" | "folderIds" | "memoryWritable" | "memoryRefs"
  >;
  route: { role: AiGenerationRole; priorAnswerChallenged: boolean };
  log: Logger;
};

/** What saving a turn produced, for the done event and the work after it. */
export type SavedTutorTurn = {
  threadId: string;
  assistantMessageId: string;
  now: number;
  contextLabel: string;
};

/**
 * Saves the turn in one batch.
 *
 * Persist the exact provider-validated turn before issuing any illustration
 * entitlement. Firestore client rules deny writes to these collections, so
 * route-chain and canIllustrate state cannot be forged to force a juror or
 * reveal a flashcard answer visually.
 */
export async function saveTutorTurn(
  record: TutorTurnRecord,
  payload: TutorAnswerPackage,
  parsedAnswer: ParsedJamiAssistantModelAnswer,
  /** What the agent looked up or worked out first, kept so a reopened chat still says. */
  agentSteps: readonly TutorAgentStepView[] = []
): Promise<SavedTutorTurn> {
  const { userRef, existingThread, movedFromSurface, savedContext, canonicalContextKey, resolved, log } = record;
  const threadRef = existingThread
    ? userRef.collection("assistantThreads").doc(existingThread.id)
    : userRef.collection("assistantThreads").doc();
  const userMessageRef = userRef.collection("assistantMessages").doc();
  const assistantMessageRef = userRef.collection("assistantMessages").doc();
  const now = Date.now();
  const contextLabel =
    record.contextLabel?.trim().slice(0, 120) || "Study context";
  const batch = record.adminDb.batch();
  batch.set(
    threadRef,
    {
      ...(!existingThread
        ? {
            title: createJamiAssistantThreadTitle(record.message),
            surface: savedContext.surface,
            context: savedContext,
            contextKey: canonicalContextKey,
            contextLabel,
            createdAt: now,
          }
        : movedFromSurface
          ? {
              // Carried on somewhere new: the chat now lives here.
              surface: savedContext.surface,
              context: savedContext,
              contextKey: canonicalContextKey,
              contextLabel,
            }
          : {}),
      updatedAt: now,
      lastMessagePreview: payload.reply.slice(0, 180),
      lastAssistantMessageId: assistantMessageRef.id,
      messageCount: (existingThread?.messageCount ?? 0) + 2,
    },
    { merge: true }
  );
  batch.create(userMessageRef, {
    threadId: threadRef.id,
    role: "user",
    text: record.message,
    // Kept so the chat shows them, can read them again, and deletes them with itself.
    ...(record.newAttachments.length > 0 ? { attachments: record.newAttachments } : {}),
    createdAt: now,
  });
  batch.create(assistantMessageRef, {
    threadId: threadRef.id,
    role: "assistant",
    text: payload.reply,
    used: payload.used,
    followUps: payload.followUps ?? [],
    citations: payload.citations ?? [],
    illustrations: [],
    canIllustrate: payload.canIllustrate === true,
    // Recorded server-side, so the route that makes the material can
    // check it was actually agreed or offered on this answer.
    ...(payload.studyMaterialRequest
      ? { studyMaterialRequest: payload.studyMaterialRequest }
      : {}),
    studyMaterialOffers: payload.studyMaterialOffers ?? [],
    // What Tutor asked about first, so the card can still make them later.
    ...(payload.studyMaterialSetup ? { studyMaterialSetup: payload.studyMaterialSetup } : {}),
    // What an offer would be made on, kept server-side for when it is taken up.
    ...(payload.studyMaterialFocus ? { studyMaterialFocus: payload.studyMaterialFocus } : {}),
    // Kept so a reopened chat still shows them; they run again only on a press.
    ...(payload.appActions ? { appActions: payload.appActions, appScope: payload.appScope } : {}),
    ...(agentSteps.length > 0 ? { agentSteps } : {}),
    createdAt: now + 1,
  });
  /*
   * A quick check asked in this answer, placed by the server. Route state
   * is replaced every turn, so a check is answerable on the next message
   * only, and an unanswered one simply lapses.
   */
  const newCheck =
    record.plan.checkInvited && resolved.checkTarget && parsedAnswer.quickCheck !== undefined
      ? readTutorCheckProposal({
          proposal: parsedAnswer.quickCheck,
          id: randomUUID(),
          topicKeys: resolved.checkTarget.topicKeys,
          scope: resolved.checkTarget.scope,
          askedAt: now,
        })
      : null;
  if (parsedAnswer.quickCheck !== undefined) {
    log.info(newCheck ? "tutor_check.asked" : "tutor_check.proposal_rejected", {
      ...(newCheck ? { points: newCheck.points.length } : {}),
    });
  }
  batch.set(userRef.collection("assistantRouteState").doc(threadRef.id), {
    lastRole: record.route.role,
    lastTurnChallenged: record.route.priorAnswerChallenged,
    lastAssistantMessageId: assistantMessageRef.id,
    ...(newCheck ? { pendingCheck: newCheck } : {}),
    updatedAt: now,
  });
  await batch.commit();
  return { threadId: threadRef.id, assistantMessageId: assistantMessageRef.id, now, contextLabel };
}

/**
 * Marks the answer to last turn's quick check and records a notebook marking,
 * when the turn carried either. Both run after the turn is saved and outside
 * its batch: a check or a marking that fails to save costs the student nothing.
 *
 * Returns the study action a recorded marking answered, when the student came
 * to the page from one: the work it asked for has now actually been done, and
 * the browser records it as such.
 */
export async function recordTutorTurnAssessments(
  record: TutorTurnRecord,
  parsedAnswer: ParsedJamiAssistantModelAnswer,
  now: number
): Promise<{ completedActionId?: string }> {
  const { uid, pendingCheck, log } = record;
  /*
   * Mark the answer to last turn's check, if this message was one.
   * Outside the batch like notebook marking: a check that fails to save
   * costs the student nothing.
   */
  if (pendingCheck) {
    try {
      const outcome =
        parsedAnswer.checkMarking === undefined
          ? null
          : await recordTutorCheck({ uid, pending: pendingCheck, verdict: parsedAnswer.checkMarking, markedAt: now });
      if (!outcome) log.info("tutor_check.not_marked");
      else if (outcome.recorded) log.info("tutor_check.recorded");
      else log.info("tutor_check.rejected", { reason: outcome.reason });
    } catch (error) {
      log.warn("tutor_check.write_failed", { error });
    }
  }

  /*
   * Record Tutor's verdict, if it actually produced one.
   *
   * After the answer is saved and deliberately outside the batch: a
   * rejected marking, or a failure to write one, must cost the student
   * nothing. They asked a question and they have their answer. The
   * record is filed per page, so a retry or a regenerated response
   * replaces the verdict rather than adding a second one.
   *
   * Both outcomes are logged, because a marker that is always rejected
   * looks exactly like a marker nobody uses.
   */
  const notebookLearning = record.resolved.notebookLearning;
  if (record.plan.markingInvited && record.context.surface === "notebook" && notebookLearning) {
    try {
      const outcome = await recordNotebookMarking({
        uid,
        notebookId: record.context.notebookId,
        pageId: record.context.pageId,
        learning: notebookLearning,
        verdict: parsedAnswer.marking,
      });
      /*
       * Four outcomes, named apart, because three of them look like
       * failure and only one is. A model that declines an unmarkable
       * page did the right thing; a model that offered nothing may have
       * done the right thing too. Neither is a rejected marking.
       */
      if (outcome.recorded) {
        log.info("marking.accepted", { attribution: notebookLearning.attribution });
        if (notebookLearning.interventionId) {
          return { completedActionId: notebookLearning.interventionId };
        }
      } else if (parsedAnswer.marking === undefined) {
        log.info("marking.not_offered");
      } else if (outcome.reason === "declined") {
        log.info("marking.declined");
      } else {
        log.info("marking.rejected", { reason: outcome.reason });
      }
    } catch (error) {
      log.warn("marking.write_failed", { error });
    }
  }
  return {};
}

/** The saved chat as the drawer keeps it, sent with the finished answer. */
export function savedTutorThread(
  record: TutorTurnRecord,
  payload: TutorAnswerPackage,
  saved: SavedTutorTurn
): JamiAssistantThread {
  const { existingThread, savedContext, canonicalContextKey, movedFromSurface } = record;
  const { contextLabel, now } = saved;
  return {
    id: saved.threadId,
    title:
      existingThread?.title ??
      createJamiAssistantThreadTitle(record.message),
    surface: savedContext.surface,
    contextKey: canonicalContextKey,
    contextLabel: movedFromSurface ? contextLabel : existingThread?.contextLabel ?? contextLabel,
    context: savedContext,
    lastMessagePreview: payload.reply.slice(0, 180),
    messageCount: (existingThread?.messageCount ?? 0) + 2,
    createdAt: existingThread?.createdAt ?? now,
    updatedAt: now,
    lastAssistantMessageId: saved.assistantMessageId,
  };
}

/**
 * Keep what Tutor proposed remembering, once the student has the
 * answer and outside its batch: a memory that fails to save costs the
 * student nothing, and the answer never waits on it. Counts only in
 * the log.
 */
export async function rememberFromTutorTurn(
  record: TutorTurnRecord,
  parsedAnswer: ParsedJamiAssistantModelAnswer,
  now: number
) {
  const { resolved, log } = record;
  if (resolved.memoryWritable && parsedAnswer.memory !== undefined) {
    try {
      const memoryOutcome = await applyTutorMemoryFromAnswer({
        uid: record.uid,
        operations: parsedAnswer.memory,
        context: {
          ...(resolved.folderIds?.length === 1 ? { folderId: resolved.folderIds[0] } : {}),
          topicIds: resolved.topicIds ?? [],
          surface: record.savedContext.surface,
        },
        refs: resolved.memoryRefs ?? new Map(),
        now,
      });
      log.info("tutor_memory.updated", memoryOutcome);
    } catch (error) {
      log.warn("tutor_memory.write_failed", { error });
    }
  }
}
