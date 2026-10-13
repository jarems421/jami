import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const notebook = {
    id: "notebook-1",
    exists: true,
    data: () => ({
      folderId: "folder-1",
      title: "Mechanics paper",
      type: "free_working",
      sourceIds: [],
      topicIds: ["forces"],
    }),
  };
  const pageDocs = [
    {
      id: "page-1",
      exists: true,
      data: () => ({
        notebookId: "notebook-1",
        folderId: "folder-1",
        pageNumber: 1,
        title: "SUVAT setup",
        typedContent: "Known values: u = 4 and a = 2.",
      }),
    },
    {
      id: "page-2",
      exists: true,
      data: () => ({
        notebookId: "notebook-1",
        folderId: "folder-1",
        pageNumber: 2,
        questionPrompt: "Find the final velocity.",
        textBlocks: [
          {
            id: "text-1",
            x: 10,
            y: 10,
            width: 200,
            height: 60,
            text: "I used v = u + at.",
          },
        ],
      }),
    },
  ];

  const notebookPages = {
    doc: (pageId: string) => ({
      get: async () => pageDocs.find((page) => page.id === pageId),
    }),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(async () => ({ docs: pageDocs })),
  };
  notebookPages.where.mockReturnValue(notebookPages);
  notebookPages.orderBy.mockReturnValue(notebookPages);
  notebookPages.limit.mockReturnValue(notebookPages);

  const emptyCollection = {
    doc: () => ({
      get: async () => ({ exists: false, data: () => undefined }),
    }),
    where: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(async () => ({ docs: [] })),
  };
  emptyCollection.where.mockReturnValue(emptyCollection);
  emptyCollection.limit.mockReturnValue(emptyCollection);

  // Ink records by page id; empty unless a test draws on a page.
  const inkRecords = new Map<string, string>();
  const notebookPageInk = {
    doc: (pageId: string) => ({
      get: async () => {
        const svg = inkRecords.get(pageId);
        return svg
          ? { exists: true, data: () => ({ inkData: { version: 2, format: "js-draw-svg", svg } }) }
          : { exists: false, data: () => undefined };
      },
    }),
  };

  const db = {
    collection: vi.fn((name: string) => {
      if (name !== "users") return emptyCollection;
      return {
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({ defaultStudyLevel: "post-16-equivalent" }),
          }),
          collection: (collectionName: string) => {
            if (collectionName === "notebooks") {
              return { doc: () => ({ get: async () => notebook }) };
            }
            if (collectionName === "notebookPages") return notebookPages;
            if (collectionName === "notebookPageInk") return notebookPageInk;
            if (collectionName === "studyFolders") {
              return {
                doc: () => ({
                  get: async () => ({ exists: true, data: () => ({}) }),
                }),
              };
            }
            return emptyCollection;
          },
        }),
      };
    }),
  };

  return { db, notebookPages, inkRecords };
});

vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => mocks.db,
}));

const { resolveJamiAssistantContext } = await import(
  "@/services/ai/assistant-context"
);

describe("notebook-wide Tutor awareness", () => {
  it("adds a bounded notebook map without claiming to read other pages' handwriting", async () => {
    const result = await resolveJamiAssistantContext({
      uid: "user-1",
      message: "How does this connect to my previous page?",
      context: {
        surface: "notebook",
        notebookId: "notebook-1",
        pageId: "page-2",
      },
      useRelatedSources: false,
    });
    const text = result.currentParts
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n");

    expect(text).toContain("Notebook page map");
    expect(text).toContain("Page 1: title: SUVAT setup");
    expect(text).toContain("Known values: u = 4 and a = 2.");
    expect(text).toContain("Page 2 (current)");
    expect(text).toContain("I used v = u + at.");
    expect(text).toContain("page imagery are available for the current page and for any page pictured below");
    expect(mocks.notebookPages.limit).toHaveBeenCalledWith(60);
    // Page 1 has nothing drawn on it, so its typed text says everything and no picture is sent.
    expect(result.currentParts.some((part) => "inlineData" in part)).toBe(false);
    // A page with no Topics or linked question of its own is placed on its notebook's.
    expect(result.notebookLearning).toEqual({
      conceptKeys: ["topic:forces"],
      attribution: "notebook-topics",
      workItemId: "notebook:notebook-1:page-2",
    });
  });

  it("shows the handwritten page before the current one as a picture", async () => {
    mocks.inkRecords.set(
      "page-1",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M10 10 L190 190" stroke="black" stroke-width="4" fill="none"/></svg>'
    );
    try {
      const result = await resolveJamiAssistantContext({
        uid: "user-1",
        message: "Is this right?",
        context: { surface: "notebook", notebookId: "notebook-1", pageId: "page-2" },
        useRelatedSources: false,
      });
      const labelIndex = result.currentParts.findIndex(
        (part) => "text" in part && part.text.startsWith("Page 1, the page before the current one")
      );
      expect(labelIndex).toBeGreaterThan(0);
      const picture = result.currentParts[labelIndex + 1];
      expect(picture && "inlineData" in picture ? picture.inlineData.mimeType : null).toBe("image/jpeg");
    } finally {
      mocks.inkRecords.clear();
    }
  });
});
