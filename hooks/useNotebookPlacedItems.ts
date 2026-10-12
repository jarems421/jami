"use client";

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import type { NotebookInkController } from "@/hooks/useNotebookInkController";
import { useNotebookLasso } from "@/hooks/useNotebookLasso";
import type { NotebookLoader } from "@/hooks/useNotebookLoader";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
import {
  createNotebookGraphBlock,
  MAX_NOTEBOOK_GRAPHS,
  type NotebookGraphBlock,
  type NotebookGraphDraft,
} from "@/lib/workspace/notebook-graphs";
import {
  placedHistoryChange,
  stepPlacedHistory,
  type NotebookPlacedStep,
} from "@/lib/workspace/notebook-history";
import {
  notebookToolMovesPlacedItems,
  type NotebookEditorTool,
} from "@/lib/workspace/notebook-page-state";
import type { NotebookImageRef } from "@/lib/workspace/notebooks";
import {
  addUploadedImageToNotebookPage,
  deleteUploadedNotebookImageFile,
} from "@/services/study/notebook-page-images";
import {
  updateNotebookPageGraphs,
  updateNotebookPageImages,
} from "@/services/study/notebooks";

type UseNotebookPlacedItemsOptions = {
  userId: string | undefined;
  notebookId: string | undefined;
  pageState: NotebookPageStore;
  setPages: NotebookLoader["setPages"];
  /** The page on screen. A selection or an open graph editor belongs to it. */
  openPageId: string | undefined;
  tool: NotebookEditorTool;
  /** On a phone, placed things are looked at, never picked up. */
  isPhoneLayout: boolean;
  closeToolMenus: () => void;
  success: (message: string) => void;
  showError: (message: string) => void;
  showThrownError: (error: unknown, fallback: string) => void;
  /** What is shared with the rest of the page: the ink, for the lasso, and the undo history. */
  shared: {
    inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
    history: Pick<NotebookInkController, "recordTextEdit" | "recordPlacedEdit" | "together" | "undoStep" | "redoStep">;
    markUnsaved: () => void;
  };
};

/**
 * Images and graphs placed on a notebook page: what is selected, every write
 * that adds, moves, edits or removes one, and undo and redo for the page.
 *
 * Both are single fields on the page record, saved on their own rather than
 * with the page's ink and text, so a move never waits on an autosave. Their
 * changes join the page's undo history (`useNotebookInkController`), which
 * hands them back here to apply: every change to a graph, and an image moved,
 * resized or turned. Deleting an image deletes its file, so that is never
 * undone.
 */
export function useNotebookPlacedItems({
  userId,
  notebookId,
  pageState,
  setPages,
  openPageId,
  tool,
  isPhoneLayout,
  closeToolMenus,
  success,
  showError,
  showThrownError,
  shared,
}: UseNotebookPlacedItemsOptions) {
  const { recordPlacedEdit, together, undoStep, redoStep, recordTextEdit } = shared.history;
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  /** The id of the graph open in the editor, "new" while one is being made, or null. */
  const [graphEditorTarget, setGraphEditorTarget] = useState<string | null>(null);
  const [addingImage, setAddingImage] = useState(false);

  /*
   * Writes run one at a time, and each starts from the list the one before it
   * left. Two quick moves used to overlap, the second was rejected, and its
   * image jumped back to where the drag began. Graphs share the queue: both
   * are single fields on the page, and one queue keeps two quick edits from
   * landing in the wrong order.
   */
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  /** The last image list written or asked for, per page, ahead of `pages`. */
  const latestImageRefsRef = useRef<{ pageId: string; imageRefs: NotebookImageRef[] } | null>(
    null
  );
  /** The last graph list written or asked for, per page, ahead of `pages`. */
  const latestGraphBlocksRef = useRef<{ pageId: string; graphBlocks: NotebookGraphBlock[] } | null>(
    null
  );

  const queueWrite = useCallback(<T,>(task: () => Promise<T>) => {
    const run = writeChainRef.current.then(task, task);
    writeChainRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /*
   * A selection or an open graph editor belongs to the page it was made on,
   * and only the tools that move placed things keep one selected. Adjusted
   * while rendering rather than in an effect, so a page or tool change never
   * paints a frame with the previous selection still up.
   */
  const [selectionScope, setSelectionScope] = useState({ openPageId, tool });
  if (selectionScope.openPageId !== openPageId || selectionScope.tool !== tool) {
    const pageChanged = selectionScope.openPageId !== openPageId;
    setSelectionScope({ openPageId, tool });
    if (pageChanged || !notebookToolMovesPlacedItems(tool)) {
      setSelectedImageId(null);
      setSelectedGraphId(null);
    }
    if (pageChanged) setGraphEditorTarget(null);
  }

  /*
   * Only what is actually selected: see `clearPlacedSelection` on the page,
   * which calls this as every stroke lands.
   */
  const clearSelection = useCallback(() => {
    if (selectedImageId !== null) setSelectedImageId(null);
    if (selectedGraphId !== null) setSelectedGraphId(null);
  }, [selectedGraphId, selectedImageId]);

  const currentImageRefsFor = useCallback(
    (pageId: string) => {
      const latest = latestImageRefsRef.current;
      if (latest?.pageId === pageId) return latest.imageRefs;
      const selected = pageState.read().selectedPage;
      return selected?.id === pageId ? selected.imageRefs : [];
    },
    [pageState]
  );

  const applyPageImages = useCallback(
    (pageId: string, imageRefs: NotebookImageRef[], updatedAt: number) => {
      latestImageRefsRef.current = { pageId, imageRefs };
      setPages((current) =>
        current.map((page) =>
          page.id === pageId ? { ...page, imageRefs, updatedAt } : page
        )
      );
    },
    [setPages]
  );

  const handleIllustrationInserted = useCallback(
    (input: { imageRef: NotebookImageRef; contentRevision: number }) => {
      const pageId = pageState.read().selectedPage?.id;
      if (!pageId) return;
      const latest = latestImageRefsRef.current;
      if (
        latest?.pageId === pageId &&
        !latest.imageRefs.some((image) => image.sourceAssetId === input.imageRef.sourceAssetId)
      ) {
        latestImageRefsRef.current = { pageId, imageRefs: [...latest.imageRefs, input.imageRef] };
      }
      setPages((current) =>
        current.map((page) =>
          page.id === pageId
            ? {
                ...page,
                imageRefs: page.imageRefs.some(
                  (image) => image.sourceAssetId === input.imageRef.sourceAssetId
                )
                  ? page.imageRefs
                  : [...page.imageRefs, input.imageRef],
                contentRevision: input.contentRevision,
                updatedAt: Date.now(),
              }
            : page
        )
      );
      pageState.setContentRevision(input.contentRevision);
      setSelectedImageId(input.imageRef.id);
      if (!isPhoneLayout) pageState.setTool("select");
      pageState.setSaveStatus("saved");
      success("Visual added to this page.");
    },
    [isPhoneLayout, pageState, setPages, success]
  );

  /*
   * Shown at once and saved behind, and recorded for undo unless it is an undo
   * or a redo itself. A refused write puts back what was there.
   *
   * Images are their own field, so a move no longer flushes the page first or
   * touches its revision -- the flush was there to dodge a conflict the image
   * write itself was causing, and it put a save round-trip in front of every
   * drop.
   */
  const commitImages = useCallback(
    (imageRefs: NotebookImageRef[], record: boolean) => {
      const pageId = pageState.read().selectedPage?.id;
      if (!userId || !notebookId || !pageId) return Promise.resolve();
      const before = currentImageRefsFor(pageId);
      const change = record ? placedHistoryChange(before, imageRefs, { addsAndRemovals: false }) : null;
      if (change) recordPlacedEdit({ kind: "images", ...change });
      applyPageImages(pageId, imageRefs, Date.now());
      const stillLatest = () => latestImageRefsRef.current?.imageRefs === imageRefs;
      return queueWrite(async () => {
        const result = await updateNotebookPageImages(userId, {
          notebookId,
          pageId,
          imageRefs,
        });
        // A newer edit already on screen is not replaced by this older one.
        if (stillLatest()) applyPageImages(pageId, imageRefs, result.updatedAt);
      }).catch((error: unknown) => {
        if (stillLatest()) applyPageImages(pageId, before, Date.now());
        showThrownError(error, "That image could not be moved. Try again.");
        throw error;
      });
    },
    [
      applyPageImages,
      currentImageRefsFor,
      notebookId,
      pageState,
      queueWrite,
      recordPlacedEdit,
      showThrownError,
      userId,
    ]
  );

  const handleImagesCommit = useCallback(
    (imageRefs: NotebookImageRef[]) => commitImages(imageRefs, true),
    [commitImages]
  );

  /** Resolves true once the image is on the page; failures are shown here. */
  const handleAddImage = useCallback(
    (file: File): Promise<boolean> => {
      const pageId = pageState.read().selectedPage?.id;
      if (!userId || !notebookId || !pageId) return Promise.resolve(false);
      closeToolMenus();
      setAddingImage(true);
      return queueWrite(async () => {
        const result = await addUploadedImageToNotebookPage({
          userId,
          notebookId,
          pageId,
          file,
          currentImageRefs: currentImageRefsFor(pageId),
        });
        applyPageImages(pageId, result.imageRefs, result.updatedAt);
        if (pageState.read().selectedPage?.id === pageId) {
          // Selected and ready to move, which is almost always the next thing.
          pageState.setTool("select");
          setSelectedImageId(result.imageRef.id);
        }
        return true;
      })
        .catch((error: unknown) => {
          showThrownError(error, "That image could not be added. Try again.");
          return false;
        })
        .finally(() => setAddingImage(false));
    },
    [
      applyPageImages,
      closeToolMenus,
      currentImageRefsFor,
      notebookId,
      pageState,
      queueWrite,
      showThrownError,
      userId,
    ]
  );

  /** Deletes images, and the files of uploaded ones, which is why it is never undone. */
  const deleteImages = useCallback(
    (imageIds: readonly string[]) => {
      const pageId = pageState.read().selectedPage?.id;
      if (!userId || !notebookId || !pageId) return;
      const ids = new Set(imageIds);
      const before = currentImageRefsFor(pageId);
      const removed = before.filter((image) => ids.has(image.id));
      if (removed.length === 0) return;
      const imageRefs = before.filter((image) => !ids.has(image.id));
      setSelectedImageId(null);
      // Gone at once; put back only if the page write is refused.
      applyPageImages(pageId, imageRefs, Date.now());
      void queueWrite(async () => {
        await updateNotebookPageImages(userId, { notebookId, pageId, imageRefs });
        await Promise.all(removed.map(deleteUploadedNotebookImageFile));
      }).catch((error: unknown) => {
        applyPageImages(pageId, before, Date.now());
        showThrownError(error, "That image could not be deleted. Try again.");
      });
    },
    [applyPageImages, currentImageRefsFor, notebookId, pageState, queueWrite, showThrownError, userId]
  );

  const handleDeleteImage = useCallback((imageId: string) => deleteImages([imageId]), [deleteImages]);

  const currentGraphBlocksFor = useCallback(
    (pageId: string) => {
      const latest = latestGraphBlocksRef.current;
      if (latest?.pageId === pageId) return latest.graphBlocks;
      const selected = pageState.read().selectedPage;
      return selected?.id === pageId ? selected.graphBlocks : [];
    },
    [pageState]
  );

  const applyPageGraphs = useCallback(
    (pageId: string, graphBlocks: NotebookGraphBlock[], updatedAt: number) => {
      latestGraphBlocksRef.current = { pageId, graphBlocks };
      setPages((current) =>
        current.map((page) => (page.id === pageId ? { ...page, graphBlocks, updatedAt } : page))
      );
    },
    [setPages]
  );

  /*
   * Shown at once and saved behind, through the shared write queue, and
   * recorded for undo unless it is an undo or a redo itself. A refused write
   * puts back what was there and says so, so callers do not report failures
   * themselves.
   */
  const writePageGraphs = useCallback(
    async (pageId: string, graphBlocks: NotebookGraphBlock[], failureMessage: string, record = true) => {
      if (!userId || !notebookId) return false;
      const before = currentGraphBlocksFor(pageId);
      const change = record ? placedHistoryChange(before, graphBlocks, { addsAndRemovals: true }) : null;
      if (change) recordPlacedEdit({ kind: "graphs", ...change });
      applyPageGraphs(pageId, graphBlocks, Date.now());
      const stillLatest = () => latestGraphBlocksRef.current?.graphBlocks === graphBlocks;
      try {
        await queueWrite(async () => {
          const result = await updateNotebookPageGraphs(userId, { notebookId, pageId, graphBlocks });
          // A newer edit already on screen is not replaced by this older one.
          if (stillLatest()) applyPageGraphs(pageId, graphBlocks, result.updatedAt);
        });
        return true;
      } catch (error) {
        if (stillLatest()) applyPageGraphs(pageId, before, Date.now());
        showThrownError(error, failureMessage);
        return false;
      }
    },
    [applyPageGraphs, currentGraphBlocksFor, notebookId, queueWrite, recordPlacedEdit, showThrownError, userId]
  );

  const handleGraphsCommit = useCallback(
    async (graphBlocks: NotebookGraphBlock[]) => {
      const pageId = pageState.read().selectedPage?.id;
      if (pageId) await writePageGraphs(pageId, graphBlocks, "That graph could not be changed. Try again.");
    },
    [pageState, writePageGraphs]
  );

  // One thing selected at a time, so the options showing belong to what was tapped last.
  const handleSelectGraph = useCallback((graphId: string | null) => {
    setSelectedGraphId(graphId);
    if (graphId) setSelectedImageId(null);
  }, []);

  const handleSelectImage = useCallback((imageId: string | null) => {
    setSelectedImageId(imageId);
    if (imageId) setSelectedGraphId(null);
  }, []);

  const handleOpenNewGraph = useCallback(() => {
    closeToolMenus();
    setGraphEditorTarget("new");
  }, [closeToolMenus]);

  const selectPlacedGraph = useCallback(
    (graphId: string) => {
      if (isPhoneLayout) return;
      // Selected and ready to move or resize, which is almost always next.
      pageState.setTool("select");
      setSelectedGraphId(graphId);
      setSelectedImageId(null);
    },
    [isPhoneLayout, pageState]
  );

  const handleSaveGraph = useCallback(
    (draft: NotebookGraphDraft) => {
      const pageId = pageState.read().selectedPage?.id;
      const target = graphEditorTarget;
      setGraphEditorTarget(null);
      if (!pageId || !target) return;
      const current = currentGraphBlocksFor(pageId);
      const existing = current.find((graph) => graph.id === target);
      if (existing) {
        const { id, x, y, width, height } = existing;
        void writePageGraphs(
          pageId,
          current.map((graph) => (graph.id === id ? { id, x, y, width, height, ...draft } : graph)),
          "That graph could not be saved. Try again."
        );
        selectPlacedGraph(id);
        return;
      }
      if (current.length >= MAX_NOTEBOOK_GRAPHS) {
        showError(`A page can hold up to ${MAX_NOTEBOOK_GRAPHS} graphs. Delete one to add another.`);
        return;
      }
      const created = createNotebookGraphBlock(crypto.randomUUID(), draft);
      void writePageGraphs(pageId, [...current, created], "That graph could not be added. Try again.");
      selectPlacedGraph(created.id);
    },
    [currentGraphBlocksFor, graphEditorTarget, pageState, selectPlacedGraph, showError, writePageGraphs]
  );

  const handleDeleteGraph = useCallback(
    (graphId: string) => {
      const pageId = pageState.read().selectedPage?.id;
      if (!pageId) return;
      setSelectedGraphId(null);
      void writePageGraphs(
        pageId,
        currentGraphBlocksFor(pageId).filter((graph) => graph.id !== graphId),
        "That graph could not be deleted. Try again."
      );
    },
    [currentGraphBlocksFor, pageState, writePageGraphs]
  );

  const handleTutorGraphInsert = useCallback(
    async (draft: NotebookGraphDraft) => {
      const pageId = pageState.read().selectedPage?.id;
      if (!pageId) return false;
      const current = currentGraphBlocksFor(pageId);
      if (current.length >= MAX_NOTEBOOK_GRAPHS) {
        showError(`A page can hold up to ${MAX_NOTEBOOK_GRAPHS} graphs. Delete one to add this one.`);
        return false;
      }
      const created = createNotebookGraphBlock(crypto.randomUUID(), draft);
      const added = await writePageGraphs(pageId, [...current, created], "That graph could not be added. Try again.");
      if (!added) return false;
      if (pageState.read().selectedPage?.id === pageId) selectPlacedGraph(created.id);
      success("Graph added to this page.");
      return true;
    },
    [currentGraphBlocksFor, pageState, selectPlacedGraph, showError, success, writePageGraphs]
  );

  /** What the image and graph layers need from here, kept stable for their memo. */
  const imageLayerProps = useMemo(
    () => ({
      selectedImageId,
      onSelect: handleSelectImage,
      onCommit: handleImagesCommit,
      onDelete: handleDeleteImage,
    }),
    [handleDeleteImage, handleImagesCommit, handleSelectImage, selectedImageId]
  );
  const graphLayerProps = useMemo(
    () => ({
      selectedGraphId,
      onSelect: handleSelectGraph,
      onCommit: handleGraphsCommit,
      onEdit: setGraphEditorTarget,
      onDelete: handleDeleteGraph,
    }),
    [handleDeleteGraph, handleGraphsCommit, handleSelectGraph, selectedGraphId]
  );

  /** What undo or redo handed back for images and graphs: saved, and not recorded again. */
  const applyPlacedSteps = useCallback(
    (steps: NotebookPlacedStep[]) => {
      const pageId = pageState.read().selectedPage?.id;
      if (!pageId) return;
      for (const { edit, direction } of steps) {
        const undoing = direction === "undo";
        if (edit.kind === "images") {
          const imageRefs = stepPlacedHistory(
            currentImageRefsFor(pageId),
            undoing ? edit.next : edit.previous,
            undoing ? edit.previous : edit.next
          );
          // A refused write is shown, and put back, by the commit itself.
          commitImages(imageRefs, false).catch(() => undefined);
        } else {
          const graphBlocks = stepPlacedHistory(
            currentGraphBlocksFor(pageId),
            undoing ? edit.next : edit.previous,
            undoing ? edit.previous : edit.next
          );
          void writePageGraphs(pageId, graphBlocks, "That graph could not be changed. Try again.", false);
        }
      }
    },
    [commitImages, currentGraphBlocksFor, currentImageRefsFor, pageState, writePageGraphs]
  );

  const lasso = useNotebookLasso({
    active: tool === "lasso" && !isPhoneLayout,
    pageId: openPageId,
    inkEditorRef: shared.inkEditorRef,
    placed: {
      images: () => (openPageId ? currentImageRefsFor(openPageId) : []),
      graphs: () => (openPageId ? currentGraphBlocksFor(openPageId) : []),
      saveImages: (imageRefs) => void handleImagesCommit(imageRefs).catch(() => undefined),
      saveGraphs: (graphBlocks) => void handleGraphsCommit(graphBlocks),
      deleteImages,
      texts: () => pageState.read().textBlocks,
      setTexts: (textBlocks) => pageState.setTextBlocks(textBlocks),
      recordTexts: recordTextEdit,
      markUnsaved: shared.markUnsaved,
      together,
    },
  });
  const { refresh: refreshLasso } = lasso;

  // What the lasso holds may have moved: its box goes with it.
  const undo = useCallback(() => {
    applyPlacedSteps(undoStep());
    refreshLasso();
  }, [applyPlacedSteps, refreshLasso, undoStep]);
  const redo = useCallback(() => {
    applyPlacedSteps(redoStep());
    refreshLasso();
  }, [applyPlacedSteps, redoStep, refreshLasso]);

  return {
    lasso,
    undo,
    redo,
    imageLayerProps,
    graphLayerProps,
    selectedImageId,
    selectedGraphId,
    graphEditorTarget,
    setGraphEditorTarget,
    addingImage,
    clearSelection,
    currentImageRefsFor,
    currentGraphBlocksFor,
    handleIllustrationInserted,
    handleImagesCommit,
    handleAddImage,
    handleDeleteImage,
    handleGraphsCommit,
    handleSelectGraph,
    handleSelectImage,
    handleOpenNewGraph,
    handleSaveGraph,
    handleDeleteGraph,
    handleTutorGraphInsert,
  };
}
