import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getJamiAssistantContextKey } from "@/lib/ai/jami-assistant-history";
import { captureStructuredLogs } from "./support/log-capture";

/**
 * What one Tutor turn does from start to finish, pinned so the route can be
 * reorganised without changing it: what is saved and in which order, which
 * events reach the student and in which order, when the request is handed
 * back, and how quick checks, markings, research, recall, a second opinion and
 * attachments flow through a turn.
 */

const NOW = 1_800_000_000_000;

const mocks = vi.hoisted(() => {
  class ContextError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(message: string, status = 404, code = "context_not_found") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    ContextError,
    providerConfigured: { value: true },
    verifyIdToken: vi.fn(),
    resolveContext: vi.fn(),
    checkBudget: vi.fn(),
    refundBudget: vi.fn(),
    prepareSource: vi.fn(),
    retrieveEvidence: vi.fn(),
    generateText: vi.fn(),
    streamText: vi.fn(),
    countTokens: vi.fn(),
    generateResearch: vi.fn(),
    chargeAllowance: vi.fn(),
    recordCheck: vi.fn(),
    recordMarking: vi.fn(),
    applyMemory: vi.fn(),
    loadRecall: vi.fn(),
    after: vi.fn(),
    /** Every batch write, in the order the route made it, then the commit. */
    writes: [] as Array<{ kind: string; path: string; data?: unknown; options?: unknown }>,
    stored: new Map<string, Record<string, unknown>>(),
    storedMessages: [] as Array<{ id: string; data: Record<string, unknown> }>,
    folders: [] as Array<{ id: string; name: unknown }>,
  };
});

vi.mock("@/services/firebase/admin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => {
    let autoId = 0;
    const query = (path: string): Record<string, unknown> => ({
      where: () => query(path),
      limit: () => query(path),
      get: async () => {
        if (path.endsWith("/assistantMessages")) {
          return { docs: mocks.storedMessages.map((message) => ({ id: message.id, data: () => message.data })) };
        }
        if (path.endsWith("/folders")) {
          return { docs: mocks.folders.map((folder) => ({ id: folder.id, get: () => folder.name })) };
        }
        return { docs: [] };
      },
    });
    const collection = (path: string): Record<string, unknown> => ({
      ...query(path),
      doc: (requestedId?: string) => {
        const id = requestedId ?? `auto-${++autoId}`;
        const documentPath = `${path}/${id}`;
        return {
          id,
          path: documentPath,
          collection: (name: string) => collection(`${documentPath}/${name}`),
          get: async () => {
            const saved = mocks.stored.get(documentPath);
            return { exists: Boolean(saved), id, data: () => saved };
          },
        };
      },
    });
    return {
      collection,
      batch: () => ({
        set: (ref: { path: string }, data: unknown, options?: unknown) =>
          mocks.writes.push({ kind: "set", path: ref.path, data, ...(options ? { options } : {}) }),
        create: (ref: { path: string }, data: unknown) => mocks.writes.push({ kind: "create", path: ref.path, data }),
        commit: async () => {
          mocks.writes.push({ kind: "commit", path: "" });
        },
      }),
    };
  },
  getAdminStorageBucket: () => ({ file: () => ({ download: async () => [Buffer.from("file")] }) }),
}));

vi.mock("@/services/ai/assistant-context", () => ({
  JamiAssistantContextError: mocks.ContextError,
  resolveJamiAssistantContext: mocks.resolveContext,
}));

vi.mock("@/services/ai/budgets", () => ({
  checkAiBudget: mocks.checkBudget,
  createAiBudgetLimitResponse: (_action: string, decision: { reason: string }) =>
    Response.json({ code: decision.reason }, { status: 429 }),
  getAiTokenCap: () => 8_000,
  refundAiBudget: mocks.refundBudget,
}));

vi.mock("@/lib/ai/source-ingestion", () => ({
  prepareSourceForTutor: mocks.prepareSource,
  normalizePreparedTutorSourceForTextModel: async (prepared: unknown) => prepared,
}));

vi.mock("@/services/ai/source-index.server", () => ({ retrieveTutorEvidence: mocks.retrieveEvidence }));
vi.mock("@/services/ai/tutor-memory.server", () => ({ applyTutorMemoryFromAnswer: mocks.applyMemory }));
vi.mock("@/services/ai/tutor-chat-recall.server", () => ({ loadTutorChatRecall: mocks.loadRecall }));
vi.mock("@/services/learning/tutor-checks.server", () => ({ recordTutorCheck: mocks.recordCheck }));
vi.mock("@/services/learning/notebook-markings.server", () => ({ recordNotebookMarking: mocks.recordMarking }));
vi.mock("@/services/billing/allowances.server", () => ({ chargeAllowance: mocks.chargeAllowance }));
vi.mock("@/lib/ai/gemini", () => ({
  generateGroundedResearch: mocks.generateResearch,
  isGroundedResearchConfigured: () => true,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));

vi.mock("@/lib/ai/provider-router", () => ({
  isAnyAiProviderConfigured: () => mocks.providerConfigured.value,
  countAiInputTokens: mocks.countTokens,
  generateAiText: mocks.generateText,
  streamAiText: async function* (...args: unknown[]) {
    const text: string = await mocks.streamText(...args);
    const size = Math.max(1, Math.ceil(text.length / 3));
    for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
  },
}));

let postAssistant: (request: NextRequest) => Promise<Response>;

const learnContext = { surface: "learn", cardId: "card-1", phase: "answer" };
const sourcesContext = { surface: "sources", sourceIds: ["source-1"] };
const notebookContext = { surface: "notebook", notebookId: "nb1", pageId: "p1" };

function answer(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    answer: "Plants turn light energy into stored chemical energy.",
    sourceRefs: ["S1"],
    usedCurrentContext: true,
    usedGeneralKnowledge: true,
    usedWebResearch: false,
    ...fields,
  });
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    title: "Biology notes",
    type: "manual_note",
    folderIds: [],
    topicIds: [],
    contentText: "Plants capture light energy.",
    status: "active",
    createdBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
    indexStatus: "ready",
    indexVersion: 2,
    ...overrides,
  };
}

function resolved(overrides: Record<string, unknown> = {}) {
  return {
    currentId: "card-1",
    currentLabel: "Current card",
    currentParts: [{ text: "Card front and answer" }],
    // Chosen, so its passages are read even though the search finds none.
    pinnedSourceIds: ["source-1"],
    sources: [source()],
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    message: "What is photosynthesis?",
    history: [],
    context: learnContext,
    useRelatedSources: true,
    ...overrides,
  };
}

function request(payload: Record<string, unknown>, signal?: AbortSignal) {
  return new Request("http://localhost/api/ai/assistant", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  }) as unknown as NextRequest;
}

async function events(response: Response) {
  return (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function streamCall(index = 0) {
  return mocks.streamText.mock.calls[index]?.[0] as {
    role: string;
    routeReason: string;
    request: { systemInstruction: string; contents: Array<{ role: string; parts: Array<{ text?: string }> }> };
    generationConfig: { responseSchema: { properties: Record<string, unknown> } };
  };
}

function sentText(index = 0) {
  return streamCall(index)
    .request.contents.at(-1)
    ?.parts.map((part) => part.text ?? "")
    .join("\n") ?? "";
}

function storeThread(id: string, context: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mocks.stored.set(`users/user-1/assistantThreads/${id}`, {
    title: "Enzymes",
    surface: context.surface,
    context,
    contextKey: getJamiAssistantContextKey(context as never),
    contextLabel: "Saved label",
    createdAt: 5,
    updatedAt: 6,
    messageCount: 4,
    lastAssistantMessageId: "m4",
    ...extra,
  });
  mocks.storedMessages.push(
    { id: "m1", data: { threadId: id, role: "user", text: "Why do enzymes denature?", createdAt: 1 } },
    { id: "m2", data: { threadId: id, role: "assistant", text: "Heat breaks the bonds.", createdAt: 2 } },
    { id: "m3", data: { threadId: id, role: "user", text: "That's wrong, check again", createdAt: 3 } },
    { id: "m4", data: { threadId: id, role: "assistant", text: "Rechecked: heat unfolds them.", createdAt: 4 } }
  );
}

const pendingCheck = {
  id: "check-1",
  topicKeys: ["topic:enzymes"],
  scope: { folderId: "bio" },
  points: [
    { criterion: "Says the shape changes", marks: 1 },
    { criterion: "Says the active site no longer fits", marks: 2 },
  ],
  askedAt: NOW - 60_000,
};

beforeAll(async () => {
  postAssistant = (await import("@/app/api/ai/assistant/route")).POST;
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mocks.providerConfigured.value = true;
  mocks.writes.length = 0;
  mocks.stored.clear();
  mocks.storedMessages.length = 0;
  mocks.folders.length = 0;
  mocks.verifyIdToken.mockResolvedValue({ uid: "user-1" });
  mocks.resolveContext.mockResolvedValue(resolved());
  mocks.checkBudget.mockResolvedValue({
    allowed: true,
    reason: null,
    retryAfterSeconds: 0,
    grant: { key: "assistant:user-1", action: "assistant" },
  });
  mocks.refundBudget.mockResolvedValue(undefined);
  mocks.prepareSource.mockImplementation(async (input: { id: string }) => ({
    sourceId: input.id,
    label: input.id,
    inputBytes: 100,
    parts: [{ text: `Text of ${input.id}` }],
  }));
  mocks.retrieveEvidence.mockResolvedValue({
    passages: [
      {
        id: "source-1-0001",
        sourceId: "source-1",
        sourceTitle: "Biology notes",
        chunkIndex: 1,
        text: "Chlorophyll absorbs red and blue light.",
        pageStart: 2,
        pageEnd: 2,
        distance: 0.2,
      },
    ],
    outlines: new Map(),
    targets: new Map(),
  });
  mocks.generateText.mockResolvedValue(answer());
  mocks.streamText.mockResolvedValue(answer());
  mocks.countTokens.mockResolvedValue(100);
  mocks.generateResearch.mockResolvedValue({ ok: false, reason: "not_configured" });
  mocks.chargeAllowance.mockResolvedValue({ allowed: true, refund: vi.fn(async () => undefined) });
  mocks.recordCheck.mockResolvedValue({ recorded: true });
  mocks.recordMarking.mockResolvedValue({ recorded: true });
  mocks.applyMemory.mockResolvedValue({ added: 0, updated: 0, forgotten: 0, rejected: 0 });
  mocks.loadRecall.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saving a Tutor turn", () => {
  it("saves a new chat, both messages and the route state in one batch, in that order", async () => {
    const response = await postAssistant(request(body({ contextLabel: "  Photosynthesis card  " })));
    const stream = await events(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    const reply = "Plants turn light energy into stored chemical energy.";
    expect(mocks.writes).toEqual([
      {
        kind: "set",
        path: "users/user-1/assistantThreads/auto-1",
        data: {
          title: "What is photosynthesis?",
          surface: "learn",
          context: { surface: "learn", cardId: "card-1" },
          contextKey: "learn:card-1",
          contextLabel: "Photosynthesis card",
          createdAt: NOW,
          updatedAt: NOW,
          lastMessagePreview: reply,
          lastAssistantMessageId: "auto-3",
          messageCount: 2,
        },
        options: { merge: true },
      },
      {
        kind: "create",
        path: "users/user-1/assistantMessages/auto-2",
        data: { threadId: "auto-1", role: "user", text: "What is photosynthesis?", createdAt: NOW },
      },
      {
        kind: "create",
        path: "users/user-1/assistantMessages/auto-3",
        data: {
          threadId: "auto-1",
          role: "assistant",
          text: reply,
          used: [
            { kind: "current-context", id: "card-1", label: "Current card" },
            { kind: "source", id: "source-1", label: "Biology notes" },
            { kind: "general-knowledge", label: "general knowledge" },
          ],
          followUps: [],
          citations: [],
          illustrations: [],
          canIllustrate: false,
          studyMaterialOffers: [],
          createdAt: NOW + 1,
        },
      },
      {
        kind: "set",
        path: "users/user-1/assistantRouteState/auto-1",
        data: {
          lastRole: "worker",
          lastTurnChallenged: false,
          lastAssistantMessageId: "auto-3",
          updatedAt: NOW,
        },
      },
      { kind: "commit", path: "" },
    ]);

    // Text as it arrives, then one terminal event carrying the saved chat.
    expect(stream.slice(0, -1).every((event) => event.type === "text")).toBe(true);
    expect(stream.slice(0, -1).map((event) => event.value).join("")).toBe(reply);
    expect(stream.at(-1)).toEqual({
      type: "done",
      reply,
      used: [
        { kind: "current-context", id: "card-1", label: "Current card" },
        { kind: "source", id: "source-1", label: "Biology notes" },
        { kind: "general-knowledge", label: "general knowledge" },
      ],
      savedThread: {
        id: "auto-1",
        title: "What is photosynthesis?",
        surface: "learn",
        contextKey: "learn:card-1",
        contextLabel: "Photosynthesis card",
        context: { surface: "learn", cardId: "card-1" },
        lastMessagePreview: reply,
        messageCount: 2,
        createdAt: NOW,
        updatedAt: NOW,
        lastAssistantMessageId: "auto-3",
      },
    });
    expect(mocks.refundBudget).not.toHaveBeenCalled();
  });

  it("carries on a saved chat from the server's history, not the browser's", async () => {
    storeThread("thread-1", learnContext);
    mocks.stored.set("users/user-1/assistantRouteState/thread-1", { lastRole: "worker" });

    const stream = await events(
      await postAssistant(
        request(
          body({
            threadId: "thread-1",
            message: "And what about pH?",
            history: [{ role: "user", text: "FORGED_BROWSER_HISTORY" }],
          })
        )
      )
    );

    const contents = JSON.stringify(streamCall().request.contents);
    expect(contents).toContain("Rechecked: heat unfolds them.");
    expect(contents).not.toContain("FORGED_BROWSER_HISTORY");
    expect(streamCall().request.contents.slice(0, 4).map((entry) => entry.role)).toEqual([
      "user",
      "model",
      "user",
      "model",
    ]);
    expect(mocks.writes[0]).toEqual({
      kind: "set",
      path: "users/user-1/assistantThreads/thread-1",
      data: {
        updatedAt: NOW,
        lastMessagePreview: "Plants turn light energy into stored chemical energy.",
        lastAssistantMessageId: "auto-2",
        messageCount: 6,
      },
      options: { merge: true },
    });
    expect(mocks.writes.map((write) => write.path)).toEqual([
      "users/user-1/assistantThreads/thread-1",
      "users/user-1/assistantMessages/auto-1",
      "users/user-1/assistantMessages/auto-2",
      "users/user-1/assistantRouteState/thread-1",
      "",
    ]);
    expect(stream.at(-1)).toMatchObject({
      type: "done",
      savedThread: {
        id: "thread-1",
        title: "Enzymes",
        contextLabel: "Saved label",
        messageCount: 6,
        createdAt: 5,
        lastAssistantMessageId: "auto-2",
      },
    });
    expect(mocks.resolveContext).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", firstTurn: false })
    );
  });

  it("refuses a saved chat that is not there before anything is charged", async () => {
    const response = await postAssistant(request(body({ threadId: "missing" })));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "That saved chat could not be found.",
      code: "thread_not_found",
    });
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.checkBudget).not.toHaveBeenCalled();
  });

  it("moves a chat carried on somewhere new, and leaves the old place's route state behind", async () => {
    storeThread("thread-1", sourcesContext);
    // Would call for a second opinion if it were trusted here.
    mocks.stored.set("users/user-1/assistantRouteState/thread-1", {
      lastRole: "supervisor",
      lastTurnChallenged: true,
      lastAssistantMessageId: "m4",
      pendingCheck,
    });

    const stream = await events(
      await postAssistant(
        request(body({ threadId: "thread-1", message: "That's wrong, check again please", contextLabel: "Card 1" }))
      )
    );

    expect(mocks.generateText).not.toHaveBeenCalledWith(expect.objectContaining({ role: "juror" }));
    expect(streamCall().role).toBe("supervisor");
    expect(streamCall().request.systemInstruction).toContain(
      "This conversation began about their material in the Library, and the student has now opened it while reviewing flashcards."
    );
    expect(streamCall().request.systemInstruction).not.toContain("These are the points you fixed for it");
    expect(mocks.writes[0]).toMatchObject({
      data: {
        surface: "learn",
        context: { surface: "learn", cardId: "card-1" },
        contextKey: "learn:card-1",
        contextLabel: "Card 1",
      },
    });
    expect(mocks.writes[0].data).not.toHaveProperty("title");
    expect(mocks.writes[0].data).not.toHaveProperty("createdAt");
    expect(stream.at(-1)).toMatchObject({ savedThread: { contextLabel: "Card 1", title: "Enzymes" } });
  });
});

describe("handing the request back", () => {
  it("refunds a provider failure and reports it as the terminal event", async () => {
    mocks.streamText.mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 503 }));

    const response = await postAssistant(request(body()));
    const stream = await events(response);

    expect(response.status).toBe(200);
    expect(stream).toEqual([
      {
        type: "error",
        error: "Jami could not finish that answer just now. Try again in a moment.",
        code: "provider_failure",
      },
    ]);
    expect(mocks.refundBudget).toHaveBeenCalledWith({ key: "assistant:user-1", action: "assistant" });
    expect(mocks.writes).toEqual([]);
  });

  it("refunds an answer that never parses, after one buffered retry", async () => {
    mocks.streamText.mockResolvedValueOnce('{"answer":"Incomplete');
    mocks.generateText.mockResolvedValueOnce('{"answer":"still broken');

    const stream = await events(await postAssistant(request(body())));

    expect(stream.map((event) => event.type)).toEqual(["text", "text", "error"]);
    expect(stream.at(-1)).toEqual({
      type: "error",
      error: "Jami could not produce a reliable answer just now. Try again.",
      code: "invalid_provider_response",
    });
    expect(mocks.refundBudget).toHaveBeenCalledTimes(1);
    expect(mocks.writes).toEqual([]);
  });

  it("refunds an answer that is empty once its figures are placed", async () => {
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "[graph 1]", sourceRefs: [] }));

    const stream = await events(await postAssistant(request(body())));

    expect(stream.at(-1)).toMatchObject({ type: "error", code: "invalid_provider_response" });
    expect(mocks.refundBudget).toHaveBeenCalledTimes(1);
    expect(mocks.writes).toEqual([]);
  });

  it("refunds a reader who left, without sending them an error", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.streamText.mockImplementationOnce(async (input: { signal: AbortSignal }) => {
      if (input.signal.aborted) throw new Error("aborted");
      return answer();
    });

    const { records, result } = await captureStructuredLogs(async () =>
      events(await postAssistant(request(body(), controller.signal)))
    );

    expect(result).toEqual([]);
    expect(mocks.refundBudget).toHaveBeenCalledTimes(1);
    expect(records.map((record) => record.event)).toContain("request.cancelled");
    expect(records.map((record) => record.event)).not.toContain("provider.failed");
  });

  it("refunds and refuses a request too large to send, before streaming", async () => {
    mocks.prepareSource.mockResolvedValueOnce({
      sourceId: "source-1",
      label: "source-1",
      inputBytes: 2 * 1024 * 1024,
      parts: [{ text: "A very long source" }],
    });
    mocks.retrieveEvidence.mockResolvedValueOnce({ passages: [], outlines: new Map(), targets: new Map() });
    mocks.resolveContext.mockResolvedValueOnce(resolved({ sources: [source({ indexStatus: undefined })] }));
    mocks.countTokens.mockResolvedValueOnce(300_000);

    const response = await postAssistant(request(body()));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "That is more material than Jami can read at once. Choose fewer sources and ask again.",
      code: "input_too_large",
    });
    expect(mocks.refundBudget).toHaveBeenCalledTimes(1);
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("streams the answer at the reasoning level the student chose", async () => {
    mocks.resolveContext.mockResolvedValueOnce(resolved({ reasoningEffort: "high" }));

    await events(await postAssistant(request(body())));

    expect(mocks.streamText).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "high" }));
  });

  it("refuses sources that turn out too large once read", async () => {
    mocks.prepareSource.mockResolvedValueOnce({
      sourceId: "source-1",
      label: "source-1",
      inputBytes: 31 * 1024 * 1024,
      parts: [{ text: "Huge" }],
    });
    mocks.retrieveEvidence.mockResolvedValueOnce({ passages: [], outlines: new Map(), targets: new Map() });
    mocks.resolveContext.mockResolvedValueOnce(resolved({ sources: [source({ indexStatus: undefined })] }));

    const response = await postAssistant(request(body()));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "sources_too_large" });
    expect(mocks.streamText).not.toHaveBeenCalled();
    // The request was charged before the sources were read; a refused turn gives it back.
    expect(mocks.refundBudget).toHaveBeenCalledTimes(1);
  });

  it("says plainly when no AI provider is configured", async () => {
    mocks.providerConfigured.value = false;

    const { records, result: response } = await captureStructuredLogs(() => postAssistant(request(body())));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "AI features are not configured", code: "not_configured" });
    expect(records.map((record) => record.event)).toEqual(["provider.not_configured"]);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("fails safely when the study context cannot be loaded", async () => {
    mocks.resolveContext.mockRejectedValueOnce(new Error("Firestore down"));

    const response = await postAssistant(request(body()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Jami could not load the current study context.",
      code: "context_load_failed",
    });
    expect(mocks.checkBudget).not.toHaveBeenCalled();
  });

  it("logs a completed turn with its counts", async () => {
    const { records } = await captureStructuredLogs(async () => events(await postAssistant(request(body()))));

    const completed = records.find((record) => record.event === "request.completed");
    expect(completed).toMatchObject({
      level: "info",
      route: "ai.assistant",
      depth: "brief",
      durationMs: 0,
      sourceCount: 1,
      sourceFailureCount: 0,
      sourcesConsidered: 1,
      sourcesSearchedWhole: 0,
      sourcesNotRelevant: 0,
      studyMaterialRequested: null,
      studyMaterialOffered: 0,
      followUpsOffered: [],
      practiceOffered: false,
      combinedSourceBytes: expect.any(Number),
      providerDiagnostics: [],
    });
  });
});

describe("quick checks and markings in a turn", () => {
  it("keeps a quick check Tutor asks in the route state, for the next message only", async () => {
    mocks.resolveContext.mockResolvedValueOnce(
      resolved({ checkTarget: { topicKeys: ["topic:enzymes"], scope: { folderId: "bio" } } })
    );
    mocks.streamText.mockResolvedValueOnce(
      answer({
        answer: "Quick check: what happens to an enzyme's shape when heated?",
        sourceRefs: [],
        quickCheck: { points: [{ criterion: "Shape changes", marks: 1 }] },
      })
    );

    await events(await postAssistant(request(body({ message: "I think I understand enzymes now" }))));

    expect(streamCall().request.systemInstruction).toContain("You may end your answer with one quick check");
    expect(streamCall().generationConfig.responseSchema.properties).toHaveProperty("quickCheck");
    const routeState = mocks.writes.find((write) => write.path.includes("assistantRouteState"));
    expect(routeState?.data).toEqual({
      lastRole: "worker",
      lastTurnChallenged: false,
      lastAssistantMessageId: "auto-3",
      pendingCheck: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        topicKeys: ["topic:enzymes"],
        scope: { folderId: "bio" },
        points: [{ criterion: "Shape changes", marks: 1 }],
        askedAt: NOW,
      },
      updatedAt: NOW,
    });
  });

  it("marks the answer to last turn's check after the turn is saved", async () => {
    storeThread("thread-1", learnContext);
    mocks.stored.set("users/user-1/assistantRouteState/thread-1", { pendingCheck });
    mocks.recordCheck.mockImplementationOnce(async () => {
      // Saved first: the check is outside the batch.
      expect(mocks.writes.at(-1)).toEqual({ kind: "commit", path: "" });
      return { recorded: true };
    });
    const verdict = { attempted: true, awarded: [true, false] };
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "Right about the shape.", sourceRefs: [], checkMarking: verdict }));

    const { records } = await captureStructuredLogs(async () =>
      events(await postAssistant(request(body({ threadId: "thread-1", message: "Enzymes lose their shape" }))))
    );

    expect(streamCall().request.systemInstruction).toMatch(
      /Your previous answer ended with a quick check[\s\S]*1\. "Says the shape changes"\n2\. "Says the active site no longer fits"/
    );
    expect(streamCall().generationConfig.responseSchema.properties).toHaveProperty("checkMarking");
    expect(mocks.recordCheck).toHaveBeenCalledWith({ uid: "user-1", pending: pendingCheck, verdict, markedAt: NOW });
    expect(records.map((record) => record.event)).toContain("tutor_check.recorded");
    // An answered check is not asked again.
    const routeState = mocks.writes.find((write) => write.path.includes("assistantRouteState"));
    expect(routeState?.data).not.toHaveProperty("pendingCheck");
  });

  it("records a notebook marking when the student asked to be marked", async () => {
    const notebookLearning = { conceptKeys: ["topic:t1"], attribution: "page-topics", workItemId: "notebook:nb1:p1" };
    mocks.resolveContext.mockResolvedValueOnce(resolved({ topicIds: ["t1"], notebookLearning }));
    const marking = { earned: 1, available: 2, points: [] };
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "One of two marks.", sourceRefs: [], marking }));
    mocks.recordMarking.mockResolvedValueOnce({ recorded: false, reason: "declined" });

    const { records } = await captureStructuredLogs(async () =>
      events(await postAssistant(request(body({ message: "Mark my work please", context: notebookContext }))))
    );

    expect(streamCall().request.systemInstruction).toContain("The student has asked to be marked.");
    expect(streamCall().generationConfig.responseSchema.properties).not.toHaveProperty("quickCheck");
    expect(mocks.recordMarking).toHaveBeenCalledWith({
      uid: "user-1",
      notebookId: "nb1",
      pageId: "p1",
      learning: notebookLearning,
      verdict: marking,
    });
    expect(records.map((record) => record.event)).toContain("marking.declined");
  });

  it("checks working without marking it, then offers to mark the corrected page", async () => {
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "Step 2 drops a sign.", sourceRefs: [] }));

    const sent = await events(
      await postAssistant(request(body({ message: "Check my working on this page.", context: notebookContext })))
    );

    expect(mocks.recordMarking).not.toHaveBeenCalled();
    const done = sent.find((event) => event.type === "done") as
      | { followUps?: Array<{ label: string; prompt: string }> }
      | undefined;
    const markAgain = done?.followUps?.find((followUp) => followUp.label === "Mark my updated work");
    expect(markAgain?.prompt).toMatch(/^Mark my work on this page/);
  });

  it("says which study action a recorded marking answered", async () => {
    const actionId = "folder:f1|knowledge_decay|topic:t1";
    const notebookLearning = {
      conceptKeys: ["topic:t1"],
      attribution: "page-topics",
      workItemId: "notebook:nb1:p1",
      interventionId: actionId,
    };
    mocks.resolveContext.mockResolvedValueOnce(resolved({ topicIds: ["t1"], notebookLearning }));
    const marking = { awardedMarks: 1, maxMarks: 2, criterionResults: [] };
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "One of two marks.", sourceRefs: [], marking }));
    mocks.recordMarking.mockResolvedValueOnce({ recorded: true });

    const sent = await events(await postAssistant(request(body({ message: "Mark my work please", context: notebookContext }))));

    expect(sent.find((event) => event.type === "done")?.completedActionId).toBe(actionId);
  });

  it("claims no completed action for a marking that was not recorded", async () => {
    const notebookLearning = {
      conceptKeys: ["topic:t1"],
      attribution: "page-topics",
      workItemId: "notebook:nb1:p1",
      interventionId: "folder:f1|knowledge_decay|topic:t1",
    };
    mocks.resolveContext.mockResolvedValueOnce(resolved({ topicIds: ["t1"], notebookLearning }));
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "Nothing to mark.", sourceRefs: [], marking: { canMark: false } }));
    mocks.recordMarking.mockResolvedValueOnce({ recorded: false, reason: "declined" });

    const sent = await events(await postAssistant(request(body({ message: "Mark my work please", context: notebookContext }))));

    expect(sent.find((event) => event.type === "done")).not.toHaveProperty("completedActionId");
  });

  it("does not mark a page when the student asked for an explanation", async () => {
    await events(
      await postAssistant(request(body({ message: "Explain how to do question 2", context: notebookContext })))
    );

    expect(mocks.recordMarking).not.toHaveBeenCalled();
    expect(streamCall().request.systemInstruction).not.toContain("The student has asked to be marked.");
  });

  it("applies Tutor's memory changes after the student has the answer", async () => {
    mocks.resolveContext.mockResolvedValueOnce(
      resolved({ folderIds: ["chemistry"], topicIds: ["moles"], memoryWritable: true, memoryRefs: new Map() })
    );
    const operations = [{ action: "remember", kind: "plan", text: "About to try the moles questions" }];
    mocks.streamText.mockResolvedValueOnce(answer({ memory: operations }));
    let sentBeforeMemory = false;
    mocks.applyMemory.mockImplementationOnce(async () => {
      sentBeforeMemory = mocks.writes.some((write) => write.kind === "commit");
      return { added: 1, updated: 0, forgotten: 0, rejected: 0 };
    });

    await events(await postAssistant(request(body())));

    expect(sentBeforeMemory).toBe(true);
    expect(mocks.applyMemory).toHaveBeenCalledWith({
      uid: "user-1",
      operations,
      context: { folderId: "chemistry", topicIds: ["moles"], surface: "learn" },
      refs: new Map(),
      now: NOW,
    });
  });
});

describe("what a turn reads", () => {
  it("adds a verified web brief, cites it, and charges one search", async () => {
    mocks.generateResearch.mockResolvedValueOnce({
      ok: true,
      brief: "The current specification is 8461.",
      citations: Array.from({ length: 10 }, (_, index) => ({ title: `Page ${index}`, url: `https://example.org/${index}` })),
    });
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "It is 8461.", sourceRefs: [], usedWebResearch: true }));

    const stream = await events(
      await postAssistant(request(body({ message: "Search the web for the latest exam specification." })))
    );

    expect(mocks.chargeAllowance).toHaveBeenCalledWith({ uid: "user-1", key: "searches" });
    expect(sentText()).toContain("REFERENCE W1");
    expect(sentText()).toContain("- Page 0: https://example.org/0");
    expect(streamCall().request.systemInstruction).toContain("W1 is a concise grounded web-research brief.");
    // Their course's convention wins over the web's, said in a sentence.
    expect(streamCall().request.systemInstruction).toContain("teach their material's version for their course");
    const done = stream.at(-1) as { citations: unknown[]; used: Array<{ kind: string }> };
    expect(done.citations).toHaveLength(8);
    expect(done.used.map((entry) => entry.kind)).toContain("web");
  });

  it("gives a search back when the research fails", async () => {
    const refund = vi.fn(async () => undefined);
    mocks.chargeAllowance.mockResolvedValueOnce({ allowed: true, refund });
    mocks.generateResearch.mockResolvedValueOnce({ ok: false, reason: "unavailable" });

    await events(await postAssistant(request(body({ message: "Search the web for the latest exam specification." }))));

    expect(refund).toHaveBeenCalledTimes(1);
    expect(streamCall().request.systemInstruction).toContain("Web verification was needed but unavailable.");
  });

  it("answers without searching when the month's searches are used", async () => {
    mocks.chargeAllowance.mockResolvedValueOnce({ allowed: false, key: "searches" });

    await events(await postAssistant(request(body({ message: "Search the web for the latest exam specification." }))));

    expect(mocks.generateResearch).not.toHaveBeenCalled();
    expect(streamCall().request.systemInstruction).toContain("The student has used this month's web searches");
  });

  it("asks for a blind second opinion when a supervisor answer is challenged again", async () => {
    storeThread("thread-1", learnContext);
    mocks.stored.set("users/user-1/assistantRouteState/thread-1", {
      lastRole: "supervisor",
      lastTurnChallenged: true,
      lastAssistantMessageId: "m4",
    });
    mocks.generateText.mockImplementation(async (input: { role: string }) =>
      input.role === "juror" ? "The reviewer thinks heat unfolds enzymes." : answer()
    );

    await events(
      await postAssistant(request(body({ threadId: "thread-1", message: "That's wrong, check again please" })))
    );

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ role: "juror", routeReason: "second_correction", timeoutMs: 18_000 })
    );
    expect(streamCall()).toMatchObject({ role: "supervisor", routeReason: "second_correction" });
    const sent = sentText();
    expect(sent).toContain("REFERENCE J1");
    expect(sent).toContain("The reviewer thinks heat unfolds enzymes.");
    expect(sent.indexOf("CURRENT STUDENT REQUEST")).toBeLessThan(sent.indexOf("REFERENCE J1"));
    expect(sent).toMatch(/Reconcile J1 against the original evidence yourself/);
    expect(mocks.writes.find((write) => write.path.includes("assistantRouteState"))?.data).toMatchObject({
      lastRole: "supervisor",
      lastTurnChallenged: true,
    });
  });

  it("thinks on the fast model about a question it can read as working, with no routing call", async () => {
    await events(
      await postAssistant(request(body({ message: "Why do the tides happen on both sides of the earth at once?" })))
    );

    expect(mocks.generateText).not.toHaveBeenCalledWith(expect.objectContaining({ routeReason: "routing_preflight" }));
    expect(streamCall()).toMatchObject({ role: "worker", reasoningEffort: "high", preferStandby: false });
  });

  it("looks things up before a Think answer, shows each step as it starts, and keeps them with the answer", async () => {
    let planned = 0;
    mocks.generateText.mockImplementation(async (input: { routeReason?: string }) => {
      if (input.routeReason === "agent_step") {
        planned += 1;
        return planned === 1 ? '{"tool":"work_out","query":"Why are there two tidal bulges?"}' : '{"tool":"done","query":""}';
      }
      return input.routeReason === "agent_check" ? "Two bulges: the Moon's pull differs across the Earth." : answer();
    });

    const sent = await events(
      await postAssistant(request(body({ message: "Why do the tides happen on both sides of the earth at once?" })))
    );

    expect(sent[0]).toEqual({
      type: "step",
      tool: "work_out",
      doing: "Working it through separately to check",
      done: "Worked it through separately to check",
    });
    const steps = [{ tool: "work_out", label: "Worked it through separately to check" }];
    expect(sent.find((event) => event.type === "done")?.agentSteps).toEqual(steps);
    expect(sentText()).toContain("REFERENCE V1");
    expect(streamCall().request.systemInstruction).toContain("V1 is an independent working");
    const saved = mocks.writes.find((write) => (write.data as Record<string, unknown> | undefined)?.role === "assistant");
    expect(saved?.data).toMatchObject({ agentSteps: steps });
  });

  it("answers a Quick question in one call, looking nothing up", async () => {
    mocks.resolveContext.mockResolvedValueOnce(resolved({ reasoningEffort: "low" }));
    const sent = await events(await postAssistant(request(body({ message: "Why do the tides happen on both sides of the earth at once?" }))));
    expect(mocks.generateText).not.toHaveBeenCalledWith(expect.objectContaining({ routeReason: "agent_step" }));
    expect(sent.some((event) => event.type === "step")).toBe(false);
  });

  it("asks the routing check about an open question, and answers deeply when it says so", async () => {
    mocks.generateText.mockImplementation(async (input: { routeReason?: string }) =>
      input.routeReason === "routing_preflight" ? '{"tier":"deep","confidence":"high"}' : answer()
    );

    await events(await postAssistant(request(body({ message: "Can you help me with my revision plan for chemistry?" }))));

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ role: "worker", routeReason: "routing_preflight", timeoutMs: 7_000, allowRoleEscalation: false })
    );
    expect(streamCall()).toMatchObject({ role: "supervisor", routeReason: "routing_preflight", preferStandby: true });
  });

  it("brings back what the student referred to from an earlier chat", async () => {
    mocks.loadRecall.mockResolvedValueOnce({ text: "Earlier: we solved x^2 = 4.", found: 1 });

    await events(await postAssistant(request(body({ message: "Do you remember what we did last time?" }))));

    expect(mocks.loadRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "user-1",
        message: "Do you remember what we did last time?",
        earlierInThread: [],
        deadlineAt: NOW + 20_000,
      })
    );
    const sent = sentText();
    expect(sent).toContain("REFERENCE R1");
    expect(sent).toContain("Earlier: we solved x^2 = 4.");
    expect(sent.indexOf("REFERENCE R1")).toBeLessThan(sent.indexOf("REFERENCE C1"));
  });

  it("reads files attached in the chat, saves this message's, and offers to keep one", async () => {
    mocks.folders.push({ id: "f-bio", name: " Biology " }, { id: "f-blank", name: "  " });
    const attachments = [
      { storagePath: "users/user-1/sourceFiles/chat-a/sheet.pdf", fileName: "sheet.pdf", fileType: "application/pdf", sizeBytes: 1000 },
      { storagePath: "users/user-1/sourceFiles/chat-b/old.pdf", fileName: "old.pdf", fileType: "application/pdf", sizeBytes: 2000 },
      { storagePath: "users/user-2/sourceFiles/chat-c/theirs.pdf", fileName: "theirs.pdf", fileType: "application/pdf", sizeBytes: 2000 },
    ];
    mocks.streamText.mockResolvedValueOnce(
      answer({
        answer: "Question 1 asks about osmosis.",
        sourceRefs: [],
        saveSource: { attachment: "A1", title: "Osmosis sheet", folder: "F1" },
      })
    );

    const stream = await events(
      await postAssistant(
        request(body({ message: "Save this sheet and explain question 1", context: sourcesContext, attachments, newAttachmentCount: 1 }))
      )
    );

    // Another student's file is never read.
    expect(mocks.prepareSource.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual([
      "attachment-1",
      "attachment-2",
    ]);
    expect(sentText()).toContain("Attached by the student: sheet.pdf");
    expect(streamCall().request.systemInstruction).toContain('F1 "Biology"');
    const userMessage = mocks.writes.find((write) => (write.data as { role?: string } | undefined)?.role === "user");
    expect((userMessage?.data as { attachments: unknown }).attachments).toEqual([attachments[0]]);
    expect(stream.at(-1)).toMatchObject({
      sourceSaveOffer: { attachment: attachments[0], title: "Osmosis sheet", folderId: "f-bio" },
    });
  });

  it("asks once more for a graph that was asked for and missing, and keeps it", async () => {
    mocks.streamText.mockResolvedValueOnce(answer({ answer: "Here is the parabola.", sourceRefs: [], graphs: [] }));
    mocks.generateText.mockImplementation(async (input: { routeReason?: string }) =>
      input.routeReason === "routing_preflight"
        ? "{}"
        : answer({
            answer: "Here it is.\n\n[graph 1]",
            sourceRefs: [],
            graphs: ['{"title":"y = x^2 - 4","x":[-5,5],"functions":["x^2 - 4"]}'],
          })
    );

    const stream = await events(await postAssistant(request(body({ message: "Draw a graph of y = x^2 - 4" }))));

    // Past the routing check and the agent's own look-ups, to the answer asked again.
    const retry = mocks.generateText.mock.calls.find(
      (call) => !["routing_preflight", "agent_step", "agent_check"].includes((call[0] as { routeReason?: string }).routeReason ?? "")
    )?.[0] as { generationConfig: { maxOutputTokens: number }; request: { systemInstruction: string } };
    expect(retry.generationConfig.maxOutputTokens).toBe(8_000);
    expect(
      retry.request.systemInstruction.endsWith(
        "\nThe student asked for a graph and the last answer had none. Put the graph in the graphs field as a JSON object written as a string, and write [graph 1] in the answer where it belongs."
      )
    ).toBe(true);
    expect((stream.at(-1) as { reply: string }).reply).toContain("```graph");
  });

  it("passes the engine's offers through when the turn reads as what next", async () => {
    const offer = { actionId: "a1", title: "Next", label: "Go", href: "/next" };
    const practice = { actionId: "a2", title: "Practise", label: "Go", href: "/practise" };
    mocks.resolveContext.mockResolvedValueOnce(
      resolved({ learningContext: "--- LEARNER PROFILE ---", nextStepOffer: offer, practiceOffer: practice })
    );
    mocks.streamText.mockResolvedValueOnce(answer({ offerNextStep: true }));

    const stream = await events(await postAssistant(request(body({ message: "What should I do next?" }))));

    expect(stream.at(-1)).toMatchObject({ nextStepOffer: offer, practiceOffer: practice });
    const saved = mocks.writes.find((write) => (write.data as { role?: string } | undefined)?.role === "assistant");
    // Live advice: shown, never saved with the conversation.
    expect(saved?.data).not.toHaveProperty("nextStepOffer");
    expect(saved?.data).not.toHaveProperty("practiceOffer");
  });
});
