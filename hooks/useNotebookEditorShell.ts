"use client";

import { useEffect } from "react";
import { buildNotebookPageSearch } from "@/lib/workspace/notebook-navigation";
import {
  clearNotebookNativeSelection,
  installNotebookViewportZoomBlock,
  isNotebookSelectableTextTarget,
  isNotebookTextEditingTarget,
  NOTEBOOK_EDITOR_LOCK_BODY_CLASS,
  NOTEBOOK_OPEN_BODY_CLASS,
  shouldSuppressNotebookNativeEvent,
} from "@/lib/workspace/notebook-interaction-lock";

const NATIVE_EDITING_EVENTS = [
  "selectstart",
  "contextmenu",
  "dragstart",
  "copy",
  "cut",
  "paste",
] as const;

/**
 * Makes the document the notebook's editing surface while the editor is open,
 * and hands it back exactly as it was on the way out.
 *
 * The page behind the editor takes the editor's colour (so an overscroll or a
 * safe-area inset never shows the dashboard's), the body is locked, and the
 * browser's own selection, callout, drag and clipboard gestures are suppressed
 * everywhere except text the student is editing or a Tutor answer being
 * selected to copy.
 */
export function useNotebookEditorShell() {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.documentElement;
    const themeColorMeta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]'
    );
    const previousRootBackground = root.style.background;
    const previousBodyBackground = document.body.style.background;
    const previousThemeColor = themeColorMeta?.content;
    const notebookSurfaceColor =
      window
        .getComputedStyle(root)
        .getPropertyValue("--color-surface-base")
        .trim() || "#0d1018";

    root.style.background = notebookSurfaceColor;
    document.body.style.background = notebookSurfaceColor;
    if (themeColorMeta) {
      themeColorMeta.content = notebookSurfaceColor;
    }
    document.body.classList.add(NOTEBOOK_EDITOR_LOCK_BODY_CLASS, NOTEBOOK_OPEN_BODY_CLASS);

    const preventIfOutsideTextEditor = (event: Event) => {
      if (!shouldSuppressNotebookNativeEvent(event.target)) return;
      event.preventDefault();
      clearNotebookNativeSelection(document);
    };
    const clearSelectionIfOutsideTextEditor = () => {
      if (isNotebookTextEditingTarget(document.activeElement)) return;
      // A selection being made in the Tutor's answers, to copy them.
      if (isNotebookSelectableTextTarget(document.getSelection()?.anchorNode ?? null)) return;
      clearNotebookNativeSelection(document);
    };

    for (const type of NATIVE_EDITING_EVENTS) {
      document.addEventListener(type, preventIfOutsideTextEditor, true);
    }
    document.addEventListener("selectionchange", clearSelectionIfOutsideTextEditor);
    // The browser's own pinch zoom would otherwise run alongside the sheet's.
    const releaseViewportZoomBlock = installNotebookViewportZoomBlock(document);

    return () => {
      releaseViewportZoomBlock();
      document.body.classList.remove(NOTEBOOK_EDITOR_LOCK_BODY_CLASS, NOTEBOOK_OPEN_BODY_CLASS);
      root.style.background = previousRootBackground;
      document.body.style.background = previousBodyBackground;
      if (themeColorMeta && previousThemeColor !== undefined) {
        themeColorMeta.content = previousThemeColor;
      }
      for (const type of NATIVE_EDITING_EVENTS) {
        document.removeEventListener(type, preventIfOutsideTextEditor, true);
      }
      document.removeEventListener("selectionchange", clearSelectionIfOutsideTextEditor);
    };
  }, []);
}

/**
 * Keeps the address bar pointing at the open page, so a reload or a shared
 * link returns to it, and drops the one-shot `?settings` flag that opened the
 * editor from elsewhere so a reload does not act on it again.
 */
export function useNotebookPageUrl(selectedPageId: string | undefined) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = new URLSearchParams(window.location.search);
    if (!search.has("settings")) return;
    search.delete("settings");
    const query = search.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    );
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedPageId) return;
    const nextSearch = buildNotebookPageSearch(window.location.search, selectedPageId);
    const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [selectedPageId]);
}
