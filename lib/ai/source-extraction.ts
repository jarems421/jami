import "server-only";

import { OfficeParser } from "officeparser";
import type { SourceTextPage } from "@/lib/ai/source-chunking";
import { fetchPublicSourceText } from "@/lib/ai/source-ingestion";
import { parseSectionMarker, type SourcePageKind } from "@/lib/ai/source-outline";
import type { Source } from "@/lib/material/sources";
import { getSourceFileKind, MAX_SOURCE_FILE_SIZE } from "@/lib/material/source-files";

/**
 * A source's whole text, for indexing, with the structure it came with.
 *
 * Tutor's whole-source read stops at 60,000 characters, which is right for a
 * document sent to a model in one go and wrong for an index: a fourteen-lecture
 * pack cut there ends somewhere in lecture three, and everything after it was
 * never searchable. This keeps the whole source (to a generous bound), and
 * keeps what tells its parts apart -- PDF pages and their headings, slide
 * numbers and titles, a Word document's headings -- so the outline can find
 * the lectures and every passage can say where it came from.
 */

/** The most text one source contributes to its index: several hundred slides or a long textbook. */
export const MAX_INDEX_TEXT_CHARACTERS = 1_600_000;
const MAX_PDF_PAGES = 1_500;

export type ExtractedSourcePages = {
  pages: SourceTextPage[];
  pageKind: SourcePageKind;
  /** True when the source was longer than the index keeps. */
  truncated: boolean;
};

function tidy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Stops adding pages once the index budget is spent. */
function budgeted(pages: SourceTextPage[]): { pages: SourceTextPage[]; truncated: boolean } {
  const kept: SourceTextPage[] = [];
  let used = 0;
  for (const page of pages) {
    if (used + page.text.length > MAX_INDEX_TEXT_CHARACTERS) {
      const room = MAX_INDEX_TEXT_CHARACTERS - used;
      if (room > 500) kept.push({ ...page, text: page.text.slice(0, room) });
      return { pages: kept, truncated: true };
    }
    kept.push(page);
    used += page.text.length;
  }
  return { pages: kept, truncated: false };
}

type PdfTextItem = {
  str: string;
  hasEOL?: boolean;
  height?: number;
  transform?: number[];
};

/**
 * One PDF page's text as lines, with a blank line where the page leaves a gap,
 * and the page's heading: a line near the top set clearly larger than the rest.
 */
export function buildPdfPageText(items: readonly PdfTextItem[]) {
  type Line = { text: string; size: number; y: number | null };
  const lines: Line[] = [];
  let current: Line = { text: "", size: 0, y: null };
  const pushLine = () => {
    const text = current.text.replace(/\s+/g, " ").trim();
    if (text) lines.push({ ...current, text });
    current = { text: "", size: 0, y: null };
  };
  for (const item of items) {
    const y = item.transform?.[5];
    const size = Math.abs(item.height ?? item.transform?.[3] ?? 0);
    // A jump down the page without an end-of-line flag is still a new line.
    if (
      current.text &&
      current.y !== null &&
      typeof y === "number" &&
      Math.abs(y - current.y) > Math.max(2, (current.size || size) * 0.6)
    ) {
      pushLine();
    }
    if (current.y === null && typeof y === "number") current.y = y;
    current.text += item.str;
    current.size = Math.max(current.size, size);
    if (item.hasEOL) pushLine();
  }
  pushLine();
  if (lines.length === 0) return { text: "", heading: undefined };

  const sizes = lines.map((line) => line.size).filter((size) => size > 0).sort((a, b) => a - b);
  // The lower middle, so a page of one title and one body line reads the body as usual.
  const median = sizes[Math.floor((sizes.length - 1) / 2)] ?? 0;
  const headingLine = median > 0
    ? lines
        .slice(0, 4)
        .find((line) => line.size >= median * 1.2 && line.text.length <= 120 && /\p{L}/u.test(line.text))
    : undefined;

  const parts: string[] = [];
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    const gap =
      previous && previous.y !== null && line.y !== null
        ? Math.abs(previous.y - line.y)
        : 0;
    const lineHeight = Math.max(previous?.size ?? 0, line.size, 1);
    const newParagraph =
      index > 0 &&
      (gap > lineHeight * 1.8 || line === headingLine || previous === headingLine);
    parts.push(`${newParagraph ? "\n\n" : index > 0 ? "\n" : ""}${line.text}`);
  });
  return { text: tidy(parts.join("")), heading: headingLine?.text };
}

export async function extractPdfPages(bytes: Buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages: SourceTextPage[] = [];
  let used = 0;
  let truncated = false;
  try {
    const count = Math.min(document.numPages, MAX_PDF_PAGES);
    truncated = document.numPages > MAX_PDF_PAGES;
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const { text, heading } = buildPdfPageText(
        content.items.flatMap((item) => ("str" in item ? [item as PdfTextItem] : []))
      );
      page.cleanup();
      if (!text) continue;
      pages.push({ pageNumber, ...(heading ? { heading } : {}), text });
      used += text.length;
      if (used > MAX_INDEX_TEXT_CHARACTERS) {
        truncated = true;
        break;
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  const kept = budgeted(pages);
  return { pages: kept.pages, truncated: truncated || kept.truncated, pageCount: document.numPages };
}

type OfficeNode = {
  type?: string;
  text?: string;
  children?: OfficeNode[];
  notes?: OfficeNode[];
  metadata?: { slideNumber?: number; level?: number };
};

/** The node's text with a paragraph break between blocks, so structure survives. */
function officeNodeText(node: OfficeNode): string {
  if (node.type === "paragraph" || node.type === "heading" || node.type === "text") {
    return (node.text ?? "").trim();
  }
  if (node.type === "table") {
    return (node.children ?? [])
      .map((row) => (row.children ?? []).map((cell) => (cell.text ?? "").trim()).join(" | "))
      .filter((row) => row.replace(/[|\s]/g, ""))
      .join("\n");
  }
  if (node.children?.length) {
    return node.children.map(officeNodeText).filter(Boolean).join("\n\n");
  }
  return (node.text ?? "").trim();
}

async function parseOffice(buffer: Buffer, fileType: "pptx" | "docx") {
  const ast = await OfficeParser.parseOffice(buffer, {
    fileType,
    ocr: false,
    extractAttachments: false,
    includeRawContent: false,
  });
  return (ast.content ?? []) as OfficeNode[];
}

/** One page per slide, titled by the slide's own title, with its speaker notes. */
export function pptxNodesToPages(nodes: readonly OfficeNode[]): SourceTextPage[] {
  return nodes.flatMap((slide, index): SourceTextPage[] => {
    if (slide.type !== "slide") return [];
    const children = slide.children ?? [];
    const title = children.find((child) => child.type === "heading")?.text?.trim();
    const body = children.map(officeNodeText).filter(Boolean).join("\n\n");
    const notes = (slide.notes ?? []).map(officeNodeText).filter(Boolean).join("\n\n");
    const text = tidy([body, notes ? `Speaker notes: ${notes}` : ""].filter(Boolean).join("\n\n"));
    if (!text) return [];
    return [{
      pageNumber: slide.metadata?.slideNumber ?? index + 1,
      ...(title ? { heading: title } : {}),
      text,
    }];
  });
}

/**
 * A Word document as one part per heading, carrying the heading's level, so
 * its chapters can be found even when they are not numbered.
 */
export function docxNodesToPages(nodes: readonly OfficeNode[]): SourceTextPage[] {
  const pages: SourceTextPage[] = [];
  let current: SourceTextPage | null = null;
  for (const node of nodes) {
    const level = node.type === "heading" ? node.metadata?.level ?? 1 : undefined;
    const text = officeNodeText(node);
    if (!text) continue;
    if (level !== undefined && level <= 2) {
      if (current?.text.trim()) pages.push({ ...current, text: tidy(current.text) });
      current = { heading: text, headingLevel: level, text };
      continue;
    }
    current ??= { text: "" };
    current.text = current.text ? `${current.text}\n\n${text}` : text;
  }
  if (current?.text.trim()) pages.push({ ...current, text: tidy(current.text) });
  return pages;
}

/**
 * Plain text split where it starts a new lecture, week or chapter, or at a
 * top-level Markdown heading, so a pasted or downloaded course page keeps its
 * divisions too.
 */
export function splitTextIntoPages(text: string): SourceTextPage[] {
  const pages: SourceTextPage[] = [];
  let current: SourceTextPage = { text: "" };
  for (const line of tidy(text).split("\n")) {
    const trimmed = line.trim();
    const markdown = trimmed.match(/^(#{1,2})\s+(.{1,160})$/);
    const startsDivision =
      trimmed.length > 0 && trimmed.length <= 160 && (markdown || parseSectionMarker(trimmed));
    if (startsDivision && current.text.trim()) {
      pages.push({ ...current, text: tidy(current.text) });
      current = { text: "" };
    }
    if (startsDivision && !current.text.trim()) {
      const heading = markdown ? markdown[2].trim() : trimmed;
      current = {
        heading,
        ...(markdown ? { headingLevel: markdown[1].length } : {}),
        text: "",
      };
    }
    current.text += `${line}\n`;
  }
  if (current.text.trim()) pages.push({ ...current, text: tidy(current.text) });
  return pages;
}

/**
 * The whole of a source as pages, or null when it has no text to extract (an
 * image, or a PDF that is only scans) and must be indexed from its picture.
 */
export async function extractSourcePagesForIndex(
  source: Source,
  loadStoredFile: (storagePath: string) => Promise<Buffer>
): Promise<ExtractedSourcePages | null> {
  if (source.contentText) {
    const kept = budgeted(splitTextIntoPages(source.contentText));
    return { ...kept, pageKind: "page" };
  }
  if (source.type === "link" && source.externalUrl) {
    const text = await fetchPublicSourceText(source.externalUrl, MAX_INDEX_TEXT_CHARACTERS);
    return { ...budgeted(splitTextIntoPages(text)), pageKind: "page" };
  }
  if (source.type !== "file" || !source.storagePath || !source.fileType) return null;
  const kind = getSourceFileKind(source.fileType);
  if (kind === "image" || kind === null) return null;

  const buffer = await loadStoredFile(source.storagePath);
  if (buffer.byteLength <= 0 || buffer.byteLength >= MAX_SOURCE_FILE_SIZE) {
    throw new Error("The uploaded file is empty or too large.");
  }
  if (kind === "pdf") {
    const extracted = await extractPdfPages(buffer);
    return extracted.pages.length > 0 ? { ...extracted, pageKind: "page" } : null;
  }
  if (kind === "text") {
    return { ...budgeted(splitTextIntoPages(buffer.toString("utf8"))), pageKind: "page" };
  }
  if (
    source.fileType ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return { ...budgeted(pptxNodesToPages(await parseOffice(buffer, "pptx"))), pageKind: "slide" };
  }
  return { ...budgeted(docxNodesToPages(await parseOffice(buffer, "docx"))), pageKind: "page" };
}
