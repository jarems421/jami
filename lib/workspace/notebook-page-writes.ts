import { normalizeOptionalString } from "@/lib/material/content";
import { normalizeQuestionAssets, type PracticePaperQuestionAsset } from "@/lib/practice/practice-papers";
import { compactNotebookInkSvg } from "@/lib/workspace/notebook-ink-compaction";
import { normalizeNotebookGraphBlocks, type NotebookGraphBlock } from "@/lib/workspace/notebook-graphs";
import {
  MAX_NOTEBOOK_IMAGE_REFS,
  MAX_NOTEBOOK_INK_SVG_LENGTH,
  MAX_NOTEBOOK_PAGE_SNAPSHOT_BYTES,
  MAX_NOTEBOOK_PAGE_TYPED_CONTENT,
  MAX_NOTEBOOK_STROKE_POINTS,
  MAX_NOTEBOOK_STROKES,
  MAX_NOTEBOOK_TEXT_BLOCKS,
  MAX_QUESTION_ANSWER_LENGTH,
  buildTypedContentFromTextBlocks,
  getNotebookTextBlockTextLimit,
  normalizeNotebookImageRefs,
  normalizeNotebookInkData,
  normalizeNotebookStrokeData,
  normalizeNotebookTextBlocks,
  notebookInkStoredLength,
  type NotebookImageRef,
  type NotebookInkData,
  type NotebookPageColor,
  type NotebookPageStatus,
  type NotebookPageStyle,
  type NotebookPageType,
  type NotebookStrokeData,
  type NotebookTextBlock,
} from "@/lib/workspace/notebooks";

/*
 * What may be written as a notebook page. Readers stay tolerant so old pages
 * open whole; this side is strict, and says what to change, so the editor can
 * keep a local draft rather than pretend a lossy save succeeded.
 */

export type NotebookPageSnapshotInput = {
  typedContent: string;
  textBlocks: NotebookTextBlock[];
  inkData?: NotebookInkData;
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  status: NotebookPageStatus;
};

export type NotebookPagePersistenceErrorCode =
  | "invalid-ink"
  | "ink-too-large"
  | "too-many-text-blocks"
  | "text-block-too-large"
  | "typed-content-too-large"
  | "legacy-strokes-too-large"
  | "too-many-images"
  | "snapshot-too-large";

export class NotebookPagePersistenceError extends Error {
  readonly code: NotebookPagePersistenceErrorCode;

  constructor(code: NotebookPagePersistenceErrorCode, message: string) {
    super(message);
    this.name = "NotebookPagePersistenceError";
    this.code = code;
  }
}

function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The ink as it will be stored: with its SVG copy while both fit the record,
 * and as Jami Ink's encoding alone when they do not.
 *
 * The copy is what a build from before Jami Ink reads, so dropping it costs
 * only that, and only on the biggest pages: such a page shows there as one
 * whose ink has not loaded, which that build will not open to edit, rather
 * than as an empty page it would save over.
 */
export function fitNotebookInkData(ink: NotebookInkData): NotebookInkData {
  if (
    ink.format === "js-draw-svg" &&
    ink.jamiInk &&
    notebookInkStoredLength(ink) > MAX_NOTEBOOK_INK_SVG_LENGTH
  ) {
    return { version: 3, format: "jami-ink", data: ink.jamiInk };
  }
  return ink;
}

/**
 * Canonical preflight for every editable notebook-page write.
 *
 * Readers remain tolerant so legacy content is never clipped on open. Writers
 * are strict and actionable so the editor can keep a local draft instead of
 * pretending a lossy save succeeded.
 */
export function prepareNotebookPageSnapshotForPersistence(
  input: NotebookPageSnapshotInput
): NotebookPageSnapshotInput & { byteLength: number } {
  const normalizedInk = input.inkData
    ? normalizeNotebookInkData(input.inkData)
    : undefined;
  if (input.inkData && !normalizedInk) {
    throw new NotebookPagePersistenceError(
      "invalid-ink",
      "This page's drawing data is invalid. Your local draft is still available."
    );
  }
  /*
   * Thin legacy ink on its way out, before it is measured against the cap.
   *
   * Strokes recorded before the smooth pen kept every input sample as a
   * separate line segment: one real page held 106 strokes as 9,540 path
   * commands and 152KB, about 1.4KB a stroke. At that rate the 850KB cap below
   * arrives at roughly six hundred strokes, and every re-render before then
   * redraws all of it. Compaction took that page to 41KB with no visible
   * change, which is both a third of the drawing work and three times the
   * headroom.
   *
   * Curved paths are left alone, so ink from the current pen passes through
   * untouched and this only ever reaches the old dense kind. It is also
   * effectively idempotent: a second pass finds nothing left within tolerance.
   *
   * Wrapped because saving someone's page must not fail over an optimisation.
   * If compaction throws, the original ink is what gets written.
   */
  let inkData = normalizedInk;
  // Only an SVG js-draw wrote: Jami Ink's carries the page's own encoding
  // beside it, and is not made of the dense segments compaction is for.
  if (normalizedInk?.format === "js-draw-svg" && !normalizedInk.jamiInk) {
    try {
      const compacted = compactNotebookInkSvg(normalizedInk.svg);
      if (compacted.bytesAfter < compacted.bytesBefore) {
        inkData = { ...normalizedInk, svg: compacted.svg };
      }
    } catch {
      inkData = normalizedInk;
    }
  }
  inkData = inkData ? fitNotebookInkData(inkData) : undefined;
  if (inkData && notebookInkStoredLength(inkData) > MAX_NOTEBOOK_INK_SVG_LENGTH) {
    throw new NotebookPagePersistenceError(
      "ink-too-large",
      "This page has too much ink to sync safely. Split the work across another page; this draft remains on this device."
    );
  }
  if (!Array.isArray(input.textBlocks) || input.textBlocks.length > MAX_NOTEBOOK_TEXT_BLOCKS) {
    throw new NotebookPagePersistenceError(
      "too-many-text-blocks",
      `A page can sync up to ${MAX_NOTEBOOK_TEXT_BLOCKS} text boxes. Delete or move a text box, then try again.`
    );
  }
  const oversizedTextBlock = input.textBlocks.find(
    (block) =>
      typeof block.text !== "string" ||
      block.text.length > getNotebookTextBlockTextLimit(block)
  );
  if (oversizedTextBlock) {
    throw new NotebookPagePersistenceError(
      "text-block-too-large",
      `Each text box can sync up to ${getNotebookTextBlockTextLimit(oversizedTextBlock).toLocaleString()} characters. Shorten that text box and try again.`
    );
  }
  if (input.typedContent.length > MAX_NOTEBOOK_PAGE_TYPED_CONTENT) {
    throw new NotebookPagePersistenceError(
      "typed-content-too-large",
      `Typed page content can sync up to ${MAX_NOTEBOOK_PAGE_TYPED_CONTENT.toLocaleString()} characters. Split it across another page and try again.`
    );
  }

  const snapshot = {
    typedContent: input.typedContent,
    textBlocks: input.textBlocks.map((block) => ({ ...block })),
    inkData,
    pageColor: input.pageColor,
    pageStyle: input.pageStyle,
    status: input.status,
  };
  const byteLength = getUtf8ByteLength(JSON.stringify(snapshot));
  if (byteLength > MAX_NOTEBOOK_PAGE_SNAPSHOT_BYTES) {
    throw new NotebookPagePersistenceError(
      "snapshot-too-large",
      "This page is too large to sync safely. Split some writing or text onto another page; this draft remains on this device."
    );
  }

  return { ...snapshot, byteLength };
}

export function buildNotebookPagePayload(input: {
  notebookId: string;
  folderId: string;
  pageNumber: number;
  title?: string;
  pageType?: NotebookPageType;
  typedContent?: string;
  textBlocks?: NotebookTextBlock[];
  inkData?: NotebookInkData;
  strokeData?: NotebookStrokeData;
  imageRefs?: NotebookImageRef[];
  graphBlocks?: NotebookGraphBlock[];
  backgroundFileId?: string;
  pdfPageIndex?: number;
  pageColor?: NotebookPageColor;
  pageStyle?: NotebookPageStyle;
  status?: NotebookPageStatus;
  questionPrompt?: string;
  questionAnswer?: string;
  questionAssets?: PracticePaperQuestionAsset[];
  linkedQuestionId?: string;
  linkedSourceId?: string;
  linkedPastPaperId?: string;
  linkedExamAttemptId?: string;
  linkedExamSessionId?: string;
  now?: number;
}) {
  const notebookId = input.notebookId.trim();
  const folderId = input.folderId.trim();
  if (!notebookId) {
    throw new Error("Missing notebook.");
  }
  if (!folderId) {
    throw new Error("Missing folder.");
  }
  if (!Number.isFinite(input.pageNumber) || input.pageNumber < 1) {
    throw new Error("Page number must be at least 1.");
  }

  const now = input.now ?? Date.now();

  const textBlocks = normalizeNotebookTextBlocks(input.textBlocks);
  const typedContent =
    buildTypedContentFromTextBlocks(textBlocks) ??
    (typeof input.typedContent === "string" && input.typedContent.trim()
      ? input.typedContent
      : undefined);
  const strokeData = input.strokeData ? normalizeNotebookStrokeData(input.strokeData) : undefined;
  if (
    input.strokeData &&
    (input.strokeData.strokes.length > MAX_NOTEBOOK_STROKES ||
      input.strokeData.strokes.some(
        (stroke) => stroke.points.length > MAX_NOTEBOOK_STROKE_POINTS
      ))
  ) {
    throw new NotebookPagePersistenceError(
      "legacy-strokes-too-large",
      "This legacy drawing is too large to sync safely. Open it in the notebook editor to preserve it as current ink data."
    );
  }
  if ((input.imageRefs?.length ?? 0) > MAX_NOTEBOOK_IMAGE_REFS) {
    throw new NotebookPagePersistenceError(
      "too-many-images",
      `A page can sync up to ${MAX_NOTEBOOK_IMAGE_REFS} images.`
    );
  }
  const inkData = input.inkData ? normalizeNotebookInkData(input.inkData) : undefined;
  if (input.inkData && !inkData) {
    throw new NotebookPagePersistenceError(
      "invalid-ink",
      "This page's drawing data is invalid and could not be saved."
    );
  }
  prepareNotebookPageSnapshotForPersistence({
    typedContent: typedContent ?? "",
    textBlocks,
    inkData,
    pageColor: input.pageColor ?? "white",
    pageStyle: input.pageStyle ?? "plain",
    status: input.status ?? "blank",
  });

  return {
    notebookId,
    folderId,
    pageNumber: Math.round(input.pageNumber),
    title: normalizeOptionalString(input.title, 120) ?? null,
    pageType: input.pageType ?? "blank",
    typedContent: typedContent ?? null,
    textBlocks,
    inkData: inkData ?? null,
    strokeData: strokeData ?? null,
    imageRefs: normalizeNotebookImageRefs(input.imageRefs ?? []),
    graphBlocks: normalizeNotebookGraphBlocks(input.graphBlocks ?? []),
    backgroundFileId: normalizeOptionalString(input.backgroundFileId, 160) ?? null,
    pdfPageIndex:
      typeof input.pdfPageIndex === "number" &&
      Number.isFinite(input.pdfPageIndex) &&
      input.pdfPageIndex >= 0
        ? Math.round(input.pdfPageIndex)
        : null,
    pageColor: input.pageColor ?? "white",
    pageStyle: input.pageStyle ?? "plain",
    status: input.status ?? "blank",
    questionPrompt: normalizeOptionalString(input.questionPrompt, 30_000) ?? null,
    questionAnswer:
      normalizeOptionalString(input.questionAnswer, MAX_QUESTION_ANSWER_LENGTH) ?? null,
    questionAssets: normalizeQuestionAssets(input.questionAssets),
    linkedQuestionId: normalizeOptionalString(input.linkedQuestionId, 160) ?? null,
    linkedSourceId: normalizeOptionalString(input.linkedSourceId, 160) ?? null,
    linkedPastPaperId: normalizeOptionalString(input.linkedPastPaperId, 160) ?? null,
    linkedExamAttemptId: normalizeOptionalString(input.linkedExamAttemptId, 160) ?? null,
    linkedExamSessionId: normalizeOptionalString(input.linkedExamSessionId, 160) ?? null,
    contentRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}
