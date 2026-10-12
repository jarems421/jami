import { decodeInkDocument, encodeInkDocument } from "@/lib/ink/codec";
import { inkToSvg } from "@/lib/ink/export-svg";
import { importJsDrawSvg } from "@/lib/ink/import-js-draw-svg";
import { emptyInkDocument, type InkDocument } from "@/lib/ink/model";
import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
  type NotebookInkData,
  type NotebookStroke,
  type NotebookStrokeColor,
  type NotebookStrokeTool,
} from "@/lib/workspace/notebooks";

/*
 * Reading and writing a page's ink, whichever form it is stored in (see
 * `NotebookInkData`). Every reader comes through `notebookInkSvg` or
 * `notebookInkDocument`, so none of them needs to know which forms exist.
 */

type InkPage = { width: number; height: number };

const NOTEBOOK_PAGE: InkPage = {
  width: NOTEBOOK_PAGE_COORDINATE_WIDTH,
  height: NOTEBOOK_PAGE_COORDINATE_HEIGHT,
};

const PEN_COLORS: Record<string, string> = {
  black: "#111827",
  white: "#f8fafc",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#fde047",
  pink: "#f9a8d4",
};

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function getNotebookInkColor(
  color: NotebookStrokeColor,
  tool: NotebookStrokeTool
) {
  const resolved = color.startsWith("#") ? color : PEN_COLORS[color] ?? PEN_COLORS.black;
  return {
    color: resolved,
    opacity: tool === "highlighter" ? 0.42 : 1,
  };
}

export function legacyStrokesToJsDrawSvg(
  strokes: NotebookStroke[],
  width: number,
  height: number
) {
  const paths = strokes.flatMap((stroke) => {
    if (stroke.points.length === 0) return [];
    const { color, opacity } = getNotebookInkColor(stroke.color, stroke.tool);
    const path = stroke.points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    return [
      `<path d="${escapeAttribute(path)}" fill="none" stroke="${escapeAttribute(
        color
      )}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />`,
    ];
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join(
    ""
  )}</svg>`;
}

/** Ink stored as SVG alone: what js-draw saves, and how an SVG from elsewhere is handed over. */
export function svgNotebookInkData(svg: string): NotebookInkData {
  return { version: 2, format: "js-draw-svg", svg };
}

/**
 * What Jami Ink saves for a page while it rolls out: the SVG a build from
 * before it reads, with its own encoding of the same page alongside. A page
 * beyond what the encoding takes (far past what a page may store anyway) goes
 * as the SVG alone, and the size check then judges it as it always has.
 */
export function jamiInkData(doc: InkDocument, page: InkPage = NOTEBOOK_PAGE): NotebookInkData {
  const svg = inkToSvg(doc, page);
  let jamiInk: string;
  try {
    jamiInk = encodeInkDocument(doc);
  } catch {
    return svgNotebookInkData(svg);
  }
  return { version: 2, format: "js-draw-svg", svg, jamiInk };
}

/**
 * SVGs made from encodings, newest last: a page drawn by the static view, its
 * thumbnail and the swipe track is asked for the same few pages over and over,
 * and a big page takes milliseconds to decode and write out.
 */
const svgCache = new Map<string, { page: InkPage; svg: string }>();
const SVG_CACHE_SIZE = 4;

function svgFromEncoding(data: string, page: InkPage): string {
  const cached = svgCache.get(data);
  if (cached && cached.page.width === page.width && cached.page.height === page.height) {
    svgCache.delete(data);
    svgCache.set(data, cached);
    return cached.svg;
  }
  // Undecodable ink shows as a blank page here; opening it to edit is refused
  // instead (`notebookInkDocument`).
  const svg = inkToSvg(decodeInkDocument(data) ?? emptyInkDocument(), page);
  svgCache.set(data, { page, svg });
  if (svgCache.size > SVG_CACHE_SIZE) svgCache.delete(svgCache.keys().next().value as string);
  return svg;
}

/**
 * A page's ink as SVG: the one it is stored with, or one written from Jami
 * Ink's encoding when the page was too big to carry both. The server,
 * thumbnails, previews, the static page and the swipe track all read it here.
 */
export function notebookInkSvg(
  ink: NotebookInkData | null | undefined,
  page: InkPage = NOTEBOOK_PAGE
): string | undefined {
  if (!ink) return undefined;
  return ink.format === "js-draw-svg" ? ink.svg : svgFromEncoding(ink.data, page);
}

/**
 * A page's ink as Jami Ink's model: its own encoding when the page carries one,
 * otherwise the SVG read as js-draw drew it (`importJsDrawSvg`).
 *
 * Null when the page is Jami Ink's encoding alone and it does not decode --
 * written by a newer build that marked it unreadable here, or damaged. That
 * page must not be opened to edit: an empty sheet saved over it would replace
 * the real one. An encoding that rides alongside an SVG and does not decode
 * falls back to the SVG, which shows the same page.
 */
export function notebookInkDocument(ink: NotebookInkData | null | undefined): InkDocument | null {
  if (!ink) return emptyInkDocument();
  if (ink.format === "jami-ink") return decodeInkDocument(ink.data);
  const decoded = ink.jamiInk ? decodeInkDocument(ink.jamiInk) : null;
  return decoded ?? importJsDrawSvg(ink.svg)?.document ?? emptyInkDocument();
}
