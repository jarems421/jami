import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The open page's place in the engine, as the notebook's Tutor asks for it.
 *
 * Pins that the page is placed by the same resolver as its markings, that the
 * starting point is the engine's own decision, and that a slow or missing
 * profile still answers -- with the page's place and no starting point.
 */

const mocks = vi.hoisted(() => {
  const docs: Record<string, Record<string, Record<string, unknown>>> = {
    notebooks: {
      "nb-1": { folderId: "folder-1", title: "Linear algebra", topicIds: ["eigen", "det"], archived: false },
    },
    notebookPages: {
      p1: { notebookId: "nb-1", folderId: "folder-1", pageNumber: 1, topicIds: ["eigen"] },
      foreign: { notebookId: "nb-other", folderId: "folder-1", pageNumber: 1 },
    },
  };
  const userDoc = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ id, exists: Boolean(docs[name]?.[id]), data: () => docs[name]?.[id] }),
      }),
    }),
  };
  return {
    db: { collection: () => ({ doc: () => userDoc }) },
    loadLearnerProfile: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/services/firebase/admin", () => ({ getAdminDb: () => mocks.db }));
vi.mock("@/services/learning/learner-profile.server", () => ({
  loadLearnerProfile: mocks.loadLearnerProfile,
}));

const { loadNotebookPageLearningView } = await import("@/services/learning/notebook-page-view.server");

beforeEach(() => {
  mocks.loadLearnerProfile.mockReset();
});

describe("the open page's place in the engine", () => {
  it("names the page's own Topics and carries the engine's starting point for them", async () => {
    mocks.loadLearnerProfile.mockResolvedValue({
      topics: [
        {
          topicKey: "topic:eigen",
          label: "Eigenvectors",
          decision: { action: "practice", reason: "low_mastery" },
        },
      ],
      recommendedFocus: [],
    });
    const view = await loadNotebookPageLearningView({ uid: "user-1", notebookId: "nb-1", pageId: "p1" });
    expect(mocks.loadLearnerProfile).toHaveBeenCalledWith({ uid: "user-1", folderId: "folder-1" });
    expect(view).toEqual({
      attribution: "page-topics",
      concepts: [{ key: "topic:eigen", label: "Eigenvectors" }],
      action: { kind: "exam-question", topicKey: "topic:eigen", label: "Eigenvectors" },
    });
  });

  it("still places the page when the profile cannot be had", async () => {
    mocks.loadLearnerProfile.mockRejectedValue(new Error("unavailable"));
    const view = await loadNotebookPageLearningView({ uid: "user-1", notebookId: "nb-1", pageId: "p1" });
    expect(view).toEqual({ attribution: "page-topics", concepts: [{ key: "topic:eigen" }] });
  });

  it("finds nothing for a page that is not in the notebook named", async () => {
    expect(
      await loadNotebookPageLearningView({ uid: "user-1", notebookId: "nb-1", pageId: "foreign" })
    ).toBeNull();
    expect(
      await loadNotebookPageLearningView({ uid: "user-1", notebookId: "nb-1", pageId: "missing" })
    ).toBeNull();
    expect(mocks.loadLearnerProfile).not.toHaveBeenCalled();
  });
});
