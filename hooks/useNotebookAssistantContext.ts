"use client";

import { useCallback, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import type { Notebook, NotebookFile, NotebookImageRef } from "@/lib/workspace/notebooks";
import { describeNotebookGraphsForTutor } from "@/lib/workspace/notebook-graphs";
import { notebookInkSvg } from "@/lib/workspace/notebook-ink-data";
import type { NotebookPdfCanvasTracking } from "@/lib/workspace/notebook-pdf-canvas";
import {
  readBlobAsBase64,
  renderNotebookPageSnapshot,
} from "@/lib/workspace/notebook-page-snapshot";
import { getNotebookFileBytes } from "@/services/study/notebook-files";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";

/**
 * Builds the notebook's answer to "what is the student looking at?".
 *
 * This is the one place the editor is read for somebody else's benefit rather
 * than the student's, and reading it is delicate: the snapshot is assembled
 * from several async sources, and any of them can land after the student has
 * turned the page. Every await is followed by a check that the capture still
 * describes the open page, so Jami either sees one coherent page or is told to
 * ask again -- it never sees half of two.
 */

function overlayImageMimeType(storagePath: string) {
  const path = storagePath.toLowerCase();
  if (path.endsWith(".webp")) return "image/webp";
  if (/\.jpe?g$/.test(path)) return "image/jpeg";
  return "image/png";
}

/** Defaults match the size an inserted illustration is placed at. */
const DEFAULT_OVERLAY_WIDTH = 480;
const DEFAULT_OVERLAY_HEIGHT = 360;

async function loadOverlayImages(images: readonly NotebookImageRef[]) {
  return Promise.all(
    images.flatMap((image) =>
      image.storagePath
        ? [
            getNotebookFileBytes(image.storagePath).then((bytes) => ({
              bytes,
              mimeType: overlayImageMimeType(image.storagePath!),
              x: image.x ?? 0,
              y: image.y ?? 0,
              width: image.displayWidth ?? DEFAULT_OVERLAY_WIDTH,
              height: image.displayHeight ?? DEFAULT_OVERLAY_HEIGHT,
            })),
          ]
        : []
    )
  );
}

export type UseNotebookAssistantContextOptions = {
  pageState: NotebookPageStore;
  notebook: Notebook | null;
  selectedPageId: string | undefined;
  activeNotebookFile: NotebookFile | null;
  activePdfRenderKey: string | null;
  activePdfCanvasTrackingRef: RefObject<
    NotebookPdfCanvasTracking<HTMLCanvasElement>
  >;
  inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
  inkReadyRef: RefObject<boolean>;
  inkInteractionActiveRef: RefObject<boolean>;
  editorRevisionRef: RefObject<number>;
};

export function useNotebookAssistantContext({
  pageState,
  notebook,
  selectedPageId,
  activeNotebookFile,
  activePdfRenderKey,
  activePdfCanvasTrackingRef,
  inkEditorRef,
  inkReadyRef,
  inkInteractionActiveRef,
  editorRevisionRef,
}: UseNotebookAssistantContextOptions) {
  return useCallback(async (): Promise<JamiAssistantContext> => {
    const page = pageState.read().selectedPage;
    const currentNotebook = notebook;
    const editor = inkEditorRef.current;
    if (
      !page ||
      !currentNotebook ||
      page.id !== selectedPageId ||
      page.notebookId !== currentNotebook.id
    ) {
      throw new Error(
        "This notebook page changed before Jami could read it. Try again on the page you want help with."
      );
    }
    if (!editor || !inkReadyRef.current) {
      throw new Error(
        "This notebook page is still opening. Wait until the writing appears, then try again."
      );
    }
    if (inkInteractionActiveRef.current || editor.isInteracting()) {
      throw new Error("Finish the current pen stroke, then ask Jami again.");
    }

    const capturedPageId = page.id;
    const capturedContentRevision = pageState.read().contentRevision;
    const capturedEditorRevision = editorRevisionRef.current;
    const capturedTextBlocks = pageState.read().textBlocks.map((block) => ({
      ...block,
    }));
    const capturedPageColor = pageState.read().pageColor;
    const capturedPageStyle = pageState.read().pageStyle;
    const capturedHasInk = editor.hasInk();
    const capturedImages = page.imageRefs.map((image) => ({ ...image }));
    // Graphs are not in the page picture, so the Tutor is told what they plot.
    const capturedGraphs = describeNotebookGraphsForTutor(page.graphBlocks);

    const assertCaptureIsCurrent = () => {
      if (
        pageState.read().selectedPage?.id !== capturedPageId ||
        pageState.read().contentRevision !== capturedContentRevision ||
        editorRevisionRef.current !== capturedEditorRevision ||
        inkEditorRef.current !== editor
      ) {
        throw new Error(
          "This notebook page changed while Jami was reading it. Try sending your question again."
        );
      }
      if (inkInteractionActiveRef.current || editor.isInteracting()) {
        throw new Error("Finish the current pen stroke, then ask Jami again.");
      }
    };

    const ink = await editor.serializeAsync();
    if (ink === null) {
      throw new Error(
        "Finish the current pen stroke and wait for the page to settle, then try again."
      );
    }
    const inkSvg = notebookInkSvg(ink) ?? "";
    assertCaptureIsCurrent();

    let background:
      | {
          kind: "pdf-canvas";
          canvas: HTMLCanvasElement;
        }
      | {
          kind: "image-bytes";
          bytes: Uint8Array;
          mimeType: string;
        }
      | null = null;

    if (
      activeNotebookFile?.fileType === "application/pdf" &&
      activeNotebookFile.storagePath
    ) {
      const pdfCanvasTracking = activePdfCanvasTrackingRef.current;
      const pdfCanvas = pdfCanvasTracking.canvas;
      if (
        !activePdfRenderKey ||
        !pdfCanvas ||
        pdfCanvasTracking.renderKey !== activePdfRenderKey ||
        pdfCanvas.width <= 0 ||
        pdfCanvas.height <= 0
      ) {
        throw new Error(
          "This PDF page is still loading. Wait until it appears, then ask Jami again."
        );
      }
      background = { kind: "pdf-canvas", canvas: pdfCanvas };
    } else if (
      activeNotebookFile?.fileType.startsWith("image/") &&
      activeNotebookFile.storagePath
    ) {
      let bytes: Uint8Array;
      try {
        bytes = await getNotebookFileBytes(activeNotebookFile.storagePath);
      } catch {
        // Replaced with wording the student can act on. The storage error
        // names an internal path and would not tell them what to do next.
        throw new Error(
          "Jami could not read this page's image background. Wait a moment and try again."
        );
      }
      assertCaptureIsCurrent();
      background = {
        kind: "image-bytes",
        bytes,
        mimeType: activeNotebookFile.fileType,
      };
    }

    const overlayImages = await loadOverlayImages(capturedImages);
    assertCaptureIsCurrent();

    const snapshot = await renderNotebookPageSnapshot({
      pageColor: capturedPageColor,
      pageStyle: capturedPageStyle,
      inkSvg,
      textBlocks: capturedTextBlocks,
      background,
      overlayImages,
    });
    assertCaptureIsCurrent();
    const dataBase64 = await readBlobAsBase64(snapshot.blob);
    assertCaptureIsCurrent();

    return {
      surface: "notebook",
      notebookId: currentNotebook.id,
      pageId: capturedPageId,
      snapshot: {
        mimeType: snapshot.mimeType,
        width: snapshot.width,
        height: snapshot.height,
        dataBase64,
      },
      typedText: [snapshot.typedText, capturedGraphs].filter(Boolean).join("\n\n") || undefined,
      questionPrompt: page.questionPrompt?.trim() || undefined,
      hasInk: capturedHasInk,
      imageCount: capturedImages.length,
    };
  }, [
    activeNotebookFile,
    activePdfCanvasTrackingRef,
    activePdfRenderKey,
    editorRevisionRef,
    inkEditorRef,
    inkInteractionActiveRef,
    inkReadyRef,
    notebook,
    pageState,
    selectedPageId,
  ]);
}
