import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  fronts: vi.fn(async () => [] as string[]),
  folderDecks: vi.fn(async () => ["deck-a", "deck-b"]),
  saved: [] as Record<string, unknown>[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/provider-router", () => ({ generateAiText: mocks.generate }));
vi.mock("@/services/study/own-cards.server", () => ({
  readOwnCardFronts: mocks.fronts,
  readOwnFolderDeckIds: mocks.folderDecks,
}));
vi.mock("@/services/firebase/admin", () => {
  let next = 0;
  const doc = () => ({ id: `draft-${(next += 1)}` });
  return {
    getAdminDb: () => ({
      collection: () => ({ doc: () => ({ collection: () => ({ doc }) }) }),
      batch: () => ({
        set: (_ref: unknown, record: Record<string, unknown>) => mocks.saved.push(record),
        commit: async () => undefined,
      }),
    }),
  };
});

const { writeTutorFlashcardDrafts, TutorStudyMaterialError } = await import("@/services/ai/tutor-study-material.server");

const cards = (...fronts: string[]) => JSON.stringify(fronts.map((front) => ({ front, back: `Answer to ${front}` })));
const write = (where: { folderId?: string; deckId?: string }) =>
  writeTutorFlashcardDrafts({
    uid: "u1",
    focus: "Photosynthesis",
    count: 4,
    context: "We talked about photosynthesis.",
    threadId: "t1",
    messageId: "m1",
    ...where,
  });

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.fronts.mockReset();
  mocks.fronts.mockResolvedValue([]);
  mocks.folderDecks.mockClear();
  mocks.saved.length = 0;
});

describe("Tutor's flashcards against the cards the student already has", () => {
  it("names the folder's existing cards to the writer and drops a draft that repeats one", async () => {
    mocks.fronts.mockResolvedValue(["Where in the cell does photosynthesis happen?"]);
    mocks.generate.mockResolvedValue(
      cards("Where in the cell does photosynthesis happen?", "What gas does photosynthesis release?")
    );
    const drafts = await write({ folderId: "folder-1" });

    expect(mocks.fronts).toHaveBeenCalledWith("u1", { deckIds: ["deck-a", "deck-b"] });
    expect(JSON.stringify(mocks.generate.mock.calls[0][0])).toContain("Cards the student already has");
    expect(drafts.map((draft) => draft.front)).toEqual(["What gas does photosynthesis release?"]);
  });

  it("reads only the chat's deck when it sits in one", async () => {
    mocks.generate.mockResolvedValue(cards("What gas does photosynthesis release?"));
    await write({ deckId: "deck-z", folderId: "folder-1" });
    expect(mocks.fronts).toHaveBeenCalledWith("u1", { deckIds: ["deck-z"] });
    expect(mocks.folderDecks).not.toHaveBeenCalled();
  });

  it("says the topic is already covered when every draft repeats a card", async () => {
    mocks.fronts.mockResolvedValue(["What gas does photosynthesis release?"]);
    mocks.generate.mockResolvedValue(cards("What gas does photosynthesis release?"));
    await expect(write({ folderId: "folder-1" })).rejects.toMatchObject({ code: "already_covered" });
    expect(mocks.saved).toHaveLength(0);
  });

  it("still writes cards when their cards cannot be read", async () => {
    mocks.fronts.mockRejectedValue(new Error("unavailable"));
    mocks.generate.mockResolvedValue(cards("What gas does photosynthesis release?"));
    expect(await write({ folderId: "folder-1" })).toHaveLength(1);
    expect(TutorStudyMaterialError).toBeDefined();
  });
});
