import {
  pickMaterialAction,
  type MaterialAction,
  type MaterialConcept,
} from "@/lib/learning/actions/material-action";

/**
 * What a notebook page is evidence about, and which piece of work it is.
 *
 * A notebook used to be attributed as a whole: marking one page of a notebook
 * filed under "Eigenvectors", "Determinants" and "Linear algebra" split the
 * verdict three ways, whatever the page was about. And every page was its own
 * item, so the same exam question marked once on its paper and again on its
 * page counted as two independent successes.
 *
 * This is the one place that answers both questions, for Tutor, for notebook
 * marking and for anything that later sends a student back to a page. The
 * trust order is fixed, strongest first:
 *
 * 1. **A linked question.** A page that is a question from a practice paper or
 *    Past Paper Practice carries that question's own specification concepts,
 *    checked by the loader against the folder's servable catalogue.
 * 2. **The page's own Topics**, which only the student sets.
 * 3. **The notebook's Topics**, shared between them as before: a notebook is
 *    a reasonable guess at what its pages are about, and a weaker one the more
 *    Topics it has.
 *
 * Nothing here infers a concept from what is written on the page. A model may
 * suggest one; only the student confirming it makes it a page Topic.
 */

export type NotebookPageAttribution =
  | "linked-question"
  | "page-topics"
  | "notebook-topics"
  | "none";

/** The question a page was made for, as the loader found it on the server. */
export type NotebookLinkedQuestion =
  | {
      kind: "practice-paper";
      paperId: string;
      questionId: string;
      /** Specification ids, already checked against the folder's catalogue. */
      specificationIds: readonly string[];
    }
  | {
      kind: "past-paper";
      questionId: string;
      specificationIds: readonly string[];
    };

export type NotebookPageLearningContext = {
  /** Namespaced concept keys: `topic:<id>` or `spec:<id>`. Empty when nothing can be placed. */
  conceptKeys: string[];
  attribution: NotebookPageAttribution;
  /**
   * The piece of work this page is, as the engine counts items.
   *
   * A page made for a question shares that question's item with its other
   * evidence, so marking it in the notebook and on its paper is one question
   * looked at twice, not two. Free working is its own page.
   */
  workItemId: string;
  /** The study action the student followed here, when they followed one. */
  interventionId?: string;
};

/** The longest id a key may carry; matches what notebook marking accepts. */
const MAX_ID_LENGTH = 160;

function cleanIds(ids: readonly string[] | undefined) {
  return Array.from(
    new Set(
      (ids ?? [])
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0 && id.length <= MAX_ID_LENGTH && !id.includes("/"))
    )
  );
}

export function notebookPageWorkItemId(input: {
  notebookId: string;
  pageId: string;
  linkedQuestion?: NotebookLinkedQuestion | null;
}) {
  const linked = input.linkedQuestion;
  if (linked?.kind === "practice-paper") return `paper:${linked.paperId}:${linked.questionId}`;
  if (linked?.kind === "past-paper") return `exam:${linked.questionId}`;
  return `notebook:${input.notebookId}:${input.pageId}`;
}

export function resolveNotebookPageLearningContext(input: {
  notebook: { id: string; topicIds: readonly string[] };
  page: { id: string; topicIds?: readonly string[] };
  linkedQuestion?: NotebookLinkedQuestion | null;
  interventionId?: string;
}): NotebookPageLearningContext {
  const workItemId = notebookPageWorkItemId({
    notebookId: input.notebook.id,
    pageId: input.page.id,
    linkedQuestion: input.linkedQuestion,
  });
  const interventionId = input.interventionId?.trim();
  const withAction = interventionId ? { interventionId } : {};

  const questionIds = cleanIds(input.linkedQuestion?.specificationIds);
  if (questionIds.length > 0) {
    return {
      conceptKeys: questionIds.map((id) => `spec:${id}`),
      attribution: "linked-question",
      workItemId,
      ...withAction,
    };
  }
  const pageTopicIds = cleanIds(input.page.topicIds);
  if (pageTopicIds.length > 0) {
    return {
      conceptKeys: pageTopicIds.map((id) => `topic:${id}`),
      attribution: "page-topics",
      workItemId,
      ...withAction,
    };
  }
  const notebookTopicIds = cleanIds(input.notebook.topicIds);
  if (notebookTopicIds.length > 0) {
    return {
      conceptKeys: notebookTopicIds.map((id) => `topic:${id}`),
      attribution: "notebook-topics",
      workItemId,
      ...withAction,
    };
  }
  return { conceptKeys: [], attribution: "none", workItemId, ...withAction };
}

/** What the notebook shows about where its open page sits in the engine. */
export type NotebookPageLearningView = {
  attribution: NotebookPageAttribution;
  /** The concepts the page counts towards, named as the profile names them where it can. */
  concepts: { key: string; label?: string }[];
  /** The engine's starting point for the page, when it has a decision on its concepts. */
  action?: MaterialAction;
};

/**
 * Everything needed to place any page of one notebook, fetched once.
 *
 * The engine's view belongs to the folder, not the page, so the notebook asks
 * once and places each page as the student turns to it, with the same
 * resolver the server places markings with. Linked questions are checked on
 * the server first: a page's link is the student's own field.
 */
export type NotebookLearningView = {
  notebookTopicIds: string[];
  /** Pages made for a question, by page id, with the question's checked concepts. */
  linkedQuestions: Record<string, NotebookLinkedQuestion>;
  /** Names and the engine's starting points, by concept key. A key not here is not in the profile. */
  concepts: Record<string, MaterialConcept>;
};

/** One page of a notebook, placed from its notebook's view. */
export function placeNotebookPage(
  view: NotebookLearningView,
  notebookId: string,
  page: { id: string; topicIds?: readonly string[] }
): NotebookPageLearningView {
  const context = resolveNotebookPageLearningContext({
    notebook: { id: notebookId, topicIds: view.notebookTopicIds },
    page,
    linkedQuestion: view.linkedQuestions[page.id] ?? null,
  });
  const action = pickMaterialAction(view.concepts, context.conceptKeys);
  return {
    attribution: context.attribution,
    concepts: context.conceptKeys.map((key) => {
      const label = view.concepts[key]?.label;
      return label ? { key, label } : { key };
    }),
    ...(action ? { action } : {}),
  };
}

/** The student's own Topic ids among a context's keys, for choosing sources and memory. */
export function notebookContextTopicIds(context: Pick<NotebookPageLearningContext, "conceptKeys">) {
  return context.conceptKeys.flatMap((key) => (key.startsWith("topic:") ? [key.slice(6)] : []));
}

/** The specification ids among a context's keys. */
export function notebookContextSpecificationIds(
  context: Pick<NotebookPageLearningContext, "conceptKeys">
) {
  return context.conceptKeys.flatMap((key) => (key.startsWith("spec:") ? [key.slice(5)] : []));
}
