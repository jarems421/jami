import {
  MAX_NOTEBOOK_PREVIEW_SVG_LENGTH,
  storedNotebookInkSvg,
  type Notebook,
  type NotebookInkData,
  type NotebookPage,
  type NotebookPageColor,
  type NotebookPageStyle,
  type NotebookTextBlock,
} from "@/lib/workspace/notebooks";

/** What a completed page save reports, to bring the loaded notebook up to date. */
export type NotebookPageSaveResult = {
  pageId: string;
  typedContent: string;
  textBlocks: NotebookTextBlock[];
  inkData: NotebookInkData;
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  status: NotebookPage["status"];
  contentRevision: number;
  updatedAt: Notebook["updatedAt"];
  /** False when a newer edit landed mid-save, so stored content must stand. */
  replaceStoredContent: boolean;
};

/**
 * The saved page as the save left it.
 *
 * Its revision, status and time always move on. Its content is replaced only
 * when no newer edit landed while the save was in flight: otherwise the copy
 * on screen is newer than the one just written, and the next save carries it.
 */
export function applyNotebookPageSave(
  page: NotebookPage,
  result: NotebookPageSaveResult
): NotebookPage {
  const replace = result.replaceStoredContent;
  return {
    ...page,
    typedContent: result.typedContent.trim() || undefined,
    textBlocks: replace ? result.textBlocks : page.textBlocks,
    inkData: replace ? result.inkData : page.inkData,
    // Saved ink is always in the current format, so a legacy stroke list goes.
    strokeData: replace ? undefined : page.strokeData,
    pageColor: replace ? result.pageColor : page.pageColor,
    pageStyle: replace ? result.pageStyle : page.pageStyle,
    status: result.status,
    contentRevision: result.contentRevision,
    updatedAt: result.updatedAt,
  };
}

/**
 * The notebook record with the page just saved as its preview, when it fits: a
 * page stored as Jami Ink's encoding alone is far too big to anyway.
 */
export function applyNotebookPreviewFromSave(
  notebook: Notebook,
  result: NotebookPageSaveResult
): Notebook {
  const svg = storedNotebookInkSvg(result.inkData);
  return {
    ...notebook,
    previewInkSvg: svg !== undefined && svg.length <= MAX_NOTEBOOK_PREVIEW_SVG_LENGTH ? svg : undefined,
    previewPageId: result.pageId,
    updatedAt: result.updatedAt,
  };
}
