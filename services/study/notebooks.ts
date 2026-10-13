import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/services/firebase/client";
import { deleteStorageFile } from "@/services/firebase/storage-files";
import { withTimeout } from "@/services/firebase/firestore";
import { invalidateDashboardData } from "@/services/dashboard/cache";
import {
  readThroughCache,
  type CachedReadOptions,
} from "@/services/cache/read-through";
import {
  buildNotebookPayload,
  buildNotebookFilePayload,
  mapNotebookData,
  mapNotebookFileData,
  mapNotebookPageData,
  getNotebookPagesAfterDelete,
  normalizeNotebookInkData,
  normalizeNotebookImageRefs,
  normalizeNotebookStrokeData,
  normalizeNotebookTitle,
  normalizeNotebookPreviewSvg,
  storedNotebookInkSvg,
  MAX_NOTEBOOK_IMAGE_REFS,
  MAX_NOTEBOOK_PAGE_TOPIC_IDS,
  type Notebook,
  type NotebookFile,
  type NotebookInkData,
  type NotebookImageRef,
  type NotebookPageColor,
  type NotebookPageStyle,
  type NotebookPageStatus,
  type NotebookPage,
  type NotebookPageType,
  type NotebookStrokeData,
  type NotebookTextBlock,
  type NotebookType,
} from "@/lib/workspace/notebooks";
import {
  buildNotebookPagePayload,
  prepareNotebookPageSnapshotForPersistence,
} from "@/lib/workspace/notebook-page-writes";
import {
  isNotebookInkRecordWithinLimits,
  mergeNotebookPageInk,
  splitNotebookPageForPersistence,
  type NotebookPageInkRecord,
} from "@/lib/workspace/notebook-page-ink-split";
import {
  MAX_NOTEBOOK_GRAPHS,
  normalizeNotebookGraphBlocks,
  type NotebookGraphBlock,
} from "@/lib/workspace/notebook-graphs";
import { reportTutorialAction } from "@/lib/onboarding/tutorial";

const LOAD_MS = 30_000;
const WRITE_MS = 30_000;
/** Firestore caps a batch at 500 operations. */
const PAGE_DELETE_BATCH_LIMIT = 400;

function notebooksCollection(userId: string) {
  return collection(db, "users", userId, "notebooks");
}

function notebookPagesCollection(userId: string) {
  return collection(db, "users", userId, "notebookPages");
}

function notebookFilesCollection(userId: string) {
  return collection(db, "users", userId, "notebookFiles");
}

function notebookPageInkRef(userId: string, pageId: string) {
  return doc(db, "users", userId, "notebookPageInk", pageId);
}

/** Shared by the Progress, Topics and Library pages. */
export async function getActiveNotebooks(
  userId: string,
  options: CachedReadOptions = {}
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }

  return readThroughCache(
    { collection: "notebooks:active", userId: normalizedUserId },
    () => loadActiveNotebooks(normalizedUserId),
    options
  );
}

async function loadActiveNotebooks(normalizedUserId: string) {
  const snapshot = await withTimeout(
    getDocs(
      query(
        notebooksCollection(normalizedUserId),
        where("archived", "==", false),
        orderBy("updatedAt", "desc")
      )
    ),
    LOAD_MS,
    "Load active notebooks"
  );

  return snapshot.docs.map((notebookDoc) =>
    mapNotebookData(notebookDoc.id, notebookDoc.data() as Record<string, unknown>)
  );
}

export async function getRecentActiveNotebooks(
  userId: string,
  maximum = 3
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  const safeMaximum = Math.max(1, Math.min(20, Math.floor(maximum)));
  const snapshot = await withTimeout(
    getDocs(
      query(
        notebooksCollection(normalizedUserId),
        where("archived", "==", false),
        orderBy("updatedAt", "desc"),
        limit(safeMaximum)
      )
    ),
    LOAD_MS,
    "Load recent active notebooks"
  );

  return snapshot.docs.map((notebookDoc) =>
    mapNotebookData(notebookDoc.id, notebookDoc.data() as Record<string, unknown>)
  );
}

export async function getNotebookById(
  userId: string,
  notebookId: string
): Promise<Notebook | null> {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }
  if (!normalizedNotebookId) {
    throw new Error("Missing notebookId.");
  }

  const snapshot = await withTimeout(
    getDoc(doc(db, "users", normalizedUserId, "notebooks", normalizedNotebookId)),
    LOAD_MS,
    "Load notebook"
  );

  if (!snapshot.exists()) {
    return null;
  }

  return mapNotebookData(snapshot.id, snapshot.data() as Record<string, unknown>);
}

export type NotebookFolderPageCursor = {
  updatedAt: number;
  id: string;
};

export async function getNotebooksForFolderPage(
  userId: string,
  folderId: string,
  options: { cursor?: NotebookFolderPageCursor | null; pageSize?: number } = {}
) {
  const normalizedUserId = userId.trim();
  const normalizedFolderId = folderId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }
  if (!normalizedFolderId) {
    throw new Error("Missing folderId.");
  }

  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 30));
  const constraints = [
    where("folderId", "==", normalizedFolderId),
    where("archived", "==", false),
    orderBy("updatedAt", "desc"),
    orderBy(documentId(), "desc"),
    ...(options.cursor
      ? [startAfter(options.cursor.updatedAt, options.cursor.id)]
      : []),
    limit(pageSize + 1),
  ];
  const snapshot = await withTimeout(
    getDocs(query(notebooksCollection(normalizedUserId), ...constraints)),
    LOAD_MS,
    "Load folder notebook page"
  );

  const mergedItems = snapshot.docs.map((notebookDoc) =>
    mapNotebookData(notebookDoc.id, notebookDoc.data() as Record<string, unknown>)
  );
  const items = mergedItems.slice(0, pageSize);
  const finalItem = items.at(-1);

  return {
    items,
    nextCursor:
      mergedItems.length > pageSize && finalItem
        ? { updatedAt: finalItem.updatedAt, id: finalItem.id }
        : null,
  };
}

export async function createNotebook(
  userId: string,
  input: {
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
  }
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }

  const payload = buildNotebookPayload(input);
  const docRef = await withTimeout(
    addDoc(notebooksCollection(normalizedUserId), payload),
    WRITE_MS,
    "Create notebook"
  );
  invalidateDashboardData(normalizedUserId);

  reportTutorialAction("create-notebook", {
    folderId: input.folderId,
    notebookId: docRef.id,
  });

  return mapNotebookData(docRef.id, payload);
}

export async function updateNotebook(
  userId: string,
  notebookId: string,
  input: Partial<{
    title: string;
    type: NotebookType;
    topicIds: string[];
    sourceIds: string[];
    pastPaperId: string;
    color: string;
    icon: string;
    pageColor: NotebookPageColor;
    pageStyle: NotebookPageStyle;
    uploadedFileId: string;
    previewInkSvg: string;
    previewPageId: string;
    archived: boolean;
  }>
) {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }
  if (!normalizedNotebookId) {
    throw new Error("Missing notebookId.");
  }

  const updates: Record<string, unknown> = {
    updatedAt: Date.now(),
  };

  if (input.title !== undefined) {
    const title = normalizeNotebookTitle(input.title);
    if (!title) {
      throw new Error("Notebook title is required.");
    }
    updates.title = title;
  }
  if (input.type !== undefined) updates.type = input.type;
  if (input.topicIds !== undefined) updates.topicIds = input.topicIds;
  if (input.sourceIds !== undefined) updates.sourceIds = input.sourceIds;
  if (input.pastPaperId !== undefined) {
    updates.pastPaperId = input.pastPaperId.trim().slice(0, 160) || null;
  }
  if (input.color !== undefined) updates.color = input.color.trim().slice(0, 80) || null;
  if (input.icon !== undefined) updates.icon = input.icon.trim().slice(0, 40) || null;
  if (input.pageColor !== undefined) updates.pageColor = input.pageColor;
  if (input.pageStyle !== undefined) updates.pageStyle = input.pageStyle;
  if (input.uploadedFileId !== undefined) {
    updates.uploadedFileId = input.uploadedFileId.trim().slice(0, 160) || null;
  }
  if (input.previewInkSvg !== undefined) {
    updates.previewInkSvg = normalizeNotebookPreviewSvg(input.previewInkSvg) ?? null;
  }
  if (input.previewPageId !== undefined) {
    updates.previewPageId = input.previewPageId.trim().slice(0, 160) || null;
  }
  if (typeof input.archived === "boolean") updates.archived = input.archived;

  await withTimeout(
    updateDoc(doc(db, "users", normalizedUserId, "notebooks", normalizedNotebookId), updates),
    WRITE_MS,
    "Update notebook"
  );
  invalidateDashboardData(normalizedUserId);
}

export async function getNotebookPages(
  userId: string,
  notebookId: string
): Promise<NotebookPage[]> {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }
  if (!normalizedNotebookId) {
    throw new Error("Missing notebookId.");
  }

  const snapshot = await withTimeout(
    getDocs(
      query(
        notebookPagesCollection(normalizedUserId),
        where("notebookId", "==", normalizedNotebookId)
      )
    ),
    LOAD_MS,
    "Load notebook pages"
  );

  return snapshot.docs
    .map((pageDoc) =>
      mapNotebookPageData(pageDoc.id, pageDoc.data() as Record<string, unknown>)
    )
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Fetches one page's full-fidelity ink.
 *
 * Returns null both when a page has no ink and when it still stores its ink
 * inline, since a legacy page's inline copy is the authoritative one and no
 * ink record exists for it.
 */
export async function getNotebookPageInk(
  userId: string,
  pageId: string
): Promise<NotebookPageInkRecord | null> {
  const normalizedUserId = userId.trim();
  const normalizedPageId = pageId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (!normalizedPageId) throw new Error("Missing pageId.");

  const snapshot = await withTimeout(
    getDoc(notebookPageInkRef(normalizedUserId, normalizedPageId)),
    LOAD_MS,
    "Load notebook page ink"
  );
  if (!snapshot.exists()) return null;

  const data = snapshot.data() as Record<string, unknown>;
  return {
    pageId: normalizedPageId,
    notebookId: typeof data.notebookId === "string" ? data.notebookId : "",
    inkData: normalizeNotebookInkData(data.inkData),
    strokeData: normalizeNotebookStrokeData(data.strokeData),
    contentRevision:
      typeof data.contentRevision === "number" &&
      Number.isFinite(data.contentRevision)
        ? Math.max(0, Math.round(data.contentRevision))
        : 0,
    updatedAt:
      typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
        ? data.updatedAt
        : 0,
  };
}

/**
 * Loads a page ready to edit, pulling its ink record only when the page does
 * not already carry ink inline.
 */
export async function getNotebookPageWithInk(
  userId: string,
  page: NotebookPage
): Promise<NotebookPage> {
  if (page.inkData || page.strokeData) return page;
  return mergeNotebookPageInk(page, await getNotebookPageInk(userId, page.id));
}

export async function getNextNotebookPageNumber(
  userId: string,
  notebookId: string
) {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (!normalizedNotebookId) throw new Error("Missing notebookId.");

  const snapshot = await withTimeout(
    getDocs(
      query(
        notebookPagesCollection(normalizedUserId),
        where("notebookId", "==", normalizedNotebookId),
        orderBy("pageNumber", "desc"),
        limit(1)
      )
    ),
    LOAD_MS,
    "Load final notebook page"
  );
  const finalPage = snapshot.docs[0];
  if (!finalPage) return 1;
  return (
    mapNotebookPageData(
      finalPage.id,
      finalPage.data() as Record<string, unknown>
    ).pageNumber + 1
  );
}

export async function createNotebookPage(
  userId: string,
  input: {
    notebookId: string;
    folderId: string;
    pageNumber: number;
    title?: string;
    pageType?: NotebookPageType;
    typedContent?: string;
    textBlocks?: NotebookTextBlock[];
    inkData?: NotebookInkData;
    strokeData?: NotebookStrokeData;
    pageColor?: NotebookPageColor;
    pageStyle?: NotebookPageStyle;
    status?: NotebookPageStatus;
    questionPrompt?: string;
    questionAnswer?: string;
    linkedQuestionId?: string;
    linkedSourceId?: string;
    linkedPastPaperId?: string;
    backgroundFileId?: string;
    pdfPageIndex?: number;
  }
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }

  const payload = buildNotebookPagePayload(input);
  const docRef = await withTimeout(
    addDoc(notebookPagesCollection(normalizedUserId), payload),
    WRITE_MS,
    "Create notebook page"
  );
  invalidateDashboardData(normalizedUserId);

  return mapNotebookPageData(docRef.id, payload);
}

export async function createNotebookPages(
  userId: string,
  inputs: Array<{
    notebookId: string;
    folderId: string;
    pageNumber: number;
    title?: string;
    pageType?: NotebookPageType;
    pageColor?: NotebookPageColor;
    pageStyle?: NotebookPageStyle;
    status?: NotebookPageStatus;
    questionPrompt?: string;
    questionAssets?: import("@/lib/practice/practice-papers").PracticePaperQuestionAsset[];
    linkedQuestionId?: string;
    linkedSourceId?: string;
    linkedPastPaperId?: string;
    backgroundFileId?: string;
    pdfPageIndex?: number;
  }>
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (inputs.length === 0) throw new Error("Add at least one notebook page.");
  if (inputs.length > 200) throw new Error("A PDF notebook can contain up to 200 pages.");

  const batch = writeBatch(db);
  const entries = inputs.map((input) => {
    const pageRef = doc(notebookPagesCollection(normalizedUserId));
    const payload = buildNotebookPagePayload(input);
    batch.set(pageRef, payload);
    return { id: pageRef.id, payload };
  });
  await withTimeout(batch.commit(), WRITE_MS, "Create notebook pages");
  invalidateDashboardData(normalizedUserId);
  return entries.map(({ id, payload }) => mapNotebookPageData(id, payload));
}

/**
 * Persists movable illustration placement with the same optimistic revision
 * guard as ink/text autosave, so an image drag cannot overwrite a page edited
 * on another device.
 */
export async function updateNotebookPageImages(
  userId: string,
  input: {
    notebookId: string;
    pageId: string;
    imageRefs: NotebookImageRef[];
  }
) {
  const normalizedUserId = userId.trim();
  const notebookId = input.notebookId.trim();
  const pageId = input.pageId.trim();
  if (!normalizedUserId || !notebookId || !pageId) {
    throw new Error("Missing notebook image target.");
  }
  /*
   * Images live in their own field, which an ink or text save never writes, so
   * this neither checks nor bumps the page's content revision.
   *
   * It used to do both. Every move bumped the revision, so an autosave already
   * in flight was rejected as a conflict, and a second move started before the
   * first landed was rejected too -- the image snapped back to where it began
   * and the student was told the page had changed on another device, when the
   * only other writer was themselves. The editor queues image writes, so the
   * last one asked for is the one that lands.
   */
  const imageRefs = normalizeNotebookImageRefs(input.imageRefs);
  if (
    imageRefs.length !== input.imageRefs.length ||
    imageRefs.length > MAX_NOTEBOOK_IMAGE_REFS
  ) {
    throw new Error("One of the notebook images is invalid.");
  }
  const pageRef = doc(db, "users", normalizedUserId, "notebookPages", pageId);
  const result = await withTimeout(
    runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(pageRef);
      if (!snapshot.exists()) throw new Error("This notebook page no longer exists.");
      const data = snapshot.data() as Record<string, unknown>;
      if (data.notebookId !== notebookId) {
        throw new Error("This page does not belong to the open notebook.");
      }
      const contentRevision =
        typeof data.contentRevision === "number" && Number.isFinite(data.contentRevision)
          ? Math.max(0, Math.round(data.contentRevision))
          : 0;
      const updatedAt = Date.now();
      transaction.update(pageRef, { imageRefs, updatedAt });
      return { contentRevision, updatedAt };
    }),
    WRITE_MS,
    "Move notebook illustration"
  );
  invalidateDashboardData(normalizedUserId);
  return result;
}

/**
 * Saves the graphs on a page. Like images they are a field of their own, which
 * an ink or text save never writes, so this neither checks nor bumps the page's
 * content revision; see updateNotebookPageImages for why that matters.
 */
export async function updateNotebookPageGraphs(
  userId: string,
  input: {
    notebookId: string;
    pageId: string;
    graphBlocks: NotebookGraphBlock[];
  }
) {
  const normalizedUserId = userId.trim();
  const notebookId = input.notebookId.trim();
  const pageId = input.pageId.trim();
  if (!normalizedUserId || !notebookId || !pageId) {
    throw new Error("Missing notebook graph target.");
  }
  if (input.graphBlocks.length > MAX_NOTEBOOK_GRAPHS) {
    throw new Error(`A page can hold up to ${MAX_NOTEBOOK_GRAPHS} graphs.`);
  }
  const graphBlocks = normalizeNotebookGraphBlocks(input.graphBlocks);
  if (graphBlocks.length !== input.graphBlocks.length) {
    throw new Error("One of the graphs on this page is invalid.");
  }
  const pageRef = doc(db, "users", normalizedUserId, "notebookPages", pageId);
  const result = await withTimeout(
    runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(pageRef);
      if (!snapshot.exists()) throw new Error("This notebook page no longer exists.");
      if (snapshot.data().notebookId !== notebookId) {
        throw new Error("This page does not belong to the open notebook.");
      }
      const updatedAt = Date.now();
      transaction.update(pageRef, { graphBlocks, updatedAt });
      return { updatedAt };
    }),
    WRITE_MS,
    "Save notebook graph"
  );
  invalidateDashboardData(normalizedUserId);
  return result;
}

/**
 * The student's own Topics for one page, or none to go back to the notebook's.
 *
 * Metadata like images and graphs: an ink or text save never writes it, so it
 * neither checks nor bumps the content revision. Marking this page from now on
 * counts towards these Topics; markings already made keep theirs.
 */
export async function updateNotebookPageTopics(
  userId: string,
  input: { notebookId: string; pageId: string; topicIds: readonly string[] }
) {
  const normalizedUserId = userId.trim();
  const notebookId = input.notebookId.trim();
  const pageId = input.pageId.trim();
  if (!normalizedUserId || !notebookId || !pageId) throw new Error("Missing notebook page.");
  const topicIds = Array.from(new Set(input.topicIds.map((id) => id.trim()).filter(Boolean)));
  if (topicIds.length > MAX_NOTEBOOK_PAGE_TOPIC_IDS) {
    throw new Error(`A page can be about up to ${MAX_NOTEBOOK_PAGE_TOPIC_IDS} topics.`);
  }
  const pageRef = doc(db, "users", normalizedUserId, "notebookPages", pageId);
  await withTimeout(
    runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(pageRef);
      if (!snapshot.exists()) throw new Error("This notebook page no longer exists.");
      if (snapshot.data().notebookId !== notebookId) {
        throw new Error("This page does not belong to the open notebook.");
      }
      transaction.update(pageRef, { topicIds, updatedAt: Date.now() });
    }),
    WRITE_MS,
    "Save page topics"
  );
  invalidateDashboardData(normalizedUserId);
  return topicIds;
}

export async function saveNotebookPageSnapshot(
  userId: string,
  input: {
    notebookId: string;
    pageId: string;
    typedContent: string;
    textBlocks: NotebookTextBlock[];
    inkData: NotebookInkData;
    pageColor: NotebookPageColor;
    pageStyle: NotebookPageStyle;
    status: NotebookPageStatus;
  }
) {
  const normalizedUserId = userId.trim();
  const notebookId = input.notebookId.trim();
  const pageId = input.pageId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (!notebookId) throw new Error("Missing notebookId.");
  if (!pageId) throw new Error("Missing pageId.");

  const snapshot = prepareNotebookPageSnapshotForPersistence(input);
  const inkData = snapshot.inkData;
  if (!inkData) throw new Error("This page has no drawing snapshot to save.");
  const pageRef = doc(db, "users", normalizedUserId, "notebookPages", pageId);
  const notebookRef = doc(db, "users", normalizedUserId, "notebooks", notebookId);

  const result = await withTimeout(
    runTransaction(db, async (transaction) => {
      const pageDocument = await transaction.get(pageRef);
      if (!pageDocument.exists()) throw new Error("This notebook page no longer exists.");
      const pageData = pageDocument.data() as Record<string, unknown>;
      if (pageData.notebookId !== notebookId) {
        throw new Error("This page does not belong to the open notebook.");
      }
      const remoteRevision =
        typeof pageData.contentRevision === "number" &&
        Number.isFinite(pageData.contentRevision) &&
        pageData.contentRevision >= 0
          ? Math.round(pageData.contentRevision)
          : 0;
      /*
       * The last save wins, from whichever device made it. A notebook belongs
       * to one student, and they work on one device at a time, so a page that
       * moved on since this device last saw it was moved by them -- refusing
       * the save only stranded their latest work behind a conflict prompt.
       * The revision still advances, so a reader can tell the page changed.
       */

      const now = Date.now();
      const contentRevision = remoteRevision + 1;
      const { thumbnail, ink } = splitNotebookPageForPersistence({
        pageId,
        notebookId,
        inkData,
        contentRevision,
        updatedAt: now,
      });
      if (ink && !isNotebookInkRecordWithinLimits(ink)) {
        throw new Error("This page has too much ink to sync safely.");
      }

      // Page and ink move together. A page record claiming a revision whose
      // ink never landed would open as blank work, so the two writes must
      // succeed or fail as one.
      transaction.update(pageRef, {
        typedContent: snapshot.typedContent.trim() || null,
        textBlocks: snapshot.textBlocks,
        // Ink now lives in its own record. Clearing the inline copy is what
        // converts a legacy page, and it happens only once the ink write below
        // is part of the same committed transaction.
        inkData: null,
        strokeData: null,
        thumbnail,
        pageColor: snapshot.pageColor,
        pageStyle: snapshot.pageStyle,
        status: snapshot.status,
        contentRevision,
        updatedAt: now,
      });
      if (ink) {
        transaction.set(notebookPageInkRef(normalizedUserId, pageId), ink);
      } else {
        transaction.delete(notebookPageInkRef(normalizedUserId, pageId));
      }
      transaction.update(notebookRef, {
        previewInkSvg: normalizeNotebookPreviewSvg(storedNotebookInkSvg(inkData)) ?? null,
        previewPageId: pageId,
        updatedAt: now,
      });
      return { contentRevision, updatedAt: now };
    }),
    WRITE_MS,
    "Save notebook page"
  );
  invalidateDashboardData(normalizedUserId);
  const hasSavedWork =
    Boolean(snapshot.typedContent.trim()) ||
    snapshot.textBlocks.length > 0 ||
    Boolean(storedNotebookInkSvg(snapshot.inkData)?.trim() ?? snapshot.inkData) ||
    snapshot.status !== "blank";
  if (hasSavedWork) {
    reportTutorialAction("save-work", { notebookId });
  }
  return result;
}

export async function deleteNotebookPage(
  userId: string,
  notebookId: string,
  pageId: string
): Promise<NotebookPage[]> {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  const normalizedPageId = pageId.trim();
  if (!normalizedUserId) {
    throw new Error("Missing userId.");
  }
  if (!normalizedNotebookId) {
    throw new Error("Missing notebookId.");
  }
  if (!normalizedPageId) {
    throw new Error("Missing pageId.");
  }

  const pages = await getNotebookPages(normalizedUserId, normalizedNotebookId);
  const pageToDelete = pages.find((page) => page.id === normalizedPageId);
  if (!pageToDelete) {
    throw new Error("Page not found.");
  }
  if (pages.length <= 1) {
    throw new Error("A notebook needs at least one page.");
  }

  const nextPages = getNotebookPagesAfterDelete(pages, normalizedPageId);
  const now = Date.now();
  const batch = writeBatch(db);

  batch.delete(doc(db, "users", normalizedUserId, "notebookPages", normalizedPageId));
  // Deleting the page without its ink record would orphan the ink, which no
  // later read could reach or clean up.
  batch.delete(notebookPageInkRef(normalizedUserId, normalizedPageId));
  for (const page of nextPages) {
    const previous = pages.find((candidate) => candidate.id === page.id);
    if (!previous) continue;
    const updates: Record<string, unknown> = { updatedAt: now };
    if (previous.pageNumber !== page.pageNumber) updates.pageNumber = page.pageNumber;
    if (previous.title !== page.title) updates.title = page.title ?? null;
    batch.update(doc(db, "users", normalizedUserId, "notebookPages", page.id), updates);
  }
  batch.update(doc(db, "users", normalizedUserId, "notebooks", normalizedNotebookId), {
    updatedAt: now,
  });

  await withTimeout(batch.commit(), WRITE_MS, "Delete notebook page");
  await Promise.allSettled(
    pageToDelete.imageRefs.flatMap((image) =>
      image.storagePath ? [deleteStorageFile(image.storagePath)] : []
    )
  );
  invalidateDashboardData(normalizedUserId);

  return nextPages.map((page) => ({ ...page, updatedAt: now }));
}

export async function getNotebookFiles(
  userId: string,
  notebookId: string
): Promise<NotebookFile[]> {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (!normalizedNotebookId) throw new Error("Missing notebookId.");

  const snapshot = await withTimeout(
    getDocs(
      query(
        notebookFilesCollection(normalizedUserId),
        where("notebookId", "==", normalizedNotebookId)
      )
    ),
    LOAD_MS,
    "Load notebook files"
  );

  return snapshot.docs
    .map((fileDoc) =>
      mapNotebookFileData(fileDoc.id, fileDoc.data() as Record<string, unknown>)
    )
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export async function createNotebookFileMetadata(
  userId: string,
  input: {
    notebookId: string;
    folderId: string;
    fileName: string;
    fileType: string;
    storagePath: string;
    sizeBytes?: number;
    pageCount?: number;
  }
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");

  const payload = buildNotebookFilePayload(input);
  const docRef = await withTimeout(
    addDoc(notebookFilesCollection(normalizedUserId), payload),
    WRITE_MS,
    "Create notebook file metadata"
  );
  invalidateDashboardData(normalizedUserId);

  return mapNotebookFileData(docRef.id, payload);
}

export async function deleteNotebookImportRecords(
  userId: string,
  notebookId: string
) {
  const normalizedUserId = userId.trim();
  const normalizedNotebookId = notebookId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (!normalizedNotebookId) throw new Error("Missing notebookId.");

  const [pagesSnapshot, filesSnapshot] = await Promise.all([
    getDocs(
      query(
        notebookPagesCollection(normalizedUserId),
        where("notebookId", "==", normalizedNotebookId)
      )
    ),
    getDocs(
      query(
        notebookFilesCollection(normalizedUserId),
        where("notebookId", "==", normalizedNotebookId)
      )
    ),
  ]);
  const batch = writeBatch(db);
  pagesSnapshot.docs.forEach((pageDoc) => batch.delete(pageDoc.ref));
  filesSnapshot.docs.forEach((fileDoc) => batch.delete(fileDoc.ref));
  batch.delete(
    doc(db, "users", normalizedUserId, "notebooks", normalizedNotebookId)
  );
  await withTimeout(batch.commit(), WRITE_MS, "Clean up notebook import");
  invalidateDashboardData(normalizedUserId);
}

export async function deleteNotebookRecord(userId: string, notebookId: string) {
  await withTimeout(
    deleteDoc(doc(db, "users", userId, "notebooks", notebookId)),
    WRITE_MS,
    "Delete notebook"
  );
  invalidateDashboardData(userId);
}

export async function deleteNotebookFileRecord(userId: string, fileId: string) {
  const normalizedUserId = userId.trim();
  const normalizedFileId = fileId.trim();
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (!normalizedFileId) throw new Error("Missing fileId.");

  await withTimeout(
    deleteDoc(doc(db, "users", normalizedUserId, "notebookFiles", normalizedFileId)),
    WRITE_MS,
    "Delete notebook file metadata"
  );
  invalidateDashboardData(normalizedUserId);
}

export async function deleteNotebookPageRecords(
  userId: string,
  pageIds: string[]
) {
  const normalizedUserId = userId.trim();
  const normalizedPageIds = pageIds.map((id) => id.trim()).filter(Boolean);
  if (!normalizedUserId) throw new Error("Missing userId.");
  if (normalizedPageIds.length === 0) return;

  // Each page costs two deletes now that ink is a separate record, and a batch
  // is capped at 500 operations, so chunk rather than assuming a notebook is
  // small enough to fit.
  const pagesPerBatch = Math.floor(PAGE_DELETE_BATCH_LIMIT / 2);
  for (let start = 0; start < normalizedPageIds.length; start += pagesPerBatch) {
    const batch = writeBatch(db);
    for (const pageId of normalizedPageIds.slice(start, start + pagesPerBatch)) {
      batch.delete(doc(db, "users", normalizedUserId, "notebookPages", pageId));
      batch.delete(notebookPageInkRef(normalizedUserId, pageId));
    }
    await withTimeout(batch.commit(), WRITE_MS, "Clean up notebook pages");
  }
  invalidateDashboardData(normalizedUserId);
}
