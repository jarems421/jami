import type { LearnerExposureItem } from "@/lib/learning/profile/exposure";
import { readMarkedAnswer } from "@/lib/learning/profile/marked-answer";
import type { NotebookMarkedWorking } from "@/lib/learning/profile/notebook-signals";

/**
 * Where a student's own notebook material on a concept is.
 *
 * The engine decides what a student needs -- "go back over eigenvectors" --
 * and used to send them to the Topic page to find it, even when the work that
 * matters was a page they had already written. This answers the other half,
 * where it can be done, deterministically and from what the profile already
 * loaded: marked pages say what they are about, and a notebook's Topics say
 * what it holds. Nothing here reads a page or decides anything about the
 * student; it only finds a place.
 */

export type NotebookMaterialPlace = {
  notebookId: string;
  /** The page to open at; absent when only the notebook is known to be about it. */
  pageId?: string;
};

type MarkedPage = {
  notebookId: string;
  pageId: string;
  topicKeys: readonly string[];
  markedAt: number;
  score: number;
};

type TaggedNotebook = { notebookId: string; topicKeys: readonly string[]; at: number };

export type NotebookMaterialIndex = {
  markedPages: readonly MarkedPage[];
  notebooks: readonly TaggedNotebook[];
};

export function buildNotebookMaterialIndex(input: {
  markings: readonly NotebookMarkedWorking[];
  exposureItems: readonly LearnerExposureItem[];
}): NotebookMaterialIndex {
  const markedPages = input.markings.flatMap((marking): MarkedPage[] => {
    const read = readMarkedAnswer(marking.result);
    if (!read || !marking.pageId) return [];
    return [
      {
        notebookId: marking.notebookId,
        pageId: marking.pageId,
        topicKeys: marking.topicKeys,
        markedAt: marking.markedAt,
        score: read.score,
      },
    ];
  });
  const notebooks = input.exposureItems.flatMap((item): TaggedNotebook[] =>
    item.kind === "notebook"
      ? [{ notebookId: item.id, topicKeys: item.topicIds.map((id) => `topic:${id}`), at: item.at }]
      : []
  );
  return { markedPages, notebooks };
}

/**
 * The best place in the student's notebooks to go back over a concept.
 *
 * A page they worked and lost marks on comes first, most recent first: it is
 * their own attempt at exactly this, with the slip still on it. Then any page
 * marked on it, then the most recently used notebook filed under it. Nothing
 * when the student has no notebook material on the concept.
 */
export function locateNotebookMaterial(
  index: NotebookMaterialIndex,
  topicKey: string
): NotebookMaterialPlace | undefined {
  const pages = index.markedPages
    .filter((page) => page.topicKeys.includes(topicKey))
    .sort(
      (left, right) =>
        Number(right.score < 1) - Number(left.score < 1) ||
        right.markedAt - left.markedAt ||
        left.pageId.localeCompare(right.pageId)
    );
  const page = pages[0];
  if (page) return { notebookId: page.notebookId, pageId: page.pageId };

  const notebook = index.notebooks
    .filter((candidate) => candidate.topicKeys.includes(topicKey))
    .sort((left, right) => right.at - left.at || left.notebookId.localeCompare(right.notebookId))[0];
  return notebook ? { notebookId: notebook.notebookId } : undefined;
}
