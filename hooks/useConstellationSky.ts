"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardData } from "@/hooks/useDashboardData";
import {
  getActiveConstellation,
  getFallbackConstellation,
  type Constellation,
} from "@/lib/constellation/constellations";
import { spreadBackfilledStars, type NormalizedStar } from "@/lib/constellation/stars";
import type { Goal } from "@/lib/goals/model";
import { ensureConstellationSetup } from "@/services/constellation/constellations";
import { backfillStarPositions, getStars } from "@/services/constellation/stars";
import { getGoals } from "@/services/study/goals";

/** Coming back to the tab sooner than this does not reload the sky again. */
const FOREGROUND_REFRESH_MS = 15_000;

/**
 * The student's skies, their stars and the goals that earned them.
 *
 * Owns loading -- including placing any star that was saved without a position
 * -- reloading when the student returns to the tab, and which sky is open. The
 * open sky survives a reload while it still exists, and otherwise falls back
 * to the one collecting stars.
 *
 * The setters are handed back because arranging, drawing and Jami's patterns
 * all change the sky optimistically before their writes land.
 */
export function useConstellationSky({
  uid,
  onLoadError,
}: {
  uid: string;
  onLoadError: (message: string) => void;
}) {
  const [constellations, setConstellations] = useState<Constellation[]>([]);
  const [allStars, setAllStars] = useState<NormalizedStar[]>([]);
  const [goalsById, setGoalsById] = useState<Record<string, Goal>>({});
  const [selectedConstellationId, setSelectedConstellationId] = useState("");
  const lastForegroundRefreshAtRef = useRef(0);

  const loadConstellationData = useCallback(async () => {
    const nextConstellations = await ensureConstellationSetup(uid);
    const [stars, goals] = await Promise.all([getStars(uid), getGoals(uid)]);
    let adjustedStars = spreadBackfilledStars(stars).sort(
      (left, right) => right.createdAt - left.createdAt
    );

    if (adjustedStars.some((star) => star.needsBackfill)) {
      await backfillStarPositions(uid, adjustedStars);
      adjustedStars = adjustedStars.map((star) =>
        star.needsBackfill ? { ...star, needsBackfill: false } : star
      );
    }

    return {
      constellations: nextConstellations,
      stars: adjustedStars,
      goalsById: Object.fromEntries(goals.map((goal) => [goal.id, goal])),
      fallbackConstellationId: getFallbackConstellation(nextConstellations)?.id ?? "",
    };
  }, [uid]);

  const applyConstellationData = useCallback(
    (data: Awaited<ReturnType<typeof loadConstellationData>>) => {
      setConstellations(data.constellations);
      setAllStars(data.stars);
      setGoalsById(data.goalsById);
      setSelectedConstellationId((currentId) =>
        currentId && data.constellations.some((constellation) => constellation.id === currentId)
          ? currentId
          : data.fallbackConstellationId
      );
    },
    []
  );

  const handleLoadError = useCallback(
    (error: unknown) => {
      console.error(error);
      setConstellations([]);
      setAllStars([]);
      setGoalsById({});
      setSelectedConstellationId("");
      onLoadError("Failed to load your constellation.");
    },
    [onLoadError]
  );

  const { loading, reload } = useDashboardData({
    requestKey: uid,
    load: loadConstellationData,
    apply: applyConstellationData,
    onError: handleLoadError,
  });

  useEffect(() => {
    const handleFocus = () => {
      const now = Date.now();
      if (
        document.visibilityState !== "hidden" &&
        now - lastForegroundRefreshAtRef.current > FOREGROUND_REFRESH_MS
      ) {
        lastForegroundRefreshAtRef.current = now;
        void reload();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [reload]);

  const selectedConstellation = useMemo(
    () =>
      constellations.find((constellation) => constellation.id === selectedConstellationId) ??
      getFallbackConstellation(constellations),
    [constellations, selectedConstellationId]
  );

  const activeConstellation = useMemo(
    () => getActiveConstellation(constellations),
    [constellations]
  );

  const visibleStars = useMemo(
    () =>
      selectedConstellation
        ? allStars.filter((star) => star.constellationId === selectedConstellation.id)
        : [],
    [allStars, selectedConstellation]
  );

  return {
    loading,
    reload,
    constellations,
    setConstellations,
    setAllStars,
    goalsById,
    selectConstellation: setSelectedConstellationId,
    selectedConstellation,
    activeConstellation,
    visibleStars,
  };
}
