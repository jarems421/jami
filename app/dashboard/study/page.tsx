"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StarRewardOverlay from "@/components/constellation/StarRewardOverlay";
import AppPage from "@/components/layout/AppPage";
import { useUser } from "@/components/providers/UserProvider";
import FocusedReviewBuilder from "@/components/study/FocusedReviewBuilder";
import MissionHandback from "@/components/study/MissionHandback";
import StudyCardStage, { StudyQuestionWriting } from "@/components/study/StudyCardStage";
import StudyDailyReviewCard, { type DailyRequiredSessionScope } from "@/components/study/StudyDailyReviewCard";
import StudyExerciseStage from "@/components/study/StudyExerciseStage";
import StudyFlashcard from "@/components/study/StudyFlashcard";
import StudyModePicker from "@/components/study/StudyModePicker";
import StudyOfflineBanner from "@/components/study/StudyOfflineBanner";
import StudyOtherWays from "@/components/study/StudyOtherWays";
import StudySessionComplete from "@/components/study/StudySessionComplete";
import StudySessionEmpty from "@/components/study/StudySessionEmpty";
import StudySessionPreparing from "@/components/study/StudySessionPreparing";
import { ButtonLink, EmptyState, FeedbackBanner, Skeleton } from "@/components/ui";
import { useFeedback } from "@/hooks/useFeedback";
import { useFocusedReview } from "@/hooks/useFocusedReview";
import { useSessionStreak } from "@/hooks/useSessionStreak";
import { useStudyActionOutcome } from "@/hooks/useStudyActionOutcome";
import { useStudyAssets } from "@/hooks/useStudyAssets";
import { useStudyBackgroundSync } from "@/hooks/useStudyBackgroundSync";
import { useStudyExerciseController } from "@/hooks/useStudyExerciseController";
import { useStudyExercises } from "@/hooks/useStudyExercises";
import { useStudyKeyboardShortcuts } from "@/hooks/useStudyKeyboardShortcuts";
import { useStudyModePolicy } from "@/hooks/useStudyModePolicy";
import { useStudyPreparation } from "@/hooks/useStudyPreparation";
import { useStudyQuestionWait } from "@/hooks/useStudyQuestionWait";
import { useStudyQueue } from "@/hooks/useStudyQueue";
import { useStudyRequest } from "@/hooks/useStudyRequest";
import { useStudySessionPersistence } from "@/hooks/useStudySessionPersistence";
import { useStudySessionRecord } from "@/hooks/useStudySessionRecord";
import { useStudySessionRestore, type ResumedStudySession } from "@/hooks/useStudySessionRestore";
import { useStudySessionState } from "@/hooks/useStudyWorkspaceState";
import { isFeatureEnabled } from "@/lib/app/feature-flags";
import { getNextDueCard, type Card } from "@/lib/study/cards";
import { getRemainingDailyReview, isCarryoverOnly } from "@/lib/study/daily-review";
import { getDeckColorPreset } from "@/lib/study/deck-style";
import { canCarryModeEventually } from "@/lib/study/mode-eligibility";
import { countModeAnswers } from "@/lib/study/mode-results";
import {
  buildPersistedStudySession,
  clearClosedStudySessionTombstone,
  createEmptySessionStats,
  savePersistedStudySession,
  type StudySessionKind,
} from "@/lib/study/session";
import { buildSessionExerciseSnapshots } from "@/lib/study/session-exercises";
import { chooseStudyNextStep } from "@/lib/study/session-next-step";
import { buildSimpleStudyQueue } from "@/lib/study/simple-study";
import { DEFAULT_STUDY_MODE_POLICY } from "@/lib/study/study-mode-preference";
import { STUDY_MODE_LABELS } from "@/lib/study/study-modes";
import { loadPresentationHistory } from "@/services/study/presentation-history";
import { saveRemoteActiveStudySession } from "@/services/study/session";
import { cardWithStudyAsset as askedCard } from "@/services/study/study-assets";

type AskedStart = { kind: StudySessionKind; scope: DailyRequiredSessionScope };

export default function StudyPage() {
  const { user } = useUser();
  const userId = user.uid;
  const request = useStudyRequest();
  const fromActionId = request.fromActionId;
  const { feedback, success, showError, clear: clearFeedback } = useFeedback();
  const studyModesEnabled = isFeatureEnabled("enableStudyModes");
  const {
    sessionKind, setSessionKind, sessionCards, setSessionCards,
    index, setIndex, flipped, setFlipped,
    jamiAssistantOpen, setJamiAssistantOpen, savingRating, setSavingRating,
    sessionStats, setSessionStats, answerFeedback, setAnswerFeedback,
    starReward, setStarReward,
    offlineMode, setOfflineMode, offlineSnapshotAt, setOfflineSnapshotAt,
    pendingOfflineReviews, setPendingOfflineReviews,
  } = useStudySessionState();
  const record = useStudySessionRecord();
  const { identity, adopt: adoptSession, forget: forgetSession, noteCurrent, currentRevision, hasOpenSession } = record;
  const { policy: modePolicy, choose: setModePolicy, adopt: adoptModePolicy } = useStudyModePolicy(userId);

  const {
    decks, cards, setCards, topics, dailyReviewState, setDailyReviewState, loaded, previewing, loadAll,
  } = useStudyQueue({
    userId,
    hasOpenSession,
    setOfflineMode,
    setOfflineSnapshotAt,
    setPendingOfflineReviews,
    clearFeedback,
    showError,
    success,
  });
  const focused = useFocusedReview({
    userId,
    request,
    cards,
    decks,
    topics,
    sessionActive: sessionKind !== null,
    clearFeedback,
  });
  const { refreshPendingOfflineReviews, syncPendingOfflineReviews } = useStudyBackgroundSync({
    userId,
    loadAll,
    hasOpenSession,
    setOfflineMode,
    setPendingOfflineReviews,
  });
  const { assets: studyAssets, mergeAssets, retireAsset } = useStudyAssets({
    enabled: studyModesEnabled,
    sessionCards,
  });
  const {
    progress: preparation,
    clearProgress: clearPreparation,
    cancel: cancelPreparation,
    skip: skipPreparation,
    prepareSessionAssets,
    prepareRemainingAssets,
    prepareCardNow,
  } = useStudyPreparation({ enabled: studyModesEnabled, modePolicy, onAssetsReady: mergeAssets });

  useEffect(() => {
    if (!answerFeedback) return;
    const timeout = window.setTimeout(() => setAnswerFeedback(null), answerFeedback.holdMs ?? 2400);
    return () => window.clearTimeout(timeout);
  }, [answerFeedback, setAnswerFeedback]);

  const daily = useMemo(() => getRemainingDailyReview(dailyReviewState, cards), [cards, dailyReviewState]);
  const simpleStudyQueue = useMemo(() => buildSimpleStudyQueue(cards), [cards]);
  const hasCards = cards.length > 0;
  const focusedCards = focused.previewCards;

  const done = loaded && sessionKind !== null && (sessionCards.length === 0 || index >= sessionCards.length);
  useEffect(() => {
    if (done) cancelPreparation();
  }, [done, cancelPreparation]);

  const current = loaded && sessionKind !== null && !done ? sessionCards[index] : null;
  const currentDeck = current ? decks.find((deck) => deck.id === current.deckId) : undefined;
  const preparedCurrent = useMemo(
    () => (current ? askedCard(current, studyAssets) : null),
    [current, studyAssets]
  );
  const nextDueCard = useMemo(() => getNextDueCard(cards), [cards]);

  const closeJamiAssistant = useCallback(() => setJamiAssistantOpen(false), [setJamiAssistantOpen]);
  const controller = useStudyExerciseController({
    userId,
    // Stamped on every answer this session produces, when a recommendation opened it.
    ...(fromActionId ? { interventionId: fromActionId } : {}),
    current,
    sessionKind,
    flipped,
    setFlipped,
    onReveal: closeJamiAssistant,
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
    savingRating,
    setSavingRating,
    offlineMode,
    setOfflineMode,
    bumpSessionRevision: record.bumpRevision,
    refreshPendingOfflineReviews,
    clearFeedback,
    notifyError: showError,
  });
  const { reveal: handleFlip, presentation } = controller;

  const exercises = useStudyExercises({
    userId,
    enabled: studyModesEnabled,
    current,
    asked: preparedCurrent,
    index,
    sessionKind,
    modePolicy,
    identity,
    controller,
    retireAsset,
    prepareRemainingAssets,
    showError,
  });
  const { currentExercise, showingAsFlashcard, showAsFlashcard, handleRating } = exercises;
  const exerciseSnapshot = exercises.snapshot;

  const questionWait = useStudyQuestionWait({
    enabled: studyModesEnabled,
    modePolicy,
    current,
    asked: preparedCurrent,
    currentExercise,
    showingAsFlashcard,
    showAsFlashcard,
    index,
    presentation,
    sessionCards,
    setSessionCards,
    studyAssets,
    seed: identity?.seed ?? 0,
    prepareCardNow,
  });

  const { selectedDeckIds, selectedTopicIds } = focused;
  const getCurrentPersistedSession = useCallback(
    (now = Date.now()) => {
      if (!sessionKind || !identity) {
        return null;
      }

      const { modeResults, recentModes, draftResponses, variantHistory, outcomeHistory, pinned } = exerciseSnapshot;
      const currentSession = buildPersistedStudySession({
        userId,
        sessionId: identity.sessionId,
        revision: currentRevision(),
        studyDayKey: identity.studyDayKey,
        kind: sessionKind,
        sessionCards,
        index,
        stats: sessionStats,
        selectedDeckIds,
        selectedTopicIds,
        startedAt: identity.startedAt,
        now,
        modePolicy,
        seed: identity.seed,
        modeResults,
        recentModes,
        draftResponses,
        variantHistory,
        outcomeHistory,
        exercises: buildSessionExerciseSnapshots({
          cards: sessionCards.slice(index),
          asAsked: (card) => askedCard(card, studyAssets),
          modePolicy,
          index,
          seed: identity.seed,
          modeCounts: countModeAnswers(modeResults),
          recentModes,
          firstExercise: pinned?.exercise ?? null,
          presentationId: pinned?.presentationId,
          sessionId: identity.sessionId,
          variantHistory,
          outcomeHistory,
        }),
      });

      noteCurrent(currentSession);
      return currentSession;
    },
    [
      currentRevision, exerciseSnapshot, identity, index, modePolicy, noteCurrent, selectedDeckIds,
      selectedTopicIds, sessionCards, sessionKind, sessionStats, studyAssets, userId,
    ]
  );

  const { closeSession } = useStudySessionPersistence({
    userId,
    loaded,
    sessionKind,
    done,
    record,
    getCurrentPersistedSession,
  });

  const { noteLeft } = useStudyActionOutcome({
    userId,
    actionId: fromActionId,
    sessionOpen: sessionKind !== null && !done,
    done,
    reviewedCards: sessionStats.reviewedCards,
    studyDayKey: identity?.studyDayKey ?? null,
  });
  const daysRunning = useSessionStreak({ userId, done, reviewedThisSession: sessionStats.reviewedCards });

  const { pushRecents } = focused;
  const beginExercises = exercises.begin;
  const resetQuestionWait = questionWait.reset;
  const startSession = useCallback(
    (kind: StudySessionKind, requiredScope: DailyRequiredSessionScope = "all") => {
      void (async () => {
        const nextCards =
          kind === "daily-required"
            ? requiredScope === "carryover"
              ? daily.carryover
              : requiredScope === "fresh"
                ? daily.fresh
                : daily.required
            : kind === "daily-optional"
              ? daily.optional
              : kind === "simple"
                ? simpleStudyQueue.cards
                : focusedCards;
        const seed = Math.floor(Math.random() * 0x7fffffff) || 1;
        const wantsPreparation = studyModesEnabled && nextCards.length > 0;
        const loadingHistory = loadPresentationHistory(userId, nextCards);
        // Started beside the history read rather than after it: neither needs the other.
        const preparing = wantsPreparation
          ? prepareSessionAssets(nextCards, loadingHistory).catch((error: unknown) => {
              console.warn("Study preparation failed; starting unprepared.", error);
              return null;
            })
          : Promise.resolve(null);
        const history = await loadingHistory;

        let assets = studyAssets;
        let headStart: Card[] = [];
        let remainder: Card[] = [];
        const ready = await preparing;
        if (wantsPreparation) clearPreparation();
        if (ready) {
          assets = { ...studyAssets, ...ready.assets };
          headStart = ready.headStart;
          remainder = ready.remainder;
          mergeAssets(ready.assets);
        }

        /*
         * Every card due is studied, whichever mode was picked.
         *
         * Cards that could never be asked this way used to be left out at the
         * door, with a notice saying so -- which meant cards that were due
         * went unreviewed, and a student saw "cannot be asked this way" at the
         * start of most Multiple Choice sessions. They stay in now, and are
         * shown as ordinary flashcards when they come round, with a line
         * saying why. Only a queue with nothing at all that suits the mode is
         * turned away, because then the choice itself was the problem.
         */
        if (
          studyModesEnabled &&
          modePolicy.kind === "fixed" &&
          nextCards.length > 0 &&
          !(modePolicy.mode === "multiple-choice" && remainder.length > 0) &&
          !nextCards.some((card) => canCarryModeEventually(askedCard(card, assets), modePolicy.mode, { seed }))
        ) {
          showError(
            `None of these cards suit ${STUDY_MODE_LABELS[modePolicy.mode]}. Try Smart Mix or another mode.`
          );
          return;
        }

        const now = Date.now();
        const nextStats = createEmptySessionStats();
        const nextSession = buildPersistedStudySession({
          userId,
          kind,
          sessionCards: nextCards,
          index: 0,
          stats: nextStats,
          selectedDeckIds: kind === "simple" ? [] : selectedDeckIds,
          selectedTopicIds: kind === "simple" ? [] : selectedTopicIds,
          startedAt: now,
          now,
          modePolicy,
          seed,
        });

        clearClosedStudySessionTombstone(userId);
        adoptSession(nextSession);
        beginExercises(history);
        resetQuestionWait();
        setSessionKind(kind);
        setSessionCards(nextCards);
        setSessionStats(nextStats);
        setIndex(0);
        setFlipped(false);
        setSavingRating(null);
        setAnswerFeedback(null);
        clearFeedback();
        savePersistedStudySession(nextSession);
        void saveRemoteActiveStudySession(nextSession).catch((error) => {
          console.warn("Failed to save active study session.", error);
        });

        if (kind === "custom") {
          pushRecents(selectedDeckIds, selectedTopicIds);
        }

        void prepareRemainingAssets(remainder, headStart);
      })();
    },
    [
      adoptSession, beginExercises, clearFeedback, clearPreparation, daily, focusedCards, mergeAssets,
      modePolicy, prepareRemainingAssets, prepareSessionAssets, pushRecents, resetQuestionWait,
      selectedDeckIds, selectedTopicIds, setAnswerFeedback, setFlipped, setIndex, setSavingRating,
      setSessionCards, setSessionKind, setSessionStats, showError, simpleStudyQueue.cards, studyAssets,
      studyModesEnabled, userId,
    ]
  );

  const { resetToRequest: resetFocusedToRequest, selectFilters } = focused;
  const resetExercises = exercises.reset;
  const adoptExercises = exercises.adopt;
  const resetForRequest = useCallback(() => {
    resetFocusedToRequest();
    setSessionKind(null);
    setSessionCards([]);
    setIndex(0);
    setFlipped(false);
    setAnswerFeedback(null);
    setSessionStats(createEmptySessionStats());
    resetExercises();
    forgetSession();
  }, [
    forgetSession, resetExercises, resetFocusedToRequest, setAnswerFeedback, setFlipped, setIndex,
    setSessionCards, setSessionKind, setSessionStats,
  ]);

  const resumeSession = useCallback(
    ({ session, cards: resumedCards, index: resumedIndex }: ResumedStudySession) => {
      adoptSession(session);
      savePersistedStudySession(session);
      setSessionKind(session.kind);
      setSessionCards(resumedCards);
      setSessionStats(session.stats);
      setIndex(resumedIndex);
      adoptModePolicy(session.modePolicy ?? DEFAULT_STUDY_MODE_POLICY);
      adoptExercises(session);
      setFlipped(false);
      setSavingRating(null);
      setAnswerFeedback(null);
      clearFeedback();
      if (session.kind === "custom") {
        selectFilters(session.selectedDeckIds, session.selectedTopicIds);
      }
    },
    [
      adoptExercises, adoptModePolicy, adoptSession, clearFeedback, selectFilters, setAnswerFeedback,
      setFlipped, setIndex, setSavingRating, setSessionCards, setSessionKind, setSessionStats,
    ]
  );

  const { settled: restoreSettled } = useStudySessionRestore({
    userId,
    loaded,
    request,
    cards,
    topics,
    dailyReviewState,
    onRequestChange: resetForRequest,
    onResume: resumeSession,
    onForget: record.noteClosed,
    closeSession,
    queue: {
      carryover: daily.carryover.length,
      required: daily.required.length,
      optional: daily.optional.length,
      focused: focusedCards.length,
    },
    startSession,
  });

  /*
   * A session asked for before Learn can start one.
   *
   * Learn is drawn from this device's cards before the server's arrive, and a
   * saved session may yet be resumed. A start asked for in the meantime waits
   * for both, then runs on the server's queue -- unless a session was resumed.
   */
  const [askedStart, setAskedStart] = useState<AskedStart | null>(null);
  const ranStartRef = useRef<AskedStart | null>(null);
  const readyToStart = loaded && restoreSettled;
  const requestStart = useCallback(
    (kind: StudySessionKind, scope: DailyRequiredSessionScope = "all") => {
      if (readyToStart) startSession(kind, scope);
      else setAskedStart({ kind, scope });
    },
    [readyToStart, startSession]
  );
  useEffect(() => {
    if (!askedStart || !readyToStart || ranStartRef.current === askedStart) return;
    ranStartRef.current = askedStart;
    if (sessionKind === null) startSession(askedStart.kind, askedStart.scope);
  }, [askedStart, readyToStart, sessionKind, startSession]);
  const waitingToStart = askedStart !== null && !readyToStart;

  const handleCustomReviewClick = useCallback(() => {
    if (!hasCards) {
      showError("Create at least one card first, then Focused Review will be ready.");
      return;
    }

    if (focusedCards.length === 0) {
      showError(focused.hasFilters
        ? "No cards match those filters. Clear them or choose a different deck or Topic."
        : "Add cards first, then Focused Review will be ready.");
      return;
    }

    requestStart("custom");
  }, [focused.hasFilters, focusedCards.length, hasCards, requestStart, showError]);

  useStudyKeyboardShortcuts({
    enabled: current !== null && !currentExercise,
    flipped,
    ratingLocked: savingRating !== null,
    scale: sessionKind === "simple" ? "two-point" : "four-point",
    onReveal: handleFlip,
    onRate: handleRating,
  });

  const exitSession = () => {
    // Leaving through the page is leaving just the same, when it is unfinished.
    noteLeft();
    const now = Date.now();
    const currentSession = getCurrentPersistedSession(now);
    if (currentSession) {
      closeSession(currentSession, done ? "completed" : "ended", done ? "completed" : "user-ended", now);
    }
    cancelPreparation();
    forgetSession();
    setSessionKind(null);
    setSessionCards([]);
    setSessionStats(createEmptySessionStats());
    setIndex(0);
    setFlipped(false);
    setSavingRating(null);
    setAnswerFeedback(null);
  };

  const handleStarRewardDone = useCallback(() => setStarReward(null), [setStarReward]);
  const totalCards = sessionCards.length;
  const ratingScale = sessionKind === "simple" ? "two-point" : "four-point";

  return (
    <AppPage
      title="Learn"
      backHref="/dashboard"
      backLabel="Today"
      width={sessionKind === null ? "2xl" : "study"}
      contentClassName="space-y-4 sm:space-y-6"
    >
      {feedback ? <FeedbackBanner type={feedback.type} message={feedback.message} onDismiss={() => clearFeedback()} /> : null}
      <StudyOfflineBanner
        offline={offlineMode}
        pendingReviews={pendingOfflineReviews}
        snapshotSavedAt={offlineSnapshotAt}
        onSync={() => void syncPendingOfflineReviews()}
      />
      {(!loaded && !previewing) || waitingToStart ? (
        <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-72" /></div>
      ) : sessionKind === null ? (
        hasCards ? (
          <>
            <StudyDailyReviewCard
              carryoverCount={daily.carryover.length}
              freshCount={daily.fresh.length}
              requiredCount={daily.required.length}
              optionalCount={daily.optional.length}
              modePicker={
                studyModesEnabled ? <StudyModePicker policy={modePolicy} onChange={setModePolicy} /> : undefined
              }
              onStartRequired={(scope) => requestStart("daily-required", scope)}
              onStartOptional={() => requestStart("daily-optional")}
            />
            <StudyOtherWays
              focused={{
                open: focused.open,
                onToggleOpen: focused.toggleOpen,
                hasFilters: focused.hasFilters,
                selectedCount: selectedDeckIds.length + selectedTopicIds.length,
                previewCount: focusedCards.length,
                builder: (
                  <FocusedReviewBuilder
                    filterKind={focused.filterKind}
                    onFilterKindChange={focused.setFilterKind}
                    decks={focused.deckColumn}
                    topics={focused.topicColumn}
                    previewCount={focusedCards.length}
                    selectionEmpty={focusedCards.length === 0}
                    modePicker={
                      studyModesEnabled ? (
                        <StudyModePicker
                          policy={modePolicy}
                          surface="focused"
                          // The builder's own step heading asks it.
                          hideLabel
                          onChange={setModePolicy}
                        />
                      ) : undefined
                    }
                    onClearFilters={focused.clearFilters}
                    onStart={handleCustomReviewClick}
                  />
                ),
                onStart: handleCustomReviewClick,
              }}
              simple={{
                newCount: simpleStudyQueue.newCount,
                wrongCount: simpleStudyQueue.wrongCount,
                cardCount: simpleStudyQueue.cards.length,
                modePicker: studyModesEnabled ? (
                  <StudyModePicker policy={modePolicy} surface="simple" onChange={setModePolicy} />
                ) : undefined,
                onStart: () => requestStart("simple"),
              }}
            />
          </>
        ) : (
          <EmptyState
            title="Nothing to review yet"
            description="Create one card and it will appear here ready to learn."
            action={<ButtonLink href="/dashboard/cards">Create cards</ButtonLink>}
            secondaryAction={<ButtonLink href="/dashboard/decks" variant="secondary">Open decks</ButtonLink>}
          />
        )
      ) : done ? (
        totalCards === 0 && sessionStats.reviewedCards === 0 ? (
          <StudySessionEmpty sessionKind={sessionKind} onExit={exitSession} />
        ) : (
          <>
            {fromActionId && sessionStats.reviewedCards > 0 ? (
              <MissionHandback answered={sessionStats.reviewedCards} />
            ) : null}
            <StudySessionComplete
              sessionKind={sessionKind}
              stats={sessionStats}
              totalCards={totalCards}
              modeResults={exercises.modeResults}
              daysRunning={daysRunning}
              nextStep={chooseStudyNextStep({
                sessionKind,
                sessionWasCarryoverOnly:
                  sessionKind === "daily-required" && isCarryoverOnly(dailyReviewState, sessionCards),
                remainingFreshRequired: daily.fresh.length,
                remainingOptional: daily.optional.length,
                focusedCardCount: focusedCards.length,
                completedGoals: sessionStats.completedGoals,
              })}
              nextDueAt={nextDueCard?.dueDate ?? null}
              canRepeat={!(sessionKind === "simple" && simpleStudyQueue.cards.length === 0)}
              onStart={startSession}
              onExit={exitSession}
            />
          </>
        )
      ) : current ? (
        <StudyCardStage
          key={current.id}
          userId={userId}
          card={current}
          sessionKind={sessionKind}
          index={index}
          totalCards={totalCards}
          answerFeedback={answerFeedback}
          flipped={flipped}
          assistantOpen={jamiAssistantOpen}
          onAssistantOpenChange={setJamiAssistantOpen}
          settingsFolderIds={currentDeck?.folderIds ?? []}
          recoveryNotice={exercises.recoveryNotice}
          showRatingControls={flipped && !currentExercise}
          savingRating={savingRating}
          onRate={handleRating}
          onEnd={exitSession}
        >
          {currentExercise && exercises.stageProps ? (
            <StudyExerciseStage
              key={`${current.id}:${currentExercise.mode}:${currentExercise.cardContentHash}:${presentation}`}
              card={preparedCurrent ?? current}
              exercise={currentExercise}
              ratingScale={ratingScale}
              savingRating={savingRating}
              {...exercises.stageProps}
            />
          ) : questionWait.waitingForQuestion ? (
            <StudyQuestionWriting
              cardId={current.id}
              onShowAsFlashcard={() => showAsFlashcard(current.id, presentation)}
            />
          ) : (
            <>
              {modePolicy.kind === "fixed" && (questionWait.refusalReason || showingAsFlashcard) ? (
                <p role="status" className="mx-auto mb-3 max-w-xl text-center text-sm text-text-secondary">
                  {showingAsFlashcard
                    ? `Its ${STUDY_MODE_LABELS[modePolicy.mode]} question isn't ready yet, so here it is as a flashcard.`
                    : `${STUDY_MODE_LABELS[modePolicy.mode]} doesn't suit this card, so here it is as a flashcard.`}
                </p>
              ) : null}
              <StudyFlashcard
                card={current}
                flipped={flipped}
                onReveal={handleFlip}
                deckName={focused.deckNamesById[current.deckId] ?? "Flashcard"}
                deckColor={getDeckColorPreset(currentDeck?.colorPreset).base}
                topicNames={(current.topicIds ?? []).map(
                  (topicId) => focused.topicNamesById[topicId] ?? "Topic"
                )}
              />
            </>
          )}
        </StudyCardStage>
      ) : null}
      <StarRewardOverlay reward={starReward} onDone={handleStarRewardDone} />
      {preparation ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-surface-base)]/85 px-4 backdrop-blur-sm">
          <StudySessionPreparing
            prepared={preparation.prepared}
            total={preparation.total}
            onSkip={skipPreparation}
          />
        </div>
      ) : null}
    </AppPage>
  );
}
