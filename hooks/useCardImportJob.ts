"use client";

import { useEffect, useState } from "react";
import type { CardImportSourceKind, VideoCardJob } from "@/lib/ai/video-card-jobs";
import { getRecentVideoCardJobs, getVideoCardJob } from "@/services/ai/video-card-jobs";

const POLL_MS = 2500;
const RESUMABLE_STATUSES: ReadonlyArray<VideoCardJob["status"]> = ["queued", "running", "ready"];

/**
 * A card import of these kinds: the one the student left running or waiting
 * for review, picked up again on opening, and followed every few seconds
 * while it is still being made.
 */
export function useCardImportJob(sourceKinds: readonly CardImportSourceKind[], deckId?: string) {
  const [job, setJob] = useState<VideoCardJob | null>(null);
  // The kinds are fixed per creator; reading them once keeps this to opening.
  const [kinds] = useState(sourceKinds);

  useEffect(() => {
    let active = true;
    void getRecentVideoCardJobs()
      .then((jobs) => {
        const resumable = jobs.find(
          (item) => kinds.includes(item.sourceKind) && (!deckId || item.deckId === deckId)
            && RESUMABLE_STATUSES.includes(item.status)
        );
        if (active && resumable) setJob((current) => current ?? resumable);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [kinds, deckId]);

  const activeJobId = job?.id;
  const inProgress = job?.status === "queued" || job?.status === "running";
  useEffect(() => {
    if (!activeJobId || !inProgress) return;
    let active = true;
    const polling = setInterval(
      () => void getVideoCardJob(activeJobId).then((next) => {
        if (active) setJob((current) =>
          current?.id === next.id && next.updatedAt >= current.updatedAt ? next : current);
      }).catch(() => undefined),
      POLL_MS
    );
    return () => {
      active = false;
      clearInterval(polling);
    };
  }, [activeJobId, inProgress]);

  return [job, setJob] as const;
}
