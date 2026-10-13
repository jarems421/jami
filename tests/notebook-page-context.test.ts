import { describe, expect, it } from "vitest";
import {
  notebookContextSpecificationIds,
  notebookContextTopicIds,
  resolveNotebookPageLearningContext,
} from "@/lib/learning/notebook-page-context";

const NOTEBOOK = { id: "nb-1", topicIds: ["linear-algebra", "eigenvectors", "determinants"] };

describe("what a notebook page is evidence about", () => {
  it("trusts a linked question over every Topic", () => {
    const context = resolveNotebookPageLearningContext({
      notebook: NOTEBOOK,
      page: { id: "p6", topicIds: ["eigenvectors"] },
      linkedQuestion: {
        kind: "practice-paper",
        paperId: "paper-1",
        questionId: "q4",
        specificationIds: ["aqa-eigen"],
      },
    });
    expect(context).toEqual({
      conceptKeys: ["spec:aqa-eigen"],
      attribution: "linked-question",
      workItemId: "paper:paper-1:q4",
    });
  });

  it("uses the page's own Topics before its notebook's", () => {
    const context = resolveNotebookPageLearningContext({
      notebook: NOTEBOOK,
      page: { id: "p6", topicIds: ["eigenvectors"] },
    });
    // One eigenvector page is about eigenvectors, not a third of each notebook Topic.
    expect(context.conceptKeys).toEqual(["topic:eigenvectors"]);
    expect(context.attribution).toBe("page-topics");
    expect(context.workItemId).toBe("notebook:nb-1:p6");
  });

  it("falls back to the notebook's Topics, all of them", () => {
    const context = resolveNotebookPageLearningContext({ notebook: NOTEBOOK, page: { id: "p6" } });
    expect(context.conceptKeys).toEqual([
      "topic:linear-algebra",
      "topic:eigenvectors",
      "topic:determinants",
    ]);
    expect(context.attribution).toBe("notebook-topics");
  });

  it("places nothing when nothing is known", () => {
    const context = resolveNotebookPageLearningContext({
      notebook: { id: "nb-1", topicIds: [] },
      page: { id: "p1" },
    });
    expect(context).toEqual({ conceptKeys: [], attribution: "none", workItemId: "notebook:nb-1:p1" });
  });

  it("keeps a linked question's piece of work even when it names no concept", () => {
    // An untagged question is still the same question as on its paper.
    const context = resolveNotebookPageLearningContext({
      notebook: NOTEBOOK,
      page: { id: "p6" },
      linkedQuestion: { kind: "past-paper", questionId: "aqa-2023-1h-q7", specificationIds: [] },
    });
    expect(context.workItemId).toBe("exam:aqa-2023-1h-q7");
    expect(context.attribution).toBe("notebook-topics");
  });

  it("ignores ids that cannot be keys", () => {
    const context = resolveNotebookPageLearningContext({
      notebook: { id: "nb-1", topicIds: ["  ", "a/b", "ok"] },
      page: { id: "p1" },
    });
    expect(context.conceptKeys).toEqual(["topic:ok"]);
  });

  it("carries the action the student followed", () => {
    const context = resolveNotebookPageLearningContext({
      notebook: NOTEBOOK,
      page: { id: "p1" },
      interventionId: "folder:f1|low_mastery|topic:eigenvectors",
    });
    expect(context.interventionId).toBe("folder:f1|low_mastery|topic:eigenvectors");
  });

  it("separates the student's Topics from specification concepts", () => {
    const context = { conceptKeys: ["topic:eigen", "spec:aqa-eigen"] };
    expect(notebookContextTopicIds(context)).toEqual(["eigen"]);
    expect(notebookContextSpecificationIds(context)).toEqual(["aqa-eigen"]);
  });
});
