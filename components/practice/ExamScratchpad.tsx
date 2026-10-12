"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import ExamSheetNewSheetHint from "@/components/practice/ExamSheetNewSheetHint";
import ExamSheetPageBackground from "@/components/practice/ExamSheetPageBackground";
import ExamSheetToolbar from "@/components/practice/ExamSheetToolbar";
import { Button, ConfirmDialog } from "@/components/ui";
import { NotebookInkEditor, type NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import { useExamInkActivity } from "@/hooks/useExamInkActivity";
import { useExamSheetDocument } from "@/hooks/useExamSheetDocument";
import { useExamSheetFrame } from "@/hooks/useExamSheetFrame";
import { useExamSheetFullScreen } from "@/hooks/useExamSheetFullScreen";
import { useExamWorkingTools, type ExamWorkingTool } from "@/hooks/useExamWorkingTools";
import { examSheetCorner, examSheetPageCaption } from "@/lib/practice/exam-question-sheet";
import {
  readExamSheetPaperPreference,
  saveExamSheetPaperPreference,
  type ExamSheetPaper,
} from "@/lib/practice/exam-sheet-paper";
import { nextExamWorkingZoomStep, type ExamScratchpadHandle } from "@/lib/practice/exam-working";
import type { PracticePaperQuestionAsset } from "@/lib/practice/practice-papers";
import { svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";
import { getNotebookInkRenderWindow } from "@/lib/workspace/notebook-ink-window";
import { getNotebookPaperPalette } from "@/lib/workspace/notebook-paper-palette";

export type { ExamScratchpadHandle } from "@/lib/practice/exam-working";

/** Held stable, so passing it never re-renders the ink editor. */
const ignorePointer = () => undefined;

/*
 * Memoised, with every callback below held stable, the way the notebook holds
 * its editor. The sheet re-rendered the editor on every one of its own renders
 * with fresh inline callbacks, so the ink surface was being reconciled while a
 * student was writing on it.
 */
const WorkingInkEditor = memo(NotebookInkEditor);

type ConfirmRequest = "clear-page" | "delete-page" | null;

/**
 * The question, as a sheet of paper to answer on.
 *
 * It is the notebook's ink editor with the notebook's tools and settings,
 * deliberately: a student who has learned to write in Jami should not meet a
 * different, worse pen the moment the work is being marked. Pen feel and
 * scribble-to-erase are read from the same saved preferences, so a hand tuned
 * once stays tuned here.
 *
 * What changed is what is under the ink. This used to be four blank pads
 * beside a picture of the question, which is why answering felt like a
 * separate exercise from reading: the paper was one thing on the screen and
 * the work was another. The pages are now the board's own pages -- its
 * wording, its diagrams, its ruled answer lines, at the size it printed them
 * -- followed by as many blank sheets as the question needs.
 *
 * What it is still not is a notebook page. There is no text layer and no
 * images a student can add: the typed answer sits under the sheet, and what is
 * sent for marking is the ink on these pages and nothing else.
 */
function ExamScratchpad({
  userId,
  attemptId,
  disabled = false,
  embedded = false,
  printedPages,
  answerSpacePages,
  questionLabel,
  assetPath,
  onHandle,
  onInkChange,
}: {
  userId: string;
  attemptId: string;
  disabled?: boolean;
  /** Drawn flush inside a surrounding sheet, without a frame of its own. */
  embedded?: boolean;
  /**
   * The question's own pages of paper, in printed order, or empty for a
   * question that has none.
   *
   * Held stable by the caller: this is the identity the whole sheet is built
   * from, and a fresh array every render would rebuild the editor under a
   * student's hand.
   */
  printedPages: readonly PracticePaperQuestionAsset[];
  /** Ruled pages the board left after the question, which its crop drops. */
  answerSpacePages?: number;
  questionLabel: string;
  /** Where a printed page's image is fetched from, given its asset id. */
  assetPath(assetId: string): string;
  onHandle(handle: ExamScratchpadHandle | null): void;
  onInkChange?(hasInk: boolean, attemptId: string): void;
}) {
  const editorRef = useRef<NotebookInkEditorHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The page itself: what a pinch scales and a pan moves. */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /** The window the page is seen through, and what every finger lands on. */
  const frameRef = useRef<HTMLDivElement | null>(null);
  /** The element a page turn slides: the track the page sits on. */
  const pageShellRef = useRef<HTMLDivElement | null>(null);
  const addSheetHintRef = useRef<HTMLDivElement | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest>(null);
  const [expanded, setExpanded] = useState(false);
  /** The paper the student's own sheets are made of. Never the board's pages. */
  const [paper, setPaper] = useState<ExamSheetPaper>(readExamSheetPaperPreference);
  const [paperOpen, setPaperOpen] = useState(false);

  const ink = useExamInkActivity();
  const sheet = useExamSheetDocument({
    userId,
    attemptId,
    disabled,
    printedPages,
    answerSpacePages,
    questionLabel,
    paper,
    editorRef,
    isInking: ink.isInking,
    onHandle,
    onInkChange,
  });
  const { currentPage, pageIndex, pageMount, pageSvgs } = sheet;
  // The open page's stored SVG as the editor takes it, the same object while it is the same page.
  const openPageSvg = pageSvgs?.[pageIndex] ?? "";
  const openPageInk = useMemo(() => (openPageSvg ? svgNotebookInkData(openPageSvg) : null), [openPageSvg]);
  const ownPaper = getNotebookPaperPalette(paper.pageColor);

  const tools = useExamWorkingTools({
    paperIsDark: currentPage.kind !== "printed" && ownPaper.isDark,
    pageKey: pageMount,
    canClearPage: !disabled && sheet.currentPageHasInk,
    onRequestClearPage: () => setConfirm("clear-page"),
  });

  const frame = useExamSheetFrame({
    rootRef,
    frameRef,
    surfaceRef,
    pageShellRef,
    addSheetHintRef,
    expanded,
    disabled,
    sheetPages: sheet.sheetPages,
    currentPage,
    pageIndex,
    pageKey: pageMount,
    canAddPage: sheet.canAddPage,
    goToPage: sheet.goToPage,
    addPage: sheet.addPage,
    ink,
  });
  const { layout, zoomed, fitPage, cancelGesture } = frame;

  const closeFullScreen = useCallback(() => {
    setExpanded(false);
    fitPage();
  }, [fitPage]);
  useExamSheetFullScreen({ expanded, rootRef, editorRef, onClose: closeFullScreen, onPickTool: tools.pickTool });

  const { noteStroke } = ink;
  const { holdForStroke, resumeAfterStroke } = sheet;
  const handleInteractionChange = useCallback(
    (active: boolean) => {
      noteStroke(active);
      if (active) {
        holdForStroke();
        cancelGesture();
        return;
      }
      resumeAfterStroke();
    },
    [cancelGesture, holdForStroke, noteStroke, resumeAfterStroke]
  );

  const toggleFullScreen = () => {
    setExpanded((value) => !value);
    // Each mode opens fitted: a zoom chosen for one frame means little in the other.
    fitPage();
  };

  const pressTool = (item: ExamWorkingTool) => {
    setPaperOpen(false);
    tools.selectTool(item);
  };

  const choosePaper = (next: ExamSheetPaper) => {
    setPaper(next);
    saveExamSheetPaperPreference(next);
  };

  /** A printed page is white paper; a student's own sheet is the paper they chose. */
  const pagePaperColor = currentPage.kind === "printed" ? "#ffffff" : ownPaper.paper;
  const corner = examSheetCorner(layout.pageSize.width);

  /**
   * The slice of the page the ink canvas is asked to paint.
   *
   * Null unless the page is zoomed past its fitted size, which is the only
   * time the sheet is larger than the frame showing it -- so a fitted sheet is
   * painted exactly as it always was. See `notebook-ink-window.ts`: js-draw
   * clears and repaints its whole backing store on every frame of a stroke, so
   * a page zoomed to 3x costs nine times the work per frame and shows a ninth
   * of it.
   */
  const inkWindow = useMemo(
    () =>
      zoomed
        ? getNotebookInkRenderWindow({
            sheetWidth: layout.pageSize.width,
            sheetHeight: layout.pageSize.height,
            pageX: layout.pageOrigin.x,
            pageY: layout.pageOrigin.y,
            frameWidth: layout.frameSize.width,
            frameHeight: layout.frameSize.height,
            devicePixelRatio: window.devicePixelRatio || 1,
          })
        : null,
    [layout, zoomed]
  );

  /**
   * Where the sheet sits in the frame showing it, zoomed or not. Jami Ink
   * needs the part of the sheet on screen after every pan settles, and the
   * snapped window above does not change for a small pan.
   */
  const frameWidth = layout.frameSize.width;
  const frameHeight = layout.frameSize.height;
  const originX = layout.pageOrigin.x;
  const originY = layout.pageOrigin.y;
  const inkFrame = useMemo(
    () => ({ pageX: originX, pageY: originY, frameWidth, frameHeight }),
    [frameHeight, frameWidth, originX, originY]
  );

  /**
   * Inline and fitted, a finger dragged up or down the sheet scrolls the
   * practice page natively; see the claim listener in `useExamSheetFrame`.
   * Zoomed, or full screen, every finger is the sheet's.
   */
  const fingersScrollPage = !expanded && !zoomed;

  return (
    <div
      ref={rootRef}
      tabIndex={expanded ? -1 : undefined}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? "Your working, full screen" : undefined}
      className={
        expanded
          ? "fixed inset-0 z-[70] flex flex-col bg-[var(--app-background)] outline-none"
          : embedded
            ? "relative"
            : "relative overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-shell"
      }
    >
      <ExamSheetToolbar
        expanded={expanded}
        disabled={disabled}
        tool={tools.tool}
        openMenu={tools.openMenu}
        penColor={tools.penColor}
        highlighterColor={tools.highlighterColor}
        onSelectTool={pressTool}
        ruler={{ shown: tools.rulerShown, onToggle: tools.toggleRuler }}
        settings={tools.settings}
        canUndo={sheet.history.undo > 0}
        canRedo={sheet.history.redo > 0}
        onUndo={() => editorRef.current?.undo()}
        onRedo={() => editorRef.current?.redo()}
        pages={{
          index: pageIndex,
          count: sheet.pageCount,
          caption: examSheetPageCaption({ page: currentPage, questionLabel, printedPageCount: sheet.printedPageCount }),
          canAdd: sheet.canAddPage,
          openIsPrinted: currentPage.kind === "printed",
          onPrevious: () => sheet.goToPage(pageIndex - 1),
          onNext: () => sheet.goToPage(pageIndex + 1),
          onAdd: sheet.addPage,
          onDelete: () => (sheet.currentPageHasInk ? setConfirm("delete-page") : sheet.deletePage()),
        }}
        zoom={{
          zoom: layout.zoom,
          zoomed,
          zoomInTo: nextExamWorkingZoomStep(layout.zoom, "in"),
          zoomOutTo: nextExamWorkingZoomStep(layout.zoom, "out"),
          onZoom: (zoom) => frame.zoomAbout(zoom),
          onFit: fitPage,
        }}
        onToggleFullScreen={toggleFullScreen}
        paper={{
          open: paperOpen,
          onToggle: () => {
            tools.closeMenu();
            setPaperOpen((open) => !open);
          },
          value: paper,
          hasOwnSheets: sheet.sheetPages.some((page) => page.kind === "continuation"),
          onChange: choosePaper,
        }}
      />

      {sheet.saveProblem ? (
        <p className="shrink-0 border-b border-[var(--color-border)] bg-error/10 px-3 py-2 text-sm text-text-primary">
          {sheet.saveProblem}
        </p>
      ) : null}

      {/*
        * The frame, the track and the page: always these three elements,
        * whether or not the sheet is full screen, so switching mode restyles
        * them rather than rebuilding the editor.
        *
        * The notebook's shape, deliberately. The frame is the window the page
        * is seen through, and takes every finger; the track is what a page
        * turn slides; the page sits on the track where the viewport puts it,
        * at the size its zoom makes it.
        */}
      <div
        ref={frameRef}
        data-notebook-page-frame
        data-sheet-touch={fingersScrollPage ? "scroll" : undefined}
        className={
          expanded
            ? "relative mb-[env(safe-area-inset-bottom)] min-h-0 flex-1 overflow-hidden"
            : "relative overflow-hidden bg-[var(--color-glass-subtle)]"
        }
        style={
          expanded
            ? undefined
            : frame.inlineHeight > 0
              ? { height: frame.inlineHeight }
              : { aspectRatio: `${frame.tallestPage.width} / ${frame.tallestPage.height}` }
        }
        {...frame.frameHandlers}
      >
        <div ref={pageShellRef} className="notebook-page-track absolute inset-0">
          {/*
            * `notebook-page-surface` is the notebook sheet's own ground rules: no
            * text selection, callout or drag, no overscroll, no native pan. Paint
            * containment keeps every ink frame's repaint inside the page instead
            * of invalidating the scrolling page around it.
            *
            * Rounded like a sheet of paper, without rounding anything printed
            * on it. Clipping the page itself to a radius once cut off the
            * board's margin rule and the question number printed in the corner
            * of the crop. So the page keeps its square clip -- the ink canvas
            * has to be held inside it -- and the rounded sheet is a card of
            * the same paper behind it, a few pixels larger all round: just
            * enough that the square corner of the print falls inside the curve
            * rather than outside it. Nothing moves, and nothing is cut.
            */}
          <div
            ref={surfaceRef}
            className="notebook-page-surface absolute left-0 top-0"
            style={{
              width: layout.pageSize.width,
              height: layout.pageSize.height,
              transform: `translate3d(${layout.pageOrigin.x}px, ${layout.pageOrigin.y}px, 0)`,
              transformOrigin: "0 0",
            }}
          >
            {layout.pageSize.width > 0 ? (
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute ring-1 ring-black/[0.07] ${
                  expanded ? "shadow-shell" : "shadow-e1"
                }`}
                style={{
                  inset: -corner.bleed,
                  borderRadius: corner.radius,
                  backgroundColor: pagePaperColor,
                }}
              />
            ) : null}
            <div
              className="absolute inset-0 overflow-hidden [contain:layout_paint]"
              style={{ backgroundColor: pagePaperColor }}
            >
              {layout.pageSize.width <= 0 ? null : sheet.loadFailed ? (
                <div className="absolute inset-0 grid place-items-center gap-3 p-6 text-center">
                  <p className="text-sm text-text-secondary">
                    Your saved working could not be opened. It has not been lost — nothing will be written
                    over it until it loads.
                  </p>
                  <Button type="button" variant="secondary" onClick={sheet.retryLoad}>
                    Try again
                  </Button>
                </div>
              ) : pageSvgs !== null ? (
                <>
                  {/*
                    * The paper under the ink. Drawn inside the same clipped,
                    * paint-contained box, so a stroke repaints the page and
                    * nothing above it, and the print never moves relative to
                    * what is written on it.
                    */}
                  <ExamSheetPageBackground
                    key={`bg:${attemptId}:${pageIndex}`}
                    page={currentPage}
                    assetPath={assetPath}
                    questionLabel={questionLabel}
                    paper={paper}
                  />
                  <WorkingInkEditor
                    key={`${attemptId}:${pageMount}`}
                    ref={editorRef}
                    {...tools.ink}
                    initialInk={openPageInk}
                    inkWindow={inkWindow}
                    inkFrame={inkFrame}
                    pageHeight={currentPage.height}
                    pageId={`${attemptId}:${pageIndex}`}
                    pageWidth={currentPage.width}
                    readOnly={disabled}
                    onChange={sheet.handleInkChange}
                    onHistoryChange={sheet.handleHistoryChange}
                    onInteractionChange={handleInteractionChange}
                    // Fingers are the frame's, and reach it by bubbling.
                    onPointerCancel={ignorePointer}
                    onPointerDown={ignorePointer}
                    onPointerMove={ignorePointer}
                    onPointerUp={ignorePointer}
                  />
                </>
              ) : (
                <div className="absolute inset-0 grid place-items-center text-sm text-text-muted">
                  Opening your working…
                </div>
              )}
            </div>
          </div>
        </div>

        {!disabled && sheet.canAddPage ? <ExamSheetNewSheetHint ref={addSheetHintRef} /> : null}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "delete-page" ? "Delete this sheet?" : "Clear this page?"}
        description={
          confirm === "delete-page"
            ? "Everything written on this extra sheet is removed."
            : "Everything written on this page is removed. You can undo it straight after."
        }
        confirmLabel={confirm === "delete-page" ? "Delete sheet" : "Clear page"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === "delete-page") sheet.deletePage();
          else editorRef.current?.clear();
          setConfirm(null);
        }}
      />
    </div>
  );
}

/*
 * Memoised so the session around it -- its polling, its save indicator, the
 * answer beside it -- does not re-render the sheet while a student writes.
 */
export default memo(ExamScratchpad);
