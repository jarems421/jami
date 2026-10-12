"use client";

import { useCallback, type RefObject } from "react";
import type { NotebookDrawingToolbarProps } from "@/components/workspace/NotebookDrawingToolbar";
import { useNotebookToolbarDocking, type NotebookToolbarFrameSize } from "@/hooks/useNotebookToolbarDocking";
import { prefersReducedMotion } from "@/lib/ui/reduced-motion";

type ToolbarState = Omit<NotebookDrawingToolbarProps, "dock" | "toolbarRef" | "dockBindings" | "onUndo" | "onRedo">;

/**
 * The notebook's drawing toolbar, wired: where it is docked and dragging it
 * to another edge (`useNotebookToolbarDocking`), and everything it is drawn
 * with. Undo and redo from the toolbar put any open tool menu away first, as
 * a drag does.
 */
export function useNotebookDrawingToolbar({
  frameRef,
  frameSize,
  closeMenus,
  undo,
  redo,
  ...state
}: ToolbarState & {
  frameRef: RefObject<HTMLDivElement | null>;
  frameSize: NotebookToolbarFrameSize;
  closeMenus: () => void;
  undo: () => void;
  redo: () => void;
}) {
  const { dock, toolbarRef, toolbarBindings } = useNotebookToolbarDocking({
    frameRef,
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
  const toolbarProps: NotebookDrawingToolbarProps = {
    ...state,
    dock,
    toolbarRef,
    dockBindings: toolbarBindings,
    onUndo,
    onRedo,
  };
  return { dock, toolbarProps };
}
