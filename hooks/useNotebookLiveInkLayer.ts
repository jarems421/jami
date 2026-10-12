"use client";

import { useCallback, useMemo, type RefObject } from "react";
import type {
  NotebookLiveInkEditorProps,
  NotebookLivePageBackgroundProps,
} from "@/components/workspace/NotebookLivePageLayers";
import type { NotebookViewportController } from "@/hooks/useNotebookViewportController";
import type { NotebookDrawingToolState } from "@/hooks/useNotebookWorkspaceState";
import { getNotebookSheetRenderWindows } from "@/lib/workspace/notebook-ink-window";
import {
  getHighlighterWidthFromPercent,
  getPenWidthFromPercent,
} from "@/lib/workspace/notebook-inking";
import type { NotebookEditorTool } from "@/lib/workspace/notebook-page-state";
import {
  trackNotebookPdfCanvas,
  type NotebookPdfCanvasTracking,
} from "@/lib/workspace/notebook-pdf-canvas";
import type {
  NotebookFile,
  NotebookPage,
  NotebookPageColor,
  NotebookPageStyle,
} from "@/lib/workspace/notebooks";

type UseNotebookLiveInkLayerOptions = {
  page: NotebookPage | null;
  paper: { pageColor: NotebookPageColor; pageStyle: NotebookPageStyle };
  background: {
    file: NotebookFile | null;
    url: string | undefined;
    pdfRenderKey: string | null;
    /** A picture background finished loading, or failed to. */
    onImageSettled: () => void;
    onPdfRenderStateChange: (status: "loading" | "ready" | "error") => void;
    /** Where the Tutor finds the rendered PDF canvas for this page. */
    pdfCanvasTrackingRef: RefObject<NotebookPdfCanvasTracking<HTMLCanvasElement>>;
  };
  /** A turn is handing over to this page: the PDF appears at once, not faded in. */
  handingOff: boolean;
  viewport: Pick<NotebookViewportController, "layout" | "pageWidthPx" | "pageHeightPx">;
  tool: NotebookEditorTool;
  tools: Pick<
    NotebookDrawingToolState,
    | "eraserMode"
    | "scribbleToErase"
    | "penColor"
    | "penSettings"
    | "penThicknessPercent"
    | "highlighterColor"
    | "highlighterThicknessPercent"
  >;
  ink: {
    onReady: () => void;
    onReadyError: () => void;
    onChange: NotebookLiveInkEditorProps["onChange"];
    onHistoryChange: NotebookLiveInkEditorProps["onHistoryChange"];
    onInteractionChange: NotebookLiveInkEditorProps["onInteractionChange"];
  };
  pointer: Pick<
    NotebookLiveInkEditorProps,
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
  >;
};

/**
 * The open page's background and ink editor props, memoised so the live page
 * layers -- the ink editor, the paper and the PDF beneath it -- render only
 * when something they draw has changed.
 *
 * Built inline, these were new objects on every render of the editor, so a
 * save-status flip or the undo buttons catching up after a stroke re-rendered
 * the whole ink editor in the gap before the next stroke. Everything here is
 * keyed on the values themselves (the page's id and PDF index, not the page
 * record a save replaces).
 */
export function useNotebookLiveInkLayer({
  page,
  paper,
  background,
  handingOff,
  viewport,
  tool,
  tools,
  ink,
  pointer,
}: UseNotebookLiveInkLayerOptions) {
  const pageId = page?.id;
  const pdfPageIndex = page?.pdfPageIndex ?? 0;
  const { pageColor, pageStyle } = paper;
  const {
    file: backgroundFile,
    url: backgroundUrl,
    pdfRenderKey,
    onImageSettled,
    onPdfRenderStateChange,
    pdfCanvasTrackingRef,
  } = background;
  const {
    eraserMode,
    scribbleToErase,
    penColor,
    penSettings,
    penThicknessPercent,
    highlighterColor,
    highlighterThicknessPercent,
  } = tools;
  const { onReady, onReadyError, onChange, onHistoryChange, onInteractionChange } = ink;
  const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } = pointer;

  const { pageWidthPx, pageHeightPx } = viewport;
  const originX = viewport.layout.pageOrigin.x;
  const originY = viewport.layout.pageOrigin.y;
  const frameWidth = viewport.layout.frameSize.width;
  const frameHeight = viewport.layout.frameSize.height;
  // The ink window's pixel budget is counted in device pixels.
  const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const windows = useMemo(
    () =>
      getNotebookSheetRenderWindows({
        sheetWidth: pageWidthPx,
        sheetHeight: pageHeightPx,
        pageX: originX,
        pageY: originY,
        frameWidth,
        frameHeight,
        devicePixelRatio,
      }),
    [devicePixelRatio, frameHeight, frameWidth, originX, originY, pageHeightPx, pageWidthPx]
  );
  // Where the sheet sits in its frame, for Jami Ink to know the part of it on
  // screen after every pan settles; the snapped window above does not change
  // for a small pan.
  const inkFrame = useMemo(
    () => ({ pageX: originX, pageY: originY, frameWidth, frameHeight }),
    [frameHeight, frameWidth, originX, originY]
  );

  const handlePdfCanvasReady = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      pdfCanvasTrackingRef.current = trackNotebookPdfCanvas({
        current: pdfCanvasTrackingRef.current,
        renderKey: pdfRenderKey,
        canvas,
      });
    },
    [pdfCanvasTrackingRef, pdfRenderKey]
  );

  const backgroundProps = useMemo<NotebookLivePageBackgroundProps>(
    () => ({
      pageColor,
      pageStyle,
      backgroundFile,
      backgroundUrl,
      pageIndex: pdfPageIndex,
      imageStrategy: "next-image",
      imageRenderKey: backgroundFile && pageId ? `${pageId}:${backgroundFile.id}:image` : undefined,
      imageOnSettled: onImageSettled,
      imageLoadingLabel: "Loading file...",
      imageSizes: "48rem",
      imageClassName: "object-contain",
      pdfRenderKey: pdfRenderKey ?? undefined,
      pdfAriaHidden: false,
      pdfAriaLabel: backgroundFile
        ? `Notebook file: ${backgroundFile.fileName}, page ${pdfPageIndex + 1}`
        : undefined,
      pdfFadeIn: !handingOff,
      pdfDetailWindow: windows.pdfDetail,
      pdfOnRenderStateChange: onPdfRenderStateChange,
      pdfOnCanvasReady: handlePdfCanvasReady,
    }),
    [
      backgroundFile,
      backgroundUrl,
      handingOff,
      handlePdfCanvasReady,
      onImageSettled,
      onPdfRenderStateChange,
      pageColor,
      pageId,
      pageStyle,
      pdfPageIndex,
      pdfRenderKey,
      windows.pdfDetail,
    ]
  );

  const inkEditorProps = useMemo<NotebookLiveInkEditorProps>(
    () => ({
      onReady,
      onReadyError,
      activeTool: tool,
      inkWindow: windows.ink,
      inkFrame,
      eraserMode,
      scribbleToErase,
      shapesOnHold: true,
      penColor,
      penSettings,
      penThickness: getPenWidthFromPercent(penThicknessPercent),
      highlighterColor,
      highlighterThickness: getHighlighterWidthFromPercent(highlighterThicknessPercent),
      onChange,
      onHistoryChange,
      onInteractionChange,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    }),
    [
      eraserMode,
      highlighterColor,
      highlighterThicknessPercent,
      inkFrame,
      onChange,
      onHistoryChange,
      onInteractionChange,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onReady,
      onReadyError,
      penColor,
      penSettings,
      penThicknessPercent,
      scribbleToErase,
      tool,
      windows.ink,
    ]
  );

  return { backgroundProps, inkEditorProps };
}
