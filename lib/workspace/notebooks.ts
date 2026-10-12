import { isInkDocumentText } from "@/lib/ink/codec";
import {
  normalizeOptionalString,
  normalizeStringArray,
} from "@/lib/material/content";
import {
  normalizeQuestionAssets,
  type PracticePaperQuestionAsset,
} from "@/lib/practice/practice-papers";
import { normalizeInkPressure, normalizeInkTime } from "@/lib/workspace/notebook-ink-engine";
import type { NotebookStrokeTool } from "@/lib/workspace/notebook-ink-types";
import {
  normalizeNotebookGraphBlocks,
  type NotebookGraphBlock,
} from "@/lib/workspace/notebook-graphs";

export type { NotebookStrokeTool } from "@/lib/workspace/notebook-ink-types";

export type NotebookType =
  | "blank"
  | "uploaded_file"
  | "ai_questions"
  | "general_working"
  | "free_working"
  | "practice"
  | "past_paper"
  | "practice_paper"
  | "generated_drill"
  | "source_notes";

export type NotebookPageType =
  | "blank"
  | "question"
  | "past_paper_page"
  | "source_note"
  | "free_working";

export type NotebookStrokeData = {
  version: number;
  strokes: NotebookStroke[];
};

/**
 * A page's ink as it is stored.
 *
 * `js-draw-svg` (v2) is the SVG every build since the smooth pen has read. Jami
 * Ink writes it too while it rolls out, carrying its own encoding of the same
 * page alongside in `jamiInk` (`lib/ink/codec.ts`), so a build from before it
 * still reads and edits the SVG and a rollback loses nothing. `jami-ink` (v3)
 * is that encoding alone, written only when a page is too big to carry both;
 * once the rollout is over it is the only form written. See
 * `docs/notebook-ink.md` (Migration), and `notebookInkSvg` and
 * `notebookInkDocument` for reading either.
 */
export type NotebookInkData =
  | { version: 2; format: "js-draw-svg"; svg: string; jamiInk?: string }
  | { version: 3; format: "jami-ink"; data: string };

/**
 * Lossy page preview stored on the page record for the pages drawer. See
 * `lib/workspace/notebook-page-ink-split.ts` for how it is built and why it is
 * bounded.
 */
export type NotebookPageThumbnailData = {
  inkSvg?: string;
  strokes: NotebookStroke[];
  inkOmitted: boolean;
};

export type NotebookPenColor = "black" | "white" | "red" | "green";
export type NotebookHighlighterColor = "yellow" | "green" | "pink";
export type NotebookCustomStrokeColor = `#${string}`;
export type NotebookStrokeColor =
  | NotebookPenColor
  | NotebookHighlighterColor
  | NotebookCustomStrokeColor;
export type NotebookPageColor = "white" | "cream" | "black";
export type NotebookPageStyle = "plain" | "lined" | "grid" | "dot";
export const NOTEBOOK_CREATION_PAGE_STYLES = [
  "plain",
  "lined",
  "grid",
] as const satisfies readonly NotebookPageStyle[];
export type NotebookPageStatus = "blank" | "working" | "needs_review" | "marked";

export type NotebookStrokePoint = {
  x: number;
  y: number;
  pressure?: number;
  time?: number;
};

export type NotebookStroke = {
  points: NotebookStrokePoint[];
  color: NotebookStrokeColor;
  width: number;
  tool: NotebookStrokeTool;
};

export type NotebookImageRef = {
  id: string;
  storagePath?: string;
  localPreviewUrl?: string;
  /** Intrinsic pixel dimensions of the private asset. */
  width?: number;
  height?: number;
  /** Placement in the fixed 900 x 1240 notebook coordinate space. */
  x?: number;
  y?: number;
  displayWidth?: number;
  displayHeight?: number;
  altText?: string;
  sourceAssetId?: string;
};

export type NotebookTextBlock = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  outlineVisible: boolean;
  /**
   * How the text is read. Absent for what a student types, which shows
   * exactly as typed. "markdown" is a Tutor answer added to the page: its
   * text is the answer's own Markdown and maths, and it is shown the way the
   * Tutor showed it -- tables, headings, typeset maths -- rather than as the
   * dollar signs and pipes a copy and paste leaves behind.
   */
  format?: NotebookTextBlockFormat;
};

export type NotebookTextBlockFormat = "markdown";

export type Notebook = {
  id: string;
  folderId: string;
  title: string;
  type: NotebookType;
  topicIds: string[];
  sourceIds: string[];
  practiceSetId?: string;
  pastPaperId?: string;
  color?: string;
  icon?: string;
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  uploadedFileId?: string;
  previewInkSvg?: string;
  previewPageId?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
};

export type NotebookPage = {
  id: string;
  notebookId: string;
  folderId: string;
  pageNumber: number;
  title?: string;
  pageType: NotebookPageType;
  typedContent?: string;
  textBlocks: NotebookTextBlock[];
  /**
   * Full-fidelity ink. Absent on a page saved in the split shape until its ink
   * record is fetched; never populated from `thumbnail`, which is lossy.
   */
  inkData?: NotebookInkData;
  strokeData?: NotebookStrokeData;
  /**
   * Bounded digest used by the pages drawer so thumbnails render without
   * fetching ink. Deliberately a separate field: writing it back as `inkData`
   * would save a 160px approximation over the student's real drawing.
   */
  thumbnail?: NotebookPageThumbnailData;
  imageRefs: NotebookImageRef[];
  /** Graphs plotted from their functions and points; see notebook-graphs.ts. */
  graphBlocks: NotebookGraphBlock[];
  backgroundFileId?: string;
  pdfPageIndex?: number;
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  status: NotebookPageStatus;
  questionPrompt?: string;
  /**
   * The answer to a practice question page, kept off the page itself: shown
   * only when the student asks, and read by Tutor when it marks the working.
   */
  questionAnswer?: string;
  questionAssets?: PracticePaperQuestionAsset[];
  linkedQuestionId?: string;
  linkedSourceId?: string;
  linkedPastPaperId?: string;
  linkedExamAttemptId?: string;
  linkedExamSessionId?: string;
  /** Monotonic content version used to reject stale editor writes. */
  contentRevision: number;
  createdAt: number;
  updatedAt: number;
};

export type NotebookFile = {
  id: string;
  notebookId: string;
  folderId: string;
  fileName: string;
  fileType: string;
  storagePath: string;
  sizeBytes?: number;
  pageCount?: number;
  uploadedAt: number;
  createdAt: number;
  updatedAt: number;
};

export const MAX_NOTEBOOK_TITLE_LENGTH = 140;
export const MAX_NOTEBOOK_TOPIC_IDS = 30;
export const MAX_NOTEBOOK_SOURCE_IDS = 30;
export const MAX_NOTEBOOK_PAGE_TYPED_CONTENT = 30_000;
/** An expected answer and its solution notes, as a practice draft holds them. */
export const MAX_QUESTION_ANSWER_LENGTH = 12_500;
export const MAX_NOTEBOOK_TEXT_BLOCKS = 80;
export const MAX_NOTEBOOK_TEXT_BLOCK_TEXT = 4_000;
/**
 * A Tutor answer is one box however long it is, and its Markdown and maths
 * take more characters than the words they show.
 */
export const MAX_NOTEBOOK_MARKDOWN_BLOCK_TEXT = 12_000;

export function getNotebookTextBlockTextLimit(block: Pick<NotebookTextBlock, "format">) {
  return block.format === "markdown"
    ? MAX_NOTEBOOK_MARKDOWN_BLOCK_TEXT
    : MAX_NOTEBOOK_TEXT_BLOCK_TEXT;
}
/**
 * The most characters a page's ink may take in its record: the SVG, and Jami
 * Ink's encoding too when it carries one (`notebookInkStoredLength`). Named
 * for the SVG it was first a cap on.
 */
export const MAX_NOTEBOOK_INK_SVG_LENGTH = 850_000;
// Firestore documents have a 1 MiB ceiling. Leave room for field names and
// page metadata instead of relying on the backend to reject a nearly-full doc.
export const MAX_NOTEBOOK_PAGE_SNAPSHOT_BYTES = 900_000;
export const NOTEBOOK_PAGE_COORDINATE_WIDTH = 900;
export const NOTEBOOK_PAGE_COORDINATE_HEIGHT = 1240;
export const MAX_NOTEBOOK_IMAGE_REFS = 12;
export const MAX_NOTEBOOK_STROKES = 3_000;
export const MAX_NOTEBOOK_STROKE_POINTS = 1_200;
export const MAX_NOTEBOOK_FILE_NAME_LENGTH = 500;
export const MAX_NOTEBOOK_FILE_TYPE_LENGTH = 120;
export const MAX_NOTEBOOK_FILE_STORAGE_PATH_LENGTH = 1_000;
export const MAX_NOTEBOOK_PREVIEW_SVG_LENGTH = 120_000;
export const MIN_NOTEBOOK_TEXT_BLOCK_WIDTH = 120;
export const MIN_NOTEBOOK_TEXT_BLOCK_HEIGHT = 48;
export const MIN_NOTEBOOK_IMAGE_DISPLAY_SIZE = 120;

export type NotebookTextBlockResizeEdge = "top" | "right" | "bottom" | "left";

export type NotebookImageResizeCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Where a box on the page is pulled from to resize it: a corner, or anywhere along a side. */
export type NotebookResizeHandle = NotebookImageResizeCorner | NotebookTextBlockResizeEdge;

export function isNotebookResizeEdge(
  handle: NotebookResizeHandle
): handle is NotebookTextBlockResizeEdge {
  return handle === "top" || handle === "right" || handle === "bottom" || handle === "left";
}

export function isNotebookType(value: unknown): value is NotebookType {
  return (
    value === "blank" ||
    value === "uploaded_file" ||
    value === "ai_questions" ||
    value === "general_working" ||
    value === "free_working" ||
    value === "practice" ||
    value === "past_paper" ||
    value === "practice_paper" ||
    value === "generated_drill" ||
    value === "source_notes"
  );
}

export function isNotebookPageType(value: unknown): value is NotebookPageType {
  return (
    value === "blank" ||
    value === "question" ||
    value === "past_paper_page" ||
    value === "source_note" ||
    value === "free_working"
  );
}

export function isNotebookPageColor(value: unknown): value is NotebookPageColor {
  return value === "white" || value === "cream" || value === "black";
}

export function isNotebookPenColor(value: unknown): value is NotebookPenColor {
  return value === "black" || value === "white" || value === "red" || value === "green";
}

export function isNotebookHighlighterColor(value: unknown): value is NotebookHighlighterColor {
  return value === "yellow" || value === "green" || value === "pink";
}

export function isNotebookCustomStrokeColor(value: unknown): value is NotebookCustomStrokeColor {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function normalizeNotebookStrokeColor(
  value: unknown,
  fallback: NotebookStrokeColor = "black"
): NotebookStrokeColor {
  if (isNotebookPenColor(value) || isNotebookHighlighterColor(value)) return value;
  if (isNotebookCustomStrokeColor(value)) return value.toLowerCase() as NotebookCustomStrokeColor;
  return fallback;
}

export function isNotebookStrokeTool(value: unknown): value is NotebookStrokeTool {
  return value === "pen" || value === "eraser" || value === "highlighter";
}

export function isNotebookPageStyle(value: unknown): value is NotebookPageStyle {
  return value === "plain" || value === "lined" || value === "grid" || value === "dot";
}

export function isNotebookPageStatus(value: unknown): value is NotebookPageStatus {
  return value === "blank" || value === "working" || value === "needs_review" || value === "marked";
}

export function normalizeNotebookTitle(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_NOTEBOOK_TITLE_LENGTH);
}

function normalizeNotebookStrokePoint(value: unknown, index = 0): NotebookStrokePoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  if (typeof point.x !== "number" || typeof point.y !== "number") return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    x: Math.max(0, Math.min(10_000, point.x)),
    y: Math.max(0, Math.min(10_000, point.y)),
    pressure: normalizeInkPressure(point.pressure),
    time: normalizeInkTime(point.time, index * 16),
  };
}

function normalizeNotebookStroke(value: unknown): NotebookStroke | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stroke = value as Record<string, unknown>;
  const rawPoints = Array.isArray(stroke.points) ? stroke.points : [];
  const points = rawPoints
    .map((point, index) => normalizeNotebookStrokePoint(point, index))
    .filter((point): point is NotebookStrokePoint => Boolean(point));
  if (points.length === 0) return null;

  const width =
    typeof stroke.width === "number" && Number.isFinite(stroke.width)
      ? Math.max(1, Math.min(96, Math.round(stroke.width)))
      : 5;

  return {
    points,
    color: normalizeNotebookStrokeColor(stroke.color),
    width,
    tool: isNotebookStrokeTool(stroke.tool) ? stroke.tool : "pen",
  };
}

function normalizeThumbnailData(
  value: unknown
): NotebookPageThumbnailData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const data = value as {
    inkSvg?: unknown;
    strokes?: unknown;
    inkOmitted?: unknown;
  };
  const strokes = Array.isArray(data.strokes)
    ? data.strokes
        .map(normalizeNotebookStroke)
        .filter((stroke): stroke is NotebookStroke => Boolean(stroke))
    : [];
  const inkSvg =
    typeof data.inkSvg === "string" && data.inkSvg.trimStart().startsWith("<svg")
      ? data.inkSvg
      : undefined;

  if (!inkSvg && strokes.length === 0 && data.inkOmitted !== true) {
    return undefined;
  }

  return {
    ...(inkSvg ? { inkSvg } : {}),
    strokes,
    inkOmitted: data.inkOmitted === true,
  };
}

export function normalizeNotebookStrokeData(
  value: unknown
): NotebookStrokeData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const data = value as { version?: unknown; strokes?: unknown };
  if (!Array.isArray(data.strokes)) {
    return undefined;
  }

  const strokes = data.strokes
    .map(normalizeNotebookStroke)
    .filter((stroke): stroke is NotebookStroke => Boolean(stroke));

  return {
    version: typeof data.version === "number" ? data.version : 1,
    strokes,
  };
}

export function normalizeNotebookInkData(value: unknown): NotebookInkData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.version === 3 && data.format === "jami-ink") {
    return isInkDocumentText(data.data) ? { version: 3, format: "jami-ink", data: data.data } : undefined;
  }
  if (
    data.version !== 2 ||
    data.format !== "js-draw-svg" ||
    typeof data.svg !== "string" ||
    !data.svg.trimStart().startsWith("<svg")
  ) {
    return undefined;
  }
  return {
    version: 2,
    format: "js-draw-svg",
    svg: data.svg,
    // Shape only: a copy that does not decode is set aside when it is read.
    ...(isInkDocumentText(data.jamiInk) ? { jamiInk: data.jamiInk } : {}),
  };
}

/** The ink's SVG when it is stored with one: never decoded, so cheap enough for every render. */
export function storedNotebookInkSvg(ink: NotebookInkData | null | undefined): string | undefined {
  return ink?.format === "js-draw-svg" ? ink.svg : undefined;
}

/** The characters the ink takes in its record, held to `MAX_NOTEBOOK_INK_SVG_LENGTH`. */
export function notebookInkStoredLength(ink: NotebookInkData): number {
  return ink.format === "jami-ink" ? ink.data.length : ink.svg.length + (ink.jamiInk?.length ?? 0);
}

export function normalizeNotebookPreviewSvg(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > MAX_NOTEBOOK_PREVIEW_SVG_LENGTH ||
    !value.trimStart().startsWith("<svg")
  ) {
    return undefined;
  }
  return value;
}

function clampImageNumber(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function normalizeNotebookImageRefs(value: unknown): NotebookImageRef[] {
  if (!Array.isArray(value)) return [];

  const images: NotebookImageRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const image = entry as Record<string, unknown>;
    const id = normalizeOptionalString(image.id, 160);
    if (!id) continue;
    const displayWidth = clampImageNumber(
      image.displayWidth,
      MIN_NOTEBOOK_IMAGE_DISPLAY_SIZE,
      NOTEBOOK_PAGE_COORDINATE_WIDTH,
      480
    );
    const displayHeight = clampImageNumber(
      image.displayHeight,
      MIN_NOTEBOOK_IMAGE_DISPLAY_SIZE,
      NOTEBOOK_PAGE_COORDINATE_HEIGHT,
      360
    );
    /*
     * Absent optional fields are left out, not set to `undefined`.
     *
     * Firestore rejects an explicit `undefined` outright -- neither SDK here
     * enables `ignoreUndefinedProperties` -- and every image built for a page
     * went through this function with at least one absent key. A Jami
     * illustration has no `localPreviewUrl` by definition, so adding one to a
     * page always wrote `localPreviewUrl: undefined` and always threw, which
     * the insert route reported as a generic failure to add the visual.
     */
    const storagePath = normalizeOptionalString(image.storagePath, 1_000);
    const localPreviewUrl = normalizeOptionalString(image.localPreviewUrl, 4_000);
    const altText = normalizeOptionalString(image.altText, 500);
    const sourceAssetId = normalizeOptionalString(image.sourceAssetId, 160);
    images.push({
      id,
      ...(storagePath ? { storagePath } : {}),
      ...(localPreviewUrl ? { localPreviewUrl } : {}),
      ...(typeof image.width === "number" ? { width: image.width } : {}),
      ...(typeof image.height === "number" ? { height: image.height } : {}),
      ...(altText ? { altText } : {}),
      ...(sourceAssetId ? { sourceAssetId } : {}),
      x: clampImageNumber(
        image.x,
        0,
        NOTEBOOK_PAGE_COORDINATE_WIDTH - Math.min(displayWidth, NOTEBOOK_PAGE_COORDINATE_WIDTH),
        Math.round((NOTEBOOK_PAGE_COORDINATE_WIDTH - displayWidth) / 2)
      ),
      y: clampImageNumber(
        image.y,
        0,
        NOTEBOOK_PAGE_COORDINATE_HEIGHT - Math.min(displayHeight, NOTEBOOK_PAGE_COORDINATE_HEIGHT),
        220
      ),
      displayWidth,
      displayHeight,
    });
  }

  return images;
}

function clampTextBlockNumber(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeTextBlock(value: unknown): NotebookTextBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  const id = normalizeOptionalString(block.id, 160);
  if (!id || typeof block.text !== "string") return null;
  // Loading is intentionally lossless for legacy documents. The write
  // contract below reports limits instead of silently truncating user work.
  const text = block.text;

  const width = clampTextBlockNumber(
    block.width,
    MIN_NOTEBOOK_TEXT_BLOCK_WIDTH,
    NOTEBOOK_PAGE_COORDINATE_WIDTH,
    320
  );
  const height = clampTextBlockNumber(
    block.height,
    MIN_NOTEBOOK_TEXT_BLOCK_HEIGHT,
    NOTEBOOK_PAGE_COORDINATE_HEIGHT,
    120
  );

  return {
    id,
    x: clampTextBlockNumber(block.x, 0, NOTEBOOK_PAGE_COORDINATE_WIDTH - width, 80),
    y: clampTextBlockNumber(block.y, 0, NOTEBOOK_PAGE_COORDINATE_HEIGHT - height, 80),
    width,
    height,
    text,
    outlineVisible:
      typeof block.outlineVisible === "boolean" ? block.outlineVisible : true,
    // Set only when there is one: Firestore refuses an undefined field.
    ...(block.format === "markdown" ? { format: "markdown" as const } : {}),
  };
}

export function normalizeNotebookTextBlocks(value: unknown): NotebookTextBlock[] {
  if (!Array.isArray(value)) return [];

  return value
    .map(normalizeTextBlock)
    .filter((block): block is NotebookTextBlock => Boolean(block));
}

export function createNotebookTextBlocksFromTypedContent(
  typedContent: string | undefined
): NotebookTextBlock[] {
  const text =
    typeof typedContent === "string" && typedContent.trim()
      ? typedContent
      : undefined;
  if (!text) return [];

  return [
    {
      id: "legacy-typed-content",
      x: 80,
      y: 92,
      width: 520,
      height: 180,
      text,
      outlineVisible: true,
    },
  ];
}

export function buildTypedContentFromTextBlocks(textBlocks: NotebookTextBlock[]) {
  const content = textBlocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return content || undefined;
}

export function getNotebookPagesAfterDelete(
  pages: readonly NotebookPage[],
  pageId: string
): NotebookPage[] {
  const normalizedPageId = pageId.trim();
  if (!normalizedPageId) return [...pages].sort((a, b) => a.pageNumber - b.pageNumber);

  return pages
    .filter((page) => page.id !== normalizedPageId)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page, index) => {
      const pageNumber = index + 1;
      const title =
        !page.title || /^Page \d+$/i.test(page.title) ? `Page ${pageNumber}` : page.title;
      return {
        ...page,
        pageNumber,
        title,
      };
    });
}

export function mapNotebookData(id: string, data: Record<string, unknown>): Notebook {
  const title = normalizeNotebookTitle(typeof data.title === "string" ? data.title : "");

  return {
    id,
    folderId: normalizeOptionalString(data.folderId, 160) ?? "",
    title: title || "Untitled notebook",
    type: isNotebookType(data.type) ? data.type : "free_working",
    topicIds: normalizeStringArray(data.topicIds, MAX_NOTEBOOK_TOPIC_IDS, 120),
    sourceIds: normalizeStringArray(data.sourceIds, MAX_NOTEBOOK_SOURCE_IDS, 160),
    practiceSetId: normalizeOptionalString(data.practiceSetId, 160),
    pastPaperId: normalizeOptionalString(data.pastPaperId, 160),
    color: normalizeOptionalString(data.color, 80),
    icon: normalizeOptionalString(data.icon, 40),
    pageColor: isNotebookPageColor(data.pageColor) ? data.pageColor : "white",
    pageStyle: isNotebookPageStyle(data.pageStyle) ? data.pageStyle : "plain",
    uploadedFileId: normalizeOptionalString(data.uploadedFileId, 160),
    previewInkSvg: normalizeNotebookPreviewSvg(data.previewInkSvg),
    previewPageId: normalizeOptionalString(data.previewPageId, 160),
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
    archived: data.archived === true,
  };
}

export function mapNotebookPageData(
  id: string,
  data: Record<string, unknown>
): NotebookPage {
  const pageNumber =
    typeof data.pageNumber === "number" && Number.isFinite(data.pageNumber)
      ? Math.max(1, Math.round(data.pageNumber))
      : 1;
  const typedContent =
    typeof data.typedContent === "string" && data.typedContent.trim()
      ? data.typedContent
      : undefined;
  const textBlocks = normalizeNotebookTextBlocks(data.textBlocks);

  return {
    id,
    notebookId: normalizeOptionalString(data.notebookId, 160) ?? "",
    folderId: normalizeOptionalString(data.folderId, 160) ?? "",
    pageNumber,
    title: normalizeOptionalString(data.title, 120),
    pageType: isNotebookPageType(data.pageType) ? data.pageType : "blank",
    typedContent,
    textBlocks: textBlocks.length > 0 ? textBlocks : createNotebookTextBlocksFromTypedContent(typedContent),
    inkData: normalizeNotebookInkData(data.inkData),
    strokeData: normalizeNotebookStrokeData(data.strokeData),
    thumbnail: normalizeThumbnailData(data.thumbnail),
    imageRefs: normalizeNotebookImageRefs(data.imageRefs),
    graphBlocks: normalizeNotebookGraphBlocks(data.graphBlocks),
    backgroundFileId: normalizeOptionalString(data.backgroundFileId, 160),
    pdfPageIndex:
      typeof data.pdfPageIndex === "number" &&
      Number.isFinite(data.pdfPageIndex) &&
      data.pdfPageIndex >= 0
        ? Math.round(data.pdfPageIndex)
        : undefined,
    pageColor: isNotebookPageColor(data.pageColor) ? data.pageColor : "white",
    pageStyle: isNotebookPageStyle(data.pageStyle) ? data.pageStyle : "plain",
    status: isNotebookPageStatus(data.status) ? data.status : "blank",
    questionPrompt: normalizeOptionalString(data.questionPrompt, 30_000),
    questionAnswer: normalizeOptionalString(data.questionAnswer, MAX_QUESTION_ANSWER_LENGTH),
    questionAssets: normalizeQuestionAssets(data.questionAssets),
    linkedQuestionId: normalizeOptionalString(data.linkedQuestionId, 160),
    linkedSourceId: normalizeOptionalString(data.linkedSourceId, 160),
    linkedPastPaperId: normalizeOptionalString(data.linkedPastPaperId, 160),
    linkedExamAttemptId: normalizeOptionalString(data.linkedExamAttemptId, 160),
    linkedExamSessionId: normalizeOptionalString(data.linkedExamSessionId, 160),
    contentRevision:
      typeof data.contentRevision === "number" &&
      Number.isFinite(data.contentRevision) &&
      data.contentRevision >= 0
        ? Math.round(data.contentRevision)
        : 0,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

export function buildNotebookPayload(input: {
  folderId: string;
  title: string;
  type?: NotebookType;
  topicIds?: string[];
  sourceIds?: string[];
  practiceSetId?: string;
  pastPaperId?: string;
  color?: string;
  icon?: string;
  pageColor?: NotebookPageColor;
  pageStyle?: NotebookPageStyle;
  uploadedFileId?: string;
  previewInkSvg?: string;
  previewPageId?: string;
  now?: number;
}) {
  const folderId = input.folderId.trim();
  const title = normalizeNotebookTitle(input.title);
  if (!folderId) {
    throw new Error("Choose a folder for this notebook.");
  }
  if (!title) {
    throw new Error("Notebook title is required.");
  }

  const now = input.now ?? Date.now();

  return {
    folderId,
    title,
    type: input.type ?? "free_working",
    topicIds: normalizeStringArray(input.topicIds ?? [], MAX_NOTEBOOK_TOPIC_IDS, 120),
    sourceIds: normalizeStringArray(input.sourceIds ?? [], MAX_NOTEBOOK_SOURCE_IDS, 160),
    practiceSetId: normalizeOptionalString(input.practiceSetId, 160) ?? null,
    pastPaperId: normalizeOptionalString(input.pastPaperId, 160) ?? null,
    color: normalizeOptionalString(input.color, 80) ?? null,
    icon: normalizeOptionalString(input.icon, 40) ?? null,
    pageColor: input.pageColor ?? "white",
    pageStyle: input.pageStyle ?? "plain",
    uploadedFileId: normalizeOptionalString(input.uploadedFileId, 160) ?? null,
    previewInkSvg: normalizeNotebookPreviewSvg(input.previewInkSvg) ?? null,
    previewPageId: normalizeOptionalString(input.previewPageId, 160) ?? null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function mapNotebookFileData(id: string, data: Record<string, unknown>): NotebookFile {
  return {
    id,
    notebookId: normalizeOptionalString(data.notebookId, 160) ?? "",
    folderId: normalizeOptionalString(data.folderId, 160) ?? "",
    fileName:
      normalizeOptionalString(data.fileName, MAX_NOTEBOOK_FILE_NAME_LENGTH) ??
      "Untitled file",
    fileType:
      normalizeOptionalString(data.fileType, MAX_NOTEBOOK_FILE_TYPE_LENGTH) ??
      "application/octet-stream",
    storagePath: normalizeOptionalString(data.storagePath, MAX_NOTEBOOK_FILE_STORAGE_PATH_LENGTH) ?? "",
    sizeBytes:
      typeof data.sizeBytes === "number" && Number.isFinite(data.sizeBytes)
        ? Math.max(0, Math.round(data.sizeBytes))
        : undefined,
    pageCount:
      typeof data.pageCount === "number" &&
      Number.isFinite(data.pageCount) &&
      data.pageCount > 0
        ? Math.round(data.pageCount)
        : undefined,
    uploadedAt: typeof data.uploadedAt === "number" ? data.uploadedAt : 0,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

export function buildNotebookFilePayload(input: {
  notebookId: string;
  folderId: string;
  fileName: string;
  fileType: string;
  storagePath: string;
  sizeBytes?: number;
  pageCount?: number;
  now?: number;
}) {
  const notebookId = input.notebookId.trim();
  const folderId = input.folderId.trim();
  const fileName = normalizeOptionalString(input.fileName, MAX_NOTEBOOK_FILE_NAME_LENGTH);
  const fileType = normalizeOptionalString(input.fileType, MAX_NOTEBOOK_FILE_TYPE_LENGTH);
  const storagePath = normalizeOptionalString(input.storagePath, MAX_NOTEBOOK_FILE_STORAGE_PATH_LENGTH);
  if (!notebookId) throw new Error("Missing notebook.");
  if (!folderId) throw new Error("Missing folder.");
  if (!fileName) throw new Error("File name is required.");
  if (!fileType) throw new Error("File type is required.");
  if (!storagePath) throw new Error("File storage path is required.");

  const now = input.now ?? Date.now();

  return {
    notebookId,
    folderId,
    fileName,
    fileType,
    storagePath,
    sizeBytes:
      typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes)
        ? Math.max(0, Math.round(input.sizeBytes))
        : null,
    pageCount:
      typeof input.pageCount === "number" &&
      Number.isFinite(input.pageCount) &&
      input.pageCount > 0
        ? Math.round(input.pageCount)
        : null,
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
