import type { Card } from "@/lib/study/cards";
import {
  buildDeterministicExercise,
  getModeEligibility,
  isAwaitingPreparation,
  resolveExerciseMode,
  type ModeResolutionContext,
} from "@/lib/study/mode-eligibility";
import { canRestoreStudyExercise, restoreStudyExercise } from "@/lib/study/restored-exercise";
import type { PersistedStudyExercise } from "@/lib/study/session";
import {
  getCardContentHash,
  type ResolvedExercise,
  type StudyMode,
  type StudyModePolicy,
} from "@/lib/study/study-modes";

/**
 * Which exercise a card is being asked as, and why that answer is sticky.
 *
 * The question a student is looking at must not change under them. Assets
 * arriving late, a re-render, a mode-policy read: none of those may swap a
 * gap-fill for a multiple choice halfway through an answer. So a resolution is
 * *pinned* to a key covering the card, its position, which presentation this is
 * and the mode policy, and every later render with that key gets the same
 * answer back.
 *
 * This returns the pin rather than writing it. The logic used to mutate a ref
 * from inside a `useMemo` and return through four separate branches, which made
 * the sticky part -- the part that actually protects the student -- the hardest
 * thing in the function to see.
 */
export type ExercisePin = {
  key: string;
  /** Absent only for a resumed draft saved before presentations carried ids. */
  presentationId?: string;
  exercise: ResolvedExercise | null;
  /** A placeholder can become an exercise until the student starts the fallback. */
  waitingForQuestion?: boolean;
  recoveryNotice?: string;
};

export type ExerciseResolution = {
  exercise: ResolvedExercise | null;
  /** Set when the caller should replace its pin. Absent means keep the current one. */
  pin?: ExercisePin;
};

const REPORTED_NOTICE = "This exercise was reported. You can continue with the original card.";
const STALE_NOTICE =
  "This saved exercise needs updating. Continue with the original card; your previous draft has been kept.";

export function exercisePinKey(input: {
  cardId: string;
  index: number;
  presentation: number;
  policy: StudyModePolicy;
}) {
  return `${input.cardId}:${input.index}:${input.presentation}:${input.policy.kind}:${
    input.policy.kind === "fixed" ? input.policy.mode : ""
  }`;
}

export function resolveCurrentExercise(input: {
  card: Card;
  asked: Card;
  index: number;
  presentation: number;
  policy: StudyModePolicy;
  sessionId: string;
  seed: number;
  pinned: ExercisePin | null;
  restoredExercises: PersistedStudyExercise[];
  reportedPresentations: Set<string>;
  retiredVariantIds: string[];
  isRetiredDraft: (variantId: string) => boolean;
  modeCounts: Partial<Record<StudyMode, number>>;
  presentationIndex: number;
  recentModes: StudyMode[];
  recentVariantIds: string[];
  recentOutcomes: NonNullable<ModeResolutionContext["recentOutcomes"]>;
  newId: () => string;
}): ExerciseResolution {
  const { card, asked, index, presentation, pinned } = input;
  const key = exercisePinKey({ cardId: card.id, index, presentation, policy: input.policy });
  const fresh = (exercise: ResolvedExercise | null, recoveryNotice?: string): ExerciseResolution => ({
    exercise,
    pin: {
      key,
      presentationId: `${input.sessionId}:${index}:${card.id}:${input.newId()}`,
      exercise,
      ...(recoveryNotice ? { recoveryNotice } : {}),
    },
  });

  // A variant reported while it was on screen is retired at once, before any
  // replacement has arrived, so it cannot be handed back on the next render.
  const pinnedVariant = pinned?.key === key ? pinned.exercise?.variantId : undefined;
  if (pinnedVariant && (input.isRetiredDraft(pinnedVariant) || input.retiredVariantIds.includes(pinnedVariant))) {
    return fresh(null, REPORTED_NOTICE);
  }

  // The sticky answer: same key, same question, unless the card itself changed.
  const currentPin = pinned?.key === key ? pinned : null;
  if (currentPin && !currentPin.waitingForQuestion
    && (!currentPin.exercise || currentPin.exercise.cardContentHash === getCardContentHash(card))) {
    return { exercise: currentPin.exercise };
  }

  if (input.reportedPresentations.has(`${card.id}:${presentation}`)) return fresh(null);

  const sourceHash = getCardContentHash(card);
  const identity = `${input.sessionId}:${index}:${card.id}`;
  const restored =
    input.restoredExercises.find(
      (item) =>
        item.contentHash === sourceHash &&
        item.cardId === card.id &&
        (item.presentationId === identity || item.presentationId?.startsWith(`${identity}:`))
    ) ??
    input.restoredExercises.find(
      (item) => !item.presentationId && item.cardId === card.id && item.contentHash === sourceHash
    );

  /*
   * A saved exercise is only resumed when it still passes the current validation
   * policy. An old bundle can carry distractors and gaps that today's reviewer
   * would reject, and resuming one would let the overhaul's own quality gates be
   * bypassed by a stale draft.
   */
  if (restored && (restored.mode === "classic" || !canRestoreStudyExercise(restored, card) ||
      (restored.variantId ? input.isRetiredDraft(restored.variantId) : false))) {
    if (restored.mode === "classic" && restored.presentationId) {
      return { exercise: null, pin: { key, presentationId: restored.presentationId, exercise: null } };
    }
    return fresh(null, restored.mode === "classic" ? undefined : STALE_NOTICE);
  }

  if (restored) {
    const exercise = restoreStudyExercise(restored, card);
    return { exercise, pin: { key, presentationId: exercise.presentationId, exercise } };
  }

  const waitingForQuestion = input.policy.kind === "fixed"
    && isAwaitingPreparation(getModeEligibility(asked, input.policy.mode, { seed: input.seed }));
  if (waitingForQuestion && currentPin?.waitingForQuestion) return { exercise: null };
  const presentationId = (currentPin?.waitingForQuestion ? currentPin.presentationId : undefined)
    ?? `${input.sessionId}:${index}:${card.id}:${input.newId()}`;
  const context = {
    seed: input.seed,
    modeCounts: input.modeCounts,
    recentModes: input.recentModes,
    presentation: input.presentationIndex,
    recentVariantIds: input.recentVariantIds,
    recentOutcomes: input.recentOutcomes,
    presentationId,
  };
  const mode = resolveExerciseMode(asked, input.policy, index, context);
  const exercise =
    !mode || mode === "classic" ? null : buildDeterministicExercise(asked, mode, sourceHash, context);
  return { exercise, pin: { key, presentationId, exercise, ...(waitingForQuestion ? { waitingForQuestion } : {}) } };
}
