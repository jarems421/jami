import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One notebook's place in the engine, as its Tutor asks for it.
 *
 * Pins that it is read once per notebook -- each linked paper once however
 * many pages link to it -- that only the concepts a page could sit on are
 * sent, and that a missing profile still answers with every page placeable.
 */

const STRAIGHT_LINES = "aqa-8300-algebra-straight-line-graphs";

const mocks = vi.hoisted(() => {
  const docs: Record<string, Record<string, Record<string, unknown>>> = {
    notebooks: { "nb-1": { folderId: "folder-1", title: "Graphs", topicIds: ["algebra"], archived: false } },
    notebookPages: {
      p1: { notebookId: "nb-1", linkedPastPaperId: "paper-1", linkedQuestionId: "q1" },
      p2: { notebookId: "nb-1", linkedPastPaperId: "paper-1", linkedQuestionId: "q2" },
      p3: { notebookId: "nb-1" },
    },
    pastPapers: {
      "paper-1": {
        folderId: "folder-1",
        questions: [
          { id: "q1", prompt: "Find the gradient.", marks: 2, conceptIds: ["aqa-8300-algebra-straight-line-graphs"] },
          { id: "q2", prompt: "Plot the line.", marks: 2 },
        ],
      },
    },
    studyFolders: {
      "folder-1": {
        name: "Maths",
        studyLevel: "gcse-equivalent",
        examCourse: {
          board: "aqa",
          qualification: "gcse",
          specificationId: "8300",
          specificationTitle: "AQA GCSE Mathematics (8300)",
          componentIds: [],
        },
      },
    },
  };
  const reads: string[] = [];
  const collection = (name: string) => {
    const query = {
      where: () => query,
      select: () => query,
      limit: () => query,
      get: async () => ({
        docs: Object.entries(docs[name] ?? {}).map(([id, data]) => ({ id, data: () => data })),
      }),
      doc: (id: string) => ({
        get: async () => {
          reads.push(`${name}/${id}`);
          const data = docs[name]?.[id];
          return { id, exists: Boolean(data), data: () => data };
        },
      }),
    };
    return query;
  };
  return {
    reads,
    db: { collection: () => ({ doc: () => ({ collection }) }) },
    loadLearnerProfile: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/services/firebase/admin", () => ({ getAdminDb: () => mocks.db }));
vi.mock("@/services/learning/learner-profile.server", () => ({
  loadLearnerProfile: mocks.loadLearnerProfile,
}));

const { loadNotebookLearningView } = await import("@/services/learning/notebook-learning-view.server");

beforeEach(() => {
  mocks.reads.length = 0;
  mocks.loadLearnerProfile.mockReset();
});

describe("a notebook's place in the engine", () => {
  it("checks each linked paper once and sends only concepts a page could sit on", async () => {
    mocks.loadLearnerProfile.mockResolvedValue({
      topics: [
        { topicKey: "topic:algebra", label: "Algebra", decision: { action: "diagnose", reason: "untested_exposure" } },
        { topicKey: `spec:${STRAIGHT_LINES}`, label: "Straight-line graphs", decision: { action: "practice", reason: "low_mastery" } },
        { topicKey: "spec:aqa-8300-probability", label: "Probability" },
      ],
      recommendedFocus: [],
    });

    const view = await loadNotebookLearningView({ uid: "user-1", notebookId: "nb-1" });

    expect(mocks.reads.filter((read) => read.startsWith("pastPapers/"))).toEqual(["pastPapers/paper-1"]);
    expect(view?.notebookTopicIds).toEqual(["algebra"]);
    expect(view?.linkedQuestions.p1).toEqual({
      kind: "practice-paper",
      paperId: "paper-1",
      questionId: "q1",
      specificationIds: [STRAIGHT_LINES],
    });
    // An untagged question still shares its paper's item; it just names no concept.
    expect(view?.linkedQuestions.p2?.specificationIds).toEqual([]);
    expect(view?.linkedQuestions.p3).toBeUndefined();
    expect(Object.keys(view?.concepts ?? {}).sort()).toEqual(["spec:" + STRAIGHT_LINES, "topic:algebra"]);
    expect(view?.concepts["topic:algebra"]?.action?.kind).toBe("quick-check");
  });

  it("still answers, with every page placeable, when the profile cannot be had", async () => {
    mocks.loadLearnerProfile.mockRejectedValue(new Error("unavailable"));
    const view = await loadNotebookLearningView({ uid: "user-1", notebookId: "nb-1" });
    expect(view?.concepts).toEqual({});
    expect(Object.keys(view?.linkedQuestions ?? {})).toEqual(["p1", "p2"]);
  });

  it("finds nothing for a notebook that is not there", async () => {
    expect(await loadNotebookLearningView({ uid: "user-1", notebookId: "missing" })).toBeNull();
  });
});
