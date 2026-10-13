import type { ResolvedJamiAssistantContext } from "@/lib/ai/assistant-context.server";
import {
  getJamiAssistantResponseGuidance,
  invitesNotebookMarking,
  type JamiAssistantContext,
  type JamiAssistantResponseGuidance,
} from "@/lib/ai/jami-assistant";
import type { JamiAssistantSavedContext } from "@/lib/ai/jami-assistant-history";
import {
  availableTutorAppActions,
  jamiDestinations,
  type JamiAppScope,
  type JamiDestination,
  type TutorAppActionType,
} from "@/lib/ai/jami-app-guide";
import {
  detectTutorStudyMaterialRequest,
  isOpenTutorStudyMaterialRequest,
  type TutorStudyMaterialKind,
} from "@/lib/ai/tutor-study-material";
import { MARK_UPDATED_WORK_FOLLOW_UP } from "@/lib/workspace/notebook-assistant";

/**
 * What one Tutor turn may do, decided before the model is asked anything.
 *
 * Everything here is read from the student's request, the study context and
 * the engine's advice, never from the model: the model is only offered the
 * fields a turn allows, and its answer is read against the same plan.
 */

const WORKING_CHECK_PATTERN = /\bcheck (?:my|this|the) working\b/i;

/**
 * "Check my working" on a notebook page.
 *
 * Help, never assessment: it finds the first step that goes wrong, against an
 * independent working of the problem, and is never offered a marking -- so it
 * never becomes evidence. Read before anything else about the request, since
 * asking for a check often also says what to explain.
 */
export function requestsWorkingCheck(input: { message: string; context: JamiAssistantContext }) {
  return (
    input.context.surface === "notebook" &&
    Boolean(input.context.pageId) &&
    WORKING_CHECK_PATTERN.test(input.message)
  );
}
export type TutorTurnPlan = {
  /** How long and how deep the answer should be. */
  guidance: JamiAssistantResponseGuidance;
  /** Whether marked practice sets exist here at all. */
  practiceSetsAvailable: boolean;
  /** The study material the student's own words asked for, if any. */
  requestedStudyMaterial: TutorStudyMaterialKind | null;
  /** Asked for material with nothing to go on, so Tutor asks what to make first. */
  askStudyMaterialFirst: boolean;
  /** The study material Tutor may say it was asked to make. */
  studyMaterialKinds: TutorStudyMaterialKind[];
  /** Whether this turn may carry a marking at all. */
  markingInvited: boolean;
  /** "Check my working" on a notebook page: the first wrong step, found against an independent working. */
  workingCheck: boolean;
  /** Whether Tutor may set a quick check this turn. */
  checkInvited: boolean;
  /** Whether the engine has a next step Tutor may attach. */
  nextStepAvailable: boolean;
  /** Where this conversation sits in the app, the places Tutor can link to, and what it can do there. */
  app: {
    scope: JamiAppScope;
    destinations: JamiDestination[];
    actions: TutorAppActionType[];
  };
};

export function planTutorTurn(input: {
  message: string;
  context: JamiAssistantContext;
  savedContext: JamiAssistantSavedContext;
  /** No conversation yet: the request is all there is to go on. */
  firstTurn: boolean;
  practiceSetsAvailable: boolean;
  resolved: Pick<
    ResolvedJamiAssistantContext,
    "checkTarget" | "learningContext" | "nextStepOffer" | "folderIds" | "deckId"
  >;
}): TutorTurnPlan {
  const { resolved, practiceSetsAvailable } = input;
  const guidance = getJamiAssistantResponseGuidance({
    message: input.message,
    context: input.context,
  });
  const requestedStudyMaterial = detectTutorStudyMaterialRequest(input.message);
  /*
   * Asked for material with nothing to go on -- no topic, nothing pointed at,
   * no conversation yet -- Tutor asks what to make before making anything.
   * Mid-conversation the conversation is the topic, so it makes them at once.
   */
  const askStudyMaterialFirst =
    requestedStudyMaterial !== null &&
    (requestedStudyMaterial !== "practice" || practiceSetsAvailable) &&
    input.firstTurn &&
    isOpenTutorStudyMaterialRequest(input.message);
  /*
   * Whether this turn may carry a marking at all.
   *
   * Decided here, before the model is asked anything, so an ordinary tutoring
   * turn is never even offered the field. A student asking "can you check my
   * working" is asking for help, and help must not become assessed evidence.
   */
  const workingCheck = requestsWorkingCheck(input);
  const markingInvited =
    !workingCheck &&
    invitesNotebookMarking({
      message: input.message,
      context: input.context,
    });
  /*
   * Flashcards and practice questions asked for in a chat are made in one place:
   * the study-material panel under the answer, which drafts them from the
   * conversation for the student to review -- flashcards into their review
   * queue, questions as a marked practice set they can sit. Tutor used to also
   * write a few inline, which meant two ways to ask for the same thing; now it
   * only says what it is making and names the focus. Older answers that carry
   * inline suggestions still show them.
   */
  const studyMaterialKinds: TutorStudyMaterialKind[] = practiceSetsAvailable ? ["flashcards", "practice"] : ["flashcards"];
  /**
   * Whether Tutor may set a quick check this turn: only where the server has
   * somewhere to count it, and never while marking a page, which is already
   * the assessment the student asked for.
   */
  const checkInvited = Boolean(resolved.checkTarget) && !markingInvited;
  const nextStepAvailable = Boolean(resolved.learningContext && resolved.nextStepOffer);
  /**
   * Where this conversation sits in the app, for the places Tutor can link to
   * and the things it can do there: a notebook's pages, a folder's notebooks.
   */
  const scope: JamiAppScope = {
    ...(resolved.folderIds?.length === 1 ? { folderId: resolved.folderIds[0] } : {}),
    ...(resolved.deckId ? { deckId: resolved.deckId } : {}),
    ...(input.savedContext.surface === "notebook" ? { notebookId: input.savedContext.notebookId } : {}),
  };
  /*
   * Checking working is help and never a mark. Once the student has fixed the
   * step it found, marking the corrected page is the assessment that counts,
   * so it is offered as the next thing to ask for -- and only asked for.
   */
  const plannedGuidance = workingCheck
    ? { ...guidance, followUps: [...guidance.followUps, MARK_UPDATED_WORK_FOLLOW_UP] }
    : guidance;
  return {
    guidance: plannedGuidance,
    practiceSetsAvailable,
    requestedStudyMaterial,
    askStudyMaterialFirst,
    studyMaterialKinds,
    markingInvited,
    workingCheck,
    checkInvited,
    nextStepAvailable,
    app: {
      scope,
      destinations: jamiDestinations(scope),
      actions: availableTutorAppActions({ context: input.context, scope }),
    },
  };
}
