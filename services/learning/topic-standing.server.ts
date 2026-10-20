import "server-only";

import { buildStudyActions } from "@/lib/learning/actions/study-actions";
import { topicStandingsFromProfile, type TopicStanding } from "@/lib/goals/topic-standing";
import { loadLearnerProfileWithMaterial } from "@/services/learning/learner-profile.server";
import { loadStudyActionHistory } from "@/services/learning/study-action-history.server";
import {
  loadStudyFolderForActions,
  studyActionContextFor,
} from "@/services/learning/study-actions.server";

/**
 * Where each topic in one folder stands, for topic goals.
 *
 * The same profile and study actions Today is built from, for one folder: so a
 * goal's "Strong" means exactly what the engine means by it everywhere else,
 * and a goal's next step is the engine's own. Reads only; no AI.
 *
 * Returns null when the folder is gone or archived.
 */
export async function loadTopicStandings(input: {
  uid: string;
  folderId: string;
  now?: number;
}): Promise<TopicStanding[] | null> {
  const now = input.now ?? Date.now();
  const folder = await loadStudyFolderForActions(input.uid, input.folderId);
  if (!folder) return null;
  const [loaded, history] = await Promise.all([
    loadLearnerProfileWithMaterial({ uid: input.uid, folderId: folder.id, folder, now }),
    loadStudyActionHistory({ uid: input.uid, now }),
  ]);
  if (!loaded) return [];
  const actions = buildStudyActions(
    loaded.profile,
    { ...studyActionContextFor(folder), notebookMaterial: loaded.notebookMaterial },
    history.history,
    now
  );
  return topicStandingsFromProfile(loaded.profile, actions);
}
