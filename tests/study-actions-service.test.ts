import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLearnerProfile } from "@/lib/learning/profile/build-learner-profile";

/**
 * Study actions across a student's recent folders.
 *
 * Each folder is decided on its own evidence and then ranked together; a
 * folder that fails to load costs only its own actions; only actions with a
 * real destination reach Today.
 */

const NOW = Date.UTC(2026, 8, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => {
  const folderDocs = [
    {
      id: "folder-recent",
      data: () => ({
        name: "Maths",
        archived: false,
        updatedAt: 3,
        studyLevel: "gcse-equivalent",
        examCourse: {
          board: "aqa",
          qualification: "gcse",
          specificationId: "8300",
          specificationTitle: "AQA GCSE Mathematics (8300)",
          componentIds: [],
        },
      }),
    },
    { id: "folder-broken", data: () => ({ name: "Broken", archived: false, updatedAt: 2 }) },
    { id: "folder-older", data: () => ({ name: "Linear algebra", archived: false, updatedAt: 1 }) },
  ];
  const query = {
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(async () => ({ docs: folderDocs })),
  };
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  const db = { collection: vi.fn(() => ({ doc: () => ({ collection: () => query }) })) };
  return { db, query, loadLearnerProfile: vi.fn() };
});

vi.mock("@/services/firebase/admin", () => ({ getAdminDb: () => mocks.db }));
vi.mock("@/services/learning/learner-profile.server", () => ({
  loadLearnerProfile: mocks.loadLearnerProfile,
  loadLearnerProfileWithMaterial: async (input: unknown) => {
    const profile = await mocks.loadLearnerProfile(input);
    return profile ? { profile, notebookMaterial: { markedPages: [], notebooks: [] } } : null;
  },
}));

const { loadStudyActions, STUDY_ACTION_FOLDER_LIMIT } = await import(
  "@/services/learning/study-actions.server"
);

function emptyEvidence() {
  return {
    cards: [],
    flashcardReviewEvents: [],
    pastPaperAttempts: [],
    practicePaperAttempts: [],
    topicLabels: {},
  };
}

beforeEach(() => {
  mocks.loadLearnerProfile.mockReset();
  mocks.query.limit.mockClear();
  mocks.loadLearnerProfile.mockImplementation(async ({ folderId }: { folderId: string }) => {
    if (folderId === "folder-broken") throw new Error("FAILED_PRECONDITION");
    if (folderId === "folder-recent") {
      return buildLearnerProfile({
        scope: { folderId },
        now: NOW,
        evidence: {
          ...emptyEvidence(),
          specification: {
            id: "8300",
            title: "AQA GCSE Mathematics",
            topics: [
              { id: "graphs", label: "Algebra: graphs" },
              { id: "probability", label: "Probability" },
              { id: "vectors", label: "Geometry: vectors" },
            ],
          },
        },
      });
    }
    return buildLearnerProfile({
      scope: { folderId },
      now: NOW,
      evidence: {
        ...emptyEvidence(),
        cards: Array.from({ length: 17 }, (_, index) => ({
          id: `c${index}`,
          deckId: "deck-1",
          topicIds: ["eigen"],
          reps: 6,
          lapses: 4,
          difficulty: 8,
          fsrsState: 2,
          lastReview: NOW - DAY,
        })),
        exposureItems: [{ kind: "notebook", id: "nb", topicIds: ["vectors"], at: NOW }],
        topicLabels: {
          "topic:eigen": { label: "Eigenvectors", source: "student-topic" },
          "topic:vectors": { label: "Vector spaces", source: "student-topic" },
        },
      },
    });
  });
});

describe("loading study actions", () => {
  it("ranks executable actions from each recent folder, and survives one folder failing", async () => {
    const result = await loadStudyActions({ uid: "user-1", now: NOW });

    expect(mocks.query.limit).toHaveBeenCalledWith(STUDY_ACTION_FOLDER_LIMIT);
    expect(result.evaluatedFolders).toBe(3);
    expect(result.failedFolders).toBe(1);
    expect(result.folders.map((folder) => folder.name)).toEqual(["Maths", "Broken", "Linear algebra"]);
    // Equal-priority specification topics tie-break on their stable key: graphs, probability, vectors.
    expect(result.actions.map((action) => [action.reason, action.target.label])).toEqual([
      ["low_mastery", "Eigenvectors"],
      ["not_yet_assessed", "Algebra: graphs"],
      ["not_yet_assessed", "Probability"],
      ["not_yet_assessed", "Geometry: vectors"],
    ]);
    // The untested notebook topic has no surface that can check it, so Today never sees it.
    expect(result.actions.every((action) => action.destination)).toBe(true);
  });

  it("hands each folder document to the profile loader rather than reading it again", async () => {
    await loadStudyActions({ uid: "user-1", now: NOW });
    expect(mocks.loadLearnerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "folder-older", folder: expect.objectContaining({ id: "folder-older" }) })
    );
  });

  it("does nothing for a missing user", async () => {
    await expect(loadStudyActions({ uid: " ", now: NOW })).resolves.toMatchObject({ actions: [], folders: [] });
    expect(mocks.loadLearnerProfile).not.toHaveBeenCalled();
  });
});
