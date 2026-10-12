"use client";

import { useCallback, useMemo } from "react";
import {
  resolveNotebookCarouselPages,
  type NotebookPageSwipeMotion,
} from "@/lib/workspace/notebook-carousel";
import {
  legacyStrokesToJsDrawSvg,
  notebookInkSvg,
  svgNotebookInkData,
} from "@/lib/workspace/notebook-ink-data";
import { normalizeNotebookStrokes } from "@/lib/workspace/notebook-page-content";
import { pageHasUnloadedInk } from "@/lib/workspace/notebook-page-ink-split";
import { resolveNotebookPageBackgroundFileId } from "@/lib/workspace/notebook-pdf";
import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
  type Notebook,
  type NotebookFile,
  type NotebookInkData,
  type NotebookPage,
} from "@/lib/workspace/notebooks";

type UseNotebookActivePageOptions = {
  notebook: Notebook | null;
  pages: NotebookPage[];
  selectedPageId: string | null;
  files: NotebookFile[];
  fileUrls: Record<string, string>;
  /** A turn in progress decides which neighbours the swipe track shows. */
  swipeMotion: NotebookPageSwipeMotion | null;
};

/**
 * The page on screen and everything read off it: its place in the notebook,
 * the neighbours the swipe track shows beside it, its ink as the editor
 * loads it, and the file behind it.
 */
export function useNotebookActivePage({
  notebook,
  pages,
  selectedPageId,
  files,
  fileUrls,
  swipeMotion,
}: UseNotebookActivePageOptions) {
  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) ?? pages[0] ?? null,
    [pages, selectedPageId]
  );
  const selectedPageIndex = useMemo(
    () => pages.findIndex((page) => page.id === selectedPage?.id),
    [pages, selectedPage?.id]
  );
  const hasMappedBackgroundPages = useMemo(
    () => pages.some((page) => Boolean(page.backgroundFileId)),
    [pages]
  );
  const notebookUploadedFileId = notebook?.uploadedFileId;

  /** Which of the notebook's files is behind a page, if any, and its URL. */
  const resolvePageBackground = useCallback(
    (page: NotebookPage | null | undefined) => {
      if (!page) return { file: null as NotebookFile | null, url: undefined };
      const backgroundFileId = resolveNotebookPageBackgroundFileId({
        pageBackgroundFileId: page.backgroundFileId,
        notebookUploadedFileId,
        firstFileId: files[0]?.id,
        hasMappedPages: hasMappedBackgroundPages,
      });
      if (!backgroundFileId) {
        return { file: null as NotebookFile | null, url: undefined };
      }
      const file = files.find((entry) => entry.id === backgroundFileId) ?? null;
      return { file, url: file ? fileUrls[file.id] : undefined };
    },
    [files, fileUrls, hasMappedBackgroundPages, notebookUploadedFileId]
  );

  // Resolved even before a page is open (unlike resolvePageBackground), and
  // memoised on the open page's own background rather than on every URL.
  const activeNotebookFile = useMemo(() => {
    const backgroundFileId = resolveNotebookPageBackgroundFileId({
      pageBackgroundFileId: selectedPage?.backgroundFileId,
      notebookUploadedFileId,
      firstFileId: files[0]?.id,
      hasMappedPages: hasMappedBackgroundPages,
    });
    if (!backgroundFileId) return null;
    return files.find((file) => file.id === backgroundFileId) ?? null;
  }, [files, hasMappedBackgroundPages, notebookUploadedFileId, selectedPage?.backgroundFileId]);
  const activeNotebookFileUrl = activeNotebookFile ? fileUrls[activeNotebookFile.id] : undefined;
  const activePdfRenderKey =
    selectedPage &&
    activeNotebookFile?.fileType === "application/pdf" &&
    activeNotebookFile.storagePath
      ? `${selectedPage.id}:${activeNotebookFile.id}:${selectedPage.pdfPageIndex ?? 0}`
      : null;

  /** The open page's ink as the editor loads it, legacy strokes as the SVG they always became. */
  const selectedPageInk = useMemo(
    (): NotebookInkData =>
      selectedPage?.inkData ??
      svgNotebookInkData(
        legacyStrokesToJsDrawSvg(
          normalizeNotebookStrokes(selectedPage?.strokeData?.strokes),
          NOTEBOOK_PAGE_COORDINATE_WIDTH,
          NOTEBOOK_PAGE_COORDINATE_HEIGHT
        )
      ),
    [selectedPage]
  );
  /** And as a picture, for the swipe track before the editor has one. */
  const selectedPageInkSvg = useMemo(() => notebookInkSvg(selectedPageInk) ?? "", [selectedPageInk]);

  const carousel = resolveNotebookCarouselPages({
    motion: swipeMotion,
    previousPage: pages[selectedPageIndex - 1] ?? null,
    nextPage: pages[selectedPageIndex + 1] ?? null,
  });

  return {
    selectedPage,
    selectedPageIndex,
    /*
     * Ink is fetched separately from the page record. Until it lands, the
     * canvas is empty for that reason alone, so it must not accept new
     * strokes: the editor reads its SVG once at mount, and drawing here would
     * mean saving a near-blank page over the student's real drawing.
     */
    selectedPageInkUnloaded: selectedPage ? pageHasUnloadedInk(selectedPage) : false,
    selectedPageInk,
    selectedPageInkSvg,
    activeNotebookFile,
    activeNotebookFileUrl,
    activePdfRenderKey,
    resolvePageBackground,
    trackPreviousPage: carousel.previousPage,
    trackNextPage: carousel.nextPage,
  };
}
