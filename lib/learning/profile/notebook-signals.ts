import {
  markedAnswerWeight,
  readMarkedAnswer,
  type StoredMarkedAnswer,
} from "@/lib/learning/profile/marked-answer";
import { isValidEvidenceTime } from "@/lib/learning/evidence-time";
import type { LearningObservation } from "@/lib/learning/types";

/**
 * Marked notebook working, as evidence about what a student knows.
 *
 * Until now a notebook counted only as exposure -- "they have notes on this"
 * -- which is right for notes and wrong for working that Tutor has actually
 * marked. A student who works a question through in their notebook and has it
 * marked has demonstrated something, and the engine was throwing that away
 * while counting a flashcard tapped "good" in half a second.
 *
 * It is admitted at a fraction of the weight, for reasons that are about the
 * evidence rather than about caution:
 *
 * - It is marked by a model against the question, not by a scheme against a
 *   tariff. The score is an opinion, and a generous one when working is
 *   partial.
 * - The student chose the question. Work someone selects for themselves is
 *   not a random sample of what they can do, and skews easy.
 * - Working is often unfinished, and a page can be marked mid-thought.
 *
 * So it moves a mastery estimate, and it can never by itself carry a topic
 * past the confidence needed to call it strong. Everything downstream --
 * capping per item, sharing across concepts, recency -- applies unchanged.
 */

export type NotebookMarkedWorking = {
  /** The marking record's own id, so one marking can never count twice. */
  id: string;
  notebookId: string;
  /** The page marked. */
  pageId?: string;
  /** Namespaced concept keys, placed by `resolveNotebookPageLearningContext`. */
  topicKeys: readonly string[];
  /**
   * The piece of work marked: the page, or the question the page was made for,
   * which it then shares with that question's other evidence.
   */
  itemId: string;
  /** The study action the student was following, when they followed one. */
  interventionId?: string;
  markedAt: number;
  result: StoredMarkedAnswer;
};

/**
 * Observations from a student's marked notebook working.
 *
 * Working with no topic is dropped rather than attributed to the notebook as a
 * whole: a notebook is not a concept, and evidence that cannot be placed is
 * not evidence the engine can use.
 */
export function notebookObservations(
  markings: readonly NotebookMarkedWorking[]
): LearningObservation[] {
  const observations: LearningObservation[] = [];
  const seen = new Set<string>();

  /*
   * Most recent first, so the page-level de-duplication below keeps the latest
   * marking of a page rather than whichever one the caller happened to load
   * first. Re-marking a page after working on it further must not be read as
   * the earlier, worse attempt.
   */
  const ordered = [...markings].sort(
    (left, right) => right.markedAt - left.markedAt || left.id.localeCompare(right.id)
  );

  for (const marking of ordered) {
    if (!isValidEvidenceTime(marking.markedAt)) continue;
    const topicKeys = Array.from(
      new Set(marking.topicKeys.filter((key) => typeof key === "string" && key.trim().length > 0))
    );
    if (topicKeys.length === 0 || !marking.itemId) continue;

    const read = readMarkedAnswer(marking.result);
    if (!read) continue;

    /*
     * One observation per piece of work, not per marking.
     *
     * Asking Tutor to check the same work twice is one piece of evidence about
     * the student, looked at twice -- whether that is one page marked again or
     * two pages of the same question. The most recent marking of it wins. A
     * question also marked on its paper shares the paper's item, so the cap on
     * any one item holds across both.
     */
    const itemId = marking.itemId;
    if (seen.has(itemId)) continue;
    seen.add(itemId);

    const share = 1 / topicKeys.length;
    observations.push({
      kind: "notebook",
      evidenceId: `notebook-marking:${marking.id}`,
      itemId,
      topicKeys,
      topicShares: Object.fromEntries(topicKeys.map((key) => [key, share])),
      score: read.score,
      // Scales with the work marked, like every other marked source; how much
      // notebook marking is trusted lives in `evidenceSourceWeight`.
      weight: markedAnswerWeight(read.maxMarks),
      count: 1,
      at: marking.markedAt,
      // Each marking is dated, so a series of them is a real change over time.
      trendEligible: true,
      ...(marking.interventionId ? { interventionId: marking.interventionId } : {}),
      errorChecks: read.errorChecks,
    });
  }

  return observations;
}
