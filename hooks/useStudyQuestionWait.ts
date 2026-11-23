"use client";

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { StudyAsset } from "@/lib/ai/study-assets";
import type { Card } from "@/lib/study/cards";
import { getModeEligibility } from "@/lib/study/mode-eligibility";
import type { ResolvedExercise, StudyModePolicy } from "@/lib/study/study-modes";
import { cardWithStudyAsset } from "@/services/study/study-assets";

/** The longest a student waits on one card's question before it is shown as a flashcard. */
const QUESTION_WAIT_LIMIT_MS = 20_000;
const MULTIPLE_CHOICE_WAIT_MS = 5_000;

/**
 * What happens when a session locked to one mode reaches a card whose question
 * has not been written yet.
 *
 * Every other reason a mode cannot be used is permanent -- a picture answer,
 * an author who turned the mode off, a card Jami read and found no fair
 * question in -- and those cards are simply shown as flashcards. "Not prepared
 * yet" is the one reason about timing, and it is never shown as a refusal: a
 * ready card is brought forward, this one is prepared on its own, and a wait
 * that runs too long ends in a flashcard.
 */
export function useStudyQuestionWait({
  enabled,
  modePolicy,
  current,
  asked,
  currentExercise,
  showingAsFlashcard,
  showAsFlashcard,
  index,
  presentation,
  sessionCards,
  setSessionCards,
  studyAssets,
  seed,
  prepareCardNow,
}: {
  enabled: boolean;
  modePolicy: StudyModePolicy;
  current: Card | null;
  asked: Card | null;
  currentExercise: ResolvedExercise | null;
  showingAsFlashcard: boolean;
  showAsFlashcard: (cardId: string, shownAt: number) => void;
  index: number;
  presentation: number;
  sessionCards: Card[];
  setSessionCards: Dispatch<SetStateAction<Card[]>>;
  studyAssets: Record<string, StudyAsset>;
  seed: number;
  prepareCardNow: (card: Card, lookAhead: Card[]) => Promise<unknown>;
}) {
  /** Cards already sent for last-moment preparation, so each is asked for once. */
  const justInTimePreparedRef = useRef(new Set<string>());

  /**
   * Why the card in front of the student cannot be asked the way they chose.
   *
   * Null whenever there is an exercise, which is the usual case; a reason code
   * only when a session locked to one mode has reached a card that mode cannot
   * use yet.
   */
  const refusal =
    enabled && modePolicy.kind === "fixed" && current && !currentExercise
      ? getModeEligibility(asked ?? current, modePolicy.mode, { seed })
      : null;
  const refusalReason = refusal && !refusal.eligible ? refusal.reason : null;
  const waitingForQuestion = refusalReason === "needs-preparation" && !showingAsFlashcard;

  /*
   * A ready card goes first.
   *
   * Preparation runs through the queue in order, several cards at a time, and
   * a student who answers quickly can still reach a card before its own call
   * has come back. Any card further on whose question is ready is brought
   * forward instead, and this one takes the next turn, by which time it has
   * usually landed. Only when nothing ahead is ready does anybody wait.
   */
  useEffect(() => {
    if (!waitingForQuestion || !current || modePolicy.kind !== "fixed") return;
    const mode = modePolicy.mode;
    const readyOffset = sessionCards
      .slice(index + 1)
      .findIndex((card) => getModeEligibility(cardWithStudyAsset(card, studyAssets), mode, { seed }).eligible);
    if (readyOffset < 0) return;
    const readyAt = index + 1 + readyOffset;
    setSessionCards((previous) => {
      if (previous[index]?.id !== current.id || previous[readyAt] === undefined) return previous;
      const next = [...previous];
      const [ready] = next.splice(readyAt, 1);
      next.splice(index, 0, ready);
      return next;
    });
  }, [current, index, modePolicy, seed, sessionCards, setSessionCards, studyAssets, waitingForQuestion]);

  /*
   * This card is prepared now, on its own.
   *
   * Once per card. A card already on its way from the background pass is not
   * asked for twice; it is handed over when it lands. If nothing can be made
   * for it now -- the provider failed, or the day's allowance is spent -- it
   * is asked as a flashcard rather than refused.
   */
  useEffect(() => {
    const card = current;
    if (!card || !waitingForQuestion) return;
    if (justInTimePreparedRef.current.has(card.id)) return;
    justInTimePreparedRef.current.add(card.id);
    const shownAt = presentation;
    const lookAhead = sessionCards.slice(index + 1, index + 3);
    void prepareCardNow(card, lookAhead).then((result) => {
      if (result === null) showAsFlashcard(card.id, shownAt);
    });
  }, [current, index, prepareCardNow, presentation, sessionCards, showAsFlashcard, waitingForQuestion]);

  /*
   * A wait has a limit.
   *
   * One card's question takes about fifteen seconds to write and check, and a
   * slow one forty. Past this, the student is shown the card as a flashcard
   * and the question is kept for the next time the card comes round.
   */
  useEffect(() => {
    if (!waitingForQuestion || !current) return;
    const cardId = current.id;
    const shownAt = presentation;
    const limit = modePolicy.kind === "fixed" && modePolicy.mode === "multiple-choice"
      ? MULTIPLE_CHOICE_WAIT_MS : QUESTION_WAIT_LIMIT_MS;
    const timer = window.setTimeout(() => showAsFlashcard(cardId, shownAt), limit);
    return () => window.clearTimeout(timer);
  }, [current, modePolicy, presentation, showAsFlashcard, waitingForQuestion]);

  /** A new session prepares its own cards afresh. */
  const reset = useCallback(() => justInTimePreparedRef.current.clear(), []);

  return { waitingForQuestion, refusalReason, reset };
}
