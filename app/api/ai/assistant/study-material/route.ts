import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { featureFlags } from "@/lib/app/feature-flags";
import { parseJamiAssistantRequest } from "@/lib/ai/jami-assistant-request";
import {
  getJamiAssistantContextKey,
  getJamiAssistantSavedContext,
} from "@/lib/ai/jami-assistant-history";
import {
  isTutorStudyMaterialKind,
  type TutorStudyMaterialResult,
} from "@/lib/ai/tutor-study-material";
import { createLogger } from "@/lib/observability/logger";
import {
  apiFailure,
  authenticateRequest,
} from "@/services/auth/authenticate-request.server";
import {
  JamiAssistantContextError,
  resolveJamiAssistantContext,
} from "@/services/ai/assistant-context";
import {
  checkAiBudget,
  createAiBudgetLimitResponse,
  refundAiBudget,
} from "@/services/ai/budgets";
import {
  buildTutorStudyMaterialContext,
  loadTutorStudyMaterialTurn,
  recordTutorStudyMaterialResult,
  TutorStudyMaterialError,
  writeTutorFlashcardDrafts,
} from "@/services/ai/tutor-study-material.server";
import {
  createPracticeSet,
  PracticeSetError,
} from "@/services/practice/practice-sets.server";

export const runtime = "nodejs";
/** A practice set is written by the supervisor, five questions a call. */
export const maxDuration = 300;

/**
 * Makes the flashcards or practice set Tutor agreed to, or offered, on one of
 * its answers.
 *
 * Made from the saved conversation and the material the student is working
 * in, so what comes back is about what they were actually discussing -- not an
 * even sweep of a whole source, which is all the Create panel could do.
 */
export async function POST(request: NextRequest) {
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiFailure("Invalid request body.", 400, "invalid_request");
  }
  const threadId = typeof body.threadId === "string" ? body.threadId.trim().slice(0, 160) : "";
  const messageId = typeof body.messageId === "string" ? body.messageId.trim().slice(0, 160) : "";
  const kind = isTutorStudyMaterialKind(body.kind) ? body.kind : null;
  const parsedContext = parseJamiAssistantRequest({
    message: "Make study material",
    history: [],
    context: body.context,
    useRelatedSources: true,
  });
  if (!threadId || !messageId || !kind || !parsedContext) {
    return apiFailure("Choose a Tutor answer to make these from.", 400, "invalid_request");
  }
  if (kind === "practice" && !featureFlags.enablePastPaperPractice) {
    return apiFailure("Practice sets are not available yet.", 404, "not_found");
  }

  const log = createLogger({ route: "ai.assistant.study-material", requestId: randomUUID(), uid });
  let turn;
  try {
    turn = await loadTutorStudyMaterialTurn({
      uid,
      threadId,
      messageId,
      contextKey: getJamiAssistantContextKey(getJamiAssistantSavedContext(parsedContext.context)),
      kind,
      // What the student picked on the card, checked against the answer that asked.
      choice: body.choice,
    });
  } catch (error) {
    if (error instanceof TutorStudyMaterialError) return apiFailure(error.message, error.status, error.code);
    log.error("turn.load_failed", { error });
    return apiFailure("That Tutor answer could not be loaded.", 503, "turn_load_failed");
  }
  // Asked twice -- a double tap, a retry after a dropped connection -- is made once.
  if (turn.existing) return Response.json({ result: turn.existing });

  let resolved;
  try {
    resolved = await resolveJamiAssistantContext({
      uid,
      message: turn.focus,
      context: parsedContext.context,
      useRelatedSources: true,
    });
  } catch (error) {
    if (error instanceof JamiAssistantContextError) return apiFailure(error.message, error.status, error.code);
    log.error("context.load_failed", { error });
    return apiFailure("Jami could not load what you were studying.", 503, "context_load_failed");
  }
  const context = buildTutorStudyMaterialContext({ resolved, conversation: turn.conversation });
  const folderIds = resolved.folderIds ?? [];
  // Only material in exactly one folder says which folder its practice belongs to.
  const folderId = folderIds.length === 1 ? folderIds[0] : undefined;
  const sourceIds =
    parsedContext.context.surface === "sources" ? parsedContext.context.sourceIds : [];

  // A Tutor practice set is a handful of questions, not a paper: charged as
  // practice drafts, so asking for five quick questions cannot spend one of the
  // student's monthly papers. See docs/plans-and-stardust.md.
  const budgetAction = kind === "flashcards" ? "sourceFlashcardDrafts" : "sourcePracticeDrafts";
  const budget = await checkAiBudget({ uid, action: budgetAction }).catch(() => null);
  if (!budget) {
    return apiFailure("AI usage limits are temporarily unavailable. Try again shortly.", 503, "budget_unavailable");
  }
  if (!budget.allowed) return createAiBudgetLimitResponse(budgetAction, budget);
  enterAiSpendContext(aiSpendContextFor(uid, budgetAction));

  try {
    let result: TutorStudyMaterialResult;
    if (kind === "flashcards") {
      const drafts = await writeTutorFlashcardDrafts({
        uid,
        focus: turn.focus,
        count: turn.count,
        context,
        ...(resolved.studyLevelContext ? { studyLevelContext: resolved.studyLevelContext } : {}),
        threadId,
        messageId,
        ...(sourceIds[0] ? { sourceId: sourceIds[0] } : {}),
        ...(folderId ? { folderId } : {}),
        ...(resolved.deckId ? { deckId: resolved.deckId } : {}),
        signal: request.signal,
      });
      result = {
        kind: "flashcards",
        draftIds: drafts.map((draft) => draft.id),
        focus: turn.focus,
        ...(folderId ? { folderId } : {}),
        ...(resolved.deckId ? { deckId: resolved.deckId } : {}),
        createdAt: Date.now(),
      };
      await recordTutorStudyMaterialResult(turn.messageRef, result);
      return Response.json({ result, drafts });
    }

    const session = await createPracticeSet({
      uid,
      origin: "tutor",
      focus: turn.focus,
      count: turn.count,
      ...(folderId ? { folderId } : {}),
      context: [resolved.studyLevelContext ?? "", context].filter(Boolean).join("\n\n"),
      sourceIds,
      threadId,
      messageId,
    });
    result = {
      kind: "practice",
      sessionId: session.id,
      title: session.practiceSet?.title ?? "Practice set",
      focus: turn.focus,
      questionCount: session.questions.length,
      totalMarks: session.maxTotal,
      createdAt: Date.now(),
    };
    await recordTutorStudyMaterialResult(turn.messageRef, result);
    return Response.json({ result, session });
  } catch (error) {
    await refundAiBudget(budget.grant).catch(() => undefined);
    if (request.signal.aborted) return apiFailure("Cancelled.", 499, "cancelled");
    if (error instanceof TutorStudyMaterialError || error instanceof PracticeSetError) {
      return apiFailure(error.message, error.status, error.code);
    }
    log.error("study_material.failed", { kind, error });
    return apiFailure(
      kind === "flashcards"
        ? "Jami could not make those flashcards just now. Try again in a moment."
        : "Jami could not write that practice set just now. Try again in a moment.",
      503,
      "study_material_failed"
    );
  }
}
