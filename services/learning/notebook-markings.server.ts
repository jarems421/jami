import "server-only";

import {
  NOTEBOOK_MARKINGS_COLLECTION,
  buildNotebookMarkingWrite,
  decodeNotebookMarking,
  notebookMarkingId,
  readNotebookMarking,
  toNotebookMarkedWorking,
  type NotebookMarkingRejection,
} from "@/lib/learning/events/notebook-marking";
import type { NotebookPageLearningContext } from "@/lib/learning/notebook-page-context";
import type { NotebookMarkedWorking } from "@/lib/learning/profile/notebook-signals";
import { createLogger } from "@/lib/observability/logger";
import { getAdminDb } from "@/services/firebase/admin";

const log = createLogger({ route: "learning.notebook_markings" });

/** Bounded like every other profile read; a term's worth of marked pages. */
export const NOTEBOOK_MARKING_LIMIT = 120;

export type RecordNotebookMarkingOutcome =
  | { recorded: true }
  | { recorded: false; reason: NotebookMarkingRejection };

/**
 * Store Tutor's verdict on a page, if it is actually a verdict.
 *
 * Written through the Admin SDK because the rules refuse client writes: a
 * student who could write their own marks could write their own evidence.
 *
 * Rejections are logged with their reason and nothing else. A marker failing
 * the same way on every page needs to be visible, and it looks identical to a
 * marker nobody uses unless the reason is recorded.
 */
export async function recordNotebookMarking(input: {
  uid: string;
  notebookId: string;
  pageId: string;
  /** Where the page sits, from `loadNotebookPageLearningContext`. */
  learning: NotebookPageLearningContext;
  verdict: unknown;
  markedAt?: number;
}): Promise<RecordNotebookMarkingOutcome> {
  const now = input.markedAt ?? Date.now();
  const result = readNotebookMarking({
    verdict: input.verdict,
    notebookId: input.notebookId,
    pageId: input.pageId,
    learning: input.learning,
    markedAt: now,
  });
  if (!result.ok) {
    log.warn("marking.rejected", { reason: result.reason });
    return { recorded: false, reason: result.reason };
  }

  const id = notebookMarkingId({ notebookId: input.notebookId, pageId: input.pageId });
  const uid = input.uid.trim();
  if (!id || !uid) return { recorded: false, reason: "malformed" };

  await getAdminDb()
    .collection("users")
    .doc(uid)
    .collection(NOTEBOOK_MARKINGS_COLLECTION)
    .doc(id)
    // Re-marking a page replaces its verdict: one page, one piece of evidence.
    .set(buildNotebookMarkingWrite(result.marking, Date.now()));
  return { recorded: true };
}

/**
 * A student's marked notebook working, for the learner profile.
 *
 * Returns the shape the profile already reads. A failure here costs notebook
 * evidence and nothing else -- the profile is built from whatever sources
 * answered, as it is for every other source.
 */
export async function loadNotebookMarkings(input: {
  uid: string;
  notebookIds?: readonly string[];
}): Promise<NotebookMarkedWorking[]> {
  const uid = input.uid.trim();
  if (!uid) return [];
  try {
    const snapshot = await getAdminDb()
      .collection("users")
      .doc(uid)
      .collection(NOTEBOOK_MARKINGS_COLLECTION)
      .orderBy("markedAt", "desc")
      .limit(NOTEBOOK_MARKING_LIMIT)
      .get();
    const allowed = input.notebookIds ? new Set(input.notebookIds) : null;
    return snapshot.docs.flatMap((document) => {
      const marking = decodeNotebookMarking(
        document.id,
        document.data() as Record<string, unknown>
      );
      if (!marking) return [];
      if (allowed && !allowed.has(marking.notebookId)) return [];
      return [toNotebookMarkedWorking(marking)];
    });
  } catch (error) {
    log.warn("markings.unavailable", { error });
    return [];
  }
}
