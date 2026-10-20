"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@/components/providers/UserProvider";
import { useFeedback } from "@/hooks/useFeedback";
import { runDashboardDataRequest } from "@/lib/app/dashboard-data";
import type { Deck } from "@/lib/study/decks";
import type { Goal } from "@/lib/goals/model";
import { getCustomStudyHref, getRevisionPlanHref } from "@/lib/app/routes";
import { countTodayReviews, type DailyStudyActivity } from "@/lib/study/activity";
import type { GeneratedContentDraft } from "@/lib/material/generated-content";
import type { Card as StudyCard } from "@/lib/study/cards";
import AppPage from "@/components/layout/AppPage";
import { Button, ButtonLink, FeedbackBanner, Skeleton } from "@/components/ui";
import Refreshable, { RefreshIconButton } from "@/components/layout/Refreshable";
import type { Topic } from "@/lib/material/topics";
import type { Source } from "@/lib/material/sources";
import {
  buildTodayPlan,
  type TodayPlan,
  type TodayStudyAction,
} from "@/lib/dashboard/today-plan";
import {
  buildTodayMission,
  greeting,
  hubSubline,
  missionCompletionCopy,
} from "@/lib/dashboard/today-mission";
import StudyActionsCard from "@/components/learning/StudyActionsCard";
import InterventionDraftReview from "@/components/learning/InterventionDraftReview";
import MissionCard from "@/components/today/MissionCard";
import MaterialReady from "@/components/today/MaterialReady";
import MomentumStrip, { buildMomentumWeek } from "@/components/today/MomentumStrip";
import TodayAnytime, { type TodayAnytimeItem } from "@/components/today/TodayAnytime";
import TodayGoals from "@/components/today/TodayGoals";
import TodayHeader from "@/components/today/TodayHeader";
import TodayPlanPanel from "@/components/today/TodayPlanPanel";
import TodayWeekList from "@/components/today/TodayWeekList";
import { planScopeColor } from "@/lib/planning/plan-colors";
import { planCountdown } from "@/lib/planning/plan-countdown";
import { timetableUpNext } from "@/lib/planning/timetable";
import { useRevisionPlanToday } from "@/hooks/useRevisionPlanToday";
import { featureFlags } from "@/lib/app/feature-flags";
import { useStudyActions } from "@/hooks/useStudyActions";
import { useInterventionMaterial } from "@/hooks/useInterventionMaterial";
import { useWaitingGoalStars } from "@/hooks/useWaitingGoalStars";
import StarRewardOverlay from "@/components/constellation/StarRewardOverlay";
import {
  DAILY_REVIEW_MISSION_ID,
  noteMissionStarted,
  takeCompletedMission,
  type MissionHandoff,
} from "@/lib/learning/mission-handoff";
import { getStudyDayKey } from "@/lib/study/day";
import { noteStudyActionEvent } from "@/services/learning/study-action-events";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import type { Notebook } from "@/lib/workspace/notebooks";
import {
  getCachedDashboardSnapshot,
  loadDashboardSnapshot,
  type DashboardSnapshot,
} from "@/services/dashboard/today";
import { hasDashboardChangedThisSession } from "@/services/dashboard/cache";
import { readTodayDeviceCopy } from "@/services/dashboard/today-device-copy";
import { TutorialResumeCard, useTutorial } from "@/components/onboarding/TutorialProvider";
import { shouldInviteToTutorial } from "@/lib/onboarding/tutorial";
import FirstNightPanel from "@/components/onboarding/FirstNightPanel";
import SecondNightPanel from "@/components/onboarding/SecondNightPanel";
import { useFirstNight } from "@/components/onboarding/FirstNightProvider";

/**
 * The Study Hub.
 *
 * Today answers one question -- what should I do now? -- and it is laid out
 * like a page of a planner so the answer is the first thing on it. The day's
 * plan, contained, with the next task marked; what Jami suggests beyond it;
 * what can be done any time. Without a plan, Jami's suggestions lead in the
 * same place, so it is one page either way.
 *
 * What it deliberately is not is a dashboard. Every count Jami holds could go
 * on this page and the result would be a student auditing themselves before
 * they had studied anything. The rule that keeps it honest: show the smallest
 * amount of information that makes the next decision easy, and put the rest
 * somewhere it can be asked for.
 *
 * Nothing here decides what to study. The Learning Engine chooses, the
 * intervention catalogue chooses what can be done about it, and the planner
 * says how much time there is. This page composes those three answers and
 * never adds a fourth.
 */

const PROGRESS_VISITED_KEY = "jami:progress-visited";

export default function DashboardHome() {
  const { user } = useUser();
  const tutorial = useTutorial();
  const firstNight = useFirstNight();

  const [decks, setDecks] = useState<Deck[]>([]);
  const [dueCards, setDueCards] = useState<StudyCard[]>([]);
  const [remainingOptionalCount, setRemainingOptionalCount] = useState(0);
  const [activeGoals, setActiveGoals] = useState<Goal[]>([]);
  const [hasEarnedStars, setHasEarnedStars] = useState(false);
  const [studyActivity, setStudyActivity] = useState<DailyStudyActivity[]>([]);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [drafts, setDrafts] = useState<GeneratedContentDraft[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [studyFolders, setStudyFolders] = useState<StudyFolder[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [sectionStates, setSectionStates] = useState<DashboardSnapshot["sections"]>({
    decks: "unavailable",
    profile: "unavailable",
    cards: "unavailable",
    session: "unavailable",
    goals: "unavailable",
    activity: "unavailable",
    topics: "unavailable",
    drafts: "unavailable",
    sources: "unavailable",
    folders: "unavailable",
    notebooks: "unavailable",
    dailyReview: "unavailable",
  });
  const [progressVisited, setProgressVisited] = useState(false);
  const [hasActiveStudySession, setHasActiveStudySession] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Drawn from this device's copy, with the real load still on its way. */
  const [showingDeviceCopy, setShowingDeviceCopy] = useState(false);
  /**
   * Whether a real snapshot is on the page, which a device copy must never
   * replace, and whether a load has finished at all -- after which a copy is
   * no longer waiting on anything.
   */
  const loadProgressRef = useRef({ applied: false, settled: false });
  const { feedback, success, showError, clear: clearFeedback } = useFeedback();
  const [inAppUsername, setInAppUsername] = useState<string | null>(null);
  const [completedMission, setCompletedMission] = useState<MissionHandoff | null>(null);
  const lastForegroundRefreshAtRef = useRef(0);
  const dashboardRequestIdRef = useRef(0);

  const applySnapshot = useCallback((snapshot: DashboardSnapshot) => {
    setDecks(snapshot.decks);
    setDueCards(snapshot.dueCards);
    setRemainingOptionalCount(snapshot.remainingOptionalCount);
    setActiveGoals(snapshot.activeGoals);
    setHasEarnedStars(snapshot.hasEarnedStars);
    setStudyActivity(snapshot.studyActivity);
    setCards(snapshot.cards);
    setTopics(snapshot.topics);
    setDrafts(snapshot.drafts);
    setSources(snapshot.sources);
    setStudyFolders(snapshot.studyFolders);
    setNotebooks(snapshot.notebooks);
    setSectionStates(snapshot.sections);
    setInAppUsername(snapshot.username);
    setHasActiveStudySession(snapshot.hasActiveStudySession);
  }, []);

  const loadAll = useCallback(
    async (uid: string, options: { force?: boolean } = {}) => {
      const requestId = dashboardRequestIdRef.current + 1;
      dashboardRequestIdRef.current = requestId;

      return runDashboardDataRequest({
        load: () => loadDashboardSnapshot(uid, options),
        isCurrent: () => requestId === dashboardRequestIdRef.current,
        apply: ({ snapshot, feedback: loadFeedback }) => {
          loadProgressRef.current.applied = true;
          applySnapshot(snapshot);
          lastForegroundRefreshAtRef.current = snapshot.fetchedAt;
          if (loadFeedback) {
            if (loadFeedback.type === "success") success(loadFeedback.message);
            else showError(loadFeedback.message);
          }
        },
        onError: (error) => {
          console.error("Failed to load Today.", error);
          showError("Failed to load Today. Try refreshing in a moment.");
        },
        onSettled: () => {
          loadProgressRef.current.settled = true;
          setIsLoading(false);
          setShowingDeviceCopy(false);
        },
      });
    },
    [applySnapshot, showError, success]
  );

  useEffect(() => {
    let active = true;
    const progress = { applied: false, settled: false };
    loadProgressRef.current = progress;
    const cached = getCachedDashboardSnapshot(user.uid);
    if (cached) {
      progress.applied = true;
      applySnapshot(cached.snapshot);
      setIsLoading(false);
      lastForegroundRefreshAtRef.current = cached.snapshot.fetchedAt;
    } else {
      setIsLoading(true);
      /*
       * Launching with nothing in memory, Today draws the copy this device
       * kept of it and loads behind it, rather than holding skeletons for
       * every round trip. Not once anything has been written this session:
       * the copy would then show the student their own change undone.
       */
      if (!hasDashboardChangedThisSession(user.uid)) {
        void readTodayDeviceCopy({ userId: user.uid, dayKey: getStudyDayKey() }).then(
          (copy) => {
            if (!active || !copy || progress.applied) return;
            applySnapshot(copy);
            setIsLoading(false);
            // A load that has already failed leaves the copy as the best
            // there is, with nothing more coming behind it.
            setShowingDeviceCopy(!progress.settled);
          }
        );
      }
    }
    if (cached?.freshness !== "fresh") {
      void loadAll(user.uid);
    }
    return () => {
      active = false;
      dashboardRequestIdRef.current += 1;
    };
  }, [applySnapshot, user.uid, loadAll]);

  useEffect(() => {
    try {
      setProgressVisited(localStorage.getItem(PROGRESS_VISITED_KEY) === "true");
    } catch {
      // Treat inaccessible browser storage as no recorded visit; this only
      // affects optional onboarding copy.
      setProgressVisited(false);
    }
  }, []);


  useEffect(() => {
    const handleFocus = () => {
      const now = Date.now();
      if (
        document.visibilityState !== "hidden" &&
        now - lastForegroundRefreshAtRef.current > 60_000
      ) {
        lastForegroundRefreshAtRef.current = now;
        void loadAll(user.uid);
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [user.uid, loadAll]);

  const studyActions = useStudyActions(
    user.uid,
    featureFlags.enableLearnerProfile && featureFlags.enableStudyActions
  );
  const refreshStudyActions = studyActions.refresh;

  /*
   * Did they just come back from doing what the page asked?
   *
   * Read once, on arrival, and cleared as it is read -- the moment belongs to
   * the return journey. Nothing depends on it being there, so a browser that
   * refuses the storage simply gets the ordinary page.
   *
   * Finding one forces a recalculation rather than serving what is cached.
   * Both caches would otherwise hand back the answer from before the student
   * did the work -- the recommendations for five minutes, the snapshot for its
   * own window -- so Jami would acknowledge the session and then, in the same
   * breath, suggest it again. That is the worst thing this surface could do:
   * it would demonstrate that the loop is not really closed.
   */
  useEffect(() => {
    const completed = takeCompletedMission();
    if (!completed) return;
    setCompletedMission(completed);
    void loadAll(user.uid, { force: true });
    void refreshStudyActions();
  }, [loadAll, refreshStudyActions, user.uid]);

  /*
   * The plan's week as it was planned: the student's own tasks and Jami's
   * picks where they were put, ticked as the work behind them is done.
   */
  const revisionPlan = useRevisionPlanToday({
    uid: user.uid,
    enabled: featureFlags.enableRevisionPlans,
    folders: studyFolders,
    cards,
    decks,
  });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    clearFeedback();
    try {
      await Promise.all([loadAll(user.uid, { force: true }), refreshStudyActions()]);
    } finally {
      setRefreshing(false);
    }
  }, [clearFeedback, loadAll, refreshStudyActions, user.uid]);

  const todayReviews = useMemo(() => countTodayReviews(studyActivity), [studyActivity]);
  const todayPlan = useMemo<TodayPlan>(
    () =>
      buildTodayPlan({
        decks,
        cards,
        dueCards,
        topics,
        drafts,
        sources,
        studyFolders,
        notebooks,
        activeGoals,
        reviewedToday: todayReviews,
        progressVisited,
        hasEarnedStars,
        hasActiveStudySession,
        studyActions: studyActions.actions,
        studyActionFolders: studyActions.folders,
      }),
    [
      activeGoals,
      cards,
      decks,
      drafts,
      notebooks,
      dueCards,
      progressVisited,
      hasEarnedStars,
      hasActiveStudySession,
      sources,
      studyActions.actions,
      studyActions.folders,
      studyFolders,
      todayReviews,
      topics,
    ]
  );

  const folderName = useCallback(
    (folderId: string) =>
      studyActions.folders.find((folder) => folder.id === folderId)?.name ??
      studyFolders.find((folder) => folder.id === folderId)?.name ??
      "Flashcards",
    [studyActions.folders, studyFolders]
  );

  const material = useInterventionMaterial({ uid: user.uid, decks, folderName });
  const waitingStars = useWaitingGoalStars(user.uid);
  const startMaterial = material.start;

  const mission = useMemo(
    () =>
      buildTodayMission({
        nextAction: todayPlan.nextAction,
        studyActions: todayPlan.studyActions,
      }),
    [todayPlan.nextAction, todayPlan.studyActions]
  );

  const isEmptyAccount = shouldInviteToTutorial({
    isLoading,
    sectionStates: {
      decks: sectionStates.decks,
      cards: sectionStates.cards,
      activity: sectionStates.activity,
      folders: sectionStates.folders,
      notebooks: sectionStates.notebooks,
    },
    deckCount: decks.length,
    cardCount: cards.length,
    activityCount: studyActivity.length,
    folderCount: studyFolders.length,
    notebookCount: notebooks.length,
  });

  // A brand-new account opens straight into First night, once, if it has never run.
  const firstNightNeverRan = firstNight.ready && !firstNight.state;
  useEffect(() => {
    if (isEmptyAccount && firstNightNeverRan && tutorial.canInvite) {
      tutorial.invite();
    }
  }, [firstNightNeverRan, isEmptyAccount, tutorial]);

  const planSections = [
    "decks",
    "cards",
    "session",
    "goals",
    "activity",
    "topics",
    "drafts",
    "sources",
    "folders",
    "notebooks",
    "dailyReview",
  ] as const;
  const planUnavailable = planSections.some((section) => sectionStates[section] === "unavailable");

  const momentumWeek = useMemo(() => buildMomentumWeek(studyActivity), [studyActivity]);

  /** The engine's other advice: the mission's own recommendation is not repeated. */
  const remainingActions = useMemo(
    () => todayPlan.studyActions.filter((action) => action.id !== mission.action?.id),
    [mission.action?.id, todayPlan.studyActions]
  );

  const recordMissionStart = useCallback(() => {
    if (mission.action) {
      noteStudyActionEvent(user.uid, mission.action, "started", getStudyDayKey());
      noteMissionStarted({
        actionId: mission.action.id,
        headline: mission.headline,
        conceptLabel: mission.action.target.label,
        ...(mission.action.targetItems !== undefined
          ? { targetItems: mission.action.targetItems }
          : {}),
      });
      return;
    }
    if (todayPlan.nextAction.type === "review_due_cards") {
      noteMissionStarted({
        actionId: DAILY_REVIEW_MISSION_ID,
        headline: mission.headline,
        conceptLabel: "Your due cards",
        targetItems: todayPlan.dueCards.count,
      });
    }
  }, [mission, todayPlan.dueCards.count, todayPlan.nextAction.type, user.uid]);

  const handleGenerate = useCallback(
    (action: TodayStudyAction) => {
      void startMaterial(action);
    },
    [startMaterial]
  );

  /*
   * The finished mission, worded. Held until the page is left rather than
   * timed out: it sits above the next recommendation as context for it, and
   * something that vanished mid-read would be worse than something that stays.
   */
  const completionCopy = useMemo(
    () =>
      completedMission
        ? missionCompletionCopy({
            conceptLabel: completedMission.conceptLabel,
            answered: completedMission.answered ?? 0,
            ...(completedMission.targetItems !== undefined
              ? { targetItems: completedMission.targetItems }
              : {}),
          })
        : undefined,
    [completedMission]
  );

  const missionBusy = material.generatingId !== null;
  const generatingMission = Boolean(mission.action && material.generatingId === mission.action.id);

  // While the plan is still being read, Today waits rather than drawing the
  // mission and then swapping it for the plan a moment later.
  const planLoading = featureFlags.enableRevisionPlans && revisionPlan.loading;

  /*
   * The Learning Engine's next step, as the first line of "Jami suggests". It
   * leads Today unless a revision plan does, and then only when the plan has
   * nothing left for today.
   */
  const missionCard = (
    <>
    {isLoading || planLoading ? (
      <Skeleton className="h-40 rounded-2xl" />
    ) : planUnavailable ? (
      <MissionCard
        tone="plain"
        eyebrow="Today"
        headline="Your study plan is temporarily unavailable."
        summary="Refresh in a moment. Jami will not treat missing data as an empty study list."
        /*
         * The acknowledgement survives a failed read.
         *
         * They did the work; not being able to read their profile is
         * Jami's problem, not a reason to act as though the session
         * never happened. What is lost is only the recommendation that
         * would have followed it.
         */
        {...(completionCopy ? { completion: completionCopy } : {})}
        action={
          <Button type="button" onClick={() => void handleRefresh()}>
            Try again
          </Button>
        }
        /*
         * A failed read may cost the recommendation, never every way to start
         * studying: due cards do not depend on the profile that failed.
         */
        secondaryAction={
          <ButtonLink href={getCustomStudyHref({ mode: "daily" })} variant="secondary">
            Review cards
          </ButtonLink>
        }
      />
    ) : (
      <MissionCard
        tone={mission.action ? "engine" : "plain"}
        eyebrow={mission.eyebrow}
        headline={mission.headline}
        summary={mission.summary}
        {...(completionCopy ? { completion: completionCopy } : {})}
        bodyKey={mission.action?.id ?? mission.headline}
        {...(mission.folderName ? { context: mission.folderName } : {})}
        facts={
          mission.effort
            ? [mission.effort.items, mission.effort.minutes].filter(
                (fact): fact is string => Boolean(fact)
              )
            : []
        }
        explanation={mission.explanation}
        action={
          mission.generate && mission.action ? (
            <Button
              type="button"
              disabled={missionBusy}
              onClick={() => handleGenerate(mission.action as TodayStudyAction)}
            >
              {generatingMission ? "Writing…" : mission.actionLabel}
            </Button>
          ) : (
            <ButtonLink href={mission.href} onClick={recordMissionStart}>
              {mission.actionLabel}
            </ButtonLink>
          )
        }
        secondaryAction={
          mission.secondary ? (
            <ButtonLink href={mission.secondary.href} variant="secondary">
              {mission.secondary.label}
            </ButtonLink>
          ) : null
        }
      />
    )}
    </>
  );

  const planLed =
    featureFlags.enableRevisionPlans &&
    !isLoading &&
    !planUnavailable &&
    !planLoading &&
    Boolean(revisionPlan.plan && revisionPlan.today);
  /** The plan leads while it has something left to do today; after that, Jami does. */
  const planLeads = planLed && Boolean(timetableUpNext(revisionPlan.today));

  /*
   * What Jami suggests beyond the plan. With the plan leading, anything already
   * on today's timetable is left out, so a suggestion is never shown twice;
   * with Jami leading, it is everything after its own next step.
   */
  const planPlacedIds = useMemo(
    () =>
      new Set(
        (revisionPlan.today?.activities ?? []).flatMap((activity) => (activity.actionId ? [activity.actionId] : []))
      ),
    [revisionPlan.today]
  );
  const suggestionActions = planLeads
    ? todayPlan.studyActions.filter((action) => !planPlacedIds.has(action.id))
    : remainingActions;

  const todayDayKey = getStudyDayKey();
  const planScope = revisionPlan.plan;
  const scopeColor = useCallback((scopeKey: string) => planScopeColor(planScope, scopeKey), [planScope]);

  /*
   * The lines under "Any time today". Each used to be a card behind the "More
   * for today" fold; they are one list now, and none of them is drawn when its
   * data could not be read -- a missing list is not an empty one.
   */
  const reviewLeads = !planLeads && todayPlan.nextAction.type === "review_due_cards";
  const anytimeItems: TodayAnytimeItem[] = [];
  if (!isLoading && !planUnavailable) {
    if (todayPlan.dueCards.count > 0 && !reviewLeads) {
      anytimeItems.push({
        id: "due-cards",
        title: `Review ${todayPlan.dueCards.count} due ${todayPlan.dueCards.count === 1 ? "card" : "cards"}`,
        meta: todayPlan.dueCards.primaryDeckName
          ? `Mostly ${todayPlan.dueCards.primaryDeckName}`
          : "Flashcards",
        action: (
          <ButtonLink href={getCustomStudyHref({ mode: "daily" })} variant="secondary" size="sm">
            Review
          </ButtonLink>
        ),
      });
    }
    if (sectionStates.drafts !== "unavailable" && todayPlan.drafts.length > 0) {
      anytimeItems.push({
        id: "drafts",
        title: `Check ${todayPlan.drafts.length} new ${todayPlan.drafts.length === 1 ? "draft" : "drafts"}`,
        meta: "Jami made them from your material",
        action: (
          <ButtonLink href="/dashboard/tutor" variant="secondary" size="sm">
            Review drafts
          </ButtonLink>
        ),
      });
    }
    // A weak topic is read from its cards, so both have to be there to name one.
    if (sectionStates.topics !== "unavailable" && sectionStates.cards !== "unavailable") {
      for (const topic of todayPlan.weakTopics.slice(0, 3)) {
        anytimeItems.push({
          id: `topic-${topic.topicId}`,
          title: `Repair ${topic.name}`,
          meta: [topic.subject, topic.reason].filter(Boolean).join(" · "),
          action: (
            <ButtonLink href={topic.href} variant="secondary" size="sm">
              Practise
            </ButtonLink>
          ),
        });
      }
    }
    if (sectionStates.dailyReview !== "unavailable" && remainingOptionalCount > 0) {
      anytimeItems.push({
        id: "extras",
        title: "Extra review",
        meta: `${remainingOptionalCount} lighter ${remainingOptionalCount === 1 ? "card" : "cards"}, if you want more`,
        action: (
          <ButtonLink href={getCustomStudyHref({ mode: "daily" })} variant="secondary" size="sm">
            Review
          </ButtonLink>
        ),
      });
    }
  }

  return (
    <Refreshable onRefresh={handleRefresh}>
      <AppPage
        title="Today"
        width="2xl"
        action={
          <RefreshIconButton
            // Turning while a kept copy is shown: what is on the page is
            // about to be brought up to date.
            refreshing={refreshing || showingDeviceCopy}
            onClick={() => void handleRefresh()}
          />
        }
        contentClassName="space-y-6 sm:space-y-8"
      >
        {feedback ? (
          <FeedbackBanner
            type={feedback.type}
            message={feedback.message}
            onDismiss={() => clearFeedback()}
          />
        ) : null}
        {material.error ? (
          <FeedbackBanner type="error" message={material.error} onDismiss={material.dismissError} />
        ) : null}

        {material.confirmed ? (
          <MaterialReady
            kind={material.confirmed.kind}
            created={material.confirmed.created}
            conceptLabel={material.confirmed.conceptLabel}
            href={material.confirmed.href}
            onDismiss={material.dismissConfirmation}
          />
        ) : null}

        <TodayHeader
          greeting={`${greeting()}${inAppUsername ? `, ${inAppUsername}` : ""}.`}
          dayKey={todayDayKey}
          {...(planLed && revisionPlan.plan ? { planTitle: revisionPlan.plan.title } : {})}
          {...(isLoading
            ? { summary: "Getting today ready." }
            : planUnavailable
              ? { summary: "Some of your study data could not be read just now." }
              : planLed
                ? {}
                : { summary: hubSubline({ hasMission: true, extraActions: remainingActions.length }) })}
          countdown={planLed && revisionPlan.plan ? planCountdown(revisionPlan.plan, todayDayKey) : []}
          planHref={getRevisionPlanHref()}
          offerExamDates={featureFlags.enableRevisionPlans && !planLed && !planLoading && !isLoading}
          scopeColor={scopeColor}
        />

        {/*
          First night leads the page while it runs. A new student's Today has
          little else to say yet, and the panel sat below the mission and the
          doors -- a full scroll down on a phone, under the one thing they were
          meant to do next.
        */}
        <FirstNightPanel />

        {/*
          * A planner page: the plan, contained, then what Jami suggests beyond
          * it, then what can be done any time. The week and a goal sit beside
          * them on a wide screen and after them on a phone.
          *
          * The page used to be a greeting, a poster-sized mission, a momentum
          * panel, four doors and a fold of other cards -- and a different page
          * again with a plan. There is one order now, with or without a plan:
          * without one, Jami's suggestions simply lead.
          */}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-8">
          <div className="min-w-0 space-y-5">
            {planLed ? (
              <TodayPlanPanel uid={user.uid} planToday={revisionPlan} folders={studyFolders} topics={topics} goals={activeGoals} />
            ) : null}

            <section aria-labelledby="today-suggest-title" className="app-panel rounded-3xl p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 pb-3">
                <h2 id="today-suggest-title" className="text-base font-bold tracking-tight text-text-primary">
                  Jami suggests
                </h2>
                <span className="text-xs text-text-muted">From your recent answers</span>
              </div>
              {planLeads ? null : missionCard}
              {!isLoading && !planUnavailable ? (
                <StudyActionsCard
                  actions={suggestionActions}
                  uid={user.uid}
                  onGenerate={handleGenerate}
                  generatingId={material.generatingId}
                />
              ) : null}
              {planLeads && suggestionActions.length === 0 ? (
                <p className="px-1 text-sm leading-6 text-text-muted">
                  Nothing extra today — your plan already has what Jami would suggest.
                </p>
              ) : null}
            </section>

            <TodayAnytime items={anytimeItems} />
          </div>

          <aside className="grid content-start gap-5">
            {planLed ? (
              <TodayWeekList planToday={revisionPlan} planHref={getRevisionPlanHref()} />
            ) : isLoading ? (
              <Skeleton className="h-40 rounded-3xl" />
            ) : (
              <MomentumStrip week={momentumWeek} unavailable={sectionStates.activity === "unavailable"} />
            )}
            {featureFlags.enableRevisionPlans && !planLed && !planLoading && !isLoading ? (
              <section aria-labelledby="today-plan-invite" className="app-panel space-y-2 rounded-3xl p-4">
                <h2 id="today-plan-invite" className="px-1 text-sm font-bold text-text-primary">
                  Plan around your exams
                </h2>
                <p className="px-1 text-xs leading-5 text-text-muted">
                  Lay out your own timetable, or tell Jami your exams and week and watch it build one. Today then leads with it.
                </p>
                <div className="px-1 pt-1">
                  <ButtonLink href={getRevisionPlanHref()} size="sm">
                    Make a plan
                  </ButtonLink>
                </div>
              </section>
            ) : null}
            {!isLoading && sectionStates.goals !== "unavailable" ? <TodayGoals goals={todayPlan.goals} /> : null}
          </aside>
        </div>

        <TutorialResumeCard />
        <SecondNightPanel />

        <InterventionDraftReview
          draft={material.draft}
          saving={material.saving}
          onCancel={material.cancel}
          onConfirm={material.confirm}
        />
      </AppPage>
      <StarRewardOverlay reward={waitingStars.reward} onDone={waitingStars.dismiss} />
    </Refreshable>
  );
}
