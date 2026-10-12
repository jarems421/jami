"use client";
import "js-draw/Editor.css";
import { forwardRef, useCallback, useImperativeHandle } from "react";
import { NotebookEraserCursor } from "@/components/workspace/NotebookEraserCursor";
import type {
  NotebookInkEditorHandle,
  NotebookInkEditorProps,
} from "@/components/workspace/notebook-ink-editor-types";
import { useNotebookInkEditorCallbacks } from "@/hooks/useNotebookInkEditorCallbacks";
import { useNotebookInkEditorRefs } from "@/hooks/useNotebookInkEditorRefs";
import { useNotebookInkPointerInput } from "@/hooks/useNotebookInkPointerInput";
import { useNotebookInkRenderWindow } from "@/hooks/useNotebookInkRenderWindow";
import { useNotebookInkSnapshots } from "@/hooks/useNotebookInkSnapshots";
import { useNotebookJsDrawEditor } from "@/hooks/useNotebookJsDrawEditor";
import { getNotebookEraserToolThickness } from "@/lib/workspace/notebook-eraser";
import { notebookInkSvg, svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";
import type { NotebookInkStyle } from "@/lib/workspace/notebook-ink-types";
import {
  applyNotebookEraserMode,
  serializeNotebookInkSynchronously,
} from "@/lib/workspace/notebook-js-draw";

/**
 * A notebook page's ink on js-draw: js-draw underneath, a fast live canvas over
 * it for the stroke being drawn, and the eraser's ring. The engine behind
 * `NotebookInkEditor` while `enableJamiInk` is off, and its emergency fallback
 * after.
 *
 * Composed from the editor's lifecycle (`useNotebookJsDrawEditor`), the
 * pointer routing that feeds it (`useNotebookInkPointerInput`) and the SVG
 * snapshots the page saves and swipes with (`useNotebookInkSnapshots`), which
 * share their mutable state through `useNotebookInkEditorRefs`. The page
 * drives it through the handle.
 */
export const JsDrawInkEditor = forwardRef<NotebookInkEditorHandle, NotebookInkEditorProps>(
  function JsDrawInkEditor(
    {
      activeTool,
      eraserMode,
      eraserThickness,
      highlighterColor,
      highlighterThickness,
      initialInk,
      inkWindow = null,
      onChange,
      onHistoryChange,
      onInteractionChange,
      onReady,
      onReadyError,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      pageHeight,
      pageId,
      pageWidth,
      penColor,
      penSettings,
      penThickness,
      readOnly = false,
      scribbleToErase = false,
    },
    forwardedRef
  ) {
    const style: NotebookInkStyle = {
      activeTool,
      eraserMode,
      eraserThickness,
      highlighterColor,
      highlighterThickness,
      penColor,
      penSettings,
      penThickness,
    };
    const refs = useNotebookInkEditorRefs(style);
    const {
      hostRef,
      inkSurfaceRef,
      eraserCursorRef,
      liveInkCanvasRef,
      editorRef,
      jsDrawRef,
      readyRef,
      pointerLifecycleRef,
      styleSyncRef,
    } = refs;
    const { inkHostStyle, renderWindowRef, syncViewportRef } = useNotebookInkRenderWindow(inkWindow);

    const { callbacksRef, reportInteraction } = useNotebookInkEditorCallbacks({
      onChange,
      onHistoryChange,
      onInteractionChange,
      onReady,
      onReadyError,
    });
    const isInteracting = useCallback(
      () => pointerLifecycleRef.current?.isInteracting ?? false,
      [pointerLifecycleRef]
    );

    const snapshots = useNotebookInkSnapshots({ editorRef, readyRef, isInteracting });
    const { exportCurrentInk, currentSnapshot } = snapshots;
    const pointerInput = useNotebookInkPointerInput({
      refs,
      style,
      readOnly,
      scribbleToErase,
      inkWindow,
      reportInteraction,
      page: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    });
    useNotebookJsDrawEditor({
      refs,
      style,
      readOnly,
      // A page Jami Ink saved too big to carry its SVG is written out as one.
      initialSvg: notebookInkSvg(initialInk, { width: pageWidth, height: pageHeight }) ?? "",
      pageId,
      pageWidth,
      pageHeight,
      inkWindow,
      renderWindowRef,
      syncViewportRef,
      callbacksRef,
      reportInteraction,
      resetPointerState: pointerInput.resetPointerState,
      snapshots,
    });

    useImperativeHandle(
      forwardedRef,
      () => {
        const serializeSynchronously = () =>
          serializeNotebookInkSynchronously(editorRef.current, readyRef.current, isInteracting);
        const asInk = (svg: string | null) => (svg === null ? null : svgNotebookInkData(svg));
        return {
          clear() {
            const editor = editorRef.current;
            const jsDraw = jsDrawRef.current;
            if (!editor || !jsDraw) return;
            const components = editor.image.getAllComponents();
            if (components.length > 0) editor.dispatch(new jsDraw.Erase(components));
          },
          getHistoryState() {
            const history = editorRef.current?.history;
            return {
              undoDepth: history?.undoStackSize ?? 0,
              redoDepth: history?.redoStackSize ?? 0,
            };
          },
          hasInk() {
            return (editorRef.current?.image.estimateNumElements() ?? 0) > 0;
          },
          isInteracting,
          redo() {
            void editorRef.current?.history.redo();
          },
          serialize() {
            // An export already taken of exactly this ink saves blocking on
            // another, which matters most here: this runs as a student leaves.
            const snapshot = currentSnapshot();
            if (snapshot !== null && readyRef.current && !isInteracting()) return asInk(snapshot);
            return asInk(serializeSynchronously());
          },
          serializeWarm() {
            // A prepared snapshot is preferred even mid-gesture, where the
            // blocking path refuses to run at all and would otherwise hand the
            // swipe a stale SVG from the last save.
            return asInk(currentSnapshot() ?? serializeSynchronously());
          },
          async serializeAsync() {
            if (!editorRef.current || isInteracting() || !readyRef.current) {
              return null;
            }
            const svg = await exportCurrentInk();
            return isInteracting() ? null : asInk(svg);
          },
          setEraserMode(mode) {
            const styleSync = styleSyncRef.current;
            if (!styleSync) return;
            styleSync.desired = { ...styleSync.desired, eraserMode: mode };
            const editor = editorRef.current;
            const jsDraw = jsDrawRef.current;
            if (!editor || !jsDraw) return;
            applyNotebookEraserMode(editor, mode, jsDraw);
            editor.toolController
              .getMatchingTools(jsDraw.EraserTool)[0]
              ?.setThickness(getNotebookEraserToolThickness(styleSync.desired.eraserThickness));
          },
          undo() {
            void editorRef.current?.history.undo();
          },
        };
      },
      [currentSnapshot, editorRef, exportCurrentInk, isInteracting, jsDrawRef, readyRef, styleSyncRef]
    );

    return (
      <div
        data-notebook-live-ink-editor="true"
        // Its own layer, so wet ink redrawing every frame never invalidates
        // the ruled paper or PDF beneath it -- see NotebookLivePageLayers.
        className="absolute inset-0 z-20 [transform:translateZ(0)] [will-change:transform]"
      >
        <div
          ref={hostRef}
          aria-hidden="true"
          className="notebook-js-draw-host pointer-events-none absolute"
          style={inkHostStyle}
        />
        {/* Fast live ink: sized and placed at each contact, never by React. */}
        <canvas
          ref={liveInkCanvasRef}
          aria-hidden="true"
          data-notebook-live-ink-canvas="true"
          className="pointer-events-none absolute left-0 top-0"
        />
        <div
          ref={inkSurfaceRef}
          role="img"
          aria-label="Notebook drawing page"
          className={`notebook-ink-surface absolute inset-0 touch-none select-none ${
            activeTool === "eraser" ? "cursor-none" : ""
          }`}
          {...pointerInput.surfaceHandlers}
        />
        {activeTool === "eraser" ? (
          <NotebookEraserCursor ref={eraserCursorRef} diameter={pointerInput.eraserCursorDiameter} />
        ) : null}
      </div>
    );
  }
);
