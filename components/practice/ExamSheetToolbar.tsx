"use client";

import type { ExamWorkingTool } from "@/hooks/useExamWorkingTools";
import { Button } from "@/components/ui";
import NotebookPageDefaultsPicker from "@/components/workspace/NotebookPageDefaultsPicker";
import ToolbarIconButton from "@/components/workspace/NotebookToolbarIconButton";
import NotebookToolSettingsPopover, {
  type NotebookToolSettingsPopoverProps,
} from "@/components/workspace/NotebookToolSettingsPopover";
import type { ExamSheetPaper } from "@/lib/practice/exam-sheet-paper";
import { getNotebookStrokePaintColor } from "@/lib/workspace/notebook-page-content";
import type { NotebookToolMenu } from "@/lib/workspace/notebook-toolbar";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";

/** The notebook's floating pill, so the working sheet wears the same control. */
const PILL_CLASS =
  "notebook-floating-control flex items-center gap-1 rounded-full border border-[var(--color-border)] p-1.5";

const TOOLS: readonly ExamWorkingTool[] = ["pen", "highlighter", "eraser"];
const TOOL_LABELS: Record<ExamWorkingTool, { inline: string; fullScreen: string }> = {
  pen: { inline: "Pen", fullScreen: "Pen (P)" },
  highlighter: { inline: "Highlighter", fullScreen: "Highlighter (H)" },
  eraser: { inline: "Eraser", fullScreen: "Eraser (E)" },
};

export type ExamSheetZoomControls = {
  zoom: number;
  zoomed: boolean;
  /** Undefined past the last step either way. */
  zoomInTo?: number;
  zoomOutTo?: number;
  onZoom: (zoom: number) => void;
  onFit: () => void;
};

/**
 * The tools, as the notebook draws them: rounded, floating, and over the paper
 * rather than above it.
 *
 * This was a full-width strip with a rule under it that scrolled sideways when
 * it ran out of room -- a piece of page furniture, which on a sheet of exam
 * paper read as browser chrome sitting on the desk. The notebook's own pill is
 * the thing a student already knows, so the same shape is used here, split
 * into what writes and what turns pages so the two wrap onto their own lines on
 * a phone instead of scrolling out of reach.
 *
 * Sticky, so the pen is still under your thumb halfway down a page of working.
 * The settings popover and the paper picker travel with it: both are anchored
 * to this wrapper, so a menu opened after scrolling still opens under the
 * button that opened it.
 */
export default function ExamSheetToolbar({
  expanded,
  disabled,
  tool,
  openMenu,
  penColor,
  highlighterColor,
  onSelectTool,
  ruler,
  settings,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  pages,
  zoom,
  onToggleFullScreen,
  paper,
}: {
  expanded: boolean;
  disabled: boolean;
  tool: ExamWorkingTool;
  openMenu: NotebookToolMenu;
  penColor: NotebookStrokeColor;
  highlighterColor: NotebookStrokeColor;
  onSelectTool: (tool: ExamWorkingTool) => void;
  ruler: { shown: boolean; onToggle: () => void };
  settings: Pick<NotebookToolSettingsPopoverProps, "pen" | "highlighter" | "eraser">;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  pages: {
    index: number;
    count: number;
    /** What the open page is, read out for a screen reader. */
    caption: string;
    canAdd: boolean;
    openIsPrinted: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onAdd: () => void;
    onDelete: () => void;
  };
  zoom: ExamSheetZoomControls;
  onToggleFullScreen: () => void;
  paper: {
    open: boolean;
    onToggle: () => void;
    value: ExamSheetPaper;
    /** The sheet already has pages of the student's own. */
    hasOwnSheets: boolean;
    onChange: (paper: ExamSheetPaper) => void;
  };
}) {
  const zoomControls = <ZoomControls {...zoom} />;

  return (
    <div
      className={`sticky z-30 flex flex-wrap items-center justify-center gap-2 ${
        expanded ? "top-0 shrink-0 px-3 pb-2 pt-[max(0.375rem,env(safe-area-inset-top))]" : "top-2 px-2 py-2 sm:top-3"
      }`}
    >
      <div role="toolbar" aria-label="Working tools" className={PILL_CLASS}>
        {TOOLS.map((item) => (
          <div key={item} className="relative shrink-0">
            <ToolbarIconButton
              label={expanded ? TOOL_LABELS[item].fullScreen : TOOL_LABELS[item].inline}
              icon={item}
              active={tool === item || openMenu === item}
              disabled={disabled}
              expanded={openMenu === item}
              controls="notebook-tool-settings"
              onClick={() => onSelectTool(item)}
            >
              {item !== "eraser" ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-[0.35rem] left-1/2 h-[3px] w-4 -translate-x-1/2 rounded-full"
                  style={{
                    backgroundColor: getNotebookStrokePaintColor(item === "pen" ? penColor : highlighterColor, item),
                  }}
                />
              ) : null}
            </ToolbarIconButton>
          </div>
        ))}
        <ToolbarIconButton
          label={ruler.shown ? "Put the ruler away" : "Ruler"}
          icon="ruler"
          active={ruler.shown}
          pressed={ruler.shown}
          disabled={disabled}
          onClick={ruler.onToggle}
        />
        <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--color-border)]" />
        {/*
          * Offered even when the sheet is all printed pages.
          *
          * It was hidden until a student had a page of their own, which read
          * as tidy and was wrong: nearly every maths question is one printed
          * page, and squared paper is most wanted exactly there. A student has
          * to be able to say "grid" before adding the sheet, not after.
          */}
        {!disabled ? (
          <ToolbarIconButton
            label="Paper"
            icon="pages"
            active={paper.open}
            expanded={paper.open}
            controls="exam-sheet-paper"
            onClick={paper.onToggle}
          />
        ) : null}
        <ToolbarIconButton
          label={expanded ? "Undo (Ctrl+Z)" : "Undo"}
          icon="undo"
          disabled={disabled || !canUndo}
          onClick={onUndo}
        />
        <ToolbarIconButton
          label={expanded ? "Redo (Ctrl+Shift+Z)" : "Redo"}
          icon="redo"
          disabled={disabled || !canRedo}
          onClick={onRedo}
        />
      </div>

      <div role="toolbar" aria-label="Pages" className={PILL_CLASS}>
        <ToolbarIconButton
          label="Previous page"
          icon="back"
          disabled={pages.index === 0}
          onClick={pages.onPrevious}
        />
        <span
          aria-live="polite"
          className="min-w-[3.25rem] text-center text-xs font-semibold tabular-nums text-text-secondary"
        >
          {pages.index + 1} / {pages.count}
        </span>
        <span className="sr-only" aria-live="polite">
          {pages.caption}
        </span>
        <ToolbarIconButton
          label="Next page"
          icon="forward"
          disabled={pages.index >= pages.count - 1}
          onClick={pages.onNext}
        />
        <ToolbarIconButton
          label={pages.canAdd ? "Add another sheet" : `Up to ${pages.count} pages`}
          icon="plus"
          disabled={disabled || !pages.canAdd}
          onClick={pages.onAdd}
        />
        <ToolbarIconButton
          label={pages.openIsPrinted ? "The printed page cannot be removed" : "Delete this sheet"}
          icon="trash"
          disabled={disabled || pages.count <= 1 || pages.openIsPrinted}
          onClick={pages.onDelete}
        />
        <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--color-border)]" />
        {expanded ? zoomControls : null}
        <ToolbarIconButton
          label={expanded ? "Close full screen" : "Write full screen"}
          icon={expanded ? "close" : "expand"}
          active={expanded}
          onClick={onToggleFullScreen}
        />
      </div>

      {/*
        * Always in the toolbar full screen. Inline, only once the page has
        * been pinched -- the way back to the fitted page has to be in reach,
        * but controls nobody has asked for do not -- and floated under the
        * toolbar rather than added to it.
        *
        * It used to join the page pill. On an iPad held upright that made
        * the toolbar too wide for one row, so the moment a pinch ended the
        * toolbar wrapped, and the sheet under the fingers dropped by a row;
        * pinching back out lifted it again.
        */}
      {!expanded && zoom.zoomed ? (
        <div className={`${PILL_CLASS} absolute right-2 top-full mt-1`}>{zoomControls}</div>
      ) : null}

      <NotebookToolSettingsPopover dock="top" openMenu={disabled ? null : openMenu} {...settings} />

      {paper.open ? (
        <div
          id="exam-sheet-paper"
          className="notebook-floating-control absolute left-1/2 top-[4.85rem] z-40 w-[min(92vw,22rem)] -translate-x-1/2 rounded-lg border border-[var(--color-border)] p-3.5 shadow-e2"
        >
          <p className="mb-2 text-xs text-text-muted">
            {paper.hasOwnSheets
              ? "Your own sheets. The printed pages stay exactly as the board printed them."
              : "The sheets you add. The printed pages stay exactly as the board printed them."}
          </p>
          <NotebookPageDefaultsPicker
            pageColor={paper.value.pageColor}
            pageStyle={paper.value.pageStyle}
            disabled={disabled}
            onPageColorChange={(pageColor) => paper.onChange({ ...paper.value, pageColor })}
            onPageStyleChange={(pageStyle) => paper.onChange({ ...paper.value, pageStyle })}
          />
        </div>
      ) : null}
    </div>
  );
}

function ZoomControls({ zoom, zoomed, zoomInTo, zoomOutTo, onZoom, onFit }: ExamSheetZoomControls) {
  return (
    <div
      role="group"
      aria-label="Zoom"
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-0.5"
    >
      <ToolbarIconButton
        label="Zoom out"
        icon="minus"
        disabled={zoomOutTo === undefined}
        onClick={() => onZoom(zoomOutTo ?? 1)}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Fit the page"
        title="Fit the page"
        className="min-w-[3.5rem] tabular-nums"
        onClick={onFit}
      >
        {zoomed ? `${Math.round(zoom * 100)}%` : "Fit"}
      </Button>
      <ToolbarIconButton
        label="Zoom in"
        icon="plus"
        disabled={zoomInTo === undefined}
        onClick={() => onZoom(zoomInTo ?? zoom)}
      />
    </div>
  );
}
