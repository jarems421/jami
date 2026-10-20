"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@/components/providers/UserProvider";
import AppPage from "@/components/layout/AppPage";
import Refreshable, { RefreshIconButton } from "@/components/layout/Refreshable";
import StarRewardOverlay from "@/components/constellation/StarRewardOverlay";
import GoalCard from "@/components/goals/GoalCard";
import GoalComposer, { type GoalComposerOptions } from "@/components/goals/GoalComposer";
import GoalHistory from "@/components/goals/GoalHistory";
import { GoalMeasureBadge } from "@/components/goals/GoalIcons";
import { GOAL_KINDS } from "@/components/goals/GoalKindPicker";
import GoalSuggestions from "@/components/goals/GoalSuggestions";
import { Button, ConfirmDialog, EmptyState, FeedbackBanner, Skeleton } from "@/components/ui";
import { useFeedback } from "@/hooks/useFeedback";
import { useGoalContext } from "@/hooks/useGoalContext";
import { useGoalHistory } from "@/hooks/useGoalHistory";
import { useGoalsWorkspace } from "@/hooks/useGoalsWorkspace";
import { blankGoalDraft, repeatGoalDraft } from "@/lib/goals/drafts";
import { draftForIntent, GOALS_PATH, readGoalIntent } from "@/lib/goals/intent";
import {
  getGoalDisplayName,
  goalToDraft,
  type Goal,
  type GoalDraft,
  type GoalEdit,
  type GoalMeasure,
} from "@/lib/goals/model";
import { goalNextStep } from "@/lib/goals/next-step";
import { goalStanding, sortGoalsForDisplay } from "@/lib/goals/standing";
import { goalIdeas, type GoalSuggestion } from "@/lib/goals/suggestions";

/** Ideas shown under goals already running: a row, not a second page of them. */
const RUNNING_IDEAS = 3;

type ComposerState =
  | { mode: "closed" }
  | { mode: "create"; draft: GoalDraft; key: number }
  | { mode: "edit"; goal: Goal; key: number };

function scrollToComposer() {
  window.requestAnimationFrame(() => {
    document.getElementById("goal-composer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/**
 * The first visit, with nothing running: what a goal is for, and the three
 * kinds there are, each a way straight into the composer set up for it.
 */
function GoalsWelcome({ onNew }: { onNew: (measure: GoalMeasure) => void }) {
  return (
    <section aria-labelledby="goals-welcome-title" className="app-panel p-5 sm:p-7">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-center lg:gap-10">
        <div className="space-y-3">
          <h2 id="goals-welcome-title" className="text-2xl font-bold tracking-tight text-text-primary">
            Give your revision something to aim at
          </h2>
          <p className="max-w-xl text-sm leading-6 text-text-secondary">
            A goal counts real work: cards you review, answers Jami marks, or a topic your results show is strong.
            It keeps you on pace, and when you finish it, it becomes a star in your sky.
          </p>
          <Button type="button" variant="warm" data-tutorial-target="new-goal" onClick={() => onNew("cards")}>
            Make a goal
          </Button>
        </div>
        <div className="min-w-0">
          <p className="mb-2.5 text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">Aim at</p>
          <ul className="grid gap-2">
            {GOAL_KINDS.map((kind) => (
              <li key={kind.measure}>
                <button
                  type="button"
                  onClick={() => onNew(kind.measure)}
                  className="group flex w-full items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-panel)] px-3 py-2.5 text-left transition duration-fast ease-spring hover:-translate-y-px hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  <GoalMeasureBadge measure={kind.measure} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-text-primary">{kind.title}</span>
                    <span className="block truncate text-xs text-text-muted">{kind.detail}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-text-muted transition duration-fast group-hover:translate-x-0.5 group-hover:text-text-primary"
                  >
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function GoalsWorkspace() {
  const { user } = useUser();
  const router = useRouter();
  const search = useSearchParams();
  const { feedback, success, showError, clear: clearFeedback } = useFeedback();
  const workspace = useGoalsWorkspace({ uid: user.uid, onError: showError });
  const context = useGoalContext(user.uid);
  const history = useGoalHistory(user.uid, showError);
  const [composer, setComposer] = useState<ComposerState>(() => {
    // A link from elsewhere -- the planner's "set a goal for this exam" -- opens the composer filled in.
    const intent = readGoalIntent(search);
    return intent ? { mode: "create", draft: draftForIntent(intent, Date.now()), key: 0 } : { mode: "closed" };
  });
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState<Goal | null>(null);
  const [endingBusy, setEndingBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // The link has done its job once the composer is open; a reload should not reopen it.
  const linkClearedRef = useRef(false);
  useEffect(() => {
    if (linkClearedRef.current || !search.get("new")) return;
    linkClearedRef.current = true;
    router.replace(GOALS_PATH, { scroll: false });
  }, [router, search]);

  const goals = useMemo(() => sortGoalsForDisplay(workspace.goals), [workspace.goals]);

  const ideas = useMemo(
    () =>
      goalIdeas({
        now: workspace.now,
        activeGoals: workspace.goals,
        dueCardCount: context.dueCardCount,
        recentReviewCounts: context.recentReviewCounts,
        nextExam: context.exams[0],
        engineTopics: context.engineTopics,
      }),
    [context.dueCardCount, context.engineTopics, context.exams, context.recentReviewCounts, workspace.goals, workspace.now]
  );

  const composerOptions = useMemo<GoalComposerOptions>(() => {
    /*
     * The exam a goal arrived with stays choosable: one a running goal was set
     * for, even if the plan has moved on, and one a link or an idea brought in
     * before the plan itself has loaded.
     */
    const arrivedWith =
      composer.mode === "edit" ? composer.goal.exam : composer.mode === "create" ? composer.draft.exam : undefined;
    const exams = context.exams.map(({ planId, examId, label, dayKey }) => ({ planId, examId, label, dayKey }));
    return {
      folders: context.folders.map((folder) => ({ id: folder.id, label: folder.name })),
      decks: context.decks.map((deck) => ({ id: deck.id, label: deck.name })),
      topics: context.topics.map((topic) => ({ id: topic.id, label: topic.name })),
      exams: arrivedWith && !exams.some((exam) => exam.examId === arrivedWith.examId) ? [arrivedWith, ...exams] : exams,
    };
  }, [composer, context.decks, context.exams, context.folders, context.topics]);

  const openComposer = useCallback(
    (draft?: GoalDraft) => {
      clearFeedback();
      setComposer({ mode: "create", draft: draft ?? blankGoalDraft("cards", Date.now()), key: Date.now() });
      scrollToComposer();
    },
    [clearFeedback]
  );

  const pickSuggestion = useCallback((suggestion: GoalSuggestion) => openComposer(suggestion.draft), [openComposer]);

  const handleCreate = async (draft: GoalDraft) => {
    setSaving(true);
    try {
      await workspace.create(draft);
      setComposer({ mode: "closed" });
      success("Goal set. Finish it to earn its star.");
    } catch (error) {
      console.error("Failed to create a goal.", error);
      showError("That goal could not be saved. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (goal: Goal, edit: GoalEdit) => {
    setSaving(true);
    try {
      const saved = await workspace.edit(goal, edit);
      setComposer({ mode: "closed" });
      if (saved.status === "completed") {
        history.prepend(saved);
        success("Goal complete: you had already done enough for the new target.");
      } else {
        success("Goal saved.");
      }
    } catch (error) {
      console.error("Failed to save a goal.", error);
      showError("Your changes could not be saved. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  const confirmEnd = async () => {
    if (!ending) return;
    setEndingBusy(true);
    try {
      const ended = await workspace.end(ending);
      history.prepend(ended);
      if (composer.mode === "edit" && composer.goal.id === ending.id) setComposer({ mode: "closed" });
      success("Goal ended. You can find it in past goals.");
      setEnding(null);
    } catch (error) {
      console.error("Failed to end a goal.", error);
      showError("That goal could not be ended just now.");
    } finally {
      setEndingBusy(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    clearFeedback();
    try {
      await Promise.all([workspace.reload({ force: true }), history.loaded ? history.load() : Promise.resolve()]);
    } finally {
      setRefreshing(false);
    }
  };

  const composerOpen = composer.mode !== "closed";
  // With nothing running, the welcome panel carries the one button to make a goal.
  const welcoming = !composerOpen && !workspace.loading && !workspace.unavailable && goals.length === 0;
  const runningTitle = workspace.loading
    ? "Goals"
    : goals.length === 0
      ? "Nothing running yet"
      : `${goals.length} ${goals.length === 1 ? "goal" : "goals"} in progress`;

  return (
    <Refreshable onRefresh={handleRefresh}>
      <AppPage
        title="Goals"
        backHref="/dashboard"
        backLabel="Today"
        width="2xl"
        action={<RefreshIconButton refreshing={refreshing} onClick={() => void handleRefresh()} />}
        contentClassName="space-y-6 sm:space-y-8"
      >
        {feedback ? (
          <FeedbackBanner type={feedback.type} message={feedback.message} onDismiss={() => clearFeedback()} />
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-text-muted">Running</p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">{runningTitle}</h2>
          </div>
          {!composerOpen && !welcoming ? (
            <Button type="button" variant="warm" data-tutorial-target="new-goal" onClick={() => openComposer()}>
              New goal
            </Button>
          ) : null}
        </div>

        {composer.mode !== "closed" ? (
          <GoalComposer
            key={composer.key}
            {...(composer.mode === "edit" ? { editing: composer.goal } : {})}
            initialDraft={composer.mode === "edit" ? goalToDraft(composer.goal) : composer.draft}
            options={composerOptions}
            ideas={composer.mode === "create" ? ideas : []}
            saving={saving}
            onCancel={() => setComposer({ mode: "closed" })}
            onCreate={(draft) => void handleCreate(draft)}
            onSave={(goal, edit) => void handleSave(goal, edit)}
          />
        ) : null}

        {workspace.loading ? (
          <div className="grid gap-4 lg:grid-cols-2" aria-label="Loading goals">
            <Skeleton className="h-56 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
        ) : workspace.unavailable ? (
          <EmptyState
            emoji="Retry"
            eyebrow="Goals unavailable"
            title="Your goals could not load"
            description="Nothing has been lost. Try loading them again."
            action={
              <Button type="button" variant="secondary" onClick={() => void workspace.reload()}>
                Try again
              </Button>
            }
          />
        ) : goals.length === 0 ? (
          composerOpen ? null : (
            <div className="space-y-6">
              <GoalsWelcome onNew={(measure) => openComposer(blankGoalDraft(measure, Date.now()))} />
              <GoalSuggestions
                suggestions={ideas}
                now={workspace.now}
                title="Or start from one of these"
                onPick={pickSuggestion}
              />
            </div>
          )
        ) : (
          <div className="grid animate-slide-up gap-4 lg:grid-cols-2">
            {goals.map((goal) => {
              const folderId = goal.scope.type === "folder" ? goal.scope.id : undefined;
              const topicAction =
                goal.measure === "topic" && folderId
                  ? workspace.standings.get(folderId)?.find((topic) => topic.key === goal.topic?.key)?.action
                  : undefined;
              return (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  standing={goalStanding(goal, workspace.now)}
                  nextStep={goalNextStep(goal, {
                    decks: context.decks,
                    folders: context.folders,
                    ...(topicAction ? { topicAction } : {}),
                  })}
                  busy={saving || (endingBusy && ending?.id === goal.id)}
                  onEdit={() => {
                    clearFeedback();
                    setComposer({ mode: "edit", goal, key: Date.now() });
                    scrollToComposer();
                  }}
                  onEnd={() => setEnding(goal)}
                />
              );
            })}
          </div>
        )}

        {!composerOpen && goals.length > 0 && !workspace.loading ? (
          <GoalSuggestions suggestions={ideas.slice(0, RUNNING_IDEAS)} now={workspace.now} onPick={pickSuggestion} />
        ) : null}

        <GoalHistory
          items={history.items}
          loaded={history.loaded}
          loading={history.loading}
          unavailable={history.unavailable}
          hasMore={history.hasMore}
          onLoad={(options) => void history.load(options)}
          onRepeat={(goal) => openComposer(repeatGoalDraft(goal, Date.now()))}
        />

        <ConfirmDialog
          open={Boolean(ending)}
          title="End this goal?"
          description={
            ending
              ? `"${getGoalDisplayName(ending)}" will move to your past goals with the progress it made. It won't earn a star.`
              : ""
          }
          confirmLabel="End goal"
          cancelLabel="Keep going"
          busy={endingBusy}
          tone="danger"
          onConfirm={() => void confirmEnd()}
          onClose={() => setEnding(null)}
        />
      </AppPage>
      <StarRewardOverlay reward={workspace.reward} onDone={workspace.dismissReward} />
    </Refreshable>
  );
}

/**
 * Goals: targets a student sets themselves, paced for them, each one a star
 * when it is done.
 */
export default function GoalsPage() {
  return (
    <Suspense
      fallback={
        <AppPage title="Goals" backHref="/dashboard" backLabel="Today" width="2xl">
          <Skeleton className="h-56 rounded-2xl" />
        </AppPage>
      }
    >
      <GoalsWorkspace />
    </Suspense>
  );
}
