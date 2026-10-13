import { normalizeAssistantId as normalizeId } from "@/lib/ai/jami-assistant-normalize";
import {
  JAMI_ASSISTANT_MAX_MESSAGE_LENGTH,
  JAMI_ASSISTANT_MAX_QUESTION_PROMPT_LENGTH,
  JAMI_ASSISTANT_MAX_SNAPSHOT_BYTES,
  JAMI_ASSISTANT_MAX_SNAPSHOT_EDGE,
  JAMI_ASSISTANT_MAX_SOURCE_IDS,
  JAMI_ASSISTANT_MAX_TYPED_TEXT_LENGTH,
  normalizeJamiAssistantHistory,
  normalizeOptionalText,
  type JamiAssistantContext,
  type JamiAssistantRequest,
  type JamiAssistantSnapshot,
} from "@/lib/ai/jami-assistant";
import {
  MAX_TUTOR_ATTACHMENTS_PER_MESSAGE,
  normalizeTutorAttachments,
} from "@/lib/ai/tutor-attachments";

/**
 * A Tutor request as the browser sent it, checked field by field before the
 * route trusts any of it: the message, the chat so far, the study context and
 * any files attached.
 */

/** A study action id: scope, reason and target key. */
const MAX_ACTION_ID_LENGTH = 400;

function normalizeSourceIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizeId).filter(Boolean))).slice(
    0,
    JAMI_ASSISTANT_MAX_SOURCE_IDS + 1
  );
}

function isSnapshotMimeType(
  value: unknown
): value is JamiAssistantSnapshot["mimeType"] {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp"
  );
}

function getApproximateBase64Bytes(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function normalizeSnapshot(value: unknown): JamiAssistantSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as Record<string, unknown>;
  if (!isSnapshotMimeType(snapshot.mimeType)) return undefined;
  if (
    typeof snapshot.width !== "number" ||
    !Number.isInteger(snapshot.width) ||
    snapshot.width <= 0 ||
    snapshot.width > JAMI_ASSISTANT_MAX_SNAPSHOT_EDGE ||
    typeof snapshot.height !== "number" ||
    !Number.isInteger(snapshot.height) ||
    snapshot.height <= 0 ||
    snapshot.height > JAMI_ASSISTANT_MAX_SNAPSHOT_EDGE ||
    typeof snapshot.dataBase64 !== "string"
  ) {
    return undefined;
  }

  const dataBase64 = snapshot.dataBase64.trim();
  if (
    !dataBase64 ||
    dataBase64.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) ||
    getApproximateBase64Bytes(dataBase64) > JAMI_ASSISTANT_MAX_SNAPSHOT_BYTES
  ) {
    return undefined;
  }

  return {
    mimeType: snapshot.mimeType,
    width: snapshot.width,
    height: snapshot.height,
    dataBase64,
  };
}

function normalizeContext(value: unknown): JamiAssistantContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Record<string, unknown>;

  if (context.surface === "learn") {
    const cardId = normalizeId(context.cardId);
    const phase =
      context.phase === "question" || context.phase === "answer"
        ? context.phase
        : null;
    return cardId && phase ? { surface: "learn", cardId, phase } : null;
  }

  if (context.surface === "sources") {
    const sourceIds = normalizeSourceIds(context.sourceIds);
    return sourceIds.length > 0 && sourceIds.length <= JAMI_ASSISTANT_MAX_SOURCE_IDS
      ? { surface: "sources", sourceIds }
      : null;
  }

  if (context.surface === "notebook") {
    const notebookId = normalizeId(context.notebookId);
    const pageId = normalizeId(context.pageId);
    if (!notebookId || !pageId) return null;

    const snapshot =
      context.snapshot === undefined
        ? undefined
        : normalizeSnapshot(context.snapshot);
    if (context.snapshot !== undefined && !snapshot) return null;
    // Only its shape here; whether it belongs to this notebook's folder is the server's check.
    const actionId = normalizeOptionalText(context.actionId, MAX_ACTION_ID_LENGTH);

    return {
      surface: "notebook",
      notebookId,
      pageId,
      snapshot,
      typedText: normalizeOptionalText(
        context.typedText,
        JAMI_ASSISTANT_MAX_TYPED_TEXT_LENGTH
      ),
      questionPrompt: normalizeOptionalText(
        context.questionPrompt,
        JAMI_ASSISTANT_MAX_QUESTION_PROMPT_LENGTH
      ),
      hasInk: context.hasInk === true,
      imageCount:
        typeof context.imageCount === "number" &&
        Number.isFinite(context.imageCount)
          ? Math.max(0, Math.min(20, Math.round(context.imageCount)))
          : 0,
      ...(actionId ? { actionId } : {}),
    };
  }

  if (context.surface === "practice") {
    const sessionId = normalizeId(context.sessionId);
    const attemptId = normalizeId(context.attemptId);
    return sessionId && attemptId ? { surface: "practice", sessionId, attemptId } : null;
  }

  return null;
}

export function parseJamiAssistantRequest(
  value: unknown
): JamiAssistantRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  const message =
    typeof request.message === "string"
      ? request.message.trim().slice(0, JAMI_ASSISTANT_MAX_MESSAGE_LENGTH)
      : "";
  const context = normalizeContext(request.context);
  if (!message || !context || typeof request.useRelatedSources !== "boolean") {
    return null;
  }
  const attachments = normalizeTutorAttachments(request.attachments);

  return {
    message,
    history: normalizeJamiAssistantHistory(request.history),
    context,
    useRelatedSources: request.useRelatedSources,
    threadId: normalizeId(request.threadId) || undefined,
    contextLabel: normalizeOptionalText(request.contextLabel, 120),
    ...(attachments.length > 0
      ? {
          attachments,
          newAttachmentCount: Math.min(
            MAX_TUTOR_ATTACHMENTS_PER_MESSAGE,
            attachments.length,
            typeof request.newAttachmentCount === "number" && Number.isInteger(request.newAttachmentCount)
              ? Math.max(0, request.newAttachmentCount)
              : 0
          ),
        }
      : {}),
  };
}

