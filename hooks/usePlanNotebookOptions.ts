"use client";

import { useEffect, useState } from "react";
import { getActiveNotebooks } from "@/services/study/notebooks";

/** A notebook notebook work can be planned in. Its title is the student's, so it is shown as text only. */
export type PlanEditorNotebook = { id: string; title: string; folderId: string };

/**
 * The student's notebooks, for planning work in one of them. Read the first
 * time the editor needs them -- when notebook work is chosen -- and not before,
 * so planning anything else costs no read.
 */
export function usePlanNotebookOptions(uid: string, enabled: boolean) {
  const [notebooks, setNotebooks] = useState<PlanEditorNotebook[] | null>(null);

  useEffect(() => {
    if (!enabled || !uid || notebooks) return;
    let live = true;
    getActiveNotebooks(uid).then(
      (loaded) => {
        if (live) setNotebooks(loaded.map(({ id, title, folderId }) => ({ id, title, folderId })));
      },
      () => {
        if (live) setNotebooks([]);
      }
    );
    return () => {
      live = false;
    };
  }, [enabled, notebooks, uid]);

  return notebooks;
}
