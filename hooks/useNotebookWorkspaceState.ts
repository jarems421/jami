"use client";

import { useCallback, useState } from "react";
import type { NotebookPageSwipeMotion } from "@/lib/workspace/notebook-carousel";
import type {
  NotebookEraserMode,
  NotebookEraserSize,
} from "@/lib/workspace/notebook-eraser";
import type { NotebookPagePan } from "@/lib/workspace/notebook-inking";
import type { NotebookToolMenu } from "@/lib/workspace/notebook-toolbar";
import {
  NOTEBOOK_PEN_SETTINGS_DEFAULT,
  type NotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";

export type NotebookPageFrameSize = { width: number; height: number };

export function useNotebookDrawingToolState() {
  const [penColor, setPenColor] = useState<NotebookStrokeColor>("black");
  const [penThicknessPercent, setPenThicknessPercent] = useState(50);
  const [highlighterColor, setHighlighterColor] =
    useState<NotebookStrokeColor>("yellow");
  const [highlighterThicknessPercent, setHighlighterThicknessPercent] =
    useState(50);
  const [eraserMode, setEraserMode] =
    useState<NotebookEraserMode>("precision");
  const [eraserWidth, setEraserWidth] =
    useState<NotebookEraserSize>("medium");
  const [penMenuOpen, setPenMenuOpen] = useState(false);
  const [highlighterMenuOpen, setHighlighterMenuOpen] = useState(false);
  const [eraserMenuOpen, setEraserMenuOpen] = useState(false);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  // The stored preferences are read on the client after mount, so the server
  // and the first client render agree. See `readNotebookScribbleErasePreference`
  // and `readNotebookPenSettings`.
  const [scribbleToErase, setScribbleToErase] = useState(true);
  const [penSettings, setPenSettings] = useState<NotebookPenSettings>(
    NOTEBOOK_PEN_SETTINGS_DEFAULT
  );

  /** Which toolbar menu is showing. They are mutually exclusive. */
  const openMenu: NotebookToolMenu = penMenuOpen
    ? "pen"
    : highlighterMenuOpen
      ? "highlighter"
      : eraserMenuOpen
        ? "eraser"
        : insertMenuOpen
          ? "insert"
          : null;
  const setMenuOpen = useCallback(
    (menu: Exclude<NotebookToolMenu, null>, open: boolean) => {
      setPenMenuOpen(menu === "pen" && open);
      setHighlighterMenuOpen(menu === "highlighter" && open);
      setEraserMenuOpen(menu === "eraser" && open);
      setInsertMenuOpen(menu === "insert" && open);
    },
    []
  );
  /*
   * Only what is open. This runs as a pen lands, and setting state to the
   * value it already holds is not free: straight after another update, React
   * renders the whole editor once to find out that nothing changed.
   */
  const closeMenus = useCallback(() => {
    if (penMenuOpen) setPenMenuOpen(false);
    if (highlighterMenuOpen) setHighlighterMenuOpen(false);
    if (eraserMenuOpen) setEraserMenuOpen(false);
    if (insertMenuOpen) setInsertMenuOpen(false);
  }, [eraserMenuOpen, highlighterMenuOpen, insertMenuOpen, penMenuOpen]);

  return {
    openMenu,
    setMenuOpen,
    closeMenus,
    penSettings,
    setPenSettings,
    penColor,
    setPenColor,
    penThicknessPercent,
    setPenThicknessPercent,
    highlighterColor,
    setHighlighterColor,
    highlighterThicknessPercent,
    setHighlighterThicknessPercent,
    eraserMode,
    setEraserMode,
    eraserWidth,
    setEraserWidth,
    penMenuOpen,
    setPenMenuOpen,
    highlighterMenuOpen,
    setHighlighterMenuOpen,
    eraserMenuOpen,
    setEraserMenuOpen,
    scribbleToErase,
    setScribbleToErase,
  };
}

export type NotebookDrawingToolState = ReturnType<typeof useNotebookDrawingToolState>;

export function useNotebookNavigationState() {
  const [pageZoom, setPageZoom] = useState(1);
  const [pagePan, setPagePan] = useState<NotebookPagePan>({ x: 0, y: 0 });
  const [frameSize, setFrameSize] = useState<NotebookPageFrameSize>({
    width: 0,
    height: 0,
  });
  const [pageSwipeMotion, setPageSwipeMotion] =
    useState<NotebookPageSwipeMotion | null>(null);
  const [pageSwipeInkSnapshot, setPageSwipeInkSnapshot] = useState<{
    pageId: string;
    svg: string;
  } | null>(null);

  return {
    pageZoom,
    setPageZoom,
    pagePan,
    setPagePan,
    frameSize,
    setFrameSize,
    pageSwipeMotion,
    setPageSwipeMotion,
    pageSwipeInkSnapshot,
    setPageSwipeInkSnapshot,
  };
}

export type NotebookPageCreationState = ReturnType<typeof useNotebookPageCreationState>;

/** The pull-to-create affordance past the last page, and the ink editor's remount key. */
export function useNotebookPageCreationState() {
  const [createPageActive, setCreatePageActive] = useState(false);
  const [createPageProgress, setCreatePageProgress] = useState(0);
  const [creatingPage, setCreatingPage] = useState(false);
  const [createPageBounce, setCreatePageBounce] = useState(false);
  const [inkEditorMountRevision, setInkEditorMountRevision] = useState(0);

  return {
    createPageActive,
    setCreatePageActive,
    createPageProgress,
    setCreatePageProgress,
    creatingPage,
    setCreatingPage,
    createPageBounce,
    setCreatePageBounce,
    inkEditorMountRevision,
    setInkEditorMountRevision,
  };
}

export function useNotebookPanelState() {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [pagesDrawerOpen, setPagesDrawerOpen] = useState(false);
  const [phoneFullEditing, setPhoneFullEditing] = useState(false);

  return {
    assistantOpen,
    setAssistantOpen,
    pagesDrawerOpen,
    setPagesDrawerOpen,
    phoneFullEditing,
    setPhoneFullEditing,
  };
}
