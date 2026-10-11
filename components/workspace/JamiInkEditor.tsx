"use client";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { InkStatsOverlay, useInkStatsEnabled } from "@/components/workspace/InkStatsOverlay";
import { NotebookEraserCursor } from "@/components/workspace/NotebookEraserCursor";
import type {
  NotebookInkEditorHandle,
  NotebookInkEditorProps,
} from "@/components/workspace/notebook-ink-editor-types";
import { useJamiInkPointerInput } from "@/hooks/useJamiInkPointerInput";
import { useJamiInkSurface } from "@/hooks/useJamiInkSurface";
import { useNotebookInkEditorCallbacks } from "@/hooks/useNotebookInkEditorCallbacks";
import { InkInputTrace } from "@/lib/ink-dom/input-trace";
import type { NotebookInkStyle } from "@/lib/workspace/notebook-ink-types";
import { NotebookInkPointerLifecycle } from "@/lib/workspace/notebook-pointer-lifecycle";

/**
 * A notebook page's ink on Jami Ink (`docs/notebook-ink.md`), behind
 * `NotebookInkEditor` while `enableJamiInk` is on: a host the engine draws its
 * tiles into, the surface that takes the pointers, and the eraser's ring.
 *
 * Composed from the engine's lifecycle and viewport (`useJamiInkSurface`) and
 * the pointer routing that feeds it (`useJamiInkPointerInput`). The page drives
 * it through the same handle as the js-draw editor, and gives it the same
 * props.
 */
export const JamiInkEditor = forwardRef<NotebookInkEditorHandle, NotebookInkEditorProps>(
  function JamiInkEditor(
    {
      activeTool,
      eraserMode,
      eraserThickness,
      highlighterColor,
      highlighterThickness,
      initialSvg,
      inkFrame = null,
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
    const hostRef = useRef<HTMLDivElement | null>(null);
    const inkSurfaceRef = useRef<HTMLDivElement | null>(null);
    const eraserCursorRef = useRef<HTMLDivElement | null>(null);
    const lifecycleRef = useRef<NotebookInkPointerLifecycle | null>(null);
    lifecycleRef.current ??= new NotebookInkPointerLifecycle();
    /**
     * The eraser's mode for the next contact. The tool is fixed when the pen
     * lands, so a change never needs to wait for a stroke to end; the page also
     * sets it through the handle, ahead of its own props catching up.
     */
    const eraserModeRef = useRef(eraserMode);
    useEffect(() => {
      eraserModeRef.current = eraserMode;
    }, [eraserMode]);

    const { callbacksRef, reportInteraction } = useNotebookInkEditorCallbacks({
      onChange,
      onHistoryChange,
      onInteractionChange,
      onReady,
      onReadyError,
    });
    const engine = useJamiInkSurface({
      hostRef,
      initialSvg,
      pageId,
      pageWidth,
      pageHeight,
      inkWindow,
      inkFrame,
      callbacksRef,
      lifecycleRef,
      reportInteraction,
    });
    const traceEnabled = useInkStatsEnabled();
    const readoutRef = useRef<HTMLDivElement | null>(null);
    const trace = useMemo(
      () => (traceEnabled ? { recorder: new InkInputTrace(), readoutRef } : null),
      [traceEnabled]
    );
    const pointerInput = useJamiInkPointerInput({
      engine,
      inkSurfaceRef,
      eraserCursorRef,
      lifecycleRef,
      eraserModeRef,
      style,
      readOnly,
      scribbleToErase,
      reportInteraction,
      page: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
      trace,
    });

    const { surfaceRef, loadedRef } = engine;
    useImperativeHandle(
      forwardedRef,
      () => {
        const isInteracting = () => lifecycleRef.current?.isInteracting ?? false;
        // The committed page, which a stroke in progress is not yet part of.
        // The surface caches it until the page next changes.
        const serialize = () => {
          const surface = surfaceRef.current;
          return surface && loadedRef.current ? surface.serialize() : null;
        };
        return {
          clear: () => surfaceRef.current?.clear(),
          getHistoryState: () => surfaceRef.current?.historyState() ?? { undoDepth: 0, redoDepth: 0 },
          hasInk: () => surfaceRef.current?.hasInk() ?? false,
          isInteracting,
          redo: () => surfaceRef.current?.redo(),
          serialize,
          serializeWarm: serialize,
          serializeAsync: async () => (isInteracting() ? null : serialize()),
          setEraserMode(mode) {
            eraserModeRef.current = mode;
          },
          undo: () => surfaceRef.current?.undo(),
        };
      },
      [loadedRef, surfaceRef]
    );

    return (
      <div
        data-notebook-live-ink-editor="true"
        // Its own layer, so wet ink redrawing every frame never invalidates
        // the ruled paper or PDF beneath it -- see NotebookLivePageLayers.
        className="absolute inset-0 z-20 [transform:translateZ(0)] [will-change:transform]"
      >
        {/* The engine's tiles go here: the whole sheet, drawn only where it is on screen. */}
        <div
          ref={hostRef}
          aria-hidden="true"
          data-jami-ink-host="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
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
        {trace ? <InkStatsOverlay readoutRef={readoutRef} /> : null}
      </div>
    );
  }
);
