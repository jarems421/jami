"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardData } from "@/hooks/useDashboardData";
import type { Goal, GoalDraft, GoalEdit } from "@/lib/goals/model";
import type { TopicStanding } from "@/lib/goals/topic-standing";
import { featureFlags } from "@/lib/app/feature-flags";
import { loadTopicStandings } from "@/services/learning/topic-standing";
import {
  claimGoalRewards,
  createGoal,
  editGoal,
  endGoal,
  getActiveGoalsWithCurrentStatuses,
  recordTopicReadings,
  type GoalReward,
} from "@/services/study/goals";

/** Folders read for topic goals at once; each is a profile built on the server. */
const TOPIC_FOLDER_LIMIT = 3;
/** Coming back to the tab re-reads goals at most this often. */
const FOREGROUND_REFRESH_MS = 15_000;

function topicFolders(goals: readonly Goal[]) {
  const folders = new Set<string>();
  for (const goal of goals) {
    if (goal.measure === "topic" && goal.status === "active" && goal.scope.type === "folder" && goal.scope.id) {
      folders.add(goal.scope.id);
    }
  }
  return [...folders].slice(0, TOPIC_FOLDER_LIMIT);
}

/**
 * The running goals on the Goals page, and everything that changes them.
 *
 * Goals draw as soon as they are read. Two things then happen behind them:
 * stars waiting from goals that finished elsewhere are lit, and topic goals ask
 * the Learning Engine where their topics now stand. Neither holds up the page,
 * and neither failing does anything worse than leave a goal as it was.
 */
export function useGoalsWorkspace(input: {
  uid: string;
  onError: (message: string) => void;
}) {
  const { uid, onError } = input;
  const [goals, setGoals] = useState<Goal[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [rewards, setRewards] = useState<GoalReward[]>([]);
  const [standings, setStandings] = useState<ReadonlyMap<string, readonly TopicStanding[]>>(new Map());
  const [checkingTopics, setCheckingTopics] = useState(false);
  /** When the goals on screen were read, so every standing is worked out against the same moment. */
  const [now, setNow] = useState(() => Date.now());
  const lastForegroundRefreshAtRef = useRef(0);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  /** Folds goals changed behind the page into what is shown, dropping any that finished. */
  const merge = useCallback((changed: readonly Goal[]) => {
    const byId = new Map(changed.map((goal) => [goal.id, goal]));
    setGoals((current) =>
      current.map((goal) => byId.get(goal.id) ?? goal).filter((goal) => goal.status === "active")
    );
  }, []);

  const celebrate = useCallback((earned: readonly GoalReward[]) => {
    if (earned.length > 0) setRewards((current) => [...current, ...earned]);
  }, []);

  const checkTopics = useCallback(
    async (candidates: readonly Goal[]) => {
      const folders = featureFlags.enableLearnerProfile ? topicFolders(candidates) : [];
      if (folders.length === 0) return;
      setCheckingTopics(true);
      try {
        const read = await Promise.allSettled(folders.map((folderId) => loadTopicStandings(folderId)));
        const byFolder = new Map<string, readonly TopicStanding[]>();
        read.forEach((result, index) => {
          if (result.status === "fulfilled") byFolder.set(folders[index]!, result.value);
        });
        if (byFolder.size === 0) return;
        setStandings((current) => new Map([...current, ...byFolder]));
        const recorded = await recordTopicReadings(uid, candidates, byFolder);
        merge(recorded.changed);
        celebrate(recorded.rewards);
      } catch (error) {
        console.warn("Could not check topic goals.", error);
      } finally {
        setCheckingTopics(false);
      }
    },
    [celebrate, merge, uid]
  );

  const settleBehind = useCallback(
    (loaded: readonly Goal[]) => {
      void claimGoalRewards(uid)
        .then(celebrate)
        .catch((error: unknown) => console.warn("Could not light waiting stars.", error));
      void checkTopics(loaded);
    },
    [celebrate, checkTopics, uid]
  );

  const load = useCallback(() => getActiveGoalsWithCurrentStatuses(uid), [uid]);
  const apply = useCallback(
    (loaded: Goal[]) => {
      setGoals(loaded);
      setNow(Date.now());
      setUnavailable(false);
      settleBehind(loaded);
    },
    [settleBehind]
  );
  const handleLoadError = useCallback((error: unknown) => {
    console.error("Failed to load goals.", error);
    setUnavailable(true);
    onErrorRef.current("Your goals could not load.");
  }, []);

  const { loading, reload } = useDashboardData({ requestKey: uid, load, apply, onError: handleLoadError });

  useEffect(() => {
    const handleFocus = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden" || now - lastForegroundRefreshAtRef.current < FOREGROUND_REFRESH_MS) {
        return;
      }
      lastForegroundRefreshAtRef.current = now;
      void reload();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [reload]);

  const create = useCallback(
    async (draft: GoalDraft) => {
      const goal = await createGoal(uid, draft);
      setGoals((current) => [goal, ...current]);
      if (goal.measure === "topic") void checkTopics([goal]);
      return goal;
    },
    [checkTopics, uid]
  );

  /** Saves an edit; returns the goal as it now stands, which may have just finished. */
  const edit = useCallback(
    async (goal: Goal, change: GoalEdit) => {
      const saved = await editGoal(uid, goal, change);
      merge([saved.goal]);
      celebrate(saved.rewards);
      return saved.goal;
    },
    [celebrate, merge, uid]
  );

  const end = useCallback(
    async (goal: Goal) => {
      await endGoal(uid, goal.id);
      setGoals((current) => current.filter((item) => item.id !== goal.id));
      return { ...goal, status: "cancelled" as const };
    },
    [uid]
  );

  const dismissReward = useCallback(() => setRewards((current) => current.slice(1)), []);

  return {
    goals,
    now,
    loading,
    unavailable,
    reload,
    standings,
    checkingTopics,
    reward: rewards[0] ?? null,
    dismissReward,
    create,
    edit,
    end,
  };
}
