"use client";

import { useEffect, useState } from "react";
import type { NotebookLearningView } from "@/lib/learning/notebook-page-context";
import { loadNotebookLearningView } from "@/services/learning/notebook-learning-view";

/**
 * The notebook's place in the Learning Engine, once Tutor has been opened in it.
 *
 * Asked for once per notebook -- a student who never opens Tutor costs the
 * engine nothing -- and kept while the notebook is open, so turning a page
 * asks nothing. `settled` says the answer is in, even when it is that there is
 * none: the notebook's own starting points then stand.
 */
export function useNotebookLearning(input: { notebookId: string | undefined; enabled: boolean }) {
  const { notebookId, enabled } = input;
  const [loaded, setLoaded] = useState<{ notebookId: string; view: NotebookLearningView | null } | null>(
    null
  );

  useEffect(() => {
    if (!enabled || !notebookId || loaded?.notebookId === notebookId) return;
    let cancelled = false;
    void loadNotebookLearningView(notebookId).then((view) => {
      if (!cancelled) setLoaded({ notebookId, view });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, loaded?.notebookId, notebookId]);

  const current = notebookId && loaded?.notebookId === notebookId ? loaded : null;
  return { view: current?.view ?? null, settled: current !== null };
}
