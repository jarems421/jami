import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Loading a learner profile from Firestore-shaped data.
 *
 * The scoring is tested without Firestore; what this pins is the evidence that
 * reaches it: only the student's own decks and cards, only this folder's
 * material, only topics a catalogue or the student actually names, Topic
 * hierarchies and merges followed within bounds, nothing from sessions,
 * answers, folders or decks the student deleted, no reads at all without a
 * scope -- and a failed secondary read leaves the rest standing.
 */

const mocks = vi.hoisted(() => {
  const NOW = Date.UTC(2026, 8, 15, 12);
  const DAY = 24 * 60 * 60 * 1000;

  type Doc = { id: string; exists: boolean; data: () => Record<string, unknown> };
  const doc = (id: string, data: Record<string, unknown>): Doc => ({
    id,
    exists: true,
    data: () => data,
  });
  const missing = (id: string): Doc => ({ id, exists: false, data: () => ({}) });

  function query(docs: Doc[]) {
    const chain = {
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      select: vi.fn(),
      get: vi.fn(async () => ({ docs })),
      doc: vi.fn((id: string) => ({
        id,
        get: async () => docs.find((item) => item.id === id) ?? missing(id),
      })),
    };
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    chain.select.mockReturnValue(chain);
    return chain;
  }

  const graphs = "aqa-8300-algebra-graphs";
  const straightLines = "aqa-8300-algebra-straight-line-graphs";
  const unitsMissed = [{ criterion: "Correct units", awarded: false }];
  const markedExam = (id: string, sessionId: string, questionId: string, extra: Record<string, unknown> = {}) =>
    doc(id, {
      sessionId,
      questionId,
      status: "marked",
      attemptNumber: 1,
      markedAt: NOW - DAY,
      updatedAt: NOW - DAY,
      result: { attempted: true, awardedMarks: 0, maxMarks: 2, criterionResults: unitsMissed, improvements: [] },
      ...extra,
    });
  const questionResult = (questionId: string, awardedMarks: number) => ({
    questionId,
    label: questionId,
    awardedMarks,
    maxMarks: 2,
    feedback: "",
    strengths: [],
    improvements: [],
    confidence: "high",
    counted: true,
    attempted: true,
  });
  const reviewEvent = (id: string, cardId: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
    doc(id, {
      schemaVersion: 1,
      cardId,
      deckId: "deck-1",
      reviewedAt: NOW - daysAgo * DAY,
      studyDayKey: `2026-09-${String(15 - daysAgo).padStart(2, "0")}`,
      correct: false,
      rating: "again",
      createdAt: NOW - daysAgo * DAY,
      ...extra,
    });
  const weakCard = (id: string, topicId: string) =>
    doc(id, {
      userId: "user-1",
      deckId: "deck-1",
      topicIds: [topicId],
      reps: 6,
      lapses: 4,
      difficulty: 8,
      fsrsState: 2,
      lastReview: NOW - DAY,
      createdAt: NOW - 30 * DAY,
    });

  const collections = {
    studyFolders: query([
      doc("folder-1", {
        name: "Maths",
        studyLevel: "gcse-equivalent",
        topicIds: ["topic-eigen", "topic-vectors"],
        examCourse: {
          board: "aqa",
          qualification: "gcse",
          specificationId: "8300",
          specificationTitle: "AQA GCSE Mathematics (8300)",
          componentIds: [],
        },
      }),
    ]),
    decks: query([
      doc("deck-1", { userId: "user-1", name: "Linear algebra", folderIds: ["folder-1"] }),
      doc("deck-other", { userId: "someone-else", name: "Not theirs", folderIds: ["folder-1"] }),
    ]),
    cards: query([
      ...Array.from({ length: 4 }, (_, index) => weakCard(`card-${index}`, "topic-eigen")),
      // Tagged with a Topic that was later merged into "Eigenvectors".
      weakCard("card-old-1", "topic-old"),
      weakCard("card-old-2", "topic-old"),
      doc("card-foreign", { userId: "someone-else", deckId: "deck-1", reps: 3, lastReview: NOW }),
      doc("card-elsewhere", { userId: "user-1", deckId: "deck-2", reps: 3, lastReview: NOW }),
    ]),
    flashcardReviewEvents: query([
      reviewEvent("event-1", "card-0", 3),
      reviewEvent("event-2", "card-0", 2),
      reviewEvent("event-future-schema", "card-1", 1, { schemaVersion: 2 }),
    ]),
    notebooks: query([
      doc("nb-1", { folderId: "folder-1", archived: false, topicIds: ["topic-vectors"], updatedAt: NOW - DAY }),
      doc("nb-other-folder", { folderId: "folder-2", archived: false, topicIds: ["topic-other"], updatedAt: NOW }),
      // No Topics, but a page in it was marked against its own.
      doc("nb-untagged", { folderId: "folder-1", archived: false, topicIds: [], updatedAt: NOW - DAY }),
      // Practice Jami once wrote, which filed its specification concept as a Topic.
      doc("nb-legacy-practice", {
        folderId: "folder-1",
        archived: false,
        topicIds: [straightLines],
        updatedAt: NOW - DAY,
      }),
    ]),
    notebookMarkings: query([
      doc("nb-untagged_p1", {
        schemaVersion: 2,
        provenance: "tutor",
        notebookId: "nb-untagged",
        pageId: "p1",
        topicKeys: ["topic:topic-matrices"],
        attribution: "page-topics",
        itemId: "notebook:nb-untagged:p1",
        markedAt: NOW - DAY,
        awardedMarks: 1,
        maxMarks: 4,
        criterionResults: [
          { criterion: "Sets up the basis", awarded: true },
          { criterion: "Shows independence", awarded: false },
        ],
      }),
      doc("nb-other-folder_p1", {
        schemaVersion: 2,
        provenance: "tutor",
        notebookId: "nb-other-folder",
        pageId: "p1",
        topicKeys: ["topic:topic-other"],
        attribution: "notebook-topics",
        itemId: "notebook:nb-other-folder:p1",
        markedAt: NOW - DAY,
        awardedMarks: 0,
        maxMarks: 2,
        criterionResults: [{ criterion: "Method", awarded: false }],
      }),
    ]),
    sources: query([
      doc("src-1", { status: "active", folderIds: ["folder-1"], topicIds: ["topic-vectors"], updatedAt: NOW - DAY }),
      doc("src-archived", { status: "archived", folderIds: ["folder-1"], topicIds: ["topic-other"], updatedAt: NOW }),
    ]),
    topics: query([
      doc("topic-eigen", { name: "Eigenvectors", status: "active", parentTopicId: "topic-linear-algebra" }),
      doc("topic-linear-algebra", { name: "Linear algebra concepts", status: "active" }),
      doc("topic-old", { name: "Old eigen topic", status: "merged", mergedIntoTopicId: "topic-eigen" }),
      doc("topic-vectors", { name: "Vector spaces", status: "active" }),
      doc("topic-other", { name: "Another subject", status: "active" }),
      // Named only by a marked page.
      doc("topic-matrices", { name: "Matrices", status: "active" }),
    ]),
    examSessions: query([
      doc("session-1", {
        folderId: "folder-1",
        course: { specificationId: "8300" },
        questions: [
          {
            id: "q1",
            topicIds: [graphs, "invented-topic"],
            conceptIds: [straightLines, "invented-concept"],
            commandWord: "Work out",
          },
          { id: "q2", topicIds: [graphs], conceptIds: [straightLines] },
        ],
      }),
      doc("session-deleted", {
        folderId: "folder-1",
        answersDeletedAt: NOW,
        course: { specificationId: "8300" },
        questions: [{ id: "q9", topicIds: ["aqa-8300-probability"] }],
      }),
    ]),
    examAttempts: query([
      markedExam("a1", "session-1", "q1"),
      markedExam("a2", "session-1", "q1", { attemptNumber: 2 }),
      markedExam("a3", "session-1", "q2"),
      markedExam("a-draft", "session-1", "q2", { status: "draft" }),
      markedExam("a-deleted", "session-1", "q2", { answerDeletedAt: NOW }),
      markedExam("a-from-deleted-session", "session-deleted", "q9"),
    ]),
    pastPapers: query([doc("paper-1", { folderId: "folder-1" })]),
    practicePaperAttempts: query([
      doc("pa-1", { paperId: "paper-1", status: "in_progress", updatedAt: NOW }),
      doc("pa-2", {
        paperId: "paper-1",
        status: "marked",
        markedAt: NOW - DAY,
        updatedAt: NOW - DAY,
        result: {
          awardedMarks: 1,
          totalMarks: 4,
          percentage: 25,
          summary: "",
          strengths: [],
          priorities: [],
          questionResults: [questionResult("p1", 1), questionResult("p2", 0)],
        },
      }),
    ]),
  };

  const userDoc = {
    collection: vi.fn((name: keyof typeof collections) => collections[name]),
  };
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "users") return { doc: () => userDoc };
      return collections[name as keyof typeof collections];
    }),
    getAll: vi.fn(async (...refs: Array<{ get: () => Promise<Doc> }>) =>
      Promise.all(refs.map((ref) => ref.get()))
    ),
  };

  return { NOW, db, collections };
});

vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => mocks.db,
}));

const { loadLearnerProfile } = await import("@/services/learning/learner-profile.server");

beforeEach(() => {
  mocks.db.collection.mockClear();
  mocks.db.getAll.mockClear();
  mocks.collections.examSessions.get.mockClear();
  mocks.collections.examAttempts.orderBy.mockClear();
  mocks.collections.cards.select.mockClear();
  mocks.collections.decks.where.mockClear();
  mocks.collections.studyFolders.doc.mockClear();
  mocks.collections.notebooks.select.mockClear();
});

describe("loading a learner profile", () => {
  it("reads nothing without a folder or deck to scope to", async () => {
    await expect(loadLearnerProfile({ uid: "user-1" })).resolves.toBeNull();
    expect(mocks.db.collection).not.toHaveBeenCalled();
  });

  it("builds a folder profile from the student's own cards, history and marked answers", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });

    expect(profile?.scope).toEqual({ folderId: "folder-1", deckIds: ["deck-1"] });
    expect(profile?.evidenceSummary).toMatchObject({
      flashcardReviews: 36,
      flashcardReviewEvents: 2,
      pastPaperAttempts: 3,
      practiceAttempts: 2,
    });
    expect(profile?.diagnostics).toMatchObject({ limitsReached: [], unavailableSources: [] });
    expect(mocks.collections.decks.where).toHaveBeenCalledWith("folderIds", "array-contains", "folder-1");
    expect(mocks.collections.cards.select).toHaveBeenCalled();
    // Newest answers first, so a capped read drops the oldest rather than a random slice.
    expect(mocks.collections.examAttempts.orderBy).toHaveBeenCalledWith("updatedAt", "desc");

    expect(profile?.weaknesses.map((signal) => [signal.topic, signal.topicSource])).toEqual(
      expect.arrayContaining([
        ["Eigenvectors", "student-topic"],
        ["Algebra: graphs", "specification"],
      ])
    );
    expect(profile?.coverage).toMatchObject({ specificationId: "8300", totalTopics: 13, assessedTopics: 1 });
    expect(profile?.coverage?.notYetAssessed).toHaveLength(12);
    expect(JSON.stringify(profile)).not.toContain("invented-topic");
    expect(profile?.recurringErrors[0]).toMatchObject({ category: "missing_units", occurrences: 3 });
  });

  it("counts marked answers towards their questions' checked concepts, beneath their topics", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });

    expect(profile?.topics.find((topic) => topic.topicKey === "spec:aqa-8300-algebra-straight-line-graphs")).toMatchObject({
      parentKey: "spec:aqa-8300-algebra-graphs",
      provenance: "verified_specification",
      signal: { attempts: 3 },
    });
    // A concept the catalogue does not hold is dropped, like an invented topic.
    expect(JSON.stringify(profile)).not.toContain("invented-concept");
  });

  it("follows a Topic's parent and a merged Topic's target, in bounded rounds", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });
    const stateOf = (key: string) => profile?.topics.find((topic) => topic.topicKey === key);

    // Round one reads the Topics evidence names; round two reads the parent they point at.
    expect(mocks.db.getAll).toHaveBeenCalledTimes(2);
    expect(stateOf("topic:topic-eigen")).toMatchObject({
      parentKey: "topic:topic-linear-algebra",
      provenance: "student_defined",
    });
    // The merged Topic's cards count as Eigenvectors, which rolls up to its parent:
    // card-0's two recorded events, three cards' six reviews each, and the two merged cards'.
    expect(stateOf("topic:topic-eigen")?.signal?.attempts).toBe(2 + 3 * 6 + 2 * 6);
    expect(stateOf("topic:topic-linear-algebra")).toMatchObject({
      signal: { attempts: 2 + 3 * 6 + 2 * 6 },
      coveredBy: ["topic:topic-eigen"],
    });
    expect(stateOf("topic:topic-old")).toBeUndefined();
  });

  it("counts this folder's topic-linked material as exposure, reading only topic links", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });

    expect(profile?.topics.find((topic) => topic.topicKey === "topic:topic-vectors")).toMatchObject({
      label: "Vector spaces",
      declared: true,
      exposure: { notebooks: 1, sources: 1, cards: 0 },
      demonstration: "none",
      decision: { action: "diagnose", reason: "untested_exposure" },
    });
    expect(mocks.collections.notebooks.select).toHaveBeenCalledWith("folderId", "archived", "topicIds", "updatedAt");
    // Material from another folder, or archived, never reaches this folder's profile.
    expect(JSON.stringify(profile)).not.toContain("Another subject");
  });

  it("reads marked working from untagged notebooks, placed by each marking's own concepts", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });
    const matrices = profile?.topics.find((topic) => topic.topicKey === "topic:topic-matrices");
    // A Topic named only by the page is still looked up, so it has its name.
    expect(matrices).toMatchObject({ label: "Matrices", signal: { evidence: ["notebook"] } });
    expect(profile?.evidenceSummary.notebookMarkings).toBe(1);
    // Another folder's notebook is not this folder's evidence.
    expect(JSON.stringify(profile)).not.toContain("topic:topic-other");
  });

  it("does not read a specification concept filed among a notebook's Topics as a Topic", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });
    expect(
      profile?.topics.find((topic) => topic.topicKey === "topic:aqa-8300-algebra-straight-line-graphs")
    ).toBeUndefined();
  });

  it("uses a folder document it is given instead of reading it again", async () => {
    await loadLearnerProfile({
      uid: "user-1",
      folderId: "folder-1",
      now: mocks.NOW,
      folder: {
        id: "folder-1",
        name: "Maths",
        topicIds: [],
        tutorInstructions: "",
        tutorInstructionsUpdatedAt: 0,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    expect(mocks.collections.studyFolders.doc).not.toHaveBeenCalled();
  });

  it("produces no profile for a folder that no longer exists", async () => {
    await expect(
      loadLearnerProfile({ uid: "user-1", folderId: "deleted-folder", now: mocks.NOW })
    ).resolves.toBeNull();
  });

  it("scopes a deck profile to that deck's cards alone", async () => {
    const profile = await loadLearnerProfile({ uid: "user-1", deckId: "deck-1", now: mocks.NOW });

    expect(profile?.scope).toEqual({ deckId: "deck-1" });
    expect(profile?.evidenceSummary.pastPaperAttempts).toBe(0);
    expect(profile?.coverage).toBeUndefined();
    expect(mocks.collections.examSessions.get).not.toHaveBeenCalled();
  });

  it("produces no profile for a deck the student does not own", async () => {
    await expect(
      loadLearnerProfile({ uid: "user-1", deckId: "deck-other", now: mocks.NOW })
    ).resolves.toBeNull();
  });

  it("falls back to card totals when the review history cannot be read", async () => {
    mocks.collections.flashcardReviewEvents.get.mockRejectedValueOnce(
      Object.assign(new Error("The query requires an index."), { code: 9 })
    );
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });

    expect(profile?.diagnostics.unavailableSources).toEqual(["flashcard-events"]);
    expect(profile?.evidenceSummary.flashcardReviewEvents).toBe(0);
    expect(profile?.weaknesses.map((signal) => signal.topic)).toContain("Eigenvectors");
  });

  it("builds the profile without exposure when material cannot be read", async () => {
    mocks.collections.sources.get.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    const profile = await loadLearnerProfile({ uid: "user-1", folderId: "folder-1", now: mocks.NOW });

    expect(profile?.diagnostics.unavailableSources).toEqual(["exposure"]);
    expect(profile?.weaknesses.map((signal) => signal.topic)).toContain("Eigenvectors");
  });
});
