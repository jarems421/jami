import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLearnerProfile } from "@/lib/learning/profile/build-learner-profile";

/**
 * The learner profile reaching Tutor through the context resolver.
 *
 * Tutor is the Learning Engine's first consumer, and the one promise it makes
 * is that the engine never costs an answer: a profile with nothing to say adds
 * nothing, and a failed or slow profile leaves the request exactly as it was
 * before the engine existed.
 */

const mocks = vi.hoisted(() => {
  const state = { settings: undefined as Record<string, unknown> | undefined };

  const emptyCollection = {
    doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(async () => ({ docs: [] })),
  };
  emptyCollection.where.mockReturnValue(emptyCollection);
  emptyCollection.orderBy.mockReturnValue(emptyCollection);
  emptyCollection.limit.mockReturnValue(emptyCollection);

  const db = {
    collection: vi.fn((name: string) => {
      if (name !== "users") return emptyCollection;
      return {
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({}) }),
          collection: (collectionName: string) => {
            if (collectionName === "studyFolders") {
              return {
                doc: () => ({ get: async () => ({ exists: true, data: () => ({ name: "Maths" }) }) }),
              };
            }
            if (collectionName === "tutorPersonalisation") {
              return {
                doc: () => ({
                  get: async () => ({ exists: state.settings !== undefined, data: () => state.settings }),
                }),
              };
            }
            if (collectionName === "notebooks") {
              return {
                doc: () => ({
                  get: async () => ({
                    exists: true,
                    id: "notebook-1",
                    data: () => ({ title: "Working", userId: "user-1", folderId: "folder-1", topicIds: [], sourceIds: [] }),
                  }),
                }),
              };
            }
            if (collectionName === "notebookPages") {
              return {
                ...emptyCollection,
                doc: () => ({
                  get: async () => ({
                    exists: true,
                    id: "page-1",
                    data: () => ({ notebookId: "notebook-1", pageNumber: 1, typedContent: "Some working", textBlocks: [] }),
                  }),
                }),
              };
            }
            return emptyCollection;
          },
        }),
      };
    }),
  };

  return { db, state, loadLearnerProfile: vi.fn() };
});

vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => mocks.db,
  getAdminStorageBucket: () => ({}),
}));

vi.mock("@/services/learning/learner-profile.server", () => ({
  loadLearnerProfile: mocks.loadLearnerProfile,
  loadLearnerProfileWithMaterial: async (input: unknown) => {
    const profile = await mocks.loadLearnerProfile(input);
    return profile ? { profile, notebookMaterial: { markedPages: [], notebooks: [] } } : null;
  },
}));

const { resolveJamiAssistantContext } = await import("@/services/ai/assistant-context");

function resolveForNotebook() {
  return resolveJamiAssistantContext({
    uid: "user-1",
    message: "Check my working",
    context: { surface: "notebook", notebookId: "notebook-1", pageId: "page-1" },
    useRelatedSources: false,
  });
}

function profileWith(cardCount: number) {
  const now = Date.now();
  return buildLearnerProfile({
    scope: { folderId: "folder-1" },
    now,
    evidence: {
      cards: Array.from({ length: cardCount }, (_, index) => ({
        id: `card-${index}`,
        deckId: "deck-1",
        topicIds: ["eigen"],
        reps: 6,
        lapses: 4,
        difficulty: 8,
        fsrsState: 2,
        lastReview: now - 24 * 60 * 60 * 1000,
      })),
      flashcardReviewEvents: [],
      pastPaperAttempts: [],
      practicePaperAttempts: [],
      topicLabels: { "topic:eigen": { label: "Eigenvectors", source: "student-topic" } },
    },
  });
}

beforeEach(() => {
  mocks.state.settings = undefined;
  mocks.loadLearnerProfile.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("learner profile in Tutor's context", () => {
  it("adds the profile, scoped to the notebook's folder, when it has something to say", async () => {
    mocks.loadLearnerProfile.mockResolvedValue(profileWith(17));
    const resolved = await resolveForNotebook();

    expect(mocks.loadLearnerProfile).toHaveBeenCalledWith({ uid: "user-1", folderId: "folder-1" });
    expect(resolved.learningContext).toContain("--- LEARNER PROFILE ---");
    expect(resolved.learningContext).toContain('"Eigenvectors"');
  });

  it("adds nothing when the profile has nothing to say", async () => {
    mocks.loadLearnerProfile.mockResolvedValue(profileWith(0));
    const resolved = await resolveForNotebook();
    expect(resolved).not.toHaveProperty("learningContext");
  });

  it("answers exactly as before when the engine fails", async () => {
    mocks.state.settings = { helpApproach: "explain-directly", updatedAt: 1 };
    mocks.loadLearnerProfile.mockRejectedValue(new Error("FAILED_PRECONDITION"));
    const resolved = await resolveForNotebook();

    expect(resolved).not.toHaveProperty("learningContext");
    expect(resolved.personalisationContext).toContain("prefers a direct explanation");
    expect(resolved.currentParts.length).toBeGreaterThan(0);
  });

  it("answers without the profile when it takes too long", async () => {
    vi.useFakeTimers();
    mocks.loadLearnerProfile.mockReturnValue(new Promise(() => undefined));
    const pending = resolveForNotebook();
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(pending).resolves.not.toHaveProperty("learningContext");
  });
});
