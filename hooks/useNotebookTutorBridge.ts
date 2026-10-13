"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotebookLearning } from "@/hooks/useNotebookLearning";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
import { placeNotebookPage } from "@/lib/learning/notebook-page-context";
import type { PracticePaperStatus } from "@/lib/practice/practice-papers";
import { createNotebookAnswerBlock } from "@/lib/workspace/notebook-answer-block";
import { getNotebookAssistantQuickActions } from "@/lib/workspace/notebook-assistant";
import type { NotebookGraphBlock } from "@/lib/workspace/notebook-graphs";
import { makeNotebookTextBlockId } from "@/lib/workspace/notebook-page-content";
import type {
  Notebook,
  NotebookImageRef,
  NotebookPage,
  NotebookTextBlock,
} from "@/lib/workspace/notebooks";
import { recordPracticePaperTutorUse } from "@/services/study/practice-papers";

/**
 * How long the third starting point waits for the engine. Long enough for a
 * warm answer, short enough that a student reaching for a button finds it.
 */
const ENGINE_ACTION_WAIT_MS = 400;

/**
 * How the notebook and Tutor meet: opening and closing the floating Tutor,
 * the quick actions it offers for the page and what marking the page counts
 * towards, and putting one of its answers on the page exactly as it was shown.
 */
export function useNotebookTutorBridge(input: {
  userId: string;
  notebook: Notebook | null;
  pageState: NotebookPageStore;
  /** The open page, as rendered, so what Tutor offers follows the page. */
  selectedPage: NotebookPage | null;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  setPagesDrawerOpen: (open: boolean) => void;
  closeDrawingToolMenus: () => void;
  practicePaperStatus: PracticePaperStatus | null;
  /** Whether the open page has anything on it, which changes what Tutor offers. */
  pageHasWork: boolean;
  pageEditingEnabled: boolean;
  currentImageRefsFor: (pageId: string) => NotebookImageRef[];
  currentGraphBlocksFor: (pageId: string) => NotebookGraphBlock[];
  insertTextBlock: (block: NotebookTextBlock) => boolean;
  showError: (message: string) => void;
  success: (message: string) => void;
}) {
  const {
    userId,
    notebook,
    pageState,
    selectedPage,
    assistantOpen,
    setAssistantOpen,
    setPagesDrawerOpen,
    closeDrawingToolMenus,
    practicePaperStatus,
    pageHasWork,
    pageEditingEnabled,
    currentImageRefsFor,
    currentGraphBlocksFor,
    insertTextBlock,
    showError,
    success,
  } = input;

  /*
   * The engine's view of the notebook, once Tutor is opened in it, and the
   * open page placed from it: what the page counts towards, and the engine's
   * starting point for it. Topics the student gives a page here stand until
   * the notebook reloads.
   */
  const { view: notebookLearning, settled: learningSettled } = useNotebookLearning({
    notebookId: notebook?.id,
    enabled: assistantOpen,
  });
  const [savedPageTopics, setSavedPageTopics] = useState<Readonly<Record<string, string[]>>>({});
  const pageId = selectedPage?.id;
  const pageTopicIds = useMemo(
    () => (pageId ? (savedPageTopics[pageId] ?? selectedPage?.topicIds ?? []) : []),
    [pageId, savedPageTopics, selectedPage?.topicIds]
  );
  const pageLearning = useMemo(
    () =>
      notebookLearning && notebook && pageId
        ? placeNotebookPage(notebookLearning, notebook.id, { id: pageId, topicIds: pageTopicIds })
        : null,
    [notebook, notebookLearning, pageId, pageTopicIds]
  );
  const handlePageTopicsSaved = useCallback(
    (topicIds: string[]) => {
      if (pageId) setSavedPageTopics((current) => ({ ...current, [pageId]: topicIds }));
    },
    [pageId]
  );
  const pageFocus =
    pageLearning && pageId
      ? { pageId, pageTopicIds, view: pageLearning, onTopicsSaved: handlePageTopicsSaved }
      : null;

  /*
   * The third starting point waits for the engine, briefly, rather than
   * changing under the student's finger. Answered within the wait, it is the
   * engine's; past it, the page's ordinary one is shown and kept for that page.
   */
  const [ordinaryThirdFor, setOrdinaryThirdFor] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!assistantOpen || !pageId || learningSettled || ordinaryThirdFor.has(pageId)) return;
    const timer = setTimeout(
      () => setOrdinaryThirdFor((current) => new Set(current).add(pageId)),
      ENGINE_ACTION_WAIT_MS
    );
    return () => clearTimeout(timer);
  }, [assistantOpen, learningSettled, ordinaryThirdFor, pageId]);
  const keptOrdinary = pageId ? ordinaryThirdFor.has(pageId) : false;
  const engineAction = keptOrdinary ? undefined : pageLearning?.action?.kind;
  const waitingForEngine = assistantOpen && !learningSettled && !keptOrdinary;
  const quickActions = useMemo(
    () =>
      getNotebookAssistantQuickActions({
        hasWork: pageHasWork,
        ...(engineAction ? { engineAction } : {}),
        ...(waitingForEngine ? { waitingForEngine } : {}),
      }),
    [engineAction, pageHasWork, waitingForEngine]
  );

  const handleAssistantOpenChange = useCallback((open: boolean) => {
    if (open) {
      // Here rather than on the toolbar button: the floating Tutor reopens from its own pill too.
      if (!assistantOpen && practicePaperStatus === "in_progress" && userId && notebook) {
        void recordPracticePaperTutorUse(userId, notebook.id).catch(() => undefined);
      }
      setPagesDrawerOpen(false);
      closeDrawingToolMenus();
    }
    setAssistantOpen(open);
  }, [
    assistantOpen,
    closeDrawingToolMenus,
    notebook,
    practicePaperStatus,
    userId,
    setAssistantOpen,
    setPagesDrawerOpen,
  ]);

  /** A Tutor answer, added to this page exactly as the Tutor showed it. */
  const handleTutorAnswerInsert = useCallback(
    (text: string) => {
      const { selectedPage: page, textBlocks: currentTextBlocks } = pageState.read();
      if (!page) return false;
      if (!pageEditingEnabled) {
        showError("This page can't be edited here, so the answer can't be added to it.");
        return false;
      }
      const result = createNotebookAnswerBlock({
        id: makeNotebookTextBlockId(),
        text,
        page: {
          textBlocks: currentTextBlocks,
          imageRefs: currentImageRefsFor(page.id),
          graphBlocks: currentGraphBlocksFor(page.id),
        },
      });
      if (!result.ok) {
        showError(result.message);
        return false;
      }
      const added = insertTextBlock(result.block);
      if (added) success("Answer added to this page.");
      return added;
    },
    [
      currentGraphBlocksFor,
      currentImageRefsFor,
      insertTextBlock,
      pageEditingEnabled,
      pageState,
      showError,
      success,
    ]
  );

  return { quickActions, pageFocus, handleAssistantOpenChange, handleTutorAnswerInsert };
}
