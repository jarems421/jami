"use client";

import { useEffect, useRef } from "react";
import { isNotebookTextEditingTarget } from "@/lib/workspace/notebook-interaction-lock";
import type { NotebookEditorTool } from "@/lib/workspace/notebook-page-state";

/** Single-key toggles: press once to pick the tool up, again to put it down. */
const TOOL_TOGGLE_KEYS: Readonly<Record<string, NotebookEditorTool>> = {
  t: "text",
  p: "pen",
  h: "highlighter",
  e: "eraser",
  l: "lasso",
};

type UseNotebookKeyboardShortcutsOptions = {
  /** Off on a phone that is only viewing, where nothing can be drawn. */
  enabled: boolean;
  readTool: () => NotebookEditorTool;
  switchTool: (tool: NotebookEditorTool) => void;
  undo: () => void;
  redo: () => void;
  /** Escape also closes the tool menus and lets go of whatever is selected. */
  onEscape: () => void;
};

/**
 * The editor's keyboard: undo and redo, and a letter per tool.
 *
 * Nothing fires while the student is typing in a text box, so a "t" in an
 * answer stays a "t".
 */
export function useNotebookKeyboardShortcuts({
  enabled,
  readTool,
  switchTool,
  undo,
  redo,
  onEscape,
}: UseNotebookKeyboardShortcutsOptions) {
  // Read at keypress time, so the listener is installed once per enable
  // rather than again whenever a handler's identity changes.
  const latest = useRef({ readTool, switchTool, undo, redo, onEscape });
  useEffect(() => {
    latest.current = { readTool, switchTool, undo, redo, onEscape };
  }, [onEscape, readTool, redo, switchTool, undo]);

  useEffect(() => {
    if (!enabled) return;

    const handleShortcut = (event: KeyboardEvent) => {
      if (isNotebookTextEditingTarget(event.target)) return;
      const actions = latest.current;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;

      if (command && key === "z") {
        event.preventDefault();
        if (event.shiftKey) actions.redo();
        else actions.undo();
        return;
      }
      // Windows' own redo, which the practice sheet already answered to.
      if (command && key === "y") {
        event.preventDefault();
        actions.redo();
        return;
      }
      if (command || event.altKey) return;

      const toggled = TOOL_TOGGLE_KEYS[key];
      if (toggled) {
        actions.switchTool(actions.readTool() === toggled ? "select" : toggled);
      } else if (key === "v") {
        actions.switchTool("select");
      } else if (key === "escape") {
        actions.switchTool("select");
        actions.onEscape();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [enabled]);
}
