import "server-only";

import sharp from "sharp";
import type { AiContentPart } from "@/lib/ai/content-parts";
import { selectNotebookPicturedPageNumbers } from "@/lib/ai/notebook-page-handwriting";
import { notebookInkSvg } from "@/lib/workspace/notebook-ink-data";
import {
  mapNotebookFileData,
  normalizeNotebookInkData,
  type NotebookFile,
  type NotebookPage,
} from "@/lib/workspace/notebooks";
import { getAdminDb, getAdminStorageBucket } from "@/services/firebase/admin";
import {
  renderNotebookPage,
  renderPdfPages,
} from "@/services/ai/notebook-page-render.server";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ module: "ai.assistant.neighbour_pages" });

/**
 * The whole of this is an enrichment: a slow PDF or a missing ink record costs
 * Tutor the pages it did not finish, never the answer. Measured against the
 * rest of the pre-answer work, which already has its own deadline.
 */
const NEIGHBOUR_PAGES_BUDGET_MS = 8_000;
/** Smaller than the current page's snapshot: context to read, not work to mark. */
const NEIGHBOUR_IMAGE_WIDTH = 820;

function hasDrawnInk(svg: string | undefined) {
  return Boolean(svg && /<(path|polyline|line|circle|ellipse|rect|polygon)\b/i.test(svg));
}

function hasTypedText(page: NotebookPage) {
  return Boolean(page.typedContent?.trim() || page.textBlocks.some((block) => block.text.trim()));
}

function describePosition(pageNumber: number, currentPageNumber: number) {
  const direction = pageNumber < currentPageNumber ? "before" : "after";
  const distance = Math.abs(pageNumber - currentPageNumber);
  return distance === 1
    ? `the page ${direction} the current one`
    : `${distance} pages ${direction} the current one`;
}

async function loadInkSvg(uid: string, page: NotebookPage) {
  if (page.inkData) return notebookInkSvg(page.inkData) ?? "";
  const record = await getAdminDb()
    .collection("users")
    .doc(uid)
    .collection("notebookPageInk")
    .doc(page.id)
    .get();
  return notebookInkSvg(record.exists ? normalizeNotebookInkData(record.data()?.inkData) : undefined) ?? "";
}

/** The background files these pages use, read by id: a notebook's own file list can be long. */
async function loadBackgroundFiles(uid: string, pages: readonly NotebookPage[]) {
  const ids = Array.from(
    new Set(pages.flatMap((page) => (page.backgroundFileId ? [page.backgroundFileId] : [])))
  );
  const files = new Map<string, NotebookFile>();
  if (ids.length === 0) return files;
  const collection = getAdminDb().collection("users").doc(uid).collection("notebookFiles");
  const snapshots = await getAdminDb().getAll(...ids.map((id) => collection.doc(id)));
  snapshots.forEach((snapshot) => {
    if (!snapshot.exists) return;
    const file = mapNotebookFileData(snapshot.id, snapshot.data() ?? {});
    files.set(file.id, file);
  });
  return files;
}

/**
 * Downloads each PDF once and draws every page wanted from it in one pass.
 *
 * Drawn page by page, two neighbours of a PDF notebook each downloaded and
 * parsed the whole file, and a long PDF ran out the budget before either was
 * drawn -- which is why Tutor could read nothing beside a PDF page.
 */
async function prerenderPdfBackgrounds(input: {
  uid: string;
  pages: readonly NotebookPage[];
  files: ReadonlyMap<string, NotebookFile>;
  fileCache: Map<string, Buffer>;
  pdfCache: Map<string, Buffer>;
}) {
  const wanted = new Map<string, number[]>();
  for (const page of input.pages) {
    const file = page.backgroundFileId ? input.files.get(page.backgroundFileId) : undefined;
    if (file?.fileType !== "application/pdf" || !file.storagePath.startsWith(`users/${input.uid}/`)) {
      continue;
    }
    wanted.set(file.id, [...(wanted.get(file.id) ?? []), page.pdfPageIndex ?? 0]);
  }
  await Promise.all(
    Array.from(wanted, async ([fileId, pageIndexes]) => {
      const file = input.files.get(fileId);
      if (!file) return;
      const [bytes] = await getAdminStorageBucket().file(file.storagePath).download();
      input.fileCache.set(file.id, bytes);
      const rendered = await renderPdfPages(bytes, pageIndexes);
      rendered.forEach(({ pageIndex, bytes: png }) => {
        input.pdfCache.set(`${file.id}:${pageIndex}`, png);
      });
    })
  );
}

async function renderNeighbour(input: {
  uid: string;
  page: NotebookPage;
  inkSvg: string;
  currentPageNumber: number;
  files: ReadonlyMap<string, NotebookFile>;
  fileCache: Map<string, Buffer>;
  pdfCache: Map<string, Buffer>;
}): Promise<AiContentPart[]> {
  const rendered = await renderNotebookPage({
    uid: input.uid,
    page: input.page,
    inkSvg: input.inkSvg,
    files: input.files,
    fileCache: input.fileCache,
    pdfCache: input.pdfCache,
  });
  const bytes = await sharp(rendered.bytes)
    .resize({ width: NEIGHBOUR_IMAGE_WIDTH, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return [
    {
      text: `Page ${input.page.pageNumber}, ${describePosition(
        input.page.pageNumber,
        input.currentPageNumber
      )}, as the student sees it${
        hasTypedText(input.page) ? " (its typed text is also in the page map)" : ""
      }. Read it for the question, the rest of the working, or whatever the student points you to; it is not the page they asked about unless they say so.`,
    },
    { inlineData: { mimeType: "image/jpeg", data: bytes.toString("base64") } },
  ];
}

/**
 * Pictures of other pages of the notebook, for Tutor to read: the pages either
 * side of the current one, any page the student names, and further back when
 * they say the work carries on from earlier.
 *
 * Drawn only when the student asks something, from what is already saved, and
 * never stored: the same on-demand read the current page's snapshot is.
 */
export async function loadNotebookNeighbourPageParts(input: {
  uid: string;
  notebookId: string;
  pages: readonly NotebookPage[];
  currentPageId: string;
  message: string;
}): Promise<AiContentPart[]> {
  const current = input.pages.find((page) => page.id === input.currentPageId);
  if (!current) return [];
  const byNumber = new Map(input.pages.map((page) => [page.pageNumber, page]));
  const earlierPageHasQuestion = input.pages.some(
    (page) => page.pageNumber < current.pageNumber && Boolean(page.questionPrompt)
  );
  const chosen = selectNotebookPicturedPageNumbers({
    message: input.message,
    currentPageNumber: current.pageNumber,
    availablePageNumbers: Array.from(byNumber.keys()),
    currentPageHasQuestion: Boolean(current.questionPrompt),
    earlierPageHasQuestion,
    currentPageTextLength: [current.typedContent ?? "", ...current.textBlocks.map((block) => block.text)]
      .join("")
      .trim().length,
  }).flatMap((pageNumber) => {
    const page = byNumber.get(pageNumber);
    return page ? [page] : [];
  });
  if (chosen.length === 0) return [];
  const startedAt = Date.now();
  /** Finished pages, kept as they land so a timeout still hands back the ones that made it. */
  const finished = new Map<string, AiContentPart[]>();

  const work = (async () => {
    const [inkSvgs, files] = await Promise.all([
      Promise.all(
        chosen.map((page) =>
          loadInkSvg(input.uid, page).catch((error: unknown) => {
            log.warn("neighbour_page.ink_failed", { pageNumber: page.pageNumber, error });
            return "";
          })
        )
      ),
      loadBackgroundFiles(input.uid, chosen),
    ]);
    // A page with nothing drawn and no background is already fully described by
    // its typed text in the page map; a picture of blank paper tells Tutor nothing.
    const worthDrawing = chosen.flatMap((page, index) =>
      hasDrawnInk(inkSvgs[index]) || page.backgroundFileId
        ? [{ page, inkSvg: inkSvgs[index] }]
        : []
    );
    const fileCache = new Map<string, Buffer>();
    const pdfCache = new Map<string, Buffer>();
    await prerenderPdfBackgrounds({
      uid: input.uid,
      pages: worthDrawing.map(({ page }) => page),
      files,
      fileCache,
      pdfCache,
    }).catch((error: unknown) => log.warn("neighbour_pages.pdf_failed", { error }));
    await Promise.all(
      worthDrawing.map(({ page, inkSvg }) =>
        renderNeighbour({
          uid: input.uid,
          page,
          inkSvg,
          currentPageNumber: current.pageNumber,
          files,
          fileCache,
          pdfCache,
        }).then(
          (parts) => {
            finished.set(page.id, parts);
          },
          (error: unknown) => {
            log.warn("neighbour_page.failed", { pageNumber: page.pageNumber, error });
          }
        )
      )
    );
  })();
  // Still settles after a timeout; without this its failure would go unhandled.
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      work.then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), NEIGHBOUR_PAGES_BUDGET_MS);
      }),
    ]);
    if (outcome === "timeout") {
      log.warn("neighbour_pages.timed_out", {
        budgetMs: NEIGHBOUR_PAGES_BUDGET_MS,
        finished: finished.size,
        wanted: chosen.length,
      });
    }
  } catch (error) {
    log.warn("neighbour_pages.failed", { error });
  } finally {
    if (timer) clearTimeout(timer);
  }

  // In the order chosen, so the page the student named is read first.
  const parts = chosen.flatMap((page) => finished.get(page.id) ?? []);
  log.info("neighbour_pages.completed", {
    pictured: parts.filter((part) => "inlineData" in part).length,
    latencyMs: Date.now() - startedAt,
  });
  return parts;
}
