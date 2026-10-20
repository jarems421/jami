"use client";

import { useCallback, useEffect, useState } from "react";
import { claimGoalRewards, type GoalReward } from "@/services/study/goals";

/** Long enough for Today to have drawn first: a star should arrive on a page, not ahead of it. */
const CLAIM_DELAY_MS = 1_500;

/**
 * Stars waiting from goals that finished away from any screen -- a practice
 * answer marked on the server, most often -- lit when Today opens.
 *
 * One small query, after the page has drawn, and usually it finds nothing.
 */
export function useWaitingGoalStars(uid: string) {
  const [rewards, setRewards] = useState<GoalReward[]>([]);

  useEffect(() => {
    if (!uid) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void claimGoalRewards(uid)
        .then((earned) => {
          if (live && earned.length > 0) setRewards((current) => [...current, ...earned]);
        })
        .catch(() => undefined);
    }, CLAIM_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [uid]);

  const dismiss = useCallback(() => setRewards((current) => current.slice(1)), []);
  return { reward: rewards[0] ?? null, dismiss };
}
