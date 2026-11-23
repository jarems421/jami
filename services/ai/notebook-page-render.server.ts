import "server-only";

import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import type { NotebookFile, NotebookPage } from "@/lib/workspace/notebooks";
import { getAdminStorageBucket } from "@/services/firebase/admin";

/**
 * Drawing a saved notebook page on the server: its PDF or image background
 * with the student's ink over it.
 *
 * Paper marking was the only thing that needed this, so it lived there. Tutor
 * now reads the pages either side of the one a student is on, and a page it
 * can only see the typed text of is, for most students, a blank page.
 */

export const NOTEBOOK_RENDER_PAGE_WIDTH = 1_100;
export const NOTEBOOK_RENDER_PAGE_HEIGHT = 1_550;
/** Pages rendered when a whole PDF is asked for. */
export const MAX_RENDERED_PDF_PAGES = 40;

export async function renderPdfPages(bytes: Buffer, requestedPages?: readonly number[], options: { toleratePageErrors?: boolean } = {}) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: false,
  });
  const document = await task.promise;
  const pages = requestedPages?.length
    ? Array.from(new Set(requestedPages.filter((page) => page >= 0 && page < document.numPages)))
    : Array.from({ length: Math.min(document.numPages, MAX_RENDERED_PDF_PAGES) }, (_, index) => index);
  const rendered: Array<{ pageIndex: number; bytes: Buffer; width: number; height: number }> = [];
  try {
    for (const pageIndex of pages) {
      try {
        const page = await document.getPage(pageIndex + 1);
        try {
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, NOTEBOOK_RENDER_PAGE_WIDTH / Math.max(1, baseViewport.width));
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext("2d");
          await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
          rendered.push({ pageIndex, bytes: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height });
        } finally {
          page.cleanup();
        }
      } catch (error) {
        if (!options.toleratePageErrors) throw error;
      }
    }
  } finally {
    await task.destroy();
  }
  return rendered;
}

export async function normalizeImage(bytes: Buffer) {
  const image = sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({
      width: NOTEBOOK_RENDER_PAGE_WIDTH,
      height: NOTEBOOK_RENDER_PAGE_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" });
  const metadata = await image.metadata();
  const normalized = await image.png({ compressionLevel: 9 }).toBuffer();
  const outputMetadata = await sharp(normalized).metadata();
  return {
    bytes: normalized,
    width: outputMetadata.width ?? metadata.width,
    height: outputMetadata.height ?? metadata.height,
  };
}

async function inkSvgToPng(svg: string) {
  if (!svg || svg.length > 850_000) return null;
  try {
    return await sharp(Buffer.from(svg))
      .resize({ width: NOTEBOOK_RENDER_PAGE_WIDTH, height: NOTEBOOK_RENDER_PAGE_HEIGHT, fit: "contain" })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** A page's background as a PNG, when it has one the student owns. */
export async function backgroundForPage(
  uid: string,
  page: NotebookPage,
  files: ReadonlyMap<string, NotebookFile>,
  fileCache: Map<string, Buffer>,
  pdfCache: Map<string, Buffer>
) {
  if (!page.backgroundFileId) return null;
  const file = files.get(page.backgroundFileId);
  if (!file?.storagePath.startsWith(`users/${uid}/`)) return null;
  let bytes = fileCache.get(file.id);
  if (!bytes) {
    [bytes] = await getAdminStorageBucket().file(file.storagePath).download();
    fileCache.set(file.id, bytes);
  }
  if (file.fileType === "application/pdf") {
    const key = `${file.id}:${page.pdfPageIndex ?? 0}`;
    let png = pdfCache.get(key);
    if (!png) {
      png = (await renderPdfPages(bytes, [page.pdfPageIndex ?? 0]))[0]?.bytes;
      if (!png) return null;
      pdfCache.set(key, png);
    }
    return png;
  }
  if (file.fileType.startsWith("image/")) return (await normalizeImage(bytes)).bytes;
  return null;
}

/** One page as a PNG: its background, if it has one, with its ink drawn over. */
export async function renderNotebookPage(input: {
  uid: string;
  page: NotebookPage;
  inkSvg: string;
  files: ReadonlyMap<string, NotebookFile>;
  fileCache: Map<string, Buffer>;
  pdfCache: Map<string, Buffer>;
}) {
  const background = await backgroundForPage(
    input.uid,
    input.page,
    input.files,
    input.fileCache,
    input.pdfCache
  );
  const ink = await inkSvgToPng(input.inkSvg);
  const base = background
    ? sharp(background).resize({
        width: NOTEBOOK_RENDER_PAGE_WIDTH,
        height: NOTEBOOK_RENDER_PAGE_HEIGHT,
        fit: "contain",
        background: "#ffffff",
      })
    : sharp({
        create: {
          width: NOTEBOOK_RENDER_PAGE_WIDTH,
          height: NOTEBOOK_RENDER_PAGE_HEIGHT,
          channels: 4,
          background: "#ffffff",
        },
      });
  const bytes = await base
    .composite(ink ? [{ input: ink, blend: "over" }] : [])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { bytes, width: NOTEBOOK_RENDER_PAGE_WIDTH, height: NOTEBOOK_RENDER_PAGE_HEIGHT };
}
