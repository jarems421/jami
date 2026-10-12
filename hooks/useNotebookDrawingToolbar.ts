"use client";

import { useCallback, useRef, type RefObject } from "react";
import type { NotebookDrawingToolbarProps } from "@/components/workspace/NotebookDrawingToolbar";
import { useNotebookToolbarDocking, type NotebookToolbarFrameSize } from "@/hooks/useNotebookToolbarDocking";
import { prefersReducedMotion } from "@/lib/ui/reduced-motion";
import type { NotebookToolMenu } from "@/lib/workspace/notebook-toolbar";

type ToolbarState = Omit<
  NotebookDrawingToolbarProps,
  "dock" | "toolbarRef" | "dockBindings" | "onUndo" | "onRedo" | "onToggleInsertMenu"
>;

/**
 * The notebook's drawing toolbar, wired: where it is docked and dragging it
 * to another edge (`useNotebookToolbarDocking`), and everything it is drawn
 * with. Undo and redo from the toolbar put any open tool menu away first, as
 * a drag does. `topBarRef` goes on the top bar the toolbar sits in when it is
 * docked `top`, so a drag can carry it out of the bar and back.
 */
export function useNotebookDrawingToolbar({
  frameRef,
  frameSize,
  closeMenus,
  setMenuOpen,
  undo,
  redo,
  ...state
}: ToolbarState & {
  frameRef: RefObject<HTMLDivElement | null>;
  frameSize: NotebookToolbarFrameSize;
  closeMenus: () => void;
  setMenuOpen: (menu: Exclude<NotebookToolMenu, null>, open: boolean) => void;
  undo: () => void;
  redo: () => void;
}) {
  const topBarRef = useRef<HTMLElement | null>(null);
  const { dock, toolbarRef, toolbarBindings } = useNotebookToolbarDocking({
    frameRef,
    topBarRef,
    frameSize,
    onDragStarted: closeMenus,
    prefersReducedMotion,
  });
  const onUndo = useCallback(() => {
    closeMenus();
    undo();
  }, [closeMenus, undo]);
  const onRedo = useCallback(() => {
    closeMenus();
    redo();
  }, [closeMenus, redo]);
  const insertOpen = state.openMenu === "insert";
  const onToggleInsertMenu = useCallback(() => setMenuOpen("insert", !insertOpen), [insertOpen, setMenuOpen]);
  const toolbarProps: NotebookDrawingToolbarProps = {
    ...state,
    dock,
    toolbarRef,
    dockBindings: toolbarBindings,
    onUndo,
    onRedo,
    onToggleInsertMenu,
  };
  return { dock, topBarRef, toolbarProps };
}
