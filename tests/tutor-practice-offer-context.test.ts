import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLearnerProfile } from "@/lib/learning/profile/build-learner-profile";

/**
 * The practice offer reaching Tutor on a marked past-paper answer.
 *
 * That is where a specification concept meets Tutor: the student got a
 * question wrong and asks about it. When the engine would check that concept
 * with exam questions, Tutor offers them and the model is told it has.
 */

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => {
  const state = { examCourse: true as boolean };
  const emptyCollection: Record<string, unknown> = {};
  Object.assign(emptyCollection, {
    doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    where: () => emptyCollection,
    orderBy: () => emptyCollection,
    limit: () => emptyCollection,
    select: () => emptyCollection,
    get: async () => ({ docs: [], empty: true }),
  });
  const docOf = (id: string, data: Record<string, unknown>) => ({
    get: async () => ({ exists: true, id, data: () => data }),
  });

  const db = {
    collection: vi.fn((name: string) => {
      if (name !== "users") return emptyCollection;
      return {
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({}) }),
          collection: (collectionName: string) => {
            if (collectionName === "examSessions") {
              return {
                doc: () =>
                  docOf("session-1", {
                    folderId: "f1",
                    questions: [
                      {
                        id: "q1",
                        prompt: "Write x^2 + 6x + 2 in completed square form.",
                        marks: 4,
                        topicIds: ["algebra"],
                        conceptIds: ["completing-the-square"],
                      },
                    ],
                  }),
              };
            }
            if (collectionName === "examAttempts") {
              return {
                doc: () =>
                  docOf("attempt-1", {
                    sessionId: "session-1",
                    questionId: "q1",
                    status: "marked",
                    answerText: "(x + 6)^2 + 2",
                    result: { awardedMarks: 1, maxMarks: 4, feedback: "Halve the coefficient." },
                  }),
              };
            }
            if (collectionName === "studyFolders") {
              return {
                doc: () =>
                  docOf("f1", {
                    name: "Maths",
                    archived: false,
                    studyLevel: "gcse-equivalent",
                    ...(state.examCourse
                      ? {
                          examCourse: {
                            specificationId: "8300",
                            specificationTitle: "AQA GCSE Mathematics",
                            board: "aqa",
                            qualification: "GCSE",
                          },
                        }
                      : {}),
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
  getAdminStorageBucket: () => ({ file: () => ({ download: async () => [Buffer.from("")] }) }),
}));

vi.mock("@/services/learning/learner-profile.server", () => ({
  loadLearnerProfile: mocks.loadLearnerProfile,
  loadLearnerProfileWithMaterial: async (input: unknown) => {
    const profile = await mocks.loadLearnerProfile(input);
    return profile ? { profile, notebookMaterial: { markedPages: [], notebooks: [] } } : null;
  },
}));

vi.mock("@/services/practice/exam-evidence.server", () => ({
  loadServableExamQuestion: async () => ({ id: "q1", assets: [] }),
  examQuestionVisualParts: async () => [],
}));

const { resolveJamiAssistantContext } = await import("@/services/ai/assistant-context");

/** A few exam answers on the concept gone wrong: the engine would check it with exam questions. */
function suspectedGapProfile() {
  return buildLearnerProfile({
    scope: { folderId: "f1" },
    now: NOW,
    evidence: {
      cards: [],
      flashcardReviewEvents: [],
      practicePaperAttempts: [],
      topicLabels: {},
      pastPaperAttempts: Array.from({ length: 3 }, (_, index) => ({
        id: `a${index}`,
        questionId: `q${index}`,
        topicIds: [],
        conceptIds: ["completing-the-square"],
        attemptNumber: 1,
        markedAt: NOW - (index + 1) * DAY,
        updatedAt: NOW - (index + 1) * DAY,
        result: { attempted: true, counted: true, awardedMarks: 1, maxMarks: 4 },
      })),
      concepts: [
        {
          key: "spec:completing-the-square",
          label: "Completing the square",
          source: "specification",
          provenance: "verified_specification",
          verified: true,
          parentKey: "spec:algebra",
        },
      ],
      specification: { id: "8300", title: "AQA GCSE Mathematics", topics: [{ id: "algebra", label: "Algebra" }] },
    },
  });
}

function resolveForMarkedAnswer() {
  return resolveJamiAssistantContext({
    uid: "user-1",
    message: "Why did I lose marks here?",
    context: { surface: "practice", sessionId: "session-1", attemptId: "attempt-1" },
    useRelatedSources: false,
  });
}

beforeEach(() => {
  mocks.state.examCourse = true;
  mocks.loadLearnerProfile.mockReset();
});

describe("practice offered on a marked answer", () => {
  it("offers exam questions on the concept, and tells the model", async () => {
    mocks.loadLearnerProfile.mockResolvedValue(suspectedGapProfile());
    const resolved = await resolveForMarkedAnswer();

    expect(resolved.practiceOffer).toMatchObject({
      target: { topicKey: "spec:completing-the-square" },
      href: "/dashboard/practice/questions/new?folderId=f1&concepts=completing-the-square",
    });
    expect(resolved.learningContext).toContain(
      'Practice offered under your answer: exam-style questions on "Completing the square"'
    );
  });

  it("sends the student to write a practice paper where the folder has no exam course", async () => {
    // No real questions to serve, so the engine's route is practice Jami writes, in the folder.
    mocks.state.examCourse = false;
    mocks.loadLearnerProfile.mockResolvedValue(suspectedGapProfile());
    const resolved = await resolveForMarkedAnswer();

    expect(resolved.practiceOffer?.href).toBe("/dashboard/folders/f1?tab=practice");
  });

  it("answers as before when the engine fails", async () => {
    mocks.loadLearnerProfile.mockRejectedValue(new Error("unavailable"));
    const resolved = await resolveForMarkedAnswer();

    expect(resolved).not.toHaveProperty("practiceOffer");
    expect(resolved).not.toHaveProperty("learningContext");
    expect(resolved.currentLabel).toBe("Marked practice answer");
  });
});
