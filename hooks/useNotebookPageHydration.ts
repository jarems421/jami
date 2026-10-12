"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import type { NotebookInkController } from "@/hooks/useNotebookInkController";
import type { NotebookLoader } from "@/hooks/useNotebookLoader";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
import type { NotebookPersistenceController } from "@/hooks/useNotebookPersistenceController";
import { pageHasSavedInk, pageHasUnloadedInk } from "@/lib/workspace/notebook-page-ink-split";
import type { Notebook, NotebookPage } from "@/lib/workspace/notebooks";

type UseNotebookPageHydrationOptions = {
  /** The page on screen, or null while the notebook has none. */
  selectedPage: NotebookPage | null;
  /** The paper a page without its own falls back to. */
  notebook: Pick<Notebook, "pageColor" | "pageStyle"> | null;
  pageState: NotebookPageStore;
  ink: Pick<NotebookInkController, "inkReadyRef" | "setInkReady" | "clearHistory" | "setInkHasContent">;
  inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
  persistence: Pick<NotebookPersistenceController, "schedulePendingWork">;
  /** Bumped on every edit; reset to the recovered draft's revision, or 0. */
  editorRevisionRef: RefObject<number>;
  takeRecoveredDraft: NotebookLoader["takeRecoveredDraft"];
  resetTextBlockInteraction: () => void;
  onDraftRecovered: () => void;
  /** The page's content is in the editor; a page turn waiting on it may finish. */
  onHydrated: () => void;
  /** Mounts a fresh ink editor, which reads its SVG once at mount. */
  remountInkEditor: () => void;
};

/**
 * Brings the page that has just opened into the editor: its text boxes,
 * paper and ink, a draft recovered from this device, and a canvas rebuilt if
 * it mounted before the page's ink arrived.
 */
export function useNotebookPageHydration({
  selectedPage,
  notebook,
  pageState,
  ink,
  inkEditorRef,
  persistence,
  editorRevisionRef,
  takeRecoveredDraft,
  resetTextBlockInteraction,
  onDraftRecovered,
  onHydrated,
  remountInkEditor,
}: UseNotebookPageHydrationOptions) {
  const { inkReadyRef, setInkReady, clearHistory, setInkHasContent } = ink;
  const { schedulePendingWork } = persistence;
  /** The page whose editor mounted before its ink was fetched, if any. */
  const inkMountedUnloadedPageIdRef = useRef<string | null>(null);
  const notebookPageColor = notebook?.pageColor;
  const notebookPageStyle = notebook?.pageStyle;

  // Read when they fire, so hydration stays keyed on the page alone and a
  // caller passing a fresh callback each render cannot re-run it.
  const notify = useRef({ onDraftRecovered, onHydrated, remountInkEditor });
  useEffect(() => {
    notify.current = { onDraftRecovered, onHydrated, remountInkEditor };
  }, [onDraftRecovered, onHydrated, remountInkEditor]);

  // Each time the page changes, the ink editor remounts and re-deserializes the
  // SVG. Mark ink as not-yet-ready so the static ink underlay shows until the
  // editor paints, then NotebookInkEditor's onReady clears it — no blank flash.
  useEffect(() => {
    inkReadyRef.current = false;
    setInkReady(false);
  }, [inkReadyRef, selectedPage?.id, setInkReady]);

  // `selectedPage` is derived from the pages list, so the store has to be told
  // about it. Handlers read the open page through `pageState.read()`.
  useEffect(() => {
    pageState.selectPage(selectedPage);
  }, [pageState, selectedPage]);

  useEffect(() => {
    if (!selectedPage) {
      pageState.setTextBlocks([]);
      resetTextBlockInteraction();
      clearHistory();
      setInkHasContent(false);
      pageState.resetHydration();
      return;
    }

    if (pageState.read().hydratedPageId === selectedPage.id) {
      return;
    }

    pageState.setTextBlocks(selectedPage.textBlocks);
    resetTextBlockInteraction();
    clearHistory();
    setInkHasContent(pageHasSavedInk(selectedPage));
    pageState.setPageColor(selectedPage.pageColor ?? notebookPageColor ?? "white");
    pageState.setPageStyle(selectedPage.pageStyle ?? notebookPageStyle ?? "plain");
    // Remember when the editor is mounting without this page's real ink, so the
    // canvas can be rebuilt from it once the fetch lands.
    inkMountedUnloadedPageIdRef.current = pageHasUnloadedInk(selectedPage)
      ? selectedPage.id
      : null;
    pageState.hydratePage(selectedPage.id, selectedPage.contentRevision);
    const recoveredDraft = takeRecoveredDraft(selectedPage.id);
    if (recoveredDraft) {
      editorRevisionRef.current = Math.max(1, recoveredDraft.localRevision);
      pageState.setSaveStatus("unsaved");
      notify.current.onDraftRecovered();
      schedulePendingWork();
    } else {
      editorRevisionRef.current = 0;
      pageState.setSaveStatus("saved");
    }
    notify.current.onHydrated();
  }, [
    clearHistory,
    editorRevisionRef,
    notebookPageColor,
    notebookPageStyle,
    pageState,
    resetTextBlockInteraction,
    schedulePendingWork,
    selectedPage,
    setInkHasContent,
    takeRecoveredDraft,
  ]);

  /**
   * Rebuilds a canvas that mounted before its ink arrived.
   *
   * `NotebookInkEditor` reads `initialSvg` once, at mount, so ink that lands
   * afterwards would never reach it — and the next autosave would write that
   * empty canvas over the saved drawing. Remounting discards js-draw's undo
   * stack, so this only runs while there is demonstrably nothing to lose, which
   * the read-only gate on an unhydrated page guarantees.
   */
  useEffect(() => {
    const pendingPageId = inkMountedUnloadedPageIdRef.current;
    if (
      !selectedPage ||
      pendingPageId !== selectedPage.id ||
      pageHasUnloadedInk(selectedPage)
    ) {
      return;
    }
    inkMountedUnloadedPageIdRef.current = null;
    const inkEditor = inkEditorRef.current;
    if (inkEditor?.hasInk() || (inkEditor?.getHistoryState().undoDepth ?? 0) > 0) {
      return;
    }
    notify.current.remountInkEditor();
  }, [inkEditorRef, selectedPage]);
}
