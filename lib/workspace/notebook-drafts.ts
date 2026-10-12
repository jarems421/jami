import { isInkDocumentText } from "@/lib/ink/codec";
import {
  isNotebookPageColor,
  isNotebookPageStatus,
  isNotebookPageStyle,
  normalizeNotebookTextBlocks,
  type NotebookInkData,
  type NotebookPage,
  type NotebookPageColor,
  type NotebookPageStatus,
  type NotebookPageStyle,
  type NotebookTextBlock,
} from "@/lib/workspace/notebooks";

const NOTEBOOK_DRAFT_DB_NAME = "jami-notebook-drafts";
const NOTEBOOK_DRAFT_STORE_NAME = "page-drafts";
const NOTEBOOK_DRAFT_STORAGE_PREFIX = "jami:notebook-draft:v1:";
const MAX_NOTEBOOK_LOCAL_INK_LENGTH = 5_000_000;
const MAX_NOTEBOOK_LOCAL_DRAFT_LENGTH = 6_000_000;

export const NOTEBOOK_DRAFT_VERSION = 1;
export const NOTEBOOK_DRAFT_IDLE_MS = 350;

export type NotebookPageDraft = {
  version: typeof NOTEBOOK_DRAFT_VERSION;
  userId: string;
  notebookId: string;
  pageId: string;
  baseContentRevision: number;
  remoteUpdatedAt: number;
  localRevision: number;
  savedAt: number;
  textBlocks: NotebookTextBlock[];
  ink: NotebookInkData;
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  status: NotebookPageStatus;
};

/**
 * A draft as it is kept on the device: the ink's SVG as `inkSvg`, where every
 * build before Jami Ink reads it, and Jami Ink's encoding of the same page
 * beside it as `jamiInk` -- or alone, for a page too big to carry both.
 */
type StoredNotebookPageDraft = Omit<NotebookPageDraft, "ink"> & {
  inkSvg?: string;
  jamiInk?: string;
};

export function storedNotebookPageDraft(draft: NotebookPageDraft): StoredNotebookPageDraft {
  const { ink, ...rest } = draft;
  if (ink.format === "jami-ink") return { ...rest, jamiInk: ink.data };
  return { ...rest, inkSvg: ink.svg, ...(ink.jamiInk ? { jamiInk: ink.jamiInk } : {}) };
}

/** The ink a stored draft carries, or null if what it carries is not ink. */
function storedDraftInk(svg: unknown, jamiInk: unknown): NotebookInkData | null {
  const encoded =
    isInkDocumentText(jamiInk) && jamiInk.length <= MAX_NOTEBOOK_LOCAL_INK_LENGTH ? jamiInk : undefined;
  if (svg === undefined) return encoded ? { version: 3, format: "jami-ink", data: encoded } : null;
  if (
    typeof svg !== "string" ||
    svg.length > MAX_NOTEBOOK_LOCAL_INK_LENGTH ||
    !svg.trimStart().startsWith("<svg")
  ) {
    return null;
  }
  return { version: 2, format: "js-draw-svg", svg, ...(encoded ? { jamiInk: encoded } : {}) };
}

export type NotebookDraftDecision = "restore" | "discard";

function normalizeIdentifier(value: unknown) {
  return typeof value === "string" && value.trim() && value.length <= 200
    ? value.trim()
    : null;
}

function normalizeRevision(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export function getNotebookPageDraftKey(input: {
  userId: string;
  notebookId: string;
  pageId: string;
}) {
  return `${input.userId.trim()}:${input.notebookId.trim()}:${input.pageId.trim()}`;
}

function getNotebookPageDraftStorageKey(input: {
  userId: string;
  notebookId: string;
  pageId: string;
}) {
  return `${NOTEBOOK_DRAFT_STORAGE_PREFIX}${getNotebookPageDraftKey(input)}`;
}

export function parseNotebookPageDraft(value: unknown): NotebookPageDraft | null {
  let candidate = value;
  if (typeof candidate === "string") {
    if (candidate.length > MAX_NOTEBOOK_LOCAL_DRAFT_LENGTH) return null;
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      // Corrupt or partial recovery JSON is treated as an unusable draft.
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const draft = candidate as Record<string, unknown>;
  const userId = normalizeIdentifier(draft.userId);
  const notebookId = normalizeIdentifier(draft.notebookId);
  const pageId = normalizeIdentifier(draft.pageId);
  const baseContentRevision = normalizeRevision(draft.baseContentRevision);
  const remoteUpdatedAt = normalizeRevision(draft.remoteUpdatedAt);
  const localRevision = normalizeRevision(draft.localRevision);
  const savedAt = normalizeRevision(draft.savedAt);
  const textBlocks = normalizeNotebookTextBlocks(draft.textBlocks);
  const ink = storedDraftInk(draft.inkSvg, draft.jamiInk);

  if (
    draft.version !== NOTEBOOK_DRAFT_VERSION ||
    !userId ||
    !notebookId ||
    !pageId ||
    baseContentRevision === null ||
    remoteUpdatedAt === null ||
    localRevision === null ||
    savedAt === null ||
    !Array.isArray(draft.textBlocks) ||
    textBlocks.length !== draft.textBlocks.length ||
    !ink ||
    !isNotebookPageColor(draft.pageColor) ||
    !isNotebookPageStyle(draft.pageStyle) ||
    !isNotebookPageStatus(draft.status)
  ) {
    return null;
  }

  return {
    version: NOTEBOOK_DRAFT_VERSION,
    userId,
    notebookId,
    pageId,
    baseContentRevision,
    remoteUpdatedAt,
    localRevision,
    savedAt,
    textBlocks,
    ink,
    pageColor: draft.pageColor,
    pageStyle: draft.pageStyle,
    status: draft.status,
  };
}

export function createNotebookPageDraft(
  input: Omit<NotebookPageDraft, "version" | "savedAt"> & { savedAt?: number }
) {
  // Checked as it will be stored, so a draft that could not be read back is never written.
  const draft = parseNotebookPageDraft(
    storedNotebookPageDraft({
      ...input,
      version: NOTEBOOK_DRAFT_VERSION,
      savedAt: input.savedAt ?? Date.now(),
    })
  );
  if (!draft) throw new Error("The notebook recovery draft could not be prepared.");
  return draft;
}

/**
 * Whether this device's unsaved copy of a page should come back.
 *
 * The most recent version wins, wherever it was made: the recovery copy if it
 * was written after the synced page last changed, the synced page otherwise.
 * There is no third answer. Asking the student to choose assumed two people
 * editing one page at once, and a notebook has one owner working on one device
 * at a time -- so the prompt only ever stood between them and their own latest
 * work.
 */
export function getNotebookDraftDecision(
  draft: NotebookPageDraft,
  page: Pick<NotebookPage, "id" | "notebookId" | "updatedAt">
): NotebookDraftDecision {
  if (
    draft.pageId !== page.id ||
    draft.notebookId !== page.notebookId ||
    draft.localRevision <= 0
  ) {
    return "discard";
  }
  return draft.savedAt > page.updatedAt ? "restore" : "discard";
}

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(NOTEBOOK_DRAFT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTEBOOK_DRAFT_STORE_NAME)) {
        request.result.createObjectStore(NOTEBOOK_DRAFT_STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open notebook drafts."));
    request.onblocked = () => reject(new Error("Notebook draft storage is blocked."));
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Notebook draft storage failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Notebook draft storage was cancelled."));
  });
}

async function readIndexedDbDraft(key: string) {
  const database = await openDraftDatabase();
  try {
    const transaction = database.transaction(NOTEBOOK_DRAFT_STORE_NAME, "readonly");
    const request = transaction.objectStore(NOTEBOOK_DRAFT_STORE_NAME).get(key);
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not read notebook draft."));
    });
    await waitForTransaction(transaction);
    return parseNotebookPageDraft(value);
  } finally {
    database.close();
  }
}

async function writeIndexedDbDraft(key: string, draft: NotebookPageDraft) {
  const database = await openDraftDatabase();
  try {
    const transaction = database.transaction(NOTEBOOK_DRAFT_STORE_NAME, "readwrite");
    transaction.objectStore(NOTEBOOK_DRAFT_STORE_NAME).put(storedNotebookPageDraft(draft), key);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

async function deleteIndexedDbDraft(key: string, maxLocalRevision: number) {
  const database = await openDraftDatabase();
  try {
    const transaction = database.transaction(NOTEBOOK_DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(NOTEBOOK_DRAFT_STORE_NAME);
    const request = store.get(key);
    const current = await new Promise<NotebookPageDraft | null>((resolve, reject) => {
      request.onsuccess = () => resolve(parseNotebookPageDraft(request.result));
      request.onerror = () => reject(request.error ?? new Error("Could not read notebook draft."));
    });
    if (!current || current.localRevision <= maxLocalRevision) store.delete(key);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

function readLocalStorageDraft(storageKey: string) {
  if (typeof window === "undefined") return null;
  try {
    return parseNotebookPageDraft(window.localStorage.getItem(storageKey));
  } catch {
    // IndexedDB remains available when localStorage is blocked or corrupted.
    return null;
  }
}

export function writeNotebookPageDraftSync(draft: NotebookPageDraft) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      getNotebookPageDraftStorageKey(draft),
      JSON.stringify(storedNotebookPageDraft(draft))
    );
    return true;
  } catch {
    // The asynchronous IndexedDB copy is the primary recovery store.
    return false;
  }
}

const storageOperations = new Map<string, Promise<void>>();

function enqueueStorageOperation(key: string, operation: () => Promise<void>) {
  const previous = storageOperations.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      // A failed operation must not prevent a later recovery write or cleanup.
    })
    .then(operation)
    .finally(() => {
      if (storageOperations.get(key) === next) storageOperations.delete(key);
    });
  storageOperations.set(key, next);
  return next;
}

export async function writeNotebookPageDraft(draft: NotebookPageDraft) {
  const key = getNotebookPageDraftKey(draft);
  return enqueueStorageOperation(key, async () => {
    const localStorageSaved = writeNotebookPageDraftSync(draft);
    let indexedDbSaved = false;
    try {
      await writeIndexedDbDraft(key, draft);
      indexedDbSaved = true;
    } catch {
      // Safari private browsing and low-storage conditions can disable one
      // store while leaving the synchronous emergency copy available.
    }
    if (!localStorageSaved && !indexedDbSaved) {
      throw new Error("This device could not store a recovery copy of the page.");
    }
  });
}

export async function readNotebookPageDraft(input: {
  userId: string;
  notebookId: string;
  pageId: string;
}) {
  const key = getNotebookPageDraftKey(input);
  const storageKey = getNotebookPageDraftStorageKey(input);
  const localDraft = readLocalStorageDraft(storageKey);
  let indexedDbDraft: NotebookPageDraft | null = null;
  try {
    indexedDbDraft = await readIndexedDbDraft(key);
  } catch {
    // The localStorage emergency copy remains usable when IndexedDB is not.
  }
  if (!localDraft) return indexedDbDraft;
  if (!indexedDbDraft) return localDraft;
  if (localDraft.savedAt !== indexedDbDraft.savedAt) {
    return localDraft.savedAt > indexedDbDraft.savedAt
      ? localDraft
      : indexedDbDraft;
  }
  return localDraft.localRevision >= indexedDbDraft.localRevision
    ? localDraft
    : indexedDbDraft;
}

export async function deleteNotebookPageDraft(
  input: { userId: string; notebookId: string; pageId: string },
  maxLocalRevision = Number.POSITIVE_INFINITY
) {
  const key = getNotebookPageDraftKey(input);
  const storageKey = getNotebookPageDraftStorageKey(input);
  return enqueueStorageOperation(key, async () => {
    if (typeof window !== "undefined") {
      try {
        const current = readLocalStorageDraft(storageKey);
        if (!current || current.localRevision <= maxLocalRevision) {
          window.localStorage.removeItem(storageKey);
        }
      } catch {
        // Best-effort cleanup only; a stale recovery copy is safer than loss.
      }
    }
    try {
      await deleteIndexedDbDraft(key, maxLocalRevision);
    } catch {
      // See localStorage cleanup above.
    }
  });
}
