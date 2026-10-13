import "server-only";

import { featureFlags } from "@/lib/app/feature-flags";
import { materialConcepts } from "@/lib/learning/actions/material-action";
import type { NotebookLearningView } from "@/lib/learning/notebook-page-context";
import { createLogger } from "@/lib/observability/logger";
import { mapNotebookData, mapNotebookPageData } from "@/lib/workspace/notebooks";
import { getAdminDb } from "@/services/firebase/admin";
import { loadLearnerProfile } from "@/services/learning/learner-profile.server";
import { loadLinkedQuestions } from "@/services/learning/notebook-page-learning.server";

const log = createLogger({ module: "learning.notebook_view" });

/**
 * How long the notebook waits for the profile before going without it. Its
 * pages are still placed; only the engine's starting points are missing.
 */
const PROFILE_BUDGET_MS = 3_000;
/** A PDF notebook's page limit; more pages than any notebook can hold. */
const PAGE_LIMIT = 200;

/**
 * Where every page of one notebook sits in the Learning Engine, for its Tutor.
 *
 * The engine's view belongs to the folder, so it is read once per notebook
 * rather than once per page: the browser places each page from this with the
 * same resolver the server places markings with. Only link fields and Topics
 * are read from the pages, never their content. Read only when the student
 * opens Tutor in the notebook.
 */
export async function loadNotebookLearningView(input: {
  uid: string;
  notebookId: string;
}): Promise<NotebookLearningView | null> {
  const startedAt = Date.now();
  const db = getAdminDb();
  const userRef = db.collection("users").doc(input.uid);
  const [notebookSnapshot, pagesSnapshot] = await Promise.all([
    userRef.collection("notebooks").doc(input.notebookId).get(),
    userRef
      .collection("notebookPages")
      .where("notebookId", "==", input.notebookId)
      .select("notebookId", "linkedQuestionId", "linkedPastPaperId", "linkedExamSessionId")
      .limit(PAGE_LIMIT)
      .get(),
  ]);
  if (!notebookSnapshot.exists) return null;
  const notebook = mapNotebookData(notebookSnapshot.id, notebookSnapshot.data() ?? {});
  const pages = pagesSnapshot.docs
    .map((page) => mapNotebookPageData(page.id, page.data() as Record<string, unknown>))
    .filter((page) => page.notebookId === notebook.id);

  /*
   * The profile starts now, beside the linked questions rather than after
   * them: it is the slow part, and it needs nothing they say.
   */
  const profileLoading =
    featureFlags.enableLearnerProfile && notebook.folderId
      ? loadLearnerProfile({ uid: input.uid, folderId: notebook.folderId })
      : Promise.resolve(null);
  profileLoading.catch(() => undefined);
  const linkedQuestions = await loadLinkedQuestions({ db, uid: input.uid, notebook, pages }).catch(
    (error: unknown) => {
      log.warn("linked_questions.unavailable", { error });
      return {};
    }
  );
  const linkedKeys = new Set(
    Object.values(linkedQuestions).flatMap((question) => question.specificationIds.map((id) => `spec:${id}`))
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: "included" | "no_profile" | "timed_out" | "failed" = "no_profile";
  let concepts: NotebookLearningView["concepts"] = {};
  try {
    const profile = await Promise.race([
      profileLoading,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PROFILE_BUDGET_MS);
      }),
    ]);
    if (profile === "timeout") {
      outcome = "timed_out";
    } else if (profile) {
      outcome = "included";
      // Every student Topic, since a page can be given any of them, and the specification
      // concepts this notebook's questions were written for.
      concepts = materialConcepts(profile, (key) => key.startsWith("topic:") || linkedKeys.has(key));
    }
  } catch (error) {
    outcome = "failed";
    log.warn("learner_profile.failed", { consumer: "notebook", error });
  } finally {
    if (timer) clearTimeout(timer);
  }

  log.info("notebook_view.completed", {
    outcome,
    latencyMs: Date.now() - startedAt,
    pages: pages.length,
    linkedPages: Object.keys(linkedQuestions).length,
    concepts: Object.keys(concepts).length,
    withActions: Object.values(concepts).filter((concept) => concept.action).length,
  });
  return { notebookTopicIds: notebook.topicIds, linkedQuestions, concepts };
}
