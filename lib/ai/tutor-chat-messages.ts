import {
  JAMI_ASSISTANT_MAX_HISTORY_MESSAGES,
  type AssistantIllustration,
  type JamiAssistantCitation,
  type JamiAssistantFollowUp,
  type JamiAssistantHistoryMessage,
  type JamiAssistantResponse,
  type JamiAssistantUsedContext,
} from "@/lib/ai/jami-assistant";
import type { JamiAssistantThread } from "@/lib/ai/jami-assistant-history";
import { splitAssistantAnswerAtDiagram } from "@/lib/ai/assistant-answer-layout";
import type { JamiAppScope, TutorAppActionProposal } from "@/lib/ai/jami-app-guide";
import type { TutorAttachment, TutorSourceSaveOffer } from "@/lib/ai/tutor-attachments";
import type { JamiAssistantSuggestedCard } from "@/lib/ai/tutor-card-suggestions";
import type { TutorAgentStepView } from "@/lib/ai/tutor-agent";
import type { TutorPracticeOffer } from "@/lib/ai/tutor-practice-offer";
import {
  TUTOR_STUDY_MATERIAL_KINDS,
  type TutorStudyMaterialKind,
  type TutorStudyMaterialRequest,
  type TutorStudyMaterialResult,
  type TutorStudyMaterialSetup,
} from "@/lib/ai/tutor-study-material";

/**
 * One turn of a Tutor chat as the drawer shows it.
 *
 * Mostly what was saved with the conversation, plus a few things that only
 * live for this sitting: the engine's advice, a suggestion to save a file,
 * and whether an answer was given just now.
 */
export type TutorChatMessage = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  used?: JamiAssistantUsedContext[];
  followUps?: JamiAssistantFollowUp[];
  citations?: JamiAssistantCitation[];
  suggestedCards?: JamiAssistantSuggestedCard[];
  /** Live advice from the engine; shown with this answer, never saved with the chat. */
  practiceOffer?: TutorPracticeOffer;
  nextStepOffer?: TutorPracticeOffer;
  illustrations?: AssistantIllustration[];
  canIllustrate?: boolean;
  studyMaterialRequest?: TutorStudyMaterialRequest;
  studyMaterialOffers?: TutorStudyMaterialKind[];
  studyMaterialResults?: Partial<Record<TutorStudyMaterialKind, TutorStudyMaterialResult>>;
  /** Tutor asked what to make first; the card under the answer is filled in here. */
  studyMaterialSetup?: TutorStudyMaterialSetup;
  /** Things Tutor offered to do, or was asked to do, in the app. */
  appActions?: TutorAppActionProposal[];
  appScope?: JamiAppScope;
  /** Answered in this sitting, so material Tutor agreed to is made straight away. */
  fresh?: boolean;
  /** Files the student sent with this message. */
  attachments?: TutorAttachment[];
  /** Its files are not on a saved message yet, because the answer failed; the next one carries them. */
  attachmentsUnsaved?: boolean;
  /** Tutor's suggestion to save an attached file as a source, shown only in this sitting. */
  sourceSaveOffer?: TutorSourceSaveOffer;
  /** What Jami looked up or worked out before answering (`tutor-agent.ts`). */
  agentSteps?: TutorAgentStepView[];
};

/**
 * A chip offered before the conversation starts. Most send a prompt, but a
 * surface can also offer an action that does something else entirely, such as
 * drafting flashcards from the source being discussed.
 */
export type JamiAssistantQuickAction =
  | string
  | {
      label: string;
      prompt: string;
    }
  | {
      label: string;
      run: () => void | Promise<void>;
    };

/** A bare string is a prompt that is its own label. */
export function normalizeTutorQuickActions(actions: readonly JamiAssistantQuickAction[]) {
  return actions.map((action) =>
    typeof action === "string" ? { label: action, prompt: action } : action
  );
}

/**
 * What Jami says while the student waits.
 *
 * Escalating by elapsed time rather than cycling at random, so a long wait
 * reads as progress instead of noise, and nothing claims to be nearly done
 * before it plausibly is. The last one lands well inside the 45s timeout.
 */
export const TUTOR_WAITING_LABELS: Array<{ text: string; after: number }> = [
  { text: "Jami is locking in", after: 0 },
  { text: "Cooking", after: 4_000 },
  { text: "Ok this one is actually hard", after: 9_000 },
  { text: "Reading it again, properly this time", after: 18_000 },
  { text: "Nearly there, promise", after: 28_000 },
];

const THREAD_PLACES: Record<JamiAssistantThread["surface"], string> = {
  learn: "on your flashcards",
  sources: "in your material",
  practice: "in practice",
  notebook: "in a notebook",
};

/** Where a saved chat began, in a few words: "in a notebook (Biology notes)". */
export function describeThreadPlace(thread: JamiAssistantThread) {
  return `${THREAD_PLACES[thread.surface]} (${thread.contextLabel})`;
}

export const STUDY_MATERIAL_OFFER_LABELS: Record<TutorStudyMaterialKind, string> = {
  flashcards: "Make flashcards",
  practice: "Practice questions",
};

/** The material an answer carries: asked for, started from an offer, or already made. */
export function studyMaterialKindsFor(
  message: TutorChatMessage,
  started: readonly TutorStudyMaterialKind[]
) {
  return TUTOR_STUDY_MATERIAL_KINDS.filter(
    (kind) =>
      message.studyMaterialRequest?.kind === kind ||
      started.includes(kind) ||
      Boolean(message.studyMaterialResults?.[kind])
  );
}

/** The chat so far as the route reads it: the most recent turns, the model's as "model". */
export function tutorRequestHistory(
  messages: readonly TutorChatMessage[]
): JamiAssistantHistoryMessage[] {
  return messages.slice(-JAMI_ASSISTANT_MAX_HISTORY_MESSAGES).map((historyMessage) => ({
    role: historyMessage.role === "assistant" ? ("model" as const) : ("user" as const),
    text: historyMessage.text,
  }));
}

/** The validated reply as a turn of this sitting, with everything it offers. */
export function tutorAnswerFromResponse(
  response: JamiAssistantResponse & { agentSteps?: TutorAgentStepView[] }
): TutorChatMessage {
  return {
    role: "assistant",
    text: response.reply,
    used: response.used,
    followUps: response.followUps,
    citations: response.citations,
    suggestedCards: response.suggestedCards,
    practiceOffer: response.practiceOffer,
    nextStepOffer: response.nextStepOffer,
    canIllustrate: response.canIllustrate,
    studyMaterialRequest: response.studyMaterialRequest,
    appActions: response.appActions,
    appScope: response.appScope,
    studyMaterialOffers: response.studyMaterialOffers,
    studyMaterialSetup: response.studyMaterialSetup,
    sourceSaveOffer: response.sourceSaveOffer,
    ...(response.agentSteps?.length ? { agentSteps: response.agentSteps } : {}),
    fresh: true,
  };
}

/**
 * The words an answer puts on a notebook page.
 *
 * An answer with an illustration shows the picture in place of its own
 * sketch, which has its own button; the page gets the words around it.
 */
export function tutorAnswerTextForPage(message: TutorChatMessage) {
  if (!message.illustrations?.length) return message.text;
  const layout = splitAssistantAnswerAtDiagram(message.text);
  return [layout.before, layout.after].filter(Boolean).join("\n\n");
}
