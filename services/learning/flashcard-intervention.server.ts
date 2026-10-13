import "server-only";

import { parseGeneratedCardDrafts, type GeneratedCardDraft } from "@/lib/ai/card-generation";
import {
  buildFlashcardRequest,
  flashcardGenerationPrompt,
  readFlashcardDrafts,
  type FlashcardDraftRejection,
  type FlashcardInterventionRequest,
  type FlashcardRequestRejection,
} from "@/lib/learning/interventions/flashcard-request";
import { createLogger } from "@/lib/observability/logger";
import { generateAiText } from "@/lib/ai/provider-router";
import { readOwnCardFronts } from "@/services/study/own-cards.server";

const log = createLogger({ route: "learning.flashcard_intervention" });

/**
 * Writing cards for a concept the student has none for.
 *
 * Returns a draft and nothing else. Nothing reaches the student's deck from
 * here: they read what Jami wrote, change or discard it, and the writing
 * happens on their confirmation through the ordinary card-creation path. The
 * ordering is deliberate -- these are the student's own revision materials,
 * and material they did not agree to is worse than none.
 *
 * The intervention is *not* completed by generating. A draft nobody accepted
 * helped nobody, and a deck full of cards nobody has answered says nothing
 * about what anyone knows. The intervention closes when reviews arrive.
 */

const GENERATION_TIMEOUT_MS = 30_000;
/** Existing cards read to send as exclusions; a concept with more is well covered anyway. */
export const EXCLUSION_CARD_SCAN_LIMIT = 60;

export type FlashcardInterventionFailure =
  | FlashcardRequestRejection
  | FlashcardDraftRejection
  | "generation_failed";

export type FlashcardInterventionResult =
  | {
      ok: true;
      /** For the student to read, edit and confirm. Nothing is written yet. */
      drafts: GeneratedCardDraft[];
      request: FlashcardInterventionRequest;
      droppedDuplicates: number;
    }
  | { ok: false; reason: FlashcardInterventionFailure };

/**
 * Fronts the student already has on this concept.
 *
 * Read from their own cards, matched on the concept's own key, so the model is
 * told what exists rather than guessing. Failure costs the exclusions and not
 * the generation: cards written without them may repeat something, which the
 * student will see in the draft.
 */
async function loadExistingFronts(input: {
  uid: string;
  deckIds: readonly string[];
  conceptId: string;
}) {
  if (input.deckIds.length === 0) return [];
  try {
    return await readOwnCardFronts(input.uid, { topicId: input.conceptId }, EXCLUSION_CARD_SCAN_LIMIT);
  } catch (error) {
    log.warn("exclusions.unavailable", { error });
    return [];
  }
}

/**
 * Generate a draft set of cards for one concept.
 *
 * Every refusal is named rather than folded into a generic failure, because
 * they mean different things to the caller: a concept the catalogue does not
 * hold is a bug upstream, a generation that returned nothing is a model
 * problem, and every card being a duplicate means the student is better
 * covered than the coverage signal thought.
 */
export async function generateInterventionFlashcards(input: {
  uid: string;
  conceptId: string;
  conceptLabel: string;
  specificationId: string;
  interventionId: string;
  deckIds?: readonly string[];
  requestedCount?: number;
}): Promise<FlashcardInterventionResult> {
  const prepared = buildFlashcardRequest({
    conceptId: input.conceptId,
    conceptLabel: input.conceptLabel,
    specificationId: input.specificationId,
    interventionId: input.interventionId,
    ...(input.requestedCount !== undefined ? { requestedCount: input.requestedCount } : {}),
  });
  if (!prepared.ok) {
    log.warn("request.refused", { reason: prepared.reason });
    return { ok: false, reason: prepared.reason };
  }

  const existingFronts = await loadExistingFronts({
    uid: input.uid,
    deckIds: input.deckIds ?? [],
    conceptId: prepared.request.conceptId,
  });
  const request: FlashcardInterventionRequest = { ...prepared.request, existingFronts };

  let raw = "";
  try {
    const result = await generateAiText({
      role: "worker",
      routeReason: "routine",
      request: {
        systemInstruction:
          "You write flashcards for a student revising to a published course specification. " +
          "Answer with a JSON array of objects, each with a `front` and a `back`, and nothing else.",
        contents: [{ role: "user", parts: [{ text: flashcardGenerationPrompt(request) }] }],
      },
      timeoutMs: GENERATION_TIMEOUT_MS,
      generationConfig: { responseMimeType: "application/json" },
    });
    raw = typeof result === "string" ? result : (result as { text?: string }).text ?? "";
  } catch (error) {
    // The intervention stays open. Jami asked for cards and produced none.
    log.warn("generation.failed", { error });
    return { ok: false, reason: "generation_failed" };
  }

  const read = readFlashcardDrafts(parseGeneratedCardDrafts(raw), request);
  if (!read.ok) {
    log.warn("drafts.rejected", { reason: read.reason });
    return { ok: false, reason: read.reason };
  }

  log.info("drafts.ready", {
    cards: read.drafts.length,
    droppedDuplicates: read.droppedDuplicates,
  });
  return {
    ok: true,
    drafts: read.drafts,
    request,
    droppedDuplicates: read.droppedDuplicates,
  };
}

/**
 * What the confirmation step writes, once the student has agreed to it.
 *
 * Kept here beside the generator so the two halves of the contract -- what was
 * asked for and what is stored -- cannot drift. The caller passes this to the
 * ordinary card-creation path; nothing bypasses it.
 */
export function flashcardsToCreate(
  drafts: readonly GeneratedCardDraft[],
  request: Pick<FlashcardInterventionRequest, "conceptId" | "interventionId">
) {
  return drafts.map((draft) => ({
    front: draft.front,
    back: draft.back,
    // The canonical concept, attached at creation rather than inferred later.
    topicIds: [request.conceptId],
    createdByInterventionId: request.interventionId,
  }));
}
