"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import type { NotebookToolSettingsPopoverProps } from "@/components/workspace/NotebookToolSettingsPopover";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
import type { NotebookDrawingToolState } from "@/hooks/useNotebookWorkspaceState";
import { clampNotebookThicknessPercent } from "@/lib/workspace/notebook-inking";
import { getNotebookPaperPalette, getVisibleNibColor } from "@/lib/workspace/notebook-paper-palette";
import {
  clampNotebookPenSettings,
  readNotebookPenSettings,
  saveNotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";
import {
  isNotebookToolDoublePress,
  readNotebookScribbleErasePreference,
  saveNotebookScribbleErasePreference,
  type NotebookToolPress,
} from "@/lib/workspace/notebook-toolbar";
import {
  readNotebookToolPreferences,
  saveNotebookToolPreferences,
} from "@/lib/workspace/notebook-tool-preferences";
import type { NotebookPageColor } from "@/lib/workspace/notebooks";

type UseNotebookToolSettingsOptions = {
  tools: NotebookDrawingToolState;
  pageColor: NotebookPageColor;
  pageState: NotebookPageStore;
  inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
  inkHasContent: boolean;
  /** Lets go of every placed thing; reaching for a tool always does. */
  clearPlacedSelection: () => void;
  /** The eraser's "clear page" asks first; the page owns that confirmation. */
  onRequestClearPage: () => void;
};

/**
 * The pen, highlighter and eraser as the student set them up: restored from
 * the device, kept visible on the paper under them, saved as they change, and
 * picked up or put down from the toolbar.
 */
export function useNotebookToolSettings({
  tools,
  pageColor,
  pageState,
  inkEditorRef,
  inkHasContent,
  clearPlacedSelection,
  onRequestClearPage,
}: UseNotebookToolSettingsOptions) {
  const {
    penColor, setPenColor, penThicknessPercent, setPenThicknessPercent,
    highlighterColor, setHighlighterColor,
    highlighterThicknessPercent, setHighlighterThicknessPercent,
    eraserMode, setEraserMode, eraserWidth, setEraserWidth,
    scribbleToErase, setScribbleToErase, penSettings, setPenSettings,
    openMenu, setMenuOpen, closeMenus, setEraserMenuOpen,
  } = tools;

  useEffect(() => {
    // Restored after hydration so the server and the first client render both
    // use the defaults (see useNotebookToolbarDocking for the same rule).
    setScribbleToErase(readNotebookScribbleErasePreference());
    setPenSettings(readNotebookPenSettings());
    // The pen as it was put down. Declared before the paper check below, so a
    // remembered white pen opening onto white paper is still turned dark.
    const stored = readNotebookToolPreferences();
    setPenColor(stored.penColor);
    setPenThicknessPercent(stored.penThicknessPercent);
    setHighlighterColor(stored.highlighterColor);
    setHighlighterThicknessPercent(stored.highlighterThicknessPercent);
    setEraserMode(stored.eraserMode);
    setEraserWidth(stored.eraserSize);
  }, [
    setEraserMode,
    setEraserWidth,
    setHighlighterColor,
    setHighlighterThicknessPercent,
    setPenColor,
    setPenSettings,
    setPenThicknessPercent,
    setScribbleToErase,
  ]);

  useEffect(() => {
    // An effect rather than an adjustment while rendering, because it has to
    // run on mount too, straight after the restore above.
    // Keep the nib visible when the paper changes under it.
    setPenColor((current) => getVisibleNibColor(current, getNotebookPaperPalette(pageColor).isDark));
  }, [pageColor, setPenColor]);

  // Push the precision/stroke selection straight to the ink editor whenever it
  // changes. This bypasses the deferred style application (which can stall if a
  // stale eraser pointer leaves activePointers > 0), so the chosen mode always
  // reaches js-draw and the two modes keep their distinct roles.
  useEffect(() => {
    inkEditorRef.current?.setEraserMode(eraserMode);
  }, [eraserMode, inkEditorRef]);

  const lastToolPressRef = useRef<NotebookToolPress | null>(null);

  /**
   * Records a toolbar press, and says whether it completes a double press of
   * the same tool. A double press is used up, so a third quick press starts a
   * new pair rather than counting twice.
   */
  const takeToolDoublePress = useCallback((tool: NotebookToolPress["tool"]) => {
    const press = { tool, at: performance.now() };
    const double = isNotebookToolDoublePress(lastToolPressRef.current, press);
    lastToolPressRef.current = double ? null : press;
    return double;
  }, []);

  /**
   * Selecting an inactive tool switches to it; the active one toggles options.
   * A double press of any tool puts it down.
   */
  const handleSelectDrawingTool = useCallback(
    (nextTool: "pen" | "highlighter" | "eraser") => {
      // Reaching for a tool is done with something else in mind, so whatever
      // was selected is let go of whether or not the tool actually changes.
      // Switching tools already dropped an image or a graph on its own;
      // pressing the tool that is already on did not, and that is the press
      // where a selection is most obviously stale.
      clearPlacedSelection();
      if (takeToolDoublePress(nextTool)) {
        closeMenus();
        pageState.setTool("select");
        return;
      }
      if (pageState.read().tool !== nextTool) {
        pageState.setTool(nextTool);
        closeMenus();
        return;
      }
      setMenuOpen(nextTool, openMenu !== nextTool);
    },
    [clearPlacedSelection, closeMenus, openMenu, pageState, setMenuOpen, takeToolDoublePress]
  );

  /** The text box and the lasso: a press picks one up, and a press of the one in hand puts it down. */
  const handleToggleTool = useCallback(
    (nextTool: "text" | "lasso") => {
      // Text moves placed things, and the lasso picks them up, so neither drops
      // a selection by changing tool. Pressing the button has to say it.
      clearPlacedSelection();
      closeMenus();
      // A double press puts it down, as it does every other tool, rather than
      // picking it straight back up.
      if (takeToolDoublePress(nextTool)) {
        pageState.setTool("select");
        return;
      }
      pageState.setTool(pageState.read().tool === nextTool ? "select" : nextTool);
    },
    [clearPlacedSelection, closeMenus, pageState, takeToolDoublePress]
  );

  // Every change is saved for next time and puts the tool being set up in hand.
  const pen: NotebookToolSettingsPopoverProps["pen"] = {
    color: penColor,
    thicknessPercent: penThicknessPercent,
    onColorChange: (color) => {
      setPenColor(color);
      saveNotebookToolPreferences({ penColor: color });
      pageState.setTool("pen");
    },
    onThicknessChange: (value) => {
      const thickness = clampNotebookThicknessPercent(value);
      setPenThicknessPercent(thickness);
      saveNotebookToolPreferences({ penThicknessPercent: thickness });
      pageState.setTool("pen");
    },
    settings: penSettings,
    onSettingsChange: (value) => {
      const next = clampNotebookPenSettings(value);
      setPenSettings(next);
      saveNotebookPenSettings(next);
      pageState.setTool("pen");
    },
    scribbleToErase,
    onScribbleToEraseChange: (enabled) => {
      setScribbleToErase(enabled);
      saveNotebookScribbleErasePreference(enabled);
    },
  };
  const highlighter: NotebookToolSettingsPopoverProps["highlighter"] = {
    color: highlighterColor,
    thicknessPercent: highlighterThicknessPercent,
    onColorChange: (color) => {
      setHighlighterColor(color);
      saveNotebookToolPreferences({ highlighterColor: color });
      pageState.setTool("highlighter");
    },
    onThicknessChange: (value) => {
      const thickness = clampNotebookThicknessPercent(value);
      setHighlighterThicknessPercent(thickness);
      saveNotebookToolPreferences({ highlighterThicknessPercent: thickness });
      pageState.setTool("highlighter");
    },
  };
  const eraser: NotebookToolSettingsPopoverProps["eraser"] = {
    mode: eraserMode,
    size: eraserWidth,
    onModeChange: (mode) => {
      setEraserMode(mode);
      saveNotebookToolPreferences({ eraserMode: mode });
      pageState.setTool("eraser");
    },
    onSizeChange: (size) => {
      setEraserWidth(size);
      saveNotebookToolPreferences({ eraserSize: size });
      pageState.setTool("eraser");
    },
    canClearPage: inkHasContent,
    onClearPage: () => {
      setEraserMenuOpen(false);
      onRequestClearPage();
    },
  };

  return { handleSelectDrawingTool, handleToggleTool, pen, highlighter, eraser };
}
