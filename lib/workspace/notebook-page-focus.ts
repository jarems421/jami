import type { NotebookPageLearningView } from "@/lib/learning/notebook-page-context";

/**
 * What the notebook's Tutor tells a student about where marking the open page
 * will count, and what they can change about it.
 *
 * Said plainly because it is the student's to correct: a page placed on the
 * wrong Topics, or on none, is fixed by them choosing the page's own. A page
 * made for a question is placed by that question and has nothing to choose.
 */
export type NotebookPageFocusCopy = {
  /** Before the names: "Marking this page counts towards". */
  lead: string;
  /** The concepts by name; empty when the page counts towards nothing. */
  names: string[];
  /** After the names, when the sentence needs it. */
  tail?: string;
  /** The button that opens the page's Topics, when the student may change them. */
  changeLabel?: string;
};

export function describeNotebookPageFocus(
  view: Pick<NotebookPageLearningView, "attribution" | "concepts">,
  /** A student Topic's name by id, from the student's own list. */
  topicName: (topicId: string) => string | undefined
): NotebookPageFocusCopy {
  const names = view.concepts.flatMap((concept) => {
    const name =
      concept.label ??
      (concept.key.startsWith("topic:") ? topicName(concept.key.slice("topic:".length)) : undefined);
    return name ? [name] : [];
  });
  switch (view.attribution) {
    case "linked-question":
      return {
        lead: "Marking this page counts towards",
        names,
        tail: names.length > 0 ? ", the topics this question was written for." : "this question's topics.",
      };
    case "page-topics":
      return { lead: "Marking this page counts towards", names, changeLabel: "Change" };
    case "notebook-topics":
      return {
        lead: "Marking this page counts towards this notebook's topics",
        names,
        changeLabel: "Choose this page's topic",
      };
    case "none":
      return {
        lead: "This page isn't linked to a topic, so marking it won't count towards your progress yet.",
        names: [],
        changeLabel: "Choose a topic",
      };
  }
}
