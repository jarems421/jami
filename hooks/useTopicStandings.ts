"use client";

import { useCallback, useEffect, useState } from "react";
import type { TopicStanding } from "@/lib/goals/topic-standing";
import { loadTopicStandings } from "@/services/learning/topic-standing";

type Entry = { status: "ready" | "error"; topics: TopicStanding[] };

/**
 * One folder's topics and where the engine puts each, for choosing a topic goal.
 *
 * Answers are kept per folder, so switching back to a folder already read is
 * instant and nothing is shown for a folder that was not asked about.
 */
export function useTopicStandings(folderId: string | undefined) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!folderId) return;
    let live = true;
    loadTopicStandings(folderId, { force: attempt > 0 }).then(
      (topics) => {
        if (live) setEntries((current) => ({ ...current, [folderId]: { status: "ready", topics } }));
      },
      () => {
        if (live) setEntries((current) => ({ ...current, [folderId]: { status: "error", topics: [] } }));
      }
    );
    return () => {
      live = false;
    };
  }, [attempt, folderId]);

  const retry = useCallback(() => {
    if (!folderId) return;
    setEntries((current) => {
      const next = { ...current };
      delete next[folderId];
      return next;
    });
    setAttempt((value) => value + 1);
  }, [folderId]);

  const entry = folderId ? entries[folderId] : undefined;
  return {
    status: !folderId ? ("idle" as const) : entry ? entry.status : ("loading" as const),
    topics: entry?.topics ?? [],
    retry,
  };
}
