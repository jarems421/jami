import type { MaterialAction, MaterialActionKind } from "@/lib/learning/actions/material-action";
import type {
  NotebookPageAttribution,
  NotebookPageLearningView,
} from "@/lib/learning/notebook-page-context";
import { auth } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";

/**
 * The open notebook page's place in the Learning Engine, for its Tutor.
 *
 * Asked for only when Tutor is open on a page, and kept for a few minutes per
 * page: turning back to a page should not ask again, and the engine's view of
 * a page does not change while the student is reading it.
 */

const CACHE_MS = 3 * 60_000;
const LOAD_MS = 6_000;

const cache = new Map<string, { storedAt: number; value: NotebookPageLearningView }>();

const ATTRIBUTIONS: readonly NotebookPageAttribution[] = [
  "linked-question",
  "page-topics",
  "notebook-topics",
  "none",
];
const ACTION_KINDS: readonly MaterialActionKind[] = [
  "quick-check",
  "teach",
  "exam-question",
  "recall",
  "harder",
];

function readAction(value: unknown): MaterialAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = ACTION_KINDS.find((candidate) => candidate === record.kind);
  if (!kind || typeof record.topicKey !== "string" || typeof record.label !== "string") return undefined;
  return { kind, topicKey: record.topicKey, label: record.label };
}

function readView(body: unknown): NotebookPageLearningView | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const attribution = ATTRIBUTIONS.find((candidate) => candidate === record.attribution);
  if (!attribution) return null;
  const concepts = Array.isArray(record.concepts)
    ? record.concepts.flatMap((entry): NotebookPageLearningView["concepts"] => {
        const concept = entry as Record<string, unknown> | null;
        if (typeof concept?.key !== "string") return [];
        return [
          typeof concept.label === "string" ? { key: concept.key, label: concept.label } : { key: concept.key },
        ];
      })
    : [];
  const action = readAction(record.action);
  return { attribution, concepts, ...(action ? { action } : {}) };
}

function cacheKey(uid: string, notebookId: string, pageId: string) {
  return `${uid}:${notebookId}:${pageId}`;
}

/** Forget a page's view, after the student changes what the page is about. */
export function forgetNotebookPageLearningView(notebookId: string, pageId: string) {
  const uid = auth.currentUser?.uid;
  if (uid) cache.delete(cacheKey(uid, notebookId, pageId));
}

/** The page's view, or null when it cannot be had; the notebook works the same without it. */
export async function loadNotebookPageLearningView(
  notebookId: string,
  pageId: string
): Promise<NotebookPageLearningView | null> {
  const user = auth.currentUser;
  if (!user) return null;
  const key = cacheKey(user.uid, notebookId, pageId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.storedAt < CACHE_MS) return cached.value;
  try {
    const search = new URLSearchParams({ notebookId, pageId });
    const response = await withTimeout(
      fetch(`/api/learning/notebook-page?${search.toString()}`, {
        headers: { Authorization: `Bearer ${await user.getIdToken()}` },
      }),
      LOAD_MS,
      "Load page learning view"
    );
    if (!response.ok) return null;
    const value = readView(await response.json().catch(() => null));
    if (value) cache.set(key, { storedAt: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}
