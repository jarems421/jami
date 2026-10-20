"use client";

import { useEffect, useMemo, useState } from "react";
import { featureFlags } from "@/lib/app/feature-flags";
import {
  engineTopicsFromActions,
  upcomingPlanExams,
  type GoalSuggestionExam,
  type GoalSuggestionTopic,
} from "@/lib/goals/suggestions";
import type { Topic } from "@/lib/material/topics";
import type { RevisionPlan } from "@/lib/planning/types";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";
import type { Deck } from "@/lib/study/decks";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import { getCachedDashboardSnapshot } from "@/services/dashboard/today";
import {
  getCachedStudyActions,
  loadStudyActionsForToday,
  readStoredStudyActions,
  type StudyActionsResponse,
} from "@/services/learning/study-actions";
import { loadActiveRevisionPlan } from "@/services/planning/revision-plans";
import { getDecks } from "@/services/study/decks";
import { getActiveStudyFolders } from "@/services/study/folders";
import { getActiveTopics } from "@/services/study/topics";

/** How many recent study days the habit suggestion looks back over. */
const RECENT_DAYS = 7;

export type GoalContext = {
  decks: Deck[];
  folders: StudyFolder[];
  topics: Topic[];
  /** Exams in the student's active revision plan, soonest first. */
  exams: GoalSuggestionExam[];
  /** Topics the Learning Engine is recommending, in its order. */
  engineTopics: GoalSuggestionTopic[];
  dueCardCount: number;
  recentReviewCounts: number[];
  /** Whether a scope list could not load, so the composer can say so. */
  optionsFailed: boolean;
};

/**
 * Everything a goal can be pointed at, and everything Jami can suggest one from.
 *
 * The scope lists are read once. Suggestions come only from what the app
 * already has to hand -- Today's last snapshot, the engine's last answer and the
 * revision plan -- and asking the engine again happens behind the page, never
 * in front of it. A missing input means one fewer suggestion, not an error.
 */
export function useGoalContext(uid: string): GoalContext {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [folders, setFolders] = useState<StudyFolder[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [plan, setPlan] = useState<RevisionPlan | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [studyActions, setStudyActions] = useState<StudyActionsResponse | null>(
    () => getCachedStudyActions(uid) ?? readStoredStudyActions(uid)
  );
  const [snapshot] = useState(() => getCachedDashboardSnapshot(uid)?.snapshot ?? null);

  useEffect(() => {
    let live = true;
    void Promise.allSettled([getDecks(uid), getActiveTopics(uid), getActiveStudyFolders(uid)]).then(
      ([decksResult, topicsResult, foldersResult]) => {
        if (!live) return;
        if (decksResult.status === "fulfilled") setDecks(decksResult.value);
        if (topicsResult.status === "fulfilled") setTopics(topicsResult.value);
        if (foldersResult.status === "fulfilled") setFolders(foldersResult.value);
        const failed = [decksResult, topicsResult, foldersResult].filter((result) => result.status === "rejected");
        if (failed.length > 0) {
          console.warn("Some goal options failed to load.", failed);
          setOptionsFailed(true);
        }
      }
    );
    if (featureFlags.enableRevisionPlans) {
      void loadActiveRevisionPlan(uid)
        .then((active) => {
          if (live) setPlan(active);
        })
        .catch(() => undefined);
    }
    if (featureFlags.enableLearnerProfile && featureFlags.enableStudyActions) {
      // The same answer Today uses, kept for five minutes: usually already here.
      void loadStudyActionsForToday()
        .then((response) => {
          if (live) setStudyActions(response);
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [uid]);

  return useMemo(() => {
    const todayKey = getStudyDayKey();
    const folderNames = [
      ...folders.map((folder) => ({ id: folder.id, name: folder.name })),
      ...(studyActions?.folders ?? []),
    ];
    const since = shiftStudyDayKey(todayKey, -(RECENT_DAYS - 1));
    return {
      decks,
      folders,
      topics,
      exams: upcomingPlanExams(plan, todayKey, folderNames),
      engineTopics: engineTopicsFromActions(studyActions?.actions ?? [], folderNames),
      dueCardCount: snapshot?.dueCards.length ?? 0,
      recentReviewCounts: (snapshot?.studyActivity ?? [])
        .filter((day) => day.dayKey >= since && day.dayKey <= todayKey)
        .map((day) => day.reviewCount),
      optionsFailed,
    };
  }, [decks, folders, optionsFailed, plan, snapshot, studyActions, topics]);
}
