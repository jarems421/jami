import type { GeminiResearchResult } from "@/lib/ai/gemini";
import { placeTutorGraphs } from "@/lib/ai/assistant-graph";
import {
  shouldOfferTutorIllustration,
  type JamiAssistantContext,
  type JamiAssistantSourceFailure,
  type JamiAssistantUsedContext,
  type ParsedJamiAssistantModelAnswer,
} from "@/lib/ai/jami-assistant";
import { readTutorAppActions, resolveTutorAppLinks } from "@/lib/ai/jami-app-guide";
import { cleanAiResponseText } from "@/lib/ai/response-text";
import { readTutorSourceSaveOffer, type TutorAttachment } from "@/lib/ai/tutor-attachments";
import { placeTutorDiagrams } from "@/lib/ai/tutor-diagram";
import type { TutorPracticeOffer } from "@/lib/ai/tutor-practice-offer";
import {
  getTutorStudyMaterialOffers,
  resolveTutorStudyMaterialRequest,
} from "@/lib/ai/tutor-study-material";
import { resolveTutorSuggestions } from "@/lib/ai/tutor-suggestion";
import type { TutorTurnPlan } from "@/lib/ai/tutor-turn-plan";
import type { TutorTurnSource } from "@/lib/ai/tutor-turn-prompt";
import { notebookMarkingFollowUp } from "@/lib/workspace/notebook-assistant";

/** Everything a finished answer is read against, apart from the answer itself. */
export type TutorAnswerPackageInput = {
  message: string;
  context: JamiAssistantContext;
  plan: TutorTurnPlan;
  /** What the student is looking at, as the context service named it. */
  current: { id: string; label: string };
  sources: readonly TutorTurnSource[];
  research: GeminiResearchResult;
  sourceFailures: JamiAssistantSourceFailure[];
  /** The engine's live advice, attached as the plan allows. */
  practiceOffer?: TutorPracticeOffer;
  nextStepOffer?: TutorPracticeOffer;
  /** The chat's attached files, whether any was read, and the student's folders by reference. */
  attachments: {
    all: readonly TutorAttachment[];
    anyReadable: boolean;
    folderIds: readonly string[];
  };
};

/**
 * Builds the receipt that accompanies a finished answer. Runs once the whole
 * structured object has arrived, so source references are still validated
 * before the client is told which sources were used.
 */
export function buildTutorAnswerPackage(
  parsedAnswer: ParsedJamiAssistantModelAnswer,
  input: TutorAnswerPackageInput
) {
  const { plan, research } = input;
  const sourcesByRef = new Map(
    input.sources.map((result) => [result.sourceRef, result.source] as const)
  );
  const used: JamiAssistantUsedContext[] = [];
  if (parsedAnswer.usedCurrentContext) {
    used.push({
      kind: "current-context",
      id: input.current.id,
      label: input.current.label,
    });
  }
  parsedAnswer.sourceRefs.forEach((sourceRef) => {
    const source = sourcesByRef.get(sourceRef);
    if (source) {
      used.push({ kind: "source", id: source.id, label: source.title });
    }
  });
  if (parsedAnswer.usedWebResearch && research.ok) {
    used.push({ kind: "web", label: "verified web sources" });
  }
  if (parsedAnswer.usedGeneralKnowledge || used.length === 0) {
    used.push({ kind: "general-knowledge", label: "general knowledge" });
  }

  // Graphs and diagrams go in after cleaning, so a reply that is only a figure
  // is not taken for a wrapped code block and unwrapped into raw JSON.
  // In-app links resolved from their place keys, and any that point nowhere dropped.
  const reply = placeTutorDiagrams(
    placeTutorGraphs(
      resolveTutorAppLinks(cleanAiResponseText(parsedAnswer.answer), plan.app.destinations),
      parsedAnswer.graphs
    ),
    parsedAnswer.diagrams
  );
  if (!reply) return null;
  const appActions = readTutorAppActions(parsedAnswer.appActions, {
    available: plan.app.actions,
    destinations: plan.app.destinations,
    message: input.message,
  });

  const studyMaterialSetup =
    plan.askStudyMaterialFirst && plan.requestedStudyMaterial
      ? {
          kind: plan.requestedStudyMaterial,
          kinds: plan.studyMaterialKinds,
          topics: parsedAnswer.studyMaterialTopics,
        }
      : null;
  const studyMaterialRequest = studyMaterialSetup ? null : resolveTutorStudyMaterialRequest({
    detected: plan.requestedStudyMaterial,
    modelKind: parsedAnswer.studyMaterial,
    modelFocus: parsedAnswer.studyMaterialFocus,
    message: input.message,
    practiceAvailable: plan.practiceSetsAvailable,
  });
  const teachingOffers = getTutorStudyMaterialOffers({
    message: input.message,
    answer: reply,
    context: input.context,
    practiceAvailable: plan.practiceSetsAvailable,
    requested: studyMaterialRequest?.kind ?? null,
  });
  /*
   * What this answer may offer to make: after teaching worth revising from,
   * and after any answer that drew on the student's own material in Sources
   * or a notebook, except a marking. Whether it actually does is up to
   * Tutor's suggestions, below.
   */
  const drewOnMaterial =
    !plan.markingInvited &&
    parsedAnswer.sourceRefs.length > 0 &&
    (input.context.surface === "sources" || input.context.surface === "notebook");
  const allowedMaterial =
    teachingOffers.length > 0 || !drewOnMaterial
      ? teachingOffers
      : plan.studyMaterialKinds.filter((kind) => kind !== studyMaterialRequest?.kind);
  const suggested = resolveTutorSuggestions({
    suggestions: parsedAnswer.suggestions,
    depth: plan.guidance.depth,
    allowedMaterial,
  });
  // Asking first, the card is the offer: nothing else to make sits beside it.
  const materialOffers = studyMaterialSetup ? [] : suggested.studyMaterialOffers;
  // After marks lost on a page, the one next step that fits the kind of mistake.
  const markingFollowUp = plan.markingInvited ? notebookMarkingFollowUp(parsedAnswer.marking) : undefined;
  const followUps = [
    ...plan.guidance.followUps,
    ...(markingFollowUp ? [markingFollowUp] : []),
    ...suggested.followUps,
  ];
  const sourceSaveOffer =
    input.attachments.anyReadable
      ? readTutorSourceSaveOffer(
          parsedAnswer.saveSource,
          input.attachments.all,
          input.attachments.folderIds
        )
      : null;

  return {
    reply,
    used,
    ...(followUps.length > 0 ? { followUps } : {}),
    ...(input.practiceOffer ? { practiceOffer: input.practiceOffer } : {}),
    // The engine's action, attached only when the model read the turn as "what next?".
    ...(plan.nextStepAvailable && parsedAnswer.offerNextStep && input.nextStepOffer
      ? { nextStepOffer: input.nextStepOffer }
      : {}),
    ...(input.sourceFailures.length > 0 ? { sourceFailures: input.sourceFailures } : {}),
    ...(parsedAnswer.usedWebResearch && research.ok
      ? { citations: research.citations.slice(0, 8) }
      : {}),
    ...(shouldOfferTutorIllustration({
      message: input.message,
      answer: reply,
      context: input.context,
    })
      ? { canIllustrate: true }
      : {}),
    ...(studyMaterialRequest ? { studyMaterialRequest } : {}),
    ...(materialOffers.length > 0 ? { studyMaterialOffers: materialOffers } : {}),
    ...(studyMaterialSetup ? { studyMaterialSetup } : {}),
    ...(parsedAnswer.studyMaterialFocus ? { studyMaterialFocus: parsedAnswer.studyMaterialFocus } : {}),
    ...(sourceSaveOffer ? { sourceSaveOffer } : {}),
    ...(appActions.length > 0 ? { appActions, appScope: plan.app.scope } : {}),
  };
}

/** A finished answer, ready to save and send. */
export type TutorAnswerPackage = NonNullable<ReturnType<typeof buildTutorAnswerPackage>>;
