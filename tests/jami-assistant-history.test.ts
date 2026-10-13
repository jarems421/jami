import { describe, expect, it } from "vitest";
import {
  createJamiAssistantThreadTitle,
  getJamiAssistantContextKey,
  getJamiAssistantSavedContext,
  JAMI_ASSISTANT_MAX_THREAD_TITLE_LENGTH,
  mapJamiAssistantStoredMessage,
  mapJamiAssistantThread,
} from "@/lib/ai/jami-assistant-history";

describe("Jami assistant history", () => {
  it("stores only notebook identity and never the page snapshot or extracted text", () => {
    const saved = getJamiAssistantSavedContext({
      surface: "notebook",
      notebookId: "notebook-1",
      pageId: "page-4",
      typedText: "private working",
      questionPrompt: "private prompt",
      snapshot: {
        mimeType: "image/png",
        width: 100,
        height: 120,
        dataBase64: "snapshot-data",
      },
    });

    expect(saved).toEqual({
      surface: "notebook",
      notebookId: "notebook-1",
      pageId: "page-4",
    });
    // Scoped to the notebook, so a chat survives turning the page.
    expect(getJamiAssistantContextKey(saved)).toBe("notebook:notebook-1");
    expect(saved).not.toHaveProperty("typedText");
    expect(saved).not.toHaveProperty("questionPrompt");
    expect(saved).not.toHaveProperty("snapshot");
  });

  it("uses stable context keys for source selections regardless of order", () => {
    // Keyed on the selected source rather than the whole set, so adding one to
    // a comparison no longer invalidates the chat. Still order-independent.
    expect(
      getJamiAssistantContextKey({
        surface: "sources",
        sourceIds: ["source-b", "source-a"],
      })
    ).toBe("sources:source-a");
    expect(
      getJamiAssistantContextKey({
        surface: "sources",
        sourceIds: ["source-a", "source-b"],
      })
    ).toBe("sources:source-a");
  });

  it("creates compact thread titles from the opening message", () => {
    expect(createJamiAssistantThreadTitle("  Explain   the chain rule  ")).toBe(
      "Explain the chain rule"
    );
    const title = createJamiAssistantThreadTitle("a".repeat(200));
    expect(title).toHaveLength(JAMI_ASSISTANT_MAX_THREAD_TITLE_LENGTH);
    expect(title.endsWith("...")).toBe(true);
  });

  it("rejects malformed stored records and normalizes safe receipts", () => {
    expect(mapJamiAssistantThread("bad", { title: "Missing context" })).toBeNull();
    expect(
      mapJamiAssistantThread("mismatched", {
        title: "Wrong binding",
        contextKey: "learn:another-card",
        context: { surface: "learn", cardId: "card-1" },
      })
    ).toBeNull();
    expect(
      mapJamiAssistantStoredMessage("bad", {
        threadId: "thread-1",
        role: "system",
        text: "Not an allowed role",
      })
    ).toBeNull();

    expect(
      mapJamiAssistantStoredMessage("message-1", {
        threadId: "thread-1",
        role: "assistant",
        text: "A concise answer.",
        used: [
          { kind: "source", label: "Lecture notes", id: "source-1" },
          { kind: "unsafe", label: "Ignore this" },
        ],
        followUps: [
          { label: "Show steps", prompt: "Show me the steps." },
          { label: "", prompt: "Ignore this." },
        ],
        citations: [
          { title: "Official specification", url: "https://example.edu/spec" },
          { title: "Unsafe", url: "javascript:alert(1)" },
        ],
        illustrations: [
          {
            id: "visual-1",
            storagePath:
              "users/user-1/assistantImages/visual-1/illustration.webp",
            mimeType: "image/webp",
            width: 1024,
            height: 768,
            altText: "A labelled diagram",
            caption: "Labelled diagram",
            createdAt: 9,
          },
        ],
        canIllustrate: true,
        createdAt: 10,
      })
    ).toMatchObject({
      id: "message-1",
      threadId: "thread-1",
      role: "assistant",
      used: [{ kind: "source", label: "Lecture notes", id: "source-1" }],
      followUps: [{ label: "Show steps", prompt: "Show me the steps." }],
      citations: [
        { title: "Official specification", url: "https://example.edu/spec" },
      ],
      illustrations: [
        expect.objectContaining({ id: "visual-1", mimeType: "image/webp" }),
      ],
      canIllustrate: true,
      createdAt: 10,
    });
  });

  it("keeps what Jami looked up with a saved answer, and only on an answer", () => {
    const steps = [{ tool: "search_web", label: "Searched the web for “AQA specification”" }];
    expect(
      mapJamiAssistantStoredMessage("a1", {
        threadId: "t1",
        role: "assistant",
        text: "An answer.",
        agentSteps: [...steps, { tool: "hack", label: "x" }],
        createdAt: 1,
      })?.agentSteps
    ).toEqual(steps);
    expect(
      mapJamiAssistantStoredMessage("u1", { threadId: "t1", role: "user", text: "A question.", agentSteps: steps, createdAt: 1 })
        ?.agentSteps
    ).toBeUndefined();
  });
});
