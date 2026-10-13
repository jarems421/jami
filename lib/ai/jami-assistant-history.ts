import type {
  AssistantIllustration,
  JamiAssistantCitation,
  JamiAssistantContext,
  JamiAssistantFollowUp,
  JamiAssistantUsedContext,
} from "@/lib/ai/jami-assistant";
import {
  normalizeAssistantId as normalizeId,
  normalizeAssistantText as normalizeText,
  normalizeAssistantCitations,
  normalizeFollowUps,
  normalizeUsedContext,
} from "@/lib/ai/jami-assistant-normalize";
import { normalizeAssistantIllustrations } from "@/lib/ai/jami-assistant";
import { normalizeTutorAgentSteps, type TutorAgentStepView } from "@/lib/ai/tutor-agent";
import {
  MAX_TUTOR_ATTACHMENTS_PER_MESSAGE,
  normalizeTutorAttachments,
  type TutorAttachment,
} from "@/lib/ai/tutor-attachments";
import {
  normalizeTutorStudyMaterialOffers,
  normalizeTutorStudyMaterialRequest,
  normalizeTutorStudyMaterialResults,
  normalizeTutorStudyMaterialSetup,
  type TutorStudyMaterialKind,
  type TutorStudyMaterialRequest,
  type TutorStudyMaterialResult,
  type TutorStudyMaterialSetup,
} from "@/lib/ai/tutor-study-material";
import {
  jamiDestinations,
  normalizeJamiAppScope,
  normalizeTutorAppActions,
  type JamiAppScope,
  type TutorAppActionProposal,
} from "@/lib/ai/jami-app-guide";
import {
  normalizeSuggestedCards,
  type JamiAssistantSuggestedCard,
} from "@/lib/ai/tutor-card-suggestions";

export const JAMI_ASSISTANT_MAX_SAVED_THREADS = 50;
export const JAMI_ASSISTANT_MAX_THREAD_TITLE_LENGTH = 80;
export const JAMI_ASSISTANT_MAX_CONTEXT_LABEL_LENGTH = 120;
export const JAMI_ASSISTANT_MAX_SAVED_MESSAGE_LENGTH = 32_000;

export type JamiAssistantSavedContext =
  | {
      surface: "learn";
      cardId: string;
    }
  | {
      surface: "sources";
      sourceIds: string[];
    }
  | {
      surface: "notebook";
      notebookId: string;
      pageId: string;
    }
  | {
      surface: "practice";
      sessionId: string;
      attemptId: string;
    };

export type JamiAssistantThread = {
  id: string;
  title: string;
  surface: JamiAssistantSavedContext["surface"];
  contextKey: string;
  contextLabel: string;
  context: JamiAssistantSavedContext;
  lastMessagePreview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastAssistantMessageId?: string;
};

export type JamiAssistantStoredMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  used?: JamiAssistantUsedContext[];
  followUps?: JamiAssistantFollowUp[];
  citations?: JamiAssistantCitation[];
  suggestedCards?: JamiAssistantSuggestedCard[];
  illustrations?: AssistantIllustration[];
  canIllustrate?: boolean;
  studyMaterialRequest?: TutorStudyMaterialRequest;
  studyMaterialOffers?: TutorStudyMaterialKind[];
  studyMaterialSetup?: TutorStudyMaterialSetup;
  studyMaterialResults?: Partial<Record<TutorStudyMaterialKind, TutorStudyMaterialResult>>;
  /** Files the student sent with this message. */
  attachments?: TutorAttachment[];
  appActions?: TutorAppActionProposal[];
  appScope?: JamiAppScope;
  /** What Jami looked up or worked out before answering. */
  agentSteps?: TutorAgentStepView[];
  createdAt: number;
};

function normalizeStringArray(value: unknown, maxItems: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => normalizeId(item)).filter(Boolean))
  ).slice(0, maxItems);
}

function normalizeSavedContext(value: unknown): JamiAssistantSavedContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Record<string, unknown>;
  if (context.surface === "learn") {
    const cardId = normalizeId(context.cardId);
    return cardId ? { surface: "learn", cardId } : null;
  }
  if (context.surface === "sources") {
    const sourceIds = normalizeStringArray(context.sourceIds, 15).sort();
    return sourceIds.length > 0 ? { surface: "sources", sourceIds } : null;
  }
  if (context.surface === "notebook") {
    const notebookId = normalizeId(context.notebookId);
    const pageId = normalizeId(context.pageId);
    return notebookId && pageId
      ? { surface: "notebook", notebookId, pageId }
      : null;
  }
  if (context.surface === "practice") {
    const sessionId = normalizeId(context.sessionId);
    const attemptId = normalizeId(context.attemptId);
    return sessionId && attemptId ? { surface: "practice", sessionId, attemptId } : null;
  }
  return null;
}

export function getJamiAssistantSavedContext(
  context: JamiAssistantContext
): JamiAssistantSavedContext {
  if (context.surface === "learn") {
    return { surface: "learn", cardId: context.cardId };
  }
  if (context.surface === "sources") {
    return { surface: "sources", sourceIds: [...context.sourceIds].sort() };
  }
  if (context.surface === "practice") {
    return { surface: "practice", sessionId: context.sessionId, attemptId: context.attemptId };
  }
  return {
    surface: "notebook",
    notebookId: context.notebookId,
    pageId: context.pageId,
  };
}

/**
 * What a saved chat belongs to, and therefore where it can be continued.
 *
 * A notebook, not a page. Working a problem across a page break is the ordinary
 * notebook workflow, and keying on the page meant turning to page 2 severed the
 * conversation about the thing you were still in the middle of. Nothing is lost
 * by widening it: the current page is rebuilt and re-sent on every turn, and
 * the system instruction already says the current page outranks anything
 * earlier in the conversation.
 *
 * Flashcards stay per card. Two cards are genuinely unrelated, review moves
 * quickly, and it is the one surface where an answer is deliberately withheld
 * from Jami -- so a thread that could span cards is worth avoiding.
 *
 * Sources key on the selected source rather than the set. Keying on the set
 * meant adding one source to a comparison invalidated the thread, for no
 * benefit the student could see.
 */
export function getJamiAssistantContextKey(
  context: JamiAssistantSavedContext | JamiAssistantContext
) {
  if (context.surface === "learn") return `learn:${context.cardId}`;
  if (context.surface === "sources") {
    return `sources:${[...context.sourceIds].sort()[0] ?? ""}`;
  }
  if (context.surface === "practice") return `practice:${context.sessionId}:${context.attemptId}`;
  return `notebook:${context.notebookId}`;
}

/**
 * Keys this context was stored under before, so old chats still open.
 *
 * A thread records the key in force when it was created, and a thread whose
 * stored key no longer matches is dropped from history entirely. Narrowing or
 * widening the formula without this would make every existing notebook and
 * multi-source chat silently disappear.
 */
export function getLegacyJamiAssistantContextKeys(
  context: JamiAssistantSavedContext | JamiAssistantContext
): string[] {
  if (context.surface === "notebook") {
    return [`notebook:${context.notebookId}:page:${context.pageId}`];
  }
  if (context.surface === "sources") {
    return [`sources:${[...context.sourceIds].sort().join(",")}`];
  }
  return [];
}

export function createJamiAssistantThreadTitle(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "New Jami chat";
  if (normalized.length <= JAMI_ASSISTANT_MAX_THREAD_TITLE_LENGTH) {
    return normalized;
  }
  return `${normalized
    .slice(0, JAMI_ASSISTANT_MAX_THREAD_TITLE_LENGTH - 3)
    .trimEnd()}...`;
}

export function mapJamiAssistantThread(
  id: string,
  data: Record<string, unknown>
): JamiAssistantThread | null {
  const context = normalizeSavedContext(data.context);
  const contextKey = normalizeText(data.contextKey, 520);
  if (!context || !contextKey) return null;
  const canonicalContextKey = getJamiAssistantContextKey(context);
  // Accept the key this thread was actually written under, then report the
  // current one, so a chat saved before the scope widened keeps working.
  if (
    contextKey !== canonicalContextKey &&
    !getLegacyJamiAssistantContextKeys(context).includes(contextKey)
  ) {
    return null;
  }
  return {
    id,
    title:
      normalizeText(data.title, JAMI_ASSISTANT_MAX_THREAD_TITLE_LENGTH) ||
      "Jami chat",
    surface: context.surface,
    contextKey: canonicalContextKey,
    contextLabel:
      normalizeText(data.contextLabel, JAMI_ASSISTANT_MAX_CONTEXT_LABEL_LENGTH) ||
      "Study context",
    context,
    lastMessagePreview: normalizeText(data.lastMessagePreview, 180),
    messageCount:
      typeof data.messageCount === "number" && Number.isFinite(data.messageCount)
        ? Math.max(0, Math.round(data.messageCount))
        : 0,
    createdAt:
      typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
        ? data.createdAt
        : 0,
    updatedAt:
      typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
        ? data.updatedAt
        : 0,
    lastAssistantMessageId: normalizeId(data.lastAssistantMessageId) || undefined,
  };
}

export function mapJamiAssistantStoredMessage(
  id: string,
  data: Record<string, unknown>
): JamiAssistantStoredMessage | null {
  const threadId = normalizeId(data.threadId);
  const role =
    data.role === "user" || data.role === "assistant" ? data.role : null;
  const text = normalizeText(data.text, JAMI_ASSISTANT_MAX_SAVED_MESSAGE_LENGTH);
  if (!threadId || !role || !text) return null;
  const used = normalizeUsedContext(data.used, { maxItems: 8 });
  const followUps = normalizeFollowUps(data.followUps);
  const citations = normalizeAssistantCitations(data.citations);
  const suggestedCards = normalizeSuggestedCards(data.suggestedCards);
  const illustrations = normalizeAssistantIllustrations(data.illustrations);
  const studyMaterialRequest = normalizeTutorStudyMaterialRequest(data.studyMaterialRequest);
  const studyMaterialOffers = normalizeTutorStudyMaterialOffers(data.studyMaterialOffers);
  const studyMaterialResults = normalizeTutorStudyMaterialResults(data.studyMaterialResults);
  const studyMaterialSetup = normalizeTutorStudyMaterialSetup(data.studyMaterialSetup);
  const attachments =
    role === "user"
      ? normalizeTutorAttachments(data.attachments, { limit: MAX_TUTOR_ATTACHMENTS_PER_MESSAGE })
      : [];
  const appScope = normalizeJamiAppScope(data.appScope);
  const appActions = normalizeTutorAppActions(data.appActions, jamiDestinations(appScope));
  const agentSteps = role === "assistant" ? normalizeTutorAgentSteps(data.agentSteps) : [];
  return {
    id,
    threadId,
    role,
    text,
    ...(used.length > 0 ? { used } : {}),
    ...(followUps.length > 0 ? { followUps } : {}),
    ...(citations.length > 0 ? { citations } : {}),
    ...(suggestedCards.length > 0 ? { suggestedCards } : {}),
    ...(illustrations.length > 0 ? { illustrations } : {}),
    ...(data.canIllustrate === true ? { canIllustrate: true } : {}),
    ...(studyMaterialRequest ? { studyMaterialRequest } : {}),
    ...(studyMaterialOffers.length > 0 ? { studyMaterialOffers } : {}),
    ...(Object.keys(studyMaterialResults).length > 0 ? { studyMaterialResults } : {}),
    ...(studyMaterialSetup ? { studyMaterialSetup } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(appActions.length > 0 ? { appActions, appScope } : {}),
    ...(agentSteps.length > 0 ? { agentSteps } : {}),
    createdAt:
      typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
        ? data.createdAt
        : 0,
  };
}
