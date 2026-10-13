import "server-only";

import { randomUUID } from "node:crypto";
import { featureFlags } from "@/lib/app/feature-flags";
import { buildTutorPracticeOffer, type TutorPracticeOffer } from "@/lib/ai/tutor-practice-offer";
import { describeStudyAction } from "@/lib/dashboard/today-plan";
import { buildStudyActions } from "@/lib/learning/actions/study-actions";
import {
  practiceActionForMaterial,
  nextStudyAction,
} from "@/lib/learning/actions/practice-for-material";
import type { TutorCheckScope } from "@/lib/learning/events/tutor-check";
import { serializeLearnerProfileForTutor } from "@/lib/learning/serialize/tutor-context";
import { learnerProfileTelemetry } from "@/lib/learning/telemetry";
import { createLogger } from "@/lib/observability/logger";
import { loadLearnerProfileWithMaterial } from "@/services/learning/learner-profile.server";
import { loadRecentResultText } from "@/services/learning/recent-result-text.server";
import { loadStudyActionHistory } from "@/services/learning/study-action-history.server";
import {
  loadStudyFolderForActions,
  studyActionContextFor,
} from "@/services/learning/study-actions.server";

/**
 * What the Learning Engine believes about the student, loaded for Tutor: the
 * profile written as a prompt block, and the engine's own offers for the
 * material in front of them.
 */

/**
 * How long Tutor waits for the learner profile before answering without it.
 * The profile improves an answer; it must never be the reason one is slow.
 */
const LEARNER_PROFILE_BUDGET_MS = 2_500;

const log = createLogger({ module: "ai.assistant.context" });

/** A lookup that gives up after `ms` with `fallback`, and never throws. */
async function withinBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch (error) {
    log.warn("recent_results.text_unavailable", { error });
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The one folder, or failing that the deck, that Tutor's learning context is
 * scoped to -- and so where a quick check asked about this material counts.
 */
export function tutorLearningScope(
  folderIds: readonly string[],
  deckId: string | undefined
): TutorCheckScope | null {
  const unique = Array.from(new Set(folderIds.filter(Boolean)));
  if (unique.length === 1 && unique[0]) return { folderId: unique[0] };
  return deckId ? { deckId } : null;
}

/**
 * What the Learning Engine currently believes about the student, for the
 * material in front of them, written for Tutor.
 *
 * Scoped like folder instructions: one folder when the material sits in
 * exactly one, otherwise the card's own deck, otherwise nothing -- a profile
 * spanning two folders would set one subject's results against another's. All
 * of the learning logic lives in `lib/learning`; this only picks the scope and
 * keeps Tutor's promise that an enrichment never costs an answer. A failure or
 * a slow load drops the profile, and the request carries on exactly as it did
 * before the profile existed.
 */
export async function loadTutorLearningContext(input: {
  uid: string;
  folderIds: readonly string[];
  deckId?: string;
  /** Where the material in front of the student sits in the engine's concept space. */
  materialKeys: readonly string[];
}): Promise<
  | { learningContext: string; practiceOffer?: TutorPracticeOffer; nextStepOffer?: TutorPracticeOffer }
  | undefined
> {
  if (!featureFlags.enableLearnerProfile) return undefined;
  const scope = tutorLearningScope(input.folderIds, input.deckId);
  if (!scope) return undefined;

  const scopeKind = "folderId" in scope ? "folder" : "deck";
  const startedAt = Date.now();
  const loading = loadLearnerProfileWithMaterial({ uid: input.uid, ...scope });
  // Still settles after a timeout; without this its failure would go unhandled.
  loading.catch(() => undefined);
  /*
   * What turning the profile into actions needs, read beside it rather than
   * after it: the folder, for whether its course can be practised, and the
   * student's history with this advice, so resting advice stays at rest. Both
   * are small, and either failing costs the offers and nothing else. Read even
   * with no material open, for the folder's next step.
   */
  const actionFolderId = "folderId" in scope ? scope.folderId : undefined;
  const actionInputs =
    actionFolderId && featureFlags.enableStudyActions
      ? Promise.all([
          loadStudyFolderForActions(input.uid, actionFolderId),
          loadStudyActionHistory({ uid: input.uid }),
        ]).catch((error: unknown) => {
          log.warn("practice_offer.unavailable", { error });
          return null;
        })
      : Promise.resolve(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      Promise.all([loading, actionInputs]),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), LEARNER_PROFILE_BUDGET_MS);
      }),
    ]);
    const latencyMs = Date.now() - startedAt;
    if (settled === "timeout") {
      log.warn("learner_profile.timed_out", {
        consumer: "tutor",
        scope: scopeKind,
        budgetMs: LEARNER_PROFILE_BUDGET_MS,
      });
      return undefined;
    }
    const [loaded, inputs] = settled;
    if (!loaded) {
      log.info("learner_profile.completed", {
        consumer: "tutor",
        scope: scopeKind,
        outcome: "no_profile",
        latencyMs,
      });
      return undefined;
    }
    const { profile, notebookMaterial } = loaded;
    const [folder, history] = inputs ?? [null, null];
    const actions = folder
      ? buildStudyActions(
          profile,
          { ...studyActionContextFor(folder), notebookMaterial },
          history?.history
        )
      : [];
    const practiceAction = practiceActionForMaterial(actions, input.materialKeys);
    const practiceOffer = practiceAction
      ? buildTutorPracticeOffer(practiceAction, describeStudyAction(practiceAction))
      : undefined;
    /*
     * The folder's next step, for "what should I do next?". Left out when it is
     * the practice already offered: one action is never offered twice.
     */
    const nextAction = nextStudyAction(actions);
    const nextStepOffer =
      nextAction && nextAction.id !== practiceOffer?.actionId
        ? buildTutorPracticeOffer(nextAction, describeStudyAction(nextAction))
        : undefined;
    /*
     * The words of the cards and questions in the recent results, so Tutor can
     * name the one the student got wrong. Within what is left of the budget;
     * out of time, the results are still listed, by kind and topic.
     */
    const recentItemText = await withinBudget(
      loadRecentResultText(input.uid, profile.recentResults ?? []),
      Math.max(0, LEARNER_PROFILE_BUDGET_MS - (Date.now() - startedAt)),
      new Map<string, string>()
    );
    const learningContext = serializeLearnerProfileForTutor(profile, {
      boundaryToken: randomUUID(),
      recentItemText,
      focusKeys: input.materialKeys,
      ...(practiceAction && practiceOffer
        ? {
            practiceFocus: {
              label: practiceAction.target.label,
              reason: practiceAction.reason,
              ...(practiceAction.intervention ? { because: practiceAction.intervention.because } : {}),
            },
          }
        : {}),
      ...(nextStepOffer
        ? { nextStep: { title: nextStepOffer.title, description: nextStepOffer.description } }
        : {}),
    });
    log.info("learner_profile.completed", {
      consumer: "tutor",
      outcome: learningContext ? "included" : "insufficient_evidence",
      latencyMs,
      practiceOffered: Boolean(learningContext && practiceOffer),
      nextStepAvailable: Boolean(learningContext && nextStepOffer),
      // Counts only: how many items were listed, and how many could be named.
      recentResults: profile.recentResults?.length ?? 0,
      recentResultsNamed: recentItemText.size,
      ...learnerProfileTelemetry(profile),
    });
    if (!learningContext) return undefined;
    // Offered only alongside the profile that tells the model it is there.
    return {
      learningContext,
      ...(practiceOffer ? { practiceOffer } : {}),
      ...(nextStepOffer ? { nextStepOffer } : {}),
    };
  } catch (error) {
    log.warn("learner_profile.failed", {
      consumer: "tutor",
      scope: scopeKind,
      latencyMs: Date.now() - startedAt,
      error,
    });
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
