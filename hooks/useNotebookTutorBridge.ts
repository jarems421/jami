"use client";

import { useCallback, useMemo, useState } from "react";
import { useNotebookPageLearning } from "@/hooks/useNotebookPageLearning";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
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
   * The engine's view of the open page, while Tutor is open on it: what the
   * page counts towards, and the engine's starting point for it. The page's
   * own Topics, once the student saves them here, stand until it reloads.
   */
  const { view: pageLearning, refresh: refreshPageLearning } = useNotebookPageLearning({
    notebookId: notebook?.id,
    pageId: selectedPage?.id,
    enabled: assistantOpen,
  });
  const [savedPageTopics, setSavedPageTopics] = useState<{ pageId: string; topicIds: string[] } | null>(
    null
  );
  const pageTopicIds =
    selectedPage && savedPageTopics?.pageId === selectedPage.id
      ? savedPageTopics.topicIds
      : (selectedPage?.topicIds ?? []);
  const handlePageTopicsSaved = useCallback(
    (topicIds: string[]) => {
      if (!selectedPage) return;
      setSavedPageTopics({ pageId: selectedPage.id, topicIds });
      refreshPageLearning();
    },
    [refreshPageLearning, selectedPage]
  );
  const pageFocus =
    pageLearning && selectedPage
      ? { pageId: selectedPage.id, pageTopicIds, view: pageLearning, onTopicsSaved: handlePageTopicsSaved }
      : null;

  const engineAction = pageLearning?.action?.kind;
  const quickActions = useMemo(
    () =>
      getNotebookAssistantQuickActions({
        hasWork: pageHasWork,
        ...(engineAction ? { engineAction } : {}),
      }),
    [engineAction, pageHasWork]
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
