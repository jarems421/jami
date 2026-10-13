"use client";

import { useCallback, useEffect, useState } from "react";
import type { NotebookPageLearningView } from "@/lib/learning/notebook-page-context";
import {
  forgetNotebookPageLearningView,
  loadNotebookPageLearningView,
} from "@/services/learning/notebook-page-view";

/**
 * Where the open notebook page sits in the Learning Engine, while Tutor is open.
 *
 * Asked for only when Tutor is open on a page -- a student who never opens it
 * costs the engine nothing -- and dropped the moment the page changes, so the
 * starting points never describe the page before. Null until it arrives, and
 * null when it cannot be had: the notebook's own starting points stand in.
 */
export function useNotebookPageLearning(input: {
  notebookId: string | undefined;
  pageId: string | undefined;
  enabled: boolean;
}) {
  const { notebookId, pageId, enabled } = input;
  const [loaded, setLoaded] = useState<{ key: string; view: NotebookPageLearningView | null } | null>(
    null
  );
  const [version, setVersion] = useState(0);
  const key = notebookId && pageId ? `${notebookId}:${pageId}:${version}` : "";

  useEffect(() => {
    if (!enabled || !notebookId || !pageId || !key) return;
    let cancelled = false;
    void loadNotebookPageLearningView(notebookId, pageId).then((view) => {
      if (!cancelled) setLoaded({ key, view });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, notebookId, pageId]);

  /** Ask again, after the student changes what the page is about. */
  const refresh = useCallback(() => {
    if (notebookId && pageId) forgetNotebookPageLearningView(notebookId, pageId);
    setVersion((current) => current + 1);
  }, [notebookId, pageId]);

  return { view: loaded?.key === key ? loaded.view : null, refresh };
}
