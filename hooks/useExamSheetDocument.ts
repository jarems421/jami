"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import {
  examSheetContinuationRoom,
  examSheetOpeningContinuations,
  examSheetPages,
  examSheetReopening,
} from "@/lib/practice/exam-question-sheet";
import type { ExamSheetPaper } from "@/lib/practice/exam-sheet-paper";
import {
  captureExamWorking,
  compactExamWorkingPages,
  examWorkingHasInk,
  type ExamScratchpadHandle,
} from "@/lib/practice/exam-working";
import { BLANK_PAGE, pagesToPng } from "@/lib/practice/exam-working-snapshot";
import type { PracticePaperQuestionAsset } from "@/lib/practice/practice-papers";
import { NOTEBOOK_INK_UI_SYNC_IDLE_MS } from "@/lib/workspace/notebook-autosave";
import { notebookInkSvg } from "@/lib/workspace/notebook-ink-data";
import type { NotebookInkData } from "@/lib/workspace/notebooks";
import {
  ExamScratchpadTooLargeError,
  loadExamScratchpad,
  saveExamScratchpad,
} from "@/services/study/exam-practice";

/**
 * A page of the sheet as it is kept: its SVG. The sheet's record is held by
 * the security rules to SVG pages, so Jami Ink's own encoding is not stored
 * here (`docs/notebook-ink.md`).
 */
const pageSvg = (ink: NotebookInkData | null): string | null => (ink === null ? null : (notebookInkSvg(ink) ?? ""));

/*
 * How long the pen has to stay lifted before the sheet is written.
 *
 * This was a 700ms debounce on every change, and it was the main reason
 * writing lagged. The editor only starts preparing a snapshot of the page
 * after 600ms of stillness, and finishes it over several frames -- so at 700ms
 * there was usually none, and the save exported the whole page on the main
 * thread instead, freezing it in exactly the pause between two words. If the
 * pen was already down again the export refused, and the save wrote the
 * previous copy of every page to Firestore in the middle of the stroke anyway.
 *
 * Now nothing is written while the pen is down, the wait restarts every time
 * it lifts, and the page is read with the editor's own non-blocking export.
 */
const SAVE_IDLE_MS = 1_500;

const NO_HISTORY = { undo: 0, redo: 0 };

/**
 * The working sheet's pages: what is written on each, which is open, and
 * keeping the stored copy up to date.
 *
 * The open page lives in the ink editor and every other page as markup here.
 * Turning a page reads the open one out of the editor, and the editor is
 * remounted on the page being opened.
 */
export function useExamSheetDocument({
  userId,
  attemptId,
  disabled,
  printedPages,
  answerSpacePages,
  questionLabel,
  paper,
  editorRef,
  isInking,
  onHandle,
  onInkChange,
}: {
  userId: string;
  attemptId: string;
  disabled: boolean;
  printedPages: readonly PracticePaperQuestionAsset[];
  answerSpacePages?: number;
  questionLabel: string;
  /** The paper the student's own sheets are drawn on, for the marker's copy. */
  paper: ExamSheetPaper;
  editorRef: RefObject<NotebookInkEditorHandle | null>;
  isInking: () => boolean;
  onHandle(handle: ExamScratchpadHandle | null): void;
  /** Whether the sheet has ink, named by attempt so a report from a sheet being left is never read as the next one's. */
  onInkChange?(hasInk: boolean, attemptId: string): void;
}) {
  const mountedRef = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ink on the sheet that the stored copy does not have yet. */
  const dirtyRef = useRef(false);
  const latestHistoryRef = useRef(NO_HISTORY);
  /** The latest markup of every page; the open page is read from the editor. */
  const pagesRef = useRef<string[]>([]);
  /**
   * Whether each stored page has ink, worked out when the pages change.
   *
   * It used to be recomputed after every stroke by running the ink check over
   * every other page's markup -- a regex pass over up to hundreds of kilobytes,
   * fired dozens of times a line.
   */
  const pageInkRef = useRef<boolean[]>([]);
  const pageIndexRef = useRef(0);
  const loadedRef = useRef(false);
  const flushOnLeaveRef = useRef<() => void>(() => undefined);
  /** What each page opens with. Refreshed whenever the open page changes. */
  const [pageSvgs, setPageSvgs] = useState<string[] | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  /** Remounts the editor when the open page's content changes underneath it. */
  const [pageMount, setPageMount] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveProblem, setSaveProblem] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [history, setHistory] = useState(NO_HISTORY);
  /**
   * Blank sheets after the printed ones.
   *
   * Not stored. It is the larger of what the board left room for and what the
   * student has actually written on, so a sheet reopens with every page that
   * carries ink and never fewer pages than the paper allotted.
   */
  const [continuationCount, setContinuationCount] = useState(() =>
    examSheetOpeningContinuations({ answerSpacePages, printedPageCount: printedPages.length })
  );

  const sheetPages = useMemo(
    () => examSheetPages({ printedPages, continuationCount }),
    [continuationCount, printedPages]
  );
  const pageCount = sheetPages.length;
  const printedPageCount = printedPages.length;
  const canAddPage = continuationCount < examSheetContinuationRoom(printedPageCount);
  /** The page under the pen. Its shape is the paper's, not a fixed one. */
  const currentPage = sheetPages[pageIndex] ?? sheetPages[0] ?? BLANK_PAGE;

  /** Every page and the paper, as last rendered, for the marker's copy. */
  const sheetForMarkerRef = useRef({ sheetPages, paper });
  useLayoutEffect(() => {
    sheetForMarkerRef.current = { sheetPages, paper };
  });

  const setPages = useCallback((pages: string[]) => {
    pagesRef.current = pages;
    pageInkRef.current = pages.map((page) => examWorkingHasInk(page));
  }, []);

  useEffect(() => {
    let active = true;
    loadedRef.current = false;
    void loadExamScratchpad(userId, attemptId)
      .then((stored) => {
        if (!active) return;
        const reopened = examSheetReopening({ stored, printedPages, answerSpacePages });
        setContinuationCount(reopened.continuationCount);
        setPages(reopened.pages);
        pageIndexRef.current = 0;
        loadedRef.current = true;
        setPageIndex(0);
        setPageSvgs(reopened.pages);
        onInkChange?.(pageInkRef.current.some(Boolean), attemptId);
      })
      // An empty sheet after a failed read is not an empty sheet: writing to it
      // would replace working that is still there. Offer a retry instead.
      .catch(() => active && setLoadFailed(true));
    return () => {
      active = false;
    };
  }, [answerSpacePages, attemptId, onInkChange, printedPages, reloadKey, setPages, userId]);

  const retryLoad = useCallback(() => {
    setLoadFailed(false);
    setReloadKey((value) => value + 1);
  }, []);

  /** Every page as it stands now, read at once. For page turns and leaving only. */
  const collectPages = useCallback(() => {
    const pages = [...pagesRef.current];
    const editor = editorRef.current;
    if (editor) {
      const current = pageSvg(editor.serializeWarm() ?? editor.serialize());
      if (current != null) pages[pageIndexRef.current] = current;
    }
    setPages(pages);
    return pages;
  }, [editorRef, setPages]);

  const writePages = useCallback(
    async (pages: readonly string[]) => {
      /*
       * The label follows what is on the pages, not the undo stack. Drawing a
       * stroke and erasing it leaves history behind and no ink, and the sheet
       * would still have claimed it was being sent with the answer.
       */
      onInkChange?.(pageInkRef.current.some(Boolean), attemptId);
      try {
        await saveExamScratchpad(userId, attemptId, compactExamWorkingPages(pages));
        if (mountedRef.current) setSaveProblem("");
        return true;
      } catch (error) {
        if (mountedRef.current) {
          setSaveProblem(
            error instanceof ExamScratchpadTooLargeError
              ? "These pages are too detailed to save. Your last saved working is safe — erase some of it, or submit what you have."
              : "Your working could not be saved just now. It is still on the page."
          );
        }
        return false;
      }
    },
    [attemptId, onInkChange, userId]
  );

  /** Writes the sheet once the pen has been still, without blocking the page to read it. */
  const saveWhenStill = useCallback(async () => {
    if (!mountedRef.current || disabled || !loadedRef.current || !dirtyRef.current) return;
    const editor = editorRef.current;
    if (!editor || isInking()) return;
    const index = pageIndexRef.current;
    const current = pageSvg(await editor.serializeAsync());
    /*
     * The pen came down, the page turned or the editor was replaced while the
     * page was being read: that copy is already out of date. Whatever changed
     * schedules its own save, so nothing is written here.
     */
    if (current == null || editor !== editorRef.current || index !== pageIndexRef.current) return;
    const pages = [...pagesRef.current];
    pages[index] = current;
    setPages(pages);
    dirtyRef.current = false;
    if (!(await writePages(pages))) dirtyRef.current = true;
  }, [disabled, editorRef, isInking, setPages, writePages]);

  const scheduleSave = useCallback(() => {
    // Once the answer is frozen the sheet is evidence rather than a draft, and
    // the security rules refuse the write — so it is not attempted.
    if (disabled) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveWhenStill();
    }, SAVE_IDLE_MS);
  }, [disabled, saveWhenStill]);

  const writeNow = useCallback(() => {
    if (disabled || !loadedRef.current || !dirtyRef.current) return;
    const pages = collectPages();
    dirtyRef.current = false;
    void writePages(pages);
  }, [collectPages, disabled, writePages]);

  useEffect(() => {
    flushOnLeaveRef.current = writeNow;
  }, [writeNow]);

  /*
   * Leaving flushes the sheet rather than cancelling it, for the same reason
   * the typed draft does: the last stroke is the one most worth keeping.
   *
   * A layout effect, so it runs before the editor underneath is detached: a
   * passive cleanup ran after it, found no editor, and could only save the copy
   * from the last pause.
   */
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (uiSyncTimer.current) {
        clearTimeout(uiSyncTimer.current);
        uiSyncTimer.current = null;
      }
      flushOnLeaveRef.current();
    };
  }, []);

  useEffect(() => {
    const handle: ExamScratchpadHandle = {
      attemptId,
      snapshot: () =>
        captureExamWorking({
          serialize: async () => {
            const editor = editorRef.current;
            if (!loadedRef.current || !editor) return null;
            const current = pageSvg(await editor.serializeAsync());
            if (current == null) return null;
            const pages = [...pagesRef.current];
            pages[pageIndexRef.current] = current;
            setPages(pages);
            return pages;
          },
          save: async (pages) => {
            await saveExamScratchpad(userId, attemptId, compactExamWorkingPages(pages));
            dirtyRef.current = false;
          },
          rasterize: (inked) => {
            const { sheetPages: sheet, paper: sheetPaper } = sheetForMarkerRef.current;
            return pagesToPng(inked, sheet, questionLabel, sheetPaper);
          },
        }),
    };
    onHandle(handle);
    return () => onHandle(null);
  }, [attemptId, editorRef, onHandle, questionLabel, setPages, userId]);

  /*
   * Toolbar state, a moment after the pen lifts.
   *
   * Every stroke used to set the undo state straight away, re-rendering the
   * toolbar and its settings between two strokes of the same word -- and
   * handwriting is dozens of strokes a line. The notebook commits the same
   * state 200ms after the pen lifts and cancels it when the pen comes back
   * down; this does the same.
   */
  const flushUiSync = useCallback(() => {
    uiSyncTimer.current = null;
    if (!mountedRef.current) return;
    const { undo, redo } = latestHistoryRef.current;
    setHistory((current) => (current.undo === undo && current.redo === redo ? current : { undo, redo }));
    const otherPagesHaveInk = pageInkRef.current.some(
      (hasInk, index) => hasInk && index !== pageIndexRef.current
    );
    onInkChange?.(undo > 0 || otherPagesHaveInk, attemptId);
  }, [attemptId, onInkChange]);

  const scheduleUiSync = useCallback(() => {
    if (uiSyncTimer.current) clearTimeout(uiSyncTimer.current);
    uiSyncTimer.current = setTimeout(flushUiSync, NOTEBOOK_INK_UI_SYNC_IDLE_MS);
  }, [flushUiSync]);

  const handleHistoryChange = useCallback(
    (undo: number, redo: number) => {
      latestHistoryRef.current = { undo, redo };
      if (!isInking()) scheduleUiSync();
    },
    [isInking, scheduleUiSync]
  );

  const handleInkChange = useCallback(() => {
    if (disabled) return;
    dirtyRef.current = true;
    if (!isInking()) scheduleSave();
  }, [disabled, isInking, scheduleSave]);

  /** Nothing waits to run in the middle of a stroke. */
  const holdForStroke = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (uiSyncTimer.current) {
      clearTimeout(uiSyncTimer.current);
      uiSyncTimer.current = null;
    }
  }, []);

  /** The pen lifted: save what it wrote once it has been still, and settle the toolbar. */
  const resumeAfterStroke = useCallback(() => {
    if (!mountedRef.current) return;
    if (dirtyRef.current) scheduleSave();
    scheduleUiSync();
  }, [scheduleSave, scheduleUiSync]);

  /*
   * Opens a page, keeping what is on the one being left. The editor is
   * remounted on it, with a history of its own.
   */
  const showPage = useCallback(
    (pages: string[], nextIndex: number) => {
      setPages(pages);
      pageIndexRef.current = nextIndex;
      latestHistoryRef.current = NO_HISTORY;
      setPageSvgs(pages);
      setPageIndex(nextIndex);
      setPageMount((value) => value + 1);
      setHistory(NO_HISTORY);
    },
    [setPages]
  );

  const markChanged = useCallback(() => {
    if (disabled) return;
    dirtyRef.current = true;
    scheduleSave();
  }, [disabled, scheduleSave]);

  const goToPage = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= pageCount || nextIndex === pageIndexRef.current) return;
      showPage(collectPages(), nextIndex);
      markChanged();
    },
    [collectPages, markChanged, pageCount, showPage]
  );

  /**
   * More room, the way the real paper gives it.
   *
   * A student who runs out of space in an exam asks for an extra answer
   * booklet; they do not decide in advance how much of the page each part of
   * the question deserves. This is the same offer, and it is deliberately not
   * a decision: the sheet never refuses ink for want of space until it has
   * handed out every page it is allowed to.
   */
  const addPage = useCallback(() => {
    if (disabled || !canAddPage) return;
    const pages = [...collectPages()];
    while (pages.length < pageCount) pages.push("");
    pages.push("");
    setContinuationCount((value) => value + 1);
    showPage(pages, pages.length - 1);
    markChanged();
  }, [canAddPage, collectPages, disabled, markChanged, pageCount, showPage]);

  /** Printed pages belong to the paper; only the sheet's own can be removed. */
  const deletePage = useCallback(() => {
    const leaving = pageIndexRef.current;
    if (disabled || pageCount <= 1 || sheetPages[leaving]?.kind !== "continuation") return;
    const pages = collectPages().filter((_page, index) => index !== leaving);
    setContinuationCount((value) => Math.max(0, value - 1));
    showPage(pages, Math.min(leaving, pages.length - 1));
    markChanged();
  }, [collectPages, disabled, markChanged, pageCount, sheetPages, showPage]);

  const openedPageHasInk = useMemo(
    () => examWorkingHasInk(pageSvgs?.[pageIndex] ?? ""),
    [pageIndex, pageSvgs]
  );

  return {
    sheetPages,
    pageCount,
    printedPageCount,
    canAddPage,
    currentPage,
    pageIndex,
    pageMount,
    pageSvgs,
    loadFailed,
    retryLoad,
    saveProblem,
    history,
    currentPageHasInk: history.undo > 0 || openedPageHasInk,
    goToPage,
    addPage,
    deletePage,
    handleInkChange,
    handleHistoryChange,
    holdForStroke,
    resumeAfterStroke,
  };
}
