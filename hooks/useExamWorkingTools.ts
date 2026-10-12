"use client";

import { useCallback, useMemo, useState } from "react";
import type { NotebookToolSettingsPopoverProps } from "@/components/workspace/NotebookToolSettingsPopover";
import {
  NOTEBOOK_ERASER_THICKNESS_BY_SIZE,
  type NotebookEraserMode,
  type NotebookEraserSize,
} from "@/lib/workspace/notebook-eraser";
import { getHighlighterWidthFromPercent, getPenWidthFromPercent } from "@/lib/workspace/notebook-inking";
import { getVisibleNibColor } from "@/lib/workspace/notebook-paper-palette";
import {
  clampNotebookPenSettings,
  readNotebookPenSettings,
  saveNotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";
import {
  readNotebookScribbleErasePreference,
  saveNotebookScribbleErasePreference,
  type NotebookToolMenu,
} from "@/lib/workspace/notebook-toolbar";
import {
  readNotebookToolPreferences,
  saveNotebookToolPreferences,
} from "@/lib/workspace/notebook-tool-preferences";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";

/** A sheet of working has no text layer, so these are its only tools. */
export type ExamWorkingTool = "pen" | "highlighter" | "eraser";

/**
 * The notebook's pen, highlighter and eraser, on the working sheet.
 *
 * Read from the same saved preferences the notebook writes, once, so a pen
 * tuned in a notebook is the pen picked up here -- and what is changed here is
 * saved back for the notebook. The options menu closes whenever another page
 * is opened.
 */
export function useExamWorkingTools({
  paperIsDark,
  pageKey,
  canClearPage,
  onRequestClearPage,
}: {
  /** The page under the pen is dark, so a black nib would write nothing. */
  paperIsDark: boolean;
  /** Changes whenever another page is opened. */
  pageKey: number;
  canClearPage: boolean;
  /** The eraser's "clear page" asks first; the sheet owns that question. */
  onRequestClearPage: () => void;
}) {
  const [tool, setTool] = useState<ExamWorkingTool>("pen");
  const [openMenu, setOpenMenu] = useState<NotebookToolMenu>(null);
  /*
   * The pen as it was last put down, in the notebook or on another sheet.
   * Read once, like the settings below: it is one pen wherever it is picked up.
   */
  const [initialTools] = useState(readNotebookToolPreferences);
  const [penColor, setPenColor] = useState<NotebookStrokeColor>(initialTools.penColor);
  const [penThicknessPercent, setPenThicknessPercent] = useState(initialTools.penThicknessPercent);
  // Read once, lazily: the saved preferences are this sheet's starting values,
  // and nothing on the first paint depends on them.
  const [penSettings, setPenSettings] = useState(readNotebookPenSettings);
  const [scribbleToErase, setScribbleToErase] = useState(readNotebookScribbleErasePreference);
  /** The ruler, the one new note-taking tool the exam sheet has. Not saved. */
  const [rulerShown, setRulerShown] = useState(false);
  const [highlighterColor, setHighlighterColor] = useState<NotebookStrokeColor>(initialTools.highlighterColor);
  const [highlighterThicknessPercent, setHighlighterThicknessPercent] = useState(
    initialTools.highlighterThicknessPercent
  );
  const [eraserMode, setEraserMode] = useState<NotebookEraserMode>(initialTools.eraserMode);
  const [eraserSize, setEraserSize] = useState<NotebookEraserSize>(initialTools.eraserSize);

  /*
   * Keep the nib visible on the paper under it, as the notebook does: a white
   * pen from a black notebook page would otherwise write nothing on the
   * board's white print. Only when the paper changes, so a colour picked on
   * this page stands.
   */
  const [nibPaperIsDark, setNibPaperIsDark] = useState<boolean | null>(null);
  if (nibPaperIsDark !== paperIsDark) {
    setNibPaperIsDark(paperIsDark);
    setPenColor((current) => getVisibleNibColor(current, paperIsDark));
  }

  const [menuPageKey, setMenuPageKey] = useState(pageKey);
  if (menuPageKey !== pageKey) {
    setMenuPageKey(pageKey);
    setOpenMenu(null);
  }

  /** Pressing the active tool opens its options; pressing another switches. */
  const selectTool = useCallback(
    (next: ExamWorkingTool) => {
      if (tool === next) {
        setOpenMenu((current) => (current === next ? null : next));
        return;
      }
      setTool(next);
      setOpenMenu(null);
    },
    [tool]
  );

  /** Switches straight to a tool, as its keyboard shortcut does. */
  const pickTool = useCallback((next: ExamWorkingTool) => {
    setTool(next);
    setOpenMenu(null);
  }, []);

  const closeMenu = useCallback(() => setOpenMenu(null), []);

  const widths = useMemo(
    () => ({
      pen: getPenWidthFromPercent(penThicknessPercent),
      highlighter: getHighlighterWidthFromPercent(highlighterThicknessPercent),
      eraser: NOTEBOOK_ERASER_THICKNESS_BY_SIZE[eraserSize],
    }),
    [eraserSize, highlighterThicknessPercent, penThicknessPercent]
  );

  const settings: Pick<NotebookToolSettingsPopoverProps, "pen" | "highlighter" | "eraser"> = {
    pen: {
      color: penColor,
      thicknessPercent: penThicknessPercent,
      onColorChange: (color) => {
        setPenColor(color);
        saveNotebookToolPreferences({ penColor: color });
      },
      onThicknessChange: (value) => {
        setPenThicknessPercent(value);
        saveNotebookToolPreferences({ penThicknessPercent: value });
      },
      settings: penSettings,
      onSettingsChange: (value) => {
        const next = clampNotebookPenSettings(value);
        setPenSettings(next);
        saveNotebookPenSettings(next);
      },
      scribbleToErase,
      onScribbleToEraseChange: (enabled) => {
        setScribbleToErase(enabled);
        saveNotebookScribbleErasePreference(enabled);
      },
    },
    highlighter: {
      color: highlighterColor,
      thicknessPercent: highlighterThicknessPercent,
      onColorChange: (color) => {
        setHighlighterColor(color);
        saveNotebookToolPreferences({ highlighterColor: color });
      },
      onThicknessChange: (value) => {
        setHighlighterThicknessPercent(value);
        saveNotebookToolPreferences({ highlighterThicknessPercent: value });
      },
    },
    eraser: {
      mode: eraserMode,
      size: eraserSize,
      onModeChange: (mode) => {
        setEraserMode(mode);
        saveNotebookToolPreferences({ eraserMode: mode });
      },
      onSizeChange: (size) => {
        setEraserSize(size);
        saveNotebookToolPreferences({ eraserSize: size });
      },
      canClearPage,
      onClearPage: () => {
        setOpenMenu(null);
        onRequestClearPage();
      },
    },
  };

  return {
    tool,
    openMenu,
    rulerShown,
    toggleRuler: () => setRulerShown((shown) => !shown),
    selectTool,
    pickTool,
    closeMenu,
    penColor,
    highlighterColor,
    settings,
    /** What the ink editor draws with. */
    ink: {
      activeTool: tool,
      eraserMode,
      eraserThickness: widths.eraser,
      highlighterColor,
      highlighterThickness: widths.highlighter,
      penColor,
      penSettings,
      penThickness: widths.pen,
      scribbleToErase,
      rulerShown,
    },
  };
}
