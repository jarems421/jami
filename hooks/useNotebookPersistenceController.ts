"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
import {
  isNotebookSaveCompletionCurrent,
  NOTEBOOK_AUTOSAVE_IDLE_MS,
  shouldDiscardNotebookInkExport,
  shouldNotebookSaveReplaceStoredPageContent,
  shouldNotebookSaveUpdateLivePage,
} from "@/lib/workspace/notebook-autosave";
import {
  createNotebookPageDraft,
  deleteNotebookPageDraft,
  NOTEBOOK_DRAFT_IDLE_MS,
  writeNotebookPageDraft,
  writeNotebookPageDraftSync,
} from "@/lib/workspace/notebook-drafts";
import { getNotebookWorkingPageStatus } from "@/lib/workspace/notebook-page-content";
import {
  buildTypedContentFromTextBlocks,
  type NotebookInkData,
  type NotebookPage,
  type NotebookPageColor,
  type NotebookPageStyle,
  type NotebookTextBlock,
} from "@/lib/workspace/notebooks";
import {
  saveNotebookPageSnapshot,
} from "@/services/study/notebooks";
import { pageHasSavedInk, pageHasUnloadedInk } from "@/lib/workspace/notebook-page-ink-split";
import type { NotebookPageSaveResult } from "@/lib/workspace/notebook-save-result";

type PageSnapshotInput = {
  page: NotebookPage;
  textBlocks: NotebookTextBlock[];
  ink: NotebookInkData;
  hasInk: boolean;
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  saveId: number;
  saveRevision: number;
  baseContentRevision: number;
};

export type MarkPageUnsavedOptions = {
  /** Skip the immediate UI commit; the ink hot path batches it instead. */
  deferUi?: boolean;
  /** With `deferUi`, whether to schedule a delayed commit. Defaults to true. */
  scheduleUi?: boolean;
};

type UseNotebookPersistenceControllerOptions = {
  pageState: NotebookPageStore;
  userId: string | undefined;
  inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
  /** Bumped on every edit; save results older than the newest are discarded. */
  editorRevisionRef: RefObject<number>;
  /** True while a stroke is in flight, so saves never capture a partial page. */
  isInkInteracting: () => boolean;
  /** Ink for the open page when the editor has not mounted yet. */
  fallbackInk: NotebookInkData | null;
  /** Apply a completed save to the page list and notebook preview. */
  onPageSaved: (result: NotebookPageSaveResult) => void;
  onError: (message: string) => void;
  /** Clears a notice only while it is still the one on screen. */
  onClearError: (message: string) => void;
  /** Commit any batched editor UI immediately. */
  commitUi: () => void;
  /** Commit any batched editor UI after the current burst settles. */
  scheduleUiCommit: () => void;
};

export type NotebookPersistenceController = {
  markPageUnsaved: (options?: MarkPageUnsavedOptions) => void;
  saveCurrentPage: (options?: { flush?: boolean }) => Promise<boolean>;
  /** Serialises synchronously so a page survives an unmount mid-navigation. */
  queueCurrentPageSaveForExit: () => boolean;
  persistCurrentPageDraft: () => Promise<void>;
  persistCurrentPageDraftSync: () => boolean;
  /** Queue an autosave and a recovery draft without bumping the revision. */
  schedulePendingWork: () => void;
  cancelScheduledWork: () => void;
  /** Clear save bookkeeping when a different notebook is loaded. */
  resetSaveTracking: () => void;
  hasSaveInFlight: () => boolean;
};

/**
 * Owns everything that writes the open page: debounced autosave, the local
 * recovery draft, and the exit flush.
 *
 * The page previously held `saveCurrentPageRef` and `persistCurrentPageDraftRef`
 * only so its debounce timers could reach functions declared hundreds of lines
 * further down. Both live in this scope now, so the timers call them directly
 * and that indirection is gone.
 */
export function useNotebookPersistenceController({
  pageState,
  userId,
  inkEditorRef,
  editorRevisionRef,
  isInkInteracting,
  fallbackInk,
  onPageSaved,
  onError,
  onClearError,
  commitUi,
  scheduleUiCommit,
}: UseNotebookPersistenceControllerOptions): NotebookPersistenceController {
  const autosaveTimerRef = useRef<number | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const saveOperationRef = useRef<Promise<boolean> | null>(null);
  const saveQueuedRef = useRef(false);
  const latestSaveIdRef = useRef(0);
  const draftErrorShownRef = useRef(false);

  // Latest inputs, so the debounced callbacks below keep a stable identity.
  const latestRef = useRef({
    fallbackInk,
    isInkInteracting,
    onError,
    onClearError,
    onPageSaved,
    commitUi,
    scheduleUiCommit,
    userId,
  });
  useEffect(() => {
    latestRef.current = {
      fallbackInk,
      isInkInteracting,
      onError,
      onClearError,
      onPageSaved,
      commitUi,
      scheduleUiCommit,
      userId,
    };
  }, [
    commitUi,
    fallbackInk,
    isInkInteracting,
    onError,
    onClearError,
    onPageSaved,
    scheduleUiCommit,
    userId,
  ]);

  /** Both draft writers build the same record; only serialisation differs. */
  const buildDraft = useCallback(
    (page: NotebookPage, userId: string, ink: NotebookInkData) => {
      const { textBlocks, pageColor, pageStyle, contentRevision } =
        pageState.read();
      const inkEditor = inkEditorRef.current;
      return createNotebookPageDraft({
        userId,
        notebookId: page.notebookId,
        pageId: page.id,
        baseContentRevision: contentRevision,
        remoteUpdatedAt: page.updatedAt,
        localRevision: editorRevisionRef.current,
        textBlocks,
        ink,
        pageColor,
        pageStyle,
        status: getNotebookWorkingPageStatus({
          typedContent: buildTypedContentFromTextBlocks(textBlocks) ?? "",
          hasInk: inkEditor?.hasInk() ?? pageHasSavedInk(page),
        }),
      });
    },
    [editorRevisionRef, inkEditorRef, pageState]
  );

  /** A draft is only worth writing for a chosen page with local edits on it. */
  const draftTarget = useCallback(() => {
    const page = pageState.read().selectedPage;
    const userId = latestRef.current.userId;
    if (!page || !userId || editorRevisionRef.current <= 0) return null;
    return { page, userId };
  }, [editorRevisionRef, pageState]);

  const persistCurrentPageDraft = useCallback(async () => {
    const target = draftTarget();
    if (!target || latestRef.current.isInkInteracting()) return;
    const { page, userId } = target;
    const inkEditor = inkEditorRef.current;

    try {
      const ink = inkEditor
        ? await inkEditor.serializeAsync()
        : latestRef.current.fallbackInk;
      // The page can change while the editor serialises.
      if (pageState.read().selectedPage?.id !== page.id || ink === null) {
        return;
      }
      await writeNotebookPageDraft(buildDraft(page, userId, ink));
      draftErrorShownRef.current = false;
    } catch (error) {
      if (draftErrorShownRef.current) return;
      draftErrorShownRef.current = true;
      latestRef.current.onError(
        error instanceof Error
          ? error.message
          : "This device could not store a recovery copy of the page."
      );
    }
  }, [buildDraft, draftTarget, inkEditorRef, pageState]);

  const persistCurrentPageDraftSync = useCallback(() => {
    const target = draftTarget();
    if (!target) return false;
    const inkEditor = inkEditorRef.current;
    try {
      const ink = inkEditor
        ? inkEditor.serialize()
        : latestRef.current.fallbackInk;
      if (ink === null) return false;
      return writeNotebookPageDraftSync(
        buildDraft(target.page, target.userId, ink)
      );
    } catch {
      // This lifecycle fallback cannot await IndexedDB; the normal draft/save
      // paths surface failures and the boolean tells the caller it did not persist.
      return false;
    }
  }, [buildDraft, draftTarget, inkEditorRef]);

  const savePageSnapshot = useCallback(
    async (input: PageSnapshotInput) => {
      const { userId: currentUserId } = latestRef.current;
      if (!currentUserId) return false;
      pageState.setSaveStatus("saving");
      try {
        const typedContent =
          buildTypedContentFromTextBlocks(input.textBlocks) ?? "";
        const status = getNotebookWorkingPageStatus({
          typedContent,
          hasInk: input.hasInk,
        });
        const inkData = input.ink;
        const saveResult = await saveNotebookPageSnapshot(currentUserId, {
          notebookId: input.page.notebookId,
          pageId: input.page.id,
          typedContent,
          textBlocks: input.textBlocks,
          inkData,
          pageColor: input.pageColor,
          pageStyle: input.pageStyle,
          status,
        });

        /*
         * As a transition: the values below are written at once (the page
         * store's own reads see them straight away), but the re-render they
         * cause is done in slices.
         *
         * The write returns whenever the network does, and the usual moment
         * is just after writing has started again -- the save waits for five
         * quiet seconds, so it goes out as someone pauses to think and comes
         * back as they carry on. As an ordinary update that re-rendered the
         * whole notebook page in one piece, in the middle of whatever stroke
         * was being written.
         */
        startTransition(() => {
          if (pageState.read().selectedPage?.id === input.page.id) {
            pageState.setContentRevision(saveResult.contentRevision);
          }

          const currentRevision = editorRevisionRef.current;
          const selectedPageId = pageState.read().selectedPage?.id ?? null;
          const staleness = {
            pageId: input.page.id,
            selectedPageId,
            saveRevision: input.saveRevision,
            currentRevision,
          };

          latestRef.current.onPageSaved({
            pageId: input.page.id,
            typedContent,
            textBlocks: input.textBlocks,
            inkData,
            pageColor: input.pageColor,
            pageStyle: input.pageStyle,
            status,
            contentRevision: saveResult.contentRevision,
            updatedAt: saveResult.updatedAt,
            replaceStoredContent:
              shouldNotebookSaveReplaceStoredPageContent(staleness),
          });

          if (shouldNotebookSaveUpdateLivePage(staleness)) {
            pageState.setTextBlocks(input.textBlocks);
          }

          if (
            isNotebookSaveCompletionCurrent({
              saveId: input.saveId,
              saveRevision: input.saveRevision,
              currentRevision,
              latestSaveId: latestSaveIdRef.current,
            })
          ) {
            pageState.setSaveStatus("saved");
            latestRef.current.onClearError("Could not autosave this page.");
          }
        });

        void deleteNotebookPageDraft(
          {
            userId: currentUserId,
            notebookId: input.page.notebookId,
            pageId: input.page.id,
          },
          input.saveRevision
        );
        return true;
      } catch (error) {
        if (
          isNotebookSaveCompletionCurrent({
            saveId: input.saveId,
            saveRevision: input.saveRevision,
            currentRevision: editorRevisionRef.current,
            latestSaveId: latestSaveIdRef.current,
          })
        ) {
          pageState.setSaveStatus("failed");
          latestRef.current.onError(
            error instanceof Error ? error.message : "Could not autosave this page."
          );
        }
        return false;
      }
    },
    [editorRevisionRef, pageState]
  );

  const saveCurrentPage = useCallback(
    async function saveCurrentPage(
      options: { flush?: boolean } = {}
    ): Promise<boolean> {
      const activeSaveOperation = saveOperationRef.current;
      if (activeSaveOperation) {
        if (!options.flush) {
          saveQueuedRef.current = true;
          return true;
        }
        await activeSaveOperation;
        if (
          saveOperationRef.current &&
          saveOperationRef.current !== activeSaveOperation
        ) {
          return saveCurrentPage({ ...options, flush: true });
        }
        const status = pageState.read().saveStatus;
        if (status === "unsaved" || status === "failed") {
          return saveCurrentPage({ ...options, flush: true });
        }
        return true;
      }

      const page = pageState.read().selectedPage;
      if (!page || !latestRef.current.userId) return false;
      if (latestRef.current.isInkInteracting()) return false;
      // Ink is fetched separately from the page record. If it has not arrived,
      // the canvas is empty for that reason alone, and saving would replace
      // the student's drawing with a blank page.
      if (pageHasUnloadedInk(page)) return false;

      const operation = (async () => {
        const saveId = latestSaveIdRef.current + 1;
        latestSaveIdRef.current = saveId;
        const saveRevision = editorRevisionRef.current;
        const inkEditor = inkEditorRef.current;
        const ink = inkEditor
          ? await inkEditor.serializeAsync()
          : latestRef.current.fallbackInk;

        if (
          shouldDiscardNotebookInkExport({
            inkAvailable: ink !== null,
            inkInteractionActive: latestRef.current.isInkInteracting(),
            saveRevision,
            currentRevision: editorRevisionRef.current,
          })
        ) {
          return false;
        }
        if (ink === null) return false;

        const { textBlocks, pageColor, pageStyle, contentRevision } =
          pageState.read();
        return savePageSnapshot({
          page,
          textBlocks,
          ink,
          hasInk: inkEditorRef.current?.hasInk() ?? false,
          pageColor,
          pageStyle,
          saveId,
          saveRevision,
          baseContentRevision: contentRevision,
        });
      })();

      saveOperationRef.current = operation;
      let saved = false;
      try {
        saved = await operation;
      } finally {
        if (saveOperationRef.current === operation) {
          saveOperationRef.current = null;
        }
      }

      const status = pageState.read().saveStatus;
      const stillDirty = status === "unsaved" || status === "failed";
      if (options.flush && stillDirty) {
        if (status === "failed") return false;
        if (latestRef.current.isInkInteracting()) return false;
        return saveCurrentPage({ ...options, flush: true });
      }

      const shouldRunQueuedSave =
        saveQueuedRef.current &&
        !latestRef.current.isInkInteracting() &&
        stillDirty;
      saveQueuedRef.current = false;
      if (shouldRunQueuedSave) {
        void saveCurrentPage();
      }
      return saved;
    },
    [editorRevisionRef, inkEditorRef, pageState, savePageSnapshot]
  );

  const scheduleNotebookAutosave = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      // Never interrupt a stroke; wait for the pen to lift.
      if (latestRef.current.isInkInteracting()) {
        scheduleNotebookAutosave();
        return;
      }
      void saveCurrentPage();
    }, NOTEBOOK_AUTOSAVE_IDLE_MS);
  }, [saveCurrentPage]);

  const scheduleNotebookDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      if (latestRef.current.isInkInteracting()) {
        scheduleNotebookDraft();
        return;
      }
      void persistCurrentPageDraft();
    }, NOTEBOOK_DRAFT_IDLE_MS);
  }, [persistCurrentPageDraft]);

  const markPageUnsaved = useCallback(
    (options?: MarkPageUnsavedOptions) => {
      editorRevisionRef.current += 1;
      // Commit without rendering: a burst of strokes must not schedule a
      // React render per stroke.
      pageState.setSaveStatus("unsaved", { deferRender: true });
      scheduleNotebookAutosave();
      scheduleNotebookDraft();
      if (options?.deferUi) {
        if (options.scheduleUi !== false) {
          latestRef.current.scheduleUiCommit();
        }
        return;
      }
      latestRef.current.commitUi();
    },
    [editorRevisionRef, pageState, scheduleNotebookAutosave, scheduleNotebookDraft]
  );

  const queueCurrentPageSaveForExit = useCallback(() => {
    const page = pageState.read().selectedPage;
    const inkEditor = inkEditorRef.current;
    if (!page || !latestRef.current.userId) return false;
    if (latestRef.current.isInkInteracting()) return false;

    // Capture the editor before the route unmounts it. The synchronous export
    // only covers local serialization; the slower Firebase acknowledgement is
    // deliberately allowed to finish after the Link starts navigating.
    const saveRevision = editorRevisionRef.current;
    let ink: NotebookInkData | null;
    try {
      ink = inkEditor
        ? inkEditor.serialize()
        : latestRef.current.fallbackInk;
    } catch (error) {
      console.error("Failed to serialize notebook ink before navigation.", error);
      latestRef.current.onError("Could not prepare this page to save before leaving.");
      return false;
    }
    if (
      shouldDiscardNotebookInkExport({
        inkAvailable: ink !== null,
        inkInteractionActive: latestRef.current.isInkInteracting(),
        saveRevision,
        currentRevision: editorRevisionRef.current,
      }) ||
      ink === null
    ) {
      return false;
    }

    const saveId = latestSaveIdRef.current + 1;
    latestSaveIdRef.current = saveId;
    const { textBlocks, pageColor, pageStyle } = pageState.read();
    const snapshot = {
      page,
      textBlocks,
      ink,
      hasInk: inkEditor?.hasInk() ?? false,
      pageColor,
      pageStyle,
      saveId,
      saveRevision,
    };

    const precedingSave = saveOperationRef.current;
    const operation = (async () => {
      if (precedingSave) {
        try {
          await precedingSave;
        } catch {
          // The final captured snapshot still needs a chance to save even if
          // an older serialization or write failed.
        }
      }
      return savePageSnapshot({
        ...snapshot,
        baseContentRevision: pageState.read().contentRevision,
      });
    })();

    saveOperationRef.current = operation;
    const clearCompletedExitSave = () => {
      if (saveOperationRef.current === operation) {
        saveOperationRef.current = null;
      }
    };
    void operation.then(clearCompletedExitSave, clearCompletedExitSave);
    return true;
  }, [editorRevisionRef, inkEditorRef, pageState, savePageSnapshot]);

  const schedulePendingWork = useCallback(() => {
    scheduleNotebookAutosave();
    scheduleNotebookDraft();
  }, [scheduleNotebookAutosave, scheduleNotebookDraft]);

  const cancelScheduledWork = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  const resetSaveTracking = useCallback(() => {
    cancelScheduledWork();
    latestSaveIdRef.current = 0;
    saveQueuedRef.current = false;
    draftErrorShownRef.current = false;
  }, [cancelScheduledWork]);

  const hasSaveInFlight = useCallback(
    () => saveOperationRef.current !== null,
    []
  );

  useEffect(() => cancelScheduledWork, [cancelScheduledWork]);

  return {
    markPageUnsaved,
    saveCurrentPage,
    queueCurrentPageSaveForExit,
    persistCurrentPageDraft,
    persistCurrentPageDraftSync,
    schedulePendingWork,
    cancelScheduledWork,
    resetSaveTracking,
    hasSaveInFlight,
  };
}
