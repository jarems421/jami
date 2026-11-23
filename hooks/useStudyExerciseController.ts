"use client";

import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { StarReward } from "@/components/constellation/StarRewardOverlay";
import { getStudyDayKey } from "@/lib/study/day";
import type { DailyReviewState } from "@/lib/study/daily-review-types";
import type { Card } from "@/lib/study/cards";
import type { Deck } from "@/lib/study/decks";
import {
  applyReviewToDailyState,
  planReviewOutcome,
  type ReviewOutcome,
  type ReviewRetryResult,
} from "@/lib/study/review-outcome";
import {
  updateCardSchedule,
  type CardRating,
} from "@/lib/study/scheduler";
import {
  applySimpleStudyResultToCard,
  applySimpleStudyResultToQueue,
  type SimpleStudyResult,
} from "@/lib/study/simple-study";
import {
  getOfflineQueuedReviews,
  queueOfflineStudyReview,
  removeOfflineQueuedReviews,
  type OfflineQueuedReview,
} from "@/lib/study/offline-study";
import { keepOfflineStudySnapshot } from "@/services/study/offline-study-snapshot";
import type { StudySessionKind, StudySessionStats } from "@/lib/study/session";
import {
  getAnswerFeedback,
  getSimpleStudyFeedback,
  withGoalReward,
  type AnswerFeedback,
} from "@/lib/study/study-feedback";
import { reserveStudyCommit, type StudyCommitIntent } from "@/services/study/commit-intent";
import { syncOfflineStudyReviews } from "@/services/study/offline";
import {
  persistStudyReview,
  type PersistedStudyReview,
} from "@/services/study/review-persistence";

/**
 * One answer, on its way to being recorded.
 *
 * The card is named rather than assumed so a mode that marks its own answer
 * cannot commit against whichever card happens to be on screen by the time the
 * marking settles. `responseTimeMs` is optional: a mode that measures its own
 * thinking time passes it, and anything that reveals through `reveal()` gets
 * the flip-to-answer gap for free.
 */
export type StudyAttemptCommit = {
  intent?: StudyCommitIntent;
  commitId?: string;
  cardId: string;
  rating: CardRating;
  answeredAt: number;
  responseTimeMs?: number;
  /**
   * Send a missed card to the back of the session rather than losing it.
   *
   * This is how a flashcard has always behaved: get it wrong and you see it
   * again before you finish, but far enough away to have forgotten the answer
   * you were just shown. Daily Review already did this and now the answer-first
   * modes do too. Classic outside Daily Review does not, so its behaviour is
   * unchanged.
   *
   * Never overrides parking: a card that has used up its attempts for the day
   * still stops.
   */
  requeueOnMiss?: boolean;
  /** On a diagram card: the other label given instead. Carried to the review event as an id. */
  confusedWithLabelId?: string;
};

/**
 * The single road into scheduling.
 *
 * Every exercise, whatever it renders and however it marks, ends here. FSRS,
 * Daily Review completion, goals, stars, streak activity, the offline queue and
 * the in-session retry cadence are all reached through `commitReview` and
 * nowhere else, so a new mode cannot accidentally invent its own scheduling.
 */
/** A practice answer: counted, never scheduled. */
export type PracticeResult = {
  cardId: string;
  correct: boolean;
};

export type StudyExerciseController = {
  reveal: () => void;
  commitReview: (attempt: StudyAttemptCommit) => Promise<void>;
  continueWithoutScheduling: (result: PracticeResult) => void;
  revisitAfterHint: (cardId: string, alreadyRevisited?: boolean) => void;
  /**
   * How many times this session has sent a card to the back of the queue.
   *
   * The exercise stage is keyed on it, so a card that comes round again arrives
   * as a fresh question. Without it, a one-card session would requeue onto
   * itself and leave the previous answer's verdict on screen.
   */
  presentation: number;
};

type ControllerOptions = {
  userId: string;
  /**
   * The recommendation that opened this session, when one did.
   *
   * Written onto every answer it produces, so the engine can later separate
   * evidence that arrived *because* a student took its advice from evidence
   * that merely arrived afterwards.
   */
  interventionId?: string;
  current: Card | null;
  sessionKind: StudySessionKind | null;
  flipped: boolean;
  setFlipped: Dispatch<SetStateAction<boolean>>;
  onReveal?: () => void;
  cards: Card[];
  setCards: Dispatch<SetStateAction<Card[]>>;
  decks: Deck[];
  index: number;
  setIndex: Dispatch<SetStateAction<number>>;
  sessionCards: Card[];
  setSessionCards: Dispatch<SetStateAction<Card[]>>;
  dailyReviewState: DailyReviewState | null;
  setDailyReviewState: Dispatch<SetStateAction<DailyReviewState | null>>;
  setSessionStats: Dispatch<SetStateAction<StudySessionStats>>;
  setAnswerFeedback: Dispatch<SetStateAction<AnswerFeedback | null>>;
  setStarReward: Dispatch<SetStateAction<StarReward | null>>;
  savingRating: CardRating | null;
  setSavingRating: Dispatch<SetStateAction<CardRating | null>>;
  offlineMode: boolean;
  setOfflineMode: Dispatch<SetStateAction<boolean>>;
  bumpSessionRevision: () => number;
  refreshPendingOfflineReviews: () => void;
  clearFeedback: () => void;
  notifyError: (message: string) => void;
};

type ScheduledSessionKind = Exclude<StudySessionKind, "simple">;

/**
 * Whether a missed card comes round again before the session ends.
 *
 * Two things ask for it. Daily Review always has: a required card you got wrong
 * goes to the back of the queue until it is either answered or parked. The
 * answer-first modes now ask for it too, through `requeueOnMiss`, because a
 * flashcard you got wrong and never saw again taught you nothing.
 *
 * Parking is the one thing that overrules both. A card that has used up its
 * attempts for the day stops, however the student got it wrong.
 */
function shouldRequeueAfterMiss(input: {
  attempt: StudyAttemptCommit;
  isStruggle: boolean;
  retryResult: ReviewRetryResult | null;
}) {
  if (!input.isStruggle) return false;
  if (input.retryResult) return !input.retryResult.parked;
  return Boolean(input.attempt.requeueOnMiss);
}

function isOffline(offlineMode: boolean) {
  return offlineMode || (typeof navigator !== "undefined" && navigator.onLine === false);
}

export function useStudyExerciseController(
  options: ControllerOptions
): StudyExerciseController {
  const {
    userId,
    interventionId,
    current,
    sessionKind,
    flipped,
    setFlipped,
    onReveal,
    cards,
    setCards,
    decks,
    index,
    setIndex,
    sessionCards,
    setSessionCards,
    dailyReviewState,
    setDailyReviewState,
    setSessionStats,
    setAnswerFeedback,
    setStarReward,
    setSavingRating,
    offlineMode,
    setOfflineMode,
    bumpSessionRevision,
    refreshPendingOfflineReviews,
    clearFeedback,
    notifyError,
  } = options;

  const revealedAtRef = useRef(0);
  const commitInFlightRef = useRef(false);
  const [presentation, setPresentation] = useState(0);
  const hintedRevisitsRef = useRef(new Set<string>());
  /** Background saves run one after another, so a card's answers land in order. */
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());

  const reveal = useCallback(() => {
    if (!current || flipped) return;
    revealedAtRef.current = Date.now();
    setFlipped(true);
    onReveal?.();
  }, [current, flipped, onReveal, setFlipped]);

  const folderIdsForCard = useCallback(
    (card: Card) =>
      decks.find((deck) => deck.id === card.deckId)?.folderIds ?? [],
    [decks]
  );

  const goNext = useCallback(() => {
    setIndex((value) => value + 1);
    setFlipped(false);
  }, [setFlipped, setIndex]);

  const requeueCurrentCard = useCallback(
    (nextCard: Card) => {
      setSessionCards((prev) => {
        const before = prev.slice(0, index);
        const after = prev.slice(index + 1);
        return [...before, ...after, nextCard];
      });
      setFlipped(false);
      setPresentation((value) => value + 1);
    },
    [index, setFlipped, setSessionCards]
  );

  const measureResponseTime = useCallback(
    (attempt: StudyAttemptCommit) =>
      attempt.responseTimeMs ??
      (revealedAtRef.current > 0
        ? attempt.answeredAt - revealedAtRef.current
        : undefined),
    []
  );

  /**
   * Saves an answer to the server behind the session.
   *
   * The answer is already held on this device, so a failure costs nothing: it
   * stays queued and goes up with the next successful save or sync. The student
   * is told once, not once per card.
   */
  const persistInBackground = useCallback(
    (queued: OfflineQueuedReview, onSaved?: (saved: PersistedStudyReview) => void) => {
      persistChainRef.current = persistChainRef.current.then(async () => {
        try {
          const saved = await persistStudyReview(userId, queued);
          onSaved?.(saved);
          // Off the device only once its learning history is written too; see persistStudyReview.
          await saved.learningHistory;
          removeOfflineQueuedReviews(userId, [queued.id]);
          // Anything an earlier failure left behind goes up with it.
          if (getOfflineQueuedReviews(userId).length > 0) {
            await syncOfflineStudyReviews(userId);
          }
        } catch (error) {
          /*
           * No message here.
           *
           * The answer is on the device and the session keeps retrying, so a
           * send that has not landed yet is not something the student can act
           * on or needs to read between two cards. If it stays unsent long
           * enough to matter, the sync notice on the page says so -- once,
           * rather than once per answer.
           */
          console.warn("A study answer could not be saved yet; it stays on this device.", error);
        } finally {
          refreshPendingOfflineReviews();
        }
      });
    },
    [refreshPendingOfflineReviews, userId]
  );

  const queuedReviewFor = useCallback(
    (
      card: Card,
      attempt: StudyAttemptCommit,
      kind: ScheduledSessionKind,
      outcome: ReviewOutcome
    ): Omit<OfflineQueuedReview, "id"> => ({
      intent: attempt.intent,
      commitId: attempt.commitId,
      userId,
      cardId: card.id,
      deckId: card.deckId,
      topicIds: card.topicIds ?? [],
      folderIds: folderIdsForCard(card),
      rating: attempt.rating,
      reviewedAt: attempt.answeredAt,
      studyDayKey: getStudyDayKey(attempt.answeredAt),
      isCorrect: outcome.isCorrect,
      durationMs: measureResponseTime(attempt),
      sessionKind: kind,
      cardUpdates: outcome.cardUpdates,
      ...(attempt.confusedWithLabelId ? { confusedWithLabelId: attempt.confusedWithLabelId } : {}),
      clearMemoryRiskOverrideDayKey: Boolean(outcome.schedule && outcome.isCorrect),
      /*
       * Which advice this answer belongs to.
       *
       * The session's own wins: a student sent here by a recommendation is
       * answering that one, whatever else produced the card. Failing that, a
       * card Jami wrote attributes its reviews to the recommendation that
       * asked for it -- otherwise "create some cards" could never be shown to
       * have led anywhere, because the student usually reviews them later by
       * their own route rather than from the link.
       */
      ...(interventionId
        ? { interventionId }
        : card.createdByInterventionId
          ? { interventionId: card.createdByInterventionId }
          : {}),
    }),
    [folderIdsForCard, interventionId, measureResponseTime, userId]
  );

  /** Moves the session on from an answer: the card, Daily Review, stats, feedback, what comes next. */
  const applyOutcome = useCallback(
    (card: Card, attempt: StudyAttemptCommit, kind: ScheduledSessionKind, outcome: ReviewOutcome) => {
      if (outcome.updatesCards) {
        setCards((prev) => prev.map((entry) => (entry.id === card.id ? outcome.nextCard : entry)));
      }
      setDailyReviewState((prev) =>
        applyReviewToDailyState(prev, card.id, kind, outcome.retryResult, attempt.answeredAt)
      );
      bumpSessionRevision();
      setSessionStats((prev) => ({
        reviewedCards: prev.reviewedCards + 1,
        correctAnswers: prev.correctAnswers + (outcome.isCorrect ? 1 : 0),
        completedGoals: prev.completedGoals,
        starsEarned: prev.starsEarned,
        ratings: { ...prev.ratings, [attempt.rating]: prev.ratings[attempt.rating] + 1 },
      }));
      // A missed card goes to the back of the queue: seen again before the
      // session ends, but with enough cards in between to have genuinely
      // forgotten the answer it was just shown. Parking still wins -- a card
      // that has used up its Daily Review attempts stops for the day.
      const requeued = shouldRequeueAfterMiss({ attempt, isStruggle: outcome.isStruggle, retryResult: outcome.retryResult });
      setAnswerFeedback(getAnswerFeedback(attempt.rating, kind, Boolean(outcome.retryResult?.parked), requeued));
      if (requeued) {
        requeueCurrentCard(outcome.nextCard);
      } else {
        goNext();
      }
    },
    [bumpSessionRevision, goNext, requeueCurrentCard, setAnswerFeedback, setCards, setDailyReviewState, setSessionStats]
  );

  /** What only the server knows, applied once it has answered: goals, stars, and its retry count. */
  const applySavedReview = useCallback(
    (cardId: string, rating: CardRating, kind: ScheduledSessionKind, answeredAt: number, saved: PersistedStudyReview) => {
      const goals = saved.goalProgress;
      if (goals && (goals.completedGoals > 0 || goals.starsEarned > 0)) {
        setSessionStats((prev) => ({
          ...prev,
          completedGoals: prev.completedGoals + goals.completedGoals,
          starsEarned: prev.starsEarned + goals.starsEarned,
        }));
        // The goal lands a moment after the card moved on, so it joins whatever
        // feedback is showing rather than waiting for the next answer.
        setAnswerFeedback((prev) =>
          withGoalReward(prev ?? getAnswerFeedback(rating, kind, Boolean(saved.retryResult?.parked)), goals)
        );
      }
      // Only the first is shown: finishing two goals on one card is rare, and
      // stacking overlays would bury the card behind the celebration.
      if (goals && goals.rewards.length > 0) setStarReward(goals.rewards[0]);
      const retryResult = saved.retryResult;
      if (retryResult && kind === "daily-required") {
        setDailyReviewState((prev) => applyReviewToDailyState(prev, cardId, kind, retryResult, answeredAt));
      }
    },
    [setAnswerFeedback, setDailyReviewState, setSessionStats, setStarReward]
  );

  const commitOffline = useCallback(
    (card: Card, attempt: StudyAttemptCommit, kind: ScheduledSessionKind) => {
      const schedule = attempt.intent
        ? attempt.intent.schedule
        : kind === "custom"
          ? null
          : updateCardSchedule(card, attempt.rating);
      const outcome = planReviewOutcome({
        card,
        rating: attempt.rating,
        answeredAt: attempt.answeredAt,
        sessionKind: kind,
        schedule,
        dailyReviewState,
      });

      queueOfflineStudyReview(queuedReviewFor(card, attempt, kind, outcome));
      refreshPendingOfflineReviews();
      if (outcome.updatesCards) {
        keepOfflineStudySnapshot(userId, {
          cards: cards.map((entry) => (entry.id === card.id ? outcome.nextCard : entry)),
          decks,
        });
      }
      applyOutcome(card, attempt, kind, outcome);
      setOfflineMode(true);
    },
    [
      applyOutcome,
      cards,
      dailyReviewState,
      decks,
      queuedReviewFor,
      refreshPendingOfflineReviews,
      setOfflineMode,
      userId,
    ]
  );

  const commitSimpleStudy = useCallback(
    (card: Card, result: SimpleStudyResult, commitId?: string, intent?: StudyCommitIntent) => {
      if (sessionKind !== "simple") return;

      const now = intent?.answeredAt ?? Date.now();
      const queued = queueOfflineStudyReview({ userId, cardId: card.id, commitId, intent, rating: result === "correct" ? "good" : "again", reviewedAt: now, studyDayKey: getStudyDayKey(now), isCorrect: result === "correct", sessionKind: "simple", cardUpdates: {}, ...(interventionId ? { interventionId } : {}) });
      refreshPendingOfflineReviews();
      const nextCard = applySimpleStudyResultToCard(card, result, now);
      const nextCardsSnapshot = cards.map((entry) =>
        entry.id === card.id ? nextCard : entry
      );
      const ratingForStats: CardRating = result === "correct" ? "good" : "again";

      setCards(nextCardsSnapshot);
      keepOfflineStudySnapshot(userId, { cards: nextCardsSnapshot, decks });
      if (result === "correct") {
        setSessionCards((prev) =>
          prev.map((entry) => (entry.id === card.id ? nextCard : entry))
        );
        setIndex((value) => Math.min(value + 1, sessionCards.length));
      } else {
        setSessionCards((prev) =>
          applySimpleStudyResultToQueue(prev, card.id, result, now)
        );
        // A missed card goes to the back of the queue, which on a one-card
        // queue is the same card again at the same index. The answer-first
        // modes are keyed on this counter, so without it a re-asked question
        // would come back with the previous attempt still revealed under it.
        setPresentation((value) => value + 1);
      }
      bumpSessionRevision();
      setSessionStats((prev) => ({
        reviewedCards: prev.reviewedCards + 1,
        correctAnswers: prev.correctAnswers + (result === "correct" ? 1 : 0),
        completedGoals: prev.completedGoals,
        starsEarned: prev.starsEarned,
        ratings: {
          ...prev.ratings,
          [ratingForStats]: prev.ratings[ratingForStats] + 1,
        },
      }));
      setAnswerFeedback(getSimpleStudyFeedback(result));
      setFlipped(false);

      if (isOffline(offlineMode)) return;
      persistInBackground(queued);
    },
    [
      bumpSessionRevision,
      cards,
      decks,
      interventionId,
      offlineMode,
      persistInBackground,
      refreshPendingOfflineReviews,
      sessionCards.length,
      sessionKind,
      setAnswerFeedback,
      setCards,
      setFlipped,
      setIndex,
      setSessionCards,
      setSessionStats,
      userId,
    ]
  );

  const commitReview = useCallback(
    async (attempt: StudyAttemptCommit) => {
      // The card is resolved by id rather than taken from the session cursor,
      // so an answer that took a moment to mark can never be written against
      // whichever card arrived in the meantime.
      if (!current || !sessionKind || current.id !== attempt.cardId) return;
      if (commitInFlightRef.current) return;
      commitInFlightRef.current = true;
      setSavingRating(attempt.rating);
      clearFeedback();
      const card = current;
      const kind = sessionKind;
      const offline = isOffline(offlineMode);
      const proposal: StudyCommitIntent = {
        ...attempt,
        commitId: attempt.commitId ?? crypto.randomUUID(),
        sessionKind: kind,
        context: { deckId: card.deckId, topicIds: card.topicIds ?? [], folderIds: folderIdsForCard(card) },
        schedule: kind === "custom" || kind === "simple" ? null : updateCardSchedule(card, attempt.rating),
      };

      try {
        /*
         * The answer is held on this device before anything else, which is
         * what lets the session move on without waiting for the server. Only a
         * device that cannot hold it waits, as every answer used to.
         */
        let intent: StudyCommitIntent;
        let heldOnDevice = true;
        try {
          intent = await reserveStudyCommit(userId, proposal, true);
        } catch (error) {
          if (offline) throw error;
          heldOnDevice = false;
          intent = await reserveStudyCommit(userId, proposal, false);
        }
        const committed: StudyAttemptCommit = { ...intent, intent };

        if (kind === "simple") {
          const rating = committed.rating;
          commitSimpleStudy(card, rating === "again" || rating === "hard" ? "wrong" : "correct", committed.commitId, committed.intent);
          return;
        }

        if (offline) {
          commitOffline(card, committed, kind);
          return;
        }

        const schedule = committed.intent ? committed.intent.schedule : kind === "custom" ? null : updateCardSchedule(card, committed.rating);
        const plan = (retryResult?: ReviewRetryResult | null) =>
          planReviewOutcome({
            card,
            rating: committed.rating,
            answeredAt: committed.answeredAt,
            sessionKind: kind,
            schedule,
            dailyReviewState,
            retryResult,
          });
        const outcome = plan();
        const review = queuedReviewFor(card, committed, kind, outcome);

        let queued: OfflineQueuedReview | null = null;
        if (heldOnDevice) {
          try {
            queued = queueOfflineStudyReview(review);
            refreshPendingOfflineReviews();
          } catch {
            queued = null;
          }
        }

        if (!queued) {
          const saved = await persistStudyReview(userId, { ...review, id: proposal.commitId });
          applyOutcome(card, committed, kind, plan(saved.retryResult));
          applySavedReview(card.id, committed.rating, kind, committed.answeredAt, saved);
          return;
        }

        applyOutcome(card, committed, kind, outcome);
        persistInBackground(queued, (saved) => applySavedReview(card.id, committed.rating, kind, committed.answeredAt, saved));
      } catch (error) {
        console.error(error);
        notifyError("Your answer could not be saved yet. Please try again.");
      } finally {
        commitInFlightRef.current = false;
        setSavingRating(null);
      }
    },
    [
      applyOutcome,
      applySavedReview,
      clearFeedback,
      commitOffline,
      commitSimpleStudy,
      current,
      dailyReviewState,
      folderIdsForCard,
      notifyError,
      offlineMode,
      persistInBackground,
      queuedReviewFor,
      refreshPendingOfflineReviews,
      sessionKind,
      setSavingRating,
      userId,
    ]
  );

  /**
   * Move on without touching the schedule.
   *
   * Multiple choice ends here. It updates the session's own accuracy and reuses
   * the retry cadence -- a missed card goes to the back of the queue for
   * another look -- but writes no FSRS state, completes no Daily Review
   * obligation and credits no goal. A student can run a whole MCQ session over
   * their due cards and those cards will still be due.
   */
  const continueWithoutScheduling = useCallback(
    (result: PracticeResult) => {
      if (!current || current.id !== result.cardId) return;

      bumpSessionRevision();
      setSessionStats((prev) => ({
        ...prev,
        reviewedCards: prev.reviewedCards + 1,
        correctAnswers: prev.correctAnswers + (result.correct ? 1 : 0),
      }));

      if (result.correct) {
        goNext();
      } else {
        requeueCurrentCard(current);
      }
    },
    [bumpSessionRevision, current, goNext, requeueCurrentCard, setSessionStats]
  );

  const revisitAfterHint = useCallback((cardId: string, alreadyRevisited?: boolean) => {
    if (!current || current.id !== cardId) return;
    if (alreadyRevisited ?? hintedRevisitsRef.current.has(cardId)) {
      goNext();
      return;
    }
    hintedRevisitsRef.current.add(cardId);
    bumpSessionRevision();
    setSessionCards((previous) => {
      const before = previous.slice(0, index);
      const after = previous.slice(index + 1);
      const insertion = Math.min(3, after.length);
      return [...before, ...after.slice(0, insertion), current, ...after.slice(insertion)];
    });
    setFlipped(false);
    setPresentation((value) => value + 1);
  }, [bumpSessionRevision, current, goNext, index, setFlipped, setSessionCards]);

  return { reveal, commitReview, continueWithoutScheduling, revisitAfterHint, presentation };
}
