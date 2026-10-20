"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { featureFlags } from "@/lib/app/feature-flags";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import { buildPlanSubjectSupport, type PlanDraftingContext } from "@/lib/planning/plan-drafting";
import { planScopeKey, type RevisionPlanScope } from "@/lib/planning/types";
import { loadPlanStudyActions } from "@/services/learning/study-actions";

/**
 * What Jami fills a plan's free sessions from: the Learning Engine's actions
 * for each of the plan's subjects, and what each subject can always fall back
 * on (its cards, its question bank).
 *
 * Asked for only while something needs it -- a free session to fill, a task to
 * check is still current -- and kept per subject for the session, so moving
 * between weeks costs nothing.
 */

const NO_ACTIONS: ReadonlyMap<string, readonly StudyAction[]> = new Map();
const NO_SCOPES: ReadonlySet<string> = new Set();

export type PlanDrafting = {
  /** Null until the engine has answered or failed: filling before then would use fallbacks needlessly. */
  context: PlanDraftingContext | null;
  /** What each subject can always fall back on, known at once. */
  support: PlanDraftingContext["support"];
  /** Subjects the engine actually answered for; suggestions are only ever made in these. */
  answered: ReadonlySet<string>;
  loading: boolean;
  refresh: () => Promise<void>;
};

export function usePlanDrafting(input: {
  scopes: readonly Pick<RevisionPlanScope, "folderId" | "deckId">[];
  decks: readonly { id: string; folderIds?: readonly string[] }[];
  cards: readonly { deckId: string }[];
  folders: readonly { id: string; examCourse?: unknown }[];
  enabled: boolean;
}): PlanDrafting {
  const scopeKeys = useMemo(
    () => [...new Set(input.scopes.map(planScopeKey).filter((key) => key !== "none"))].sort(),
    [input.scopes]
  );
  const key = scopeKeys.join(",");
  const engineOn = featureFlags.enableLearnerProfile && featureFlags.enableStudyActions;
  const [answer, setAnswer] = useState<{
    key: string;
    actionsByScope: ReadonlyMap<string, readonly StudyAction[]>;
    answered: ReadonlySet<string>;
  } | null>(null);

  useEffect(() => {
    if (!input.enabled || !key || !engineOn) return;
    let live = true;
    loadPlanStudyActions(key.split(","))
      .then((result) => {
        if (live) setAnswer({ key, actionsByScope: result.actionsByScope, answered: result.answered });
      })
      .catch(() => {
        if (live) setAnswer({ key, actionsByScope: NO_ACTIONS, answered: NO_SCOPES });
      });
    return () => {
      live = false;
    };
  }, [engineOn, input.enabled, key]);

  const refresh = useCallback(async () => {
    if (!key || !engineOn) return;
    try {
      const result = await loadPlanStudyActions(key.split(","), { force: true });
      setAnswer({ key, actionsByScope: result.actionsByScope, answered: result.answered });
    } catch {
      // The last answer stands.
    }
  }, [engineOn, key]);

  const support = useMemo(
    () =>
      buildPlanSubjectSupport({
        scopes: input.scopes,
        decks: input.decks,
        cards: input.cards,
        questionPracticeFolderIds: new Set(
          featureFlags.enablePastPaperPractice
            ? input.folders.filter((folder) => Boolean(folder.examCourse)).map((folder) => folder.id)
            : []
        ),
      }),
    [input.cards, input.decks, input.folders, input.scopes]
  );

  const current = answer?.key === key ? answer : null;
  // With the engine switched off there is nothing to wait for: the fallbacks are all there is.
  const settled = Boolean(current) || !engineOn || !key;
  const context = useMemo<PlanDraftingContext | null>(
    () => (settled ? { actionsByScope: current?.actionsByScope ?? NO_ACTIONS, support } : null),
    [current?.actionsByScope, settled, support]
  );

  return {
    context: input.enabled ? context : null,
    support,
    answered: current?.answered ?? NO_SCOPES,
    loading: input.enabled && !settled,
    refresh,
  };
}
