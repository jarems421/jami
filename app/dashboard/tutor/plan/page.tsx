"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppPage from "@/components/layout/AppPage";
import { EmptyState, FeedbackBanner, Skeleton } from "@/components/ui";
import RevisionPlanner from "@/components/planning/RevisionPlanner";
import type { PlanScopeOption } from "@/components/planning/RevisionPlanBuilder";
import type { PlanNotice } from "@/lib/ai/assistant-plan";
import { useUser } from "@/components/providers/UserProvider";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useFeedback } from "@/hooks/useFeedback";
import { featureFlags } from "@/lib/app/feature-flags";
import type { Topic } from "@/lib/material/topics";
import type { PlanActivity, RevisionPlan, RevisionPlanEntry } from "@/lib/planning/types";
import type { Card } from "@/lib/study/cards";
import type { Deck } from "@/lib/study/decks";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import { loadPlanNotices } from "@/services/planning/plan-draft";
import { archiveRevisionPlan, loadRevisionPlans } from "@/services/planning/revision-plans";
import { loadUserCards } from "@/services/study/cards";
import { getDecks } from "@/services/study/decks";
import { getActiveStudyFolders } from "@/services/study/folders";
import { getActiveTopics } from "@/services/study/topics";

/**
 * Where a revision plan is made and looked after: the student's timetable,
 * with Jami beside it.
 *
 * A student who knows what they want builds it themselves; one who would
 * rather not tells Jami about their exams and their week and watches it build
 * one. Both arrive at the same timetable, and either can switch to the other
 * way at any time without starting again.
 */

/**
 * Whether a read failed because the rules refused it.
 *
 * Worth telling apart from an ordinary outage: a student can retry a network
 * blip forever and it will never work if the rules for this collection have not
 * reached the project. Saying "try again in a moment" to that is sending
 * somebody to press a button that cannot succeed.
 */
function isPermissionDenied(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "permission-denied"
  );
}

export default function RevisionPlanPage() {
  const { user } = useUser();
  const { feedback, showError, clear } = useFeedback();
  const [plans, setPlans] = useState<RevisionPlan[]>([]);
  const [folders, setFolders] = useState<StudyFolder[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [notices, setNotices] = useState<PlanNotice[]>([]);
  /** Set when saved plans could not be read, which is not the same as having none. */
  const [plansUnavailable, setPlansUnavailable] = useState<"denied" | "error" | null>(null);
  /** The days a plan was saved with, so the planner shows them at once rather than reading them back. */
  const [savedDays, setSavedDays] = useState<{ planId: string; entries: RevisionPlanEntry[] } | null>(null);

  const uid = user?.uid;

  const load = useCallback(async () => {
    if (!uid) {
      return { plans: [], folders: [], decks: [], plansProblem: null as "denied" | "error" | null };
    }
    /*
     * The saved plans are read on their own terms. A student who has never
     * made a plan -- or whose project has not yet been given the rules for the
     * collection -- should still get a page whose job is making their first.
     */
    const [plansResult, loadedFolders, loadedDecks] = await Promise.all([
      loadRevisionPlans(uid).then(
        (loaded) => ({ plans: loaded, problem: null as "denied" | "error" | null }),
        (error: unknown) => ({
          plans: [] as RevisionPlan[],
          problem: (isPermissionDenied(error) ? "denied" : "error") as "denied" | "error",
        })
      ),
      getActiveStudyFolders(uid),
      getDecks(uid),
    ]);
    return { plans: plansResult.plans, plansProblem: plansResult.problem, folders: loadedFolders, decks: loadedDecks };
  }, [uid]);

  const { loading } = useDashboardData({
    requestKey: uid ?? "",
    load,
    apply: (value) => {
      setPlans(value.plans);
      setPlansUnavailable(value.plansProblem);
      setFolders(value.folders);
      setDecks(value.decks);
      // What Jami noticed is worth having ready before anyone types, and it is
      // never worth blocking the page for.
      void loadPlanNotices().then(setNotices);
    },
    onError: () =>
      showError("Your folders and decks could not be loaded, so there is nothing to plan over yet."),
  });

  /*
   * Cards and Topics, read behind the timetable: cards to see what was studied
   * and what each subject can fall back on, Topics to offer when a student
   * names one. The planner draws without either.
   */
  useEffect(() => {
    if (!uid) return;
    let live = true;
    void loadUserCards(uid).then(
      (loaded) => live && setCards(loaded),
      () => undefined
    );
    void getActiveTopics(uid).then(
      (loaded) => live && setTopics(loaded),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [uid]);

  const active = plans.find((plan) => plan.status === "active") ?? null;

  const options = useMemo<PlanScopeOption[]>(
    () => [
      ...folders.map((folder) => ({ key: `folder:${folder.id}`, label: folder.name, folderId: folder.id })),
      // Decks that sit in no folder: the Learning Engine scopes a profile to one
      // or the other, and a loose deck would otherwise be unreachable from here.
      ...decks
        .filter((deck) => (deck.folderIds?.length ?? 0) === 0)
        .map((deck) => ({ key: `deck:${deck.id}`, label: deck.name, deckId: deck.id })),
    ],
    [decks, folders]
  );

  const handleSaved = useCallback((saved: RevisionPlan, days?: ReadonlyMap<string, PlanActivity[]>) => {
    setPlans((current) => [saved, ...current.filter((plan) => plan.id !== saved.id)]);
    if (days) {
      setSavedDays({
        planId: saved.id,
        entries: [...days].map(([dayKey, activities]) => ({ dayKey, activities })),
      });
    }
  }, []);

  const handleArchive = useCallback(async () => {
    if (!uid || !active) return;
    clear();
    try {
      await archiveRevisionPlan(uid, active.id);
      setPlans((current) => current.map((plan) => (plan.id === active.id ? { ...plan, status: "archived" } : plan)));
    } catch {
      showError("That plan could not be finished. Try again.");
    }
  }, [active, clear, showError, uid]);

  if (!featureFlags.enableRevisionPlans) {
    return (
      <AppPage title="Revision plan">
        <EmptyState title="Revision plans aren't switched on" description="This surface is still being finished." />
      </AppPage>
    );
  }

  return (
    <AppPage title="Revision plan" width="2xl">
      {feedback ? <FeedbackBanner type={feedback.type} message={feedback.message} onDismiss={clear} /> : null}

      {/*
        * Said once, quietly, and not in place of the page. A student can still
        * build a plan while this is true; what they cannot do is keep it.
        */}
      {plansUnavailable ? (
        <p className="app-subtle-panel rounded-xl px-4 py-3 text-sm leading-6 text-text-secondary">
          {plansUnavailable === "denied"
            ? "Saved plans can't be read on this project yet — the Firestore rules for them still need deploying. You can build a plan here, but it won't save until then."
            : "Jami couldn't read your saved plans just now. You can still build one, and anything already saved will reappear once the connection settles."}
        </p>
      ) : null}

      {loading || !uid ? (
        <Skeleton className="h-[32rem] w-full rounded-2xl" />
      ) : (
        <RevisionPlanner
          // A new plan, or a plan finished, is a new planner: nothing of the last one carries over.
          key={active?.id ?? "draft"}
          uid={uid}
          savedPlan={active}
          {...(active && savedDays?.planId === active.id ? { initialEntries: savedDays.entries } : {})}
          options={options}
          folders={folders}
          decks={decks}
          cards={cards}
          topics={topics}
          notices={notices}
          onPlanSaved={handleSaved}
          onArchive={() => void handleArchive()}
        />
      )}
    </AppPage>
  );
}
