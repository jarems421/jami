"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InkStatsOverlay, useInkStatsEnabled } from "@/components/workspace/InkStatsOverlay";
import { NotebookEraserCursor } from "@/components/workspace/NotebookEraserCursor";
import NotebookRuler from "@/components/workspace/NotebookRuler";
import type {
  NotebookInkEditorHandle,
  NotebookInkEditorProps,
} from "@/components/workspace/notebook-ink-editor-types";
import { useJamiInkPointerInput } from "@/hooks/useJamiInkPointerInput";
import { useJamiInkSurface } from "@/hooks/useJamiInkSurface";
import { useNotebookInkEditorCallbacks } from "@/hooks/useNotebookInkEditorCallbacks";
import type { InkDocument } from "@/lib/ink/model";
import { initialInkRuler } from "@/lib/ink/tools/ruler";
import { InkInputTrace } from "@/lib/ink-dom/input-trace";
import { inkClientToPage } from "@/lib/ink-dom/surface-viewport";
import { jamiInkData } from "@/lib/workspace/notebook-ink-data";
import type { NotebookInkStyle } from "@/lib/workspace/notebook-ink-types";
import { NotebookInkPointerLifecycle } from "@/lib/workspace/notebook-pointer-lifecycle";
import type { NotebookInkData } from "@/lib/workspace/notebooks";

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
      initialInk,
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
      shapesOnHold = false,
      rulerShown = false,
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
      initialInk,
      pageId,
      pageWidth,
      pageHeight,
      inkWindow,
      inkFrame,
      callbacksRef,
      lifecycleRef,
      reportInteraction,
    });
    // Kept while it is put away, so it comes back where it was left.
    const [ruler, setRuler] = useState(() => initialInkRuler({ width: pageWidth, height: pageHeight }));
    /** Where it is now: the ruler moves itself while fingers move it, and settles here when they lift. */
    const liveRulerRef = useRef(ruler);
    /** The sheet this editor covers, which the ruler is drawn on. */
    const [sheet, setSheet] = useState<HTMLElement | null>(null);
    const onSheet = useCallback((element: HTMLDivElement | null) => setSheet(element?.parentElement ?? null), []);
    const readRuler = useCallback(() => liveRulerRef.current, []);
    const toPage = useCallback(
      (clientX: number, clientY: number) => {
        const mapping = engine.getMapping();
        return mapping ? inkClientToPage(mapping, clientX, clientY) : null;
      },
      [engine]
    );
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
      shapesOnHold,
      ruler: rulerShown ? readRuler : null,
      reportInteraction,
      page: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
      trace,
    });

    const { surfaceRef, loadedRef } = engine;
    /** The last document handed over, the sheet it was on, and what it was handed over as. */
    const savedRef = useRef<{ doc: InkDocument; width: number; height: number; ink: NotebookInkData } | null>(null);
    useImperativeHandle(
      forwardedRef,
      () => {
        const isInteracting = () => lifecycleRef.current?.isInteracting ?? false;
        // The committed page, which a stroke in progress is not yet part of,
        // made once for each version of it: an autosave, a draft and a swipe
        // in a row ask for the same page.
        const serialize = () => {
          const surface = surfaceRef.current;
          if (!surface || !loadedRef.current) return null;
          const doc = surface.document();
          const saved = savedRef.current;
          if (saved?.doc === doc && saved.width === pageWidth && saved.height === pageHeight) return saved.ink;
          const ink = jamiInkData(doc, { width: pageWidth, height: pageHeight });
          savedRef.current = { doc, width: pageWidth, height: pageHeight, ink };
          return ink;
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
          lasso: {
            inkInLoop: (loop) => surfaceRef.current?.inkInLoop(loop) ?? [],
            items: (ids) => surfaceRef.current?.items(ids) ?? [],
            beginEdit: () => surfaceRef.current?.beginEdit(),
            showEdit: (items) => surfaceRef.current?.showEdit(items),
            endEdit: () => surfaceRef.current?.endEdit(),
            removeItems: (ids) => surfaceRef.current?.removeItems(ids),
          },
        };
      },
      [loadedRef, pageHeight, pageWidth, surfaceRef]
    );

    return (
      <div
        ref={onSheet}
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
        {rulerShown && sheet
          ? createPortal(
              // On the sheet itself, over every layer -- the lasso's included --
              // so fingers can always reach it; laid out on the same box as the ink.
              <div className="pointer-events-none absolute inset-0 z-[45]">
                <NotebookRuler
                  ruler={ruler}
                  liveRef={liveRulerRef}
                  page={{ width: pageWidth, height: pageHeight }}
                  toPage={toPage}
                  onSettle={setRuler}
                  ink={pointerInput.surfaceHandlers}
                />
              </div>,
              sheet
            )
          : null}
        {activeTool === "eraser" ? (
          <NotebookEraserCursor ref={eraserCursorRef} diameter={pointerInput.eraserCursorDiameter} />
        ) : null}
        {trace ? <InkStatsOverlay readoutRef={readoutRef} /> : null}
      </div>
    );
  }
);
