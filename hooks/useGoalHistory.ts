"use client";

import { useCallback, useRef, useState } from "react";
import type { Goal } from "@/lib/goals/model";
import { getGoalHistoryPage, type GoalHistoryCursor } from "@/services/study/goals";

const HISTORY_PAGE_SIZE = 30;

/**
 * A student's past goals, read a page at a time and only once they ask.
 *
 * Most visits to Goals are about what is running now; the history is there for
 * the student who wants to look back, so it costs nothing until they open it.
 */
export function useGoalHistory(uid: string, onError: (message: string) => void) {
  const [items, setItems] = useState<Goal[]>([]);
  const [cursor, setCursor] = useState<GoalHistoryCursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const loadingRef = useRef(false);
  const cursorRef = useRef<GoalHistoryCursor | null>(null);

  const load = useCallback(
    async (options: { append?: boolean } = {}) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setUnavailable(false);
      try {
        const page = await getGoalHistoryPage(uid, {
          cursor: options.append ? cursorRef.current : null,
          pageSize: HISTORY_PAGE_SIZE,
        });
        setItems((current) => {
          const next = options.append ? [...current, ...page.items] : page.items;
          return Array.from(new Map(next.map((goal) => [goal.id, goal])).values()).sort(
            (left, right) => right.createdAt - left.createdAt
          );
        });
        cursorRef.current = page.nextCursor;
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (error) {
        console.error("Failed to load goal history.", error);
        setUnavailable(true);
        onError("Could not load your past goals. Try again in a moment.");
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [onError, uid]
  );

  /** A goal that has just finished or ended, shown at once without a re-read. */
  const prepend = useCallback(
    (goal: Goal) => {
      if (!loaded) return;
      setItems((current) => [goal, ...current.filter((item) => item.id !== goal.id)]);
    },
    [loaded]
  );

  return { items, hasMore: cursor !== null, loaded, loading, unavailable, load, prepend };
}
