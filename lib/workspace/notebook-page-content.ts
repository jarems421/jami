import { normalizeTimedInkPoint } from "@/lib/workspace/notebook-ink-engine";
import {
  getNotebookPaperPalette,
  NOTEBOOK_PAGE_COLORS,
} from "@/lib/workspace/notebook-paper-palette";
import {
  buildTypedContentFromTextBlocks,
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
  normalizeNotebookStrokeColor,
  type NotebookHighlighterColor,
  type NotebookPage,
  type NotebookPageColor,
  type NotebookPageStatus,
  type NotebookPageStyle,
  type NotebookPenColor,
  type NotebookStroke,
  type NotebookStrokeColor,
  type NotebookStrokePoint,
  type NotebookStrokeTool,
  type NotebookTextBlock,
} from "@/lib/workspace/notebooks";
import type { NotebookPageDraft } from "@/lib/workspace/notebook-drafts";
import {
  getNotebookCompleteGridLines,
  getNotebookRuledLines,
  NOTEBOOK_DOT_RADIUS,
  NOTEBOOK_DOT_SPACING,
} from "@/lib/workspace/notebook-paper";

/*
 * Kept as a lookup because it is on the hot path of legacy stroke painting,
 * but sourced from the palette so a new paper cannot be added to one and not
 * the other.
 */
const PAGE_COLOR_HEX = Object.fromEntries(
  NOTEBOOK_PAGE_COLORS.map((color) => [color, getNotebookPaperPalette(color).paper])
) as Record<NotebookPageColor, string>;

const PEN_COLOR_HEX: Record<NotebookPenColor, string> = {
  black: "#111827",
  white: "#f8fafc",
  red: "#ef4444",
  green: "#22c55e",
};

const HIGHLIGHTER_COLOR_HEX: Record<NotebookHighlighterColor, string> = {
  yellow: "#fde047",
  green: "#86efac",
  pink: "#f9a8d4",
};

function isNotebookStrokePoint(value: unknown): value is NotebookStrokePoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

export function applyNotebookDraftToPage(
  page: NotebookPage,
  draft: NotebookPageDraft
): NotebookPage {
  return {
    ...page,
    typedContent: buildTypedContentFromTextBlocks(draft.textBlocks),
    textBlocks: draft.textBlocks,
    inkData: draft.ink,
    strokeData: undefined,
    pageColor: draft.pageColor,
    pageStyle: draft.pageStyle,
    status: draft.status,
  };
}

export function normalizeNotebookStrokes(value: unknown): NotebookStroke[] {
  if (!Array.isArray(value)) return [];

  const strokes: NotebookStroke[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const points = (entry as { points?: unknown }).points;
    if (!Array.isArray(points)) continue;
    const cleanPoints = points
      .filter(isNotebookStrokePoint)
      .map((point) => normalizeTimedInkPoint(point))
      .slice(0, 1_200);
    if (cleanPoints.length === 0) continue;

    const stroke = entry as Record<string, unknown>;
    const tool: NotebookStrokeTool =
      stroke.tool === "eraser" || stroke.tool === "highlighter"
        ? stroke.tool
        : "pen";
    const width =
      typeof stroke.width === "number" && Number.isFinite(stroke.width)
        ? Math.max(1, Math.min(96, Math.round(stroke.width)))
        : tool === "eraser"
          ? 18
          : 5;
    strokes.push({
      points: cleanPoints,
      color: normalizeNotebookStrokeColor(stroke.color),
      tool,
      width,
    });
  }

  return strokes;
}

export function makeNotebookTextBlockId() {
  return `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getNotebookTextBlockOptionsElementId(
  blockId: string,
  element: "menu" | "trigger"
) {
  return `notebook-text-box-options-${encodeURIComponent(blockId)}-${element}`;
}

export function clampNotebookTextBlock(
  block: NotebookTextBlock
): NotebookTextBlock {
  const width = Math.max(
    120,
    Math.min(NOTEBOOK_PAGE_COORDINATE_WIDTH, Math.round(block.width))
  );
  const height = Math.max(
    48,
    Math.min(NOTEBOOK_PAGE_COORDINATE_HEIGHT, Math.round(block.height))
  );
  return {
    ...block,
    width,
    height,
    x: Math.max(
      0,
      Math.min(NOTEBOOK_PAGE_COORDINATE_WIDTH - width, Math.round(block.x))
    ),
    y: Math.max(
      0,
      Math.min(NOTEBOOK_PAGE_COORDINATE_HEIGHT - height, Math.round(block.y))
    ),
  };
}

export function getNotebookStrokePaintColor(
  color: NotebookStrokeColor,
  tool: NotebookStrokeTool
) {
  if (color.startsWith("#")) return color;
  if (tool === "highlighter" && color in HIGHLIGHTER_COLOR_HEX) {
    return HIGHLIGHTER_COLOR_HEX[color as NotebookHighlighterColor];
  }
  return (
    PEN_COLOR_HEX[color as NotebookPenColor] ??
    HIGHLIGHTER_COLOR_HEX[color as NotebookHighlighterColor] ??
    PEN_COLOR_HEX.black
  );
}

export function getNotebookStrokePaintColorForPage(
  stroke: NotebookStroke,
  pageColor: NotebookPageColor
) {
  if (stroke.tool === "eraser") return PAGE_COLOR_HEX[pageColor];
  return getNotebookStrokePaintColor(stroke.color, stroke.tool);
}

export function getNotebookPageStyleBackground(
  pageColor: NotebookPageColor,
  style: NotebookPageStyle
) {
  if (style === "plain") return undefined;
  const lineColor = getNotebookPaperPalette(pageColor).line;
  const svgBody =
    style === "lined"
      ? `<path d="${getNotebookRuledLines(NOTEBOOK_PAGE_COORDINATE_HEIGHT)
          .map(
            (y) =>
              `M 0 ${y} H ${NOTEBOOK_PAGE_COORDINATE_WIDTH}`
          )
          .join(" ")}" fill="none" stroke="${lineColor}" stroke-opacity="0.14" stroke-width="1"/>`
      : style === "grid"
        ? (() => {
            const verticalLines = getNotebookCompleteGridLines(
              NOTEBOOK_PAGE_COORDINATE_WIDTH
            );
            const horizontalLines = getNotebookCompleteGridLines(
              NOTEBOOK_PAGE_COORDINATE_HEIGHT
            );
            const minX = verticalLines[0] ?? 0;
            const maxX =
              verticalLines[verticalLines.length - 1] ??
              NOTEBOOK_PAGE_COORDINATE_WIDTH;
            const minY = horizontalLines[0] ?? 0;
            const maxY =
              horizontalLines[horizontalLines.length - 1] ??
              NOTEBOOK_PAGE_COORDINATE_HEIGHT;
            return `<path d="${[
              ...verticalLines.map((x) => `M ${x} ${minY} V ${maxY}`),
              ...horizontalLines.map((y) => `M ${minX} ${y} H ${maxX}`),
            ].join(
              " "
            )}" fill="none" stroke="${lineColor}" stroke-opacity="0.14" stroke-width="1"/>`;
          })()
        : `<defs><pattern id="notebook-dots" width="${NOTEBOOK_DOT_SPACING}" height="${NOTEBOOK_DOT_SPACING}" patternUnits="userSpaceOnUse"><circle cx="${
            NOTEBOOK_DOT_SPACING / 2
          }" cy="${
            NOTEBOOK_DOT_SPACING / 2
          }" r="${NOTEBOOK_DOT_RADIUS}" fill="${lineColor}" fill-opacity="0.14"/></pattern></defs><rect width="${NOTEBOOK_PAGE_COORDINATE_WIDTH}" height="${NOTEBOOK_PAGE_COORDINATE_HEIGHT}" fill="url(#notebook-dots)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${NOTEBOOK_PAGE_COORDINATE_WIDTH} ${NOTEBOOK_PAGE_COORDINATE_HEIGHT}" preserveAspectRatio="none">${svgBody}</svg>`;

  return {
    backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    backgroundPosition: "0 0",
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 100%",
  };
}

export function buildNotebookThumbnailPoints(
  points: readonly NotebookStrokePoint[]
) {
  return points
    .slice(0, 80)
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
}

export function getNotebookWorkingPageStatus(input: {
  typedContent: string;
  hasInk: boolean;
}): NotebookPageStatus {
  return input.typedContent.trim() || input.hasInk ? "working" : "blank";
}
