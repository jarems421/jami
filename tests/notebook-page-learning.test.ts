import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("server-only", () => ({}));

const { loadNotebookPageLearningContext } = await import(
  "@/services/learning/notebook-page-learning.server"
);

/**
 * Where a notebook page sits, read on the server.
 *
 * What this pins: a page's link to a question is checked against the paper or
 * session it names before its concepts are trusted, those concepts are checked
 * against the course's catalogue, and a followed study action is kept only
 * when it belongs to the page's own folder.
 */

const GRAPHS = "aqa-8300-algebra-graphs";
const STRAIGHT_LINES = "aqa-8300-algebra-straight-line-graphs";

type Data = Record<string, unknown>;

function fakeDb(collections: Record<string, Record<string, Data>>) {
  const reads: string[] = [];
  const userDoc = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          reads.push(`${name}/${id}`);
          const data = collections[name]?.[id];
          return { id, exists: Boolean(data), data: () => data };
        },
      }),
    }),
  };
  const db = { collection: () => ({ doc: () => userDoc }) } as unknown as Firestore;
  return { db, reads };
}

const FOLDER = {
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
};
const NOTEBOOK = { id: "nb-1", folderId: "folder-1", topicIds: ["topic-algebra"] };

describe("placing a notebook page on the server", () => {
  it("places a practice-paper page on its question's checked concepts", async () => {
    const { db } = fakeDb({
      studyFolders: FOLDER,
      pastPapers: {
        "paper-1": {
          folderId: "folder-1",
          questions: [{ id: "q4", prompt: "Find the gradient.", marks: 3, conceptIds: [STRAIGHT_LINES, "made-up"] }],
        },
      },
    });
    const context = await loadNotebookPageLearningContext({
      db,
      uid: "user-1",
      notebook: NOTEBOOK,
      page: { id: "p6", linkedPastPaperId: "paper-1", linkedQuestionId: "q4" },
    });
    expect(context).toEqual({
      conceptKeys: [`spec:${STRAIGHT_LINES}`],
      attribution: "linked-question",
      workItemId: "paper:paper-1:q4",
    });
  });

  it("places a Past Paper Practice page on its session question's catalogued ids", async () => {
    const { db } = fakeDb({
      examSessions: {
        "session-1": {
          course: { specificationId: "8300" },
          questions: [{ id: "q1", topicIds: [GRAPHS, "invented"], conceptIds: [STRAIGHT_LINES, "invented"] }],
        },
      },
    });
    const context = await loadNotebookPageLearningContext({
      db,
      uid: "user-1",
      notebook: NOTEBOOK,
      page: { id: "exam_x", linkedExamSessionId: "session-1", linkedQuestionId: "q1" },
    });
    expect(context.conceptKeys).toEqual([`spec:${GRAPHS}`, `spec:${STRAIGHT_LINES}`]);
    // The same item the marked attempt itself counts as.
    expect(context.workItemId).toBe("exam:q1");
  });

  it("ignores a link to a question that is not there", async () => {
    const { db } = fakeDb({ studyFolders: FOLDER, pastPapers: { "paper-1": { questions: [] } } });
    const context = await loadNotebookPageLearningContext({
      db,
      uid: "user-1",
      notebook: NOTEBOOK,
      page: { id: "p6", linkedPastPaperId: "paper-1", linkedQuestionId: "q99" },
    });
    expect(context).toEqual({
      conceptKeys: ["topic:topic-algebra"],
      attribution: "notebook-topics",
      workItemId: "notebook:nb-1:p6",
    });
  });

  it("reads nothing for a page that links to no question", async () => {
    const { db, reads } = fakeDb({});
    const context = await loadNotebookPageLearningContext({
      db,
      uid: "user-1",
      notebook: NOTEBOOK,
      page: { id: "p1", topicIds: ["topic-quadratics"] },
    });
    expect(reads).toEqual([]);
    expect(context.attribution).toBe("page-topics");
  });

  it("keeps a followed action only when it is this folder's", async () => {
    const { db } = fakeDb({});
    const own = await loadNotebookPageLearningContext({
      db,
      uid: "user-1",
      notebook: NOTEBOOK,
      page: { id: "p1" },
      actionId: "folder:folder-1|low_mastery|topic:topic-algebra",
    });
    const foreign = await loadNotebookPageLearningContext({
      db,
      uid: "user-1",
      notebook: NOTEBOOK,
      page: { id: "p1" },
      actionId: "folder:folder-2|low_mastery|topic:topic-algebra",
    });
    expect(own.interventionId).toBe("folder:folder-1|low_mastery|topic:topic-algebra");
    expect(foreign.interventionId).toBeUndefined();
  });
});
