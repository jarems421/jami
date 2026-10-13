import "server-only";

import { featureFlags } from "@/lib/app/feature-flags";
import { materialActionFor } from "@/lib/learning/actions/material-action";
import type { NotebookPageLearningView } from "@/lib/learning/notebook-page-context";
import { createLogger } from "@/lib/observability/logger";
import { mapNotebookData, mapNotebookPageData } from "@/lib/workspace/notebooks";
import { getAdminDb } from "@/services/firebase/admin";
import { loadLearnerProfile } from "@/services/learning/learner-profile.server";
import { loadNotebookPageLearningContext } from "@/services/learning/notebook-page-learning.server";

const log = createLogger({ module: "learning.notebook_page_view" });

/**
 * How long the notebook waits for the profile before showing the page's
 * ordinary starting points. They work without it; the profile only chooses
 * a better third one.
 */
const PROFILE_BUDGET_MS = 3_000;

/**
 * The open page's place in the Learning Engine, for the notebook's Tutor.
 *
 * The page is placed by the same resolver that places its markings, and the
 * starting point is read from the engine's own decision -- the profile is
 * never asked anything here it does not already hold. Read only when the
 * student opens Tutor on a page, never in the background.
 */
export async function loadNotebookPageLearningView(input: {
  uid: string;
  notebookId: string;
  pageId: string;
}): Promise<NotebookPageLearningView | null> {
  const db = getAdminDb();
  const userRef = db.collection("users").doc(input.uid);
  const [notebookSnapshot, pageSnapshot] = await Promise.all([
    userRef.collection("notebooks").doc(input.notebookId).get(),
    userRef.collection("notebookPages").doc(input.pageId).get(),
  ]);
  if (!notebookSnapshot.exists || !pageSnapshot.exists) return null;
  const notebook = mapNotebookData(notebookSnapshot.id, notebookSnapshot.data() ?? {});
  const page = mapNotebookPageData(pageSnapshot.id, pageSnapshot.data() ?? {});
  if (page.notebookId !== notebook.id) return null;

  const learning = await loadNotebookPageLearningContext({ db, uid: input.uid, notebook, page });
  const unnamed: NotebookPageLearningView = {
    attribution: learning.attribution,
    concepts: learning.conceptKeys.map((key) => ({ key })),
  };
  if (!featureFlags.enableLearnerProfile || !notebook.folderId || learning.conceptKeys.length === 0) {
    return unnamed;
  }

  const loading = loadLearnerProfile({ uid: input.uid, folderId: notebook.folderId });
  loading.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const profile = await Promise.race([
      loading,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PROFILE_BUDGET_MS);
      }),
    ]);
    if (profile === "timeout" || !profile) {
      if (profile === "timeout") log.warn("learner_profile.timed_out", { consumer: "notebook_page" });
      return unnamed;
    }
    const labels = new Map(profile.topics.map((topic) => [topic.topicKey, topic.label]));
    const action = materialActionFor(profile, learning.conceptKeys);
    log.info("notebook_page.view", {
      attribution: learning.attribution,
      action: action?.kind ?? "none",
    });
    return {
      attribution: learning.attribution,
      concepts: learning.conceptKeys.map((key) => {
        const label = labels.get(key);
        return label ? { key, label } : { key };
      }),
      ...(action ? { action } : {}),
    };
  } catch (error) {
    log.warn("learner_profile.failed", { consumer: "notebook_page", error });
    return unnamed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
