"use client";

import { useEffect, useMemo, useState } from "react";
import { buildPlanCompletionEvidence, type PlanCompletionCard, type PlanCompletionDeck } from "@/lib/planning/plan-completion";
import { getStudyDayKey } from "@/lib/study/day";
import { loadCompletedStudyActions } from "@/services/learning/study-action-events";

/**
 * What Jami can see was done, for the days on screen: sessions finished from a
 * task's own link, for any of them, and today's card reviews.
 *
 * Read once per range, never blocking the timetable: until it arrives, a day
 * shows only what was ticked.
 */
export function usePlanCompletion(input: {
  uid: string;
  enabled: boolean;
  fromDayKey: string;
  toDayKey: string;
  todayDayKey: string;
  cards: readonly PlanCompletionCard[];
  decks: readonly PlanCompletionDeck[];
}) {
  const { uid, enabled, fromDayKey, todayDayKey } = input;
  // Nothing after today can have been finished.
  const toDayKey = input.toDayKey < todayDayKey ? input.toDayKey : todayDayKey;
  const key = `${uid}|${fromDayKey}|${toDayKey}`;
  const [finished, setFinished] = useState<{ key: string; byDay: Map<string, Set<string>> } | null>(null);

  useEffect(() => {
    if (!enabled || !uid || fromDayKey > toDayKey) return;
    let live = true;
    void loadCompletedStudyActions(uid, fromDayKey, toDayKey).then((byDay) => {
      if (live) setFinished({ key: `${uid}|${fromDayKey}|${toDayKey}`, byDay });
    });
    return () => {
      live = false;
    };
  }, [enabled, fromDayKey, toDayKey, uid]);

  const byDay = finished?.key === key ? finished.byDay : undefined;
  return useMemo(
    () =>
      enabled
        ? buildPlanCompletionEvidence({
            cards: input.cards,
            decks: input.decks,
            reviewDayKey: todayDayKey,
            dayOf: getStudyDayKey,
            ...(byDay ? { completedActionIds: byDay } : {}),
          })
        : undefined,
    [byDay, enabled, input.cards, input.decks, todayDayKey]
  );
}
