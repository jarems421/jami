import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getJamiAssistantContextKey } from "@/lib/ai/jami-assistant-history";
import {
  captureStructuredLogs,
  expectRedactedLogs,
} from "./support/log-capture";

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
    verifyIdToken: vi.fn(async () => ({ uid: "user-1" })),
    resolveContext: vi.fn(),
    checkBudget: vi.fn(),
    prepareSource: vi.fn(),
    retrieveChunks: vi.fn(),
    after: vi.fn(),
    applyMemory: vi.fn(async () => ({ added: 1, updated: 0, forgotten: 0, rejected: 0 })),
    generateText: vi.fn(),
    streamText: vi.fn(),
    generateResearch: vi.fn<
      (input: {
        sanitizedQuery: string;
        timeoutMs: number;
        urls?: readonly string[];
      }) => Promise<{ ok: boolean; reason: string }>
    >(async () => ({ ok: false, reason: "not_configured" })),
    refundBudget: vi.fn(),
    persisted: [] as Array<{ kind: string; path: string; data?: unknown }>,
    /** Saved documents by path, and saved chat messages, for tests that open a chat. */
    stored: new Map<string, Record<string, unknown>>(),
    storedMessages: [] as Array<{ id: string; data: Record<string, unknown> }>,
  };
});

vi.mock("@/services/firebase/admin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => {
    let autoId = 0;
    const collection = (path: string): Record<string, unknown> => ({
      path,
      doc: (requestedId?: string) => {
        const id = requestedId ?? `auto-${++autoId}`;
        const documentPath = `${path}/${id}`;
        return {
          id,
          path: documentPath,
          collection: (name: string) => collection(`${documentPath}/${name}`),
          get: vi.fn(async () => {
            const saved = mocks.stored.get(documentPath);
            return { exists: Boolean(saved), id, data: () => saved };
          }),
        };
      },
      where: vi.fn(() => ({
        get: vi.fn(async () =>
          path.endsWith("/assistantMessages")
            ? {
                empty: mocks.storedMessages.length === 0,
                docs: mocks.storedMessages.map((message) => ({ id: message.id, data: () => message.data })),
              }
            : { empty: true, docs: [] }
        ),
      })),
    });
    return {
      collection,
      batch: () => ({
        set: (ref: { path: string }, data: unknown) =>
          mocks.persisted.push({ kind: "set", path: ref.path, data }),
        create: (ref: { path: string }, data: unknown) =>
          mocks.persisted.push({ kind: "create", path: ref.path, data }),
        commit: vi.fn(async () => undefined),
      }),
    };
  },
  getAdminStorageBucket: () => ({
    file: vi.fn(() => ({ download: vi.fn() })),
  }),
}));

vi.mock("@/services/ai/assistant-context", () => ({
  JamiAssistantContextError: mocks.ContextError,
  resolveJamiAssistantContext: mocks.resolveContext,
}));

vi.mock("@/services/ai/budgets", () => ({
  checkAiBudget: mocks.checkBudget,
  createAiBudgetLimitResponse: (
    _action: string,
    decision: { reason: string; retryAfterSeconds: number }
  ) =>
    Response.json(
      {
        error:
          decision.reason === "burst_limit"
            ? "Jami is receiving requests too quickly. Try again in a moment."
            : "Jami has reached today's AI limit. Try again tomorrow.",
        code: decision.reason,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      {
        status: 429,
        headers:
          decision.reason === "burst_limit"
            ? { "Retry-After": String(decision.retryAfterSeconds) }
            : undefined,
      }
    ),
  getAiTokenCap: () => 8_000,
  refundAiBudget: mocks.refundBudget,
}));

vi.mock("@/lib/ai/source-ingestion", () => ({
  prepareSourceForTutor: mocks.prepareSource,
  normalizePreparedTutorSourceForTextModel: async (prepared: unknown) => prepared,
}));

vi.mock("@/services/ai/source-index.server", () => ({
  retrieveTutorEvidence: mocks.retrieveChunks,
}));

vi.mock("@/services/ai/tutor-memory.server", () => ({
  applyTutorMemoryFromAnswer: mocks.applyMemory,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));

function evidence(passages: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { passages, outlines: new Map(), targets: new Map(), ...extra };
}

vi.mock("@/lib/ai/provider-router", () => ({
  isAnyAiProviderConfigured: () => true,
  countAiInputTokens: vi.fn(async () => 100),
  generateAiText: (...args: unknown[]) => mocks.generateText(...args),
  streamAiText: async function* (...args: unknown[]) {
    const text: string = await mocks.streamText(...args);
    const size = Math.max(1, Math.ceil(text.length / 3));
    for (let at = 0; at < text.length; at += size) {
      yield text.slice(at, at + size);
    }
  },
}));

vi.mock("@/lib/ai/gemini", () => ({ generateGroundedResearch: mocks.generateResearch, isGroundedResearchConfigured: () => true }));

// No cleaner mock: the route uses the real cleanAiResponseText so these tests
// exercise the seam that previously flattened every reply.

let postAssistant: (request: NextRequest) => Promise<Response>;
let routeMaxDuration: number | undefined;

function request(
  body: Record<string, unknown>,
  authorization = "Bearer test-token"
) {
  return new Request("http://localhost/api/ai/assistant", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    message: "What is photosynthesis?",
    history: [],
    context: { surface: "learn", cardId: "card-1", phase: "answer" },
    useRelatedSources: true,
    ...overrides,
  };
}

/**
 * The route streams newline-delimited events. Text events carry the answer as
 * it generates; a single terminal event carries the validated receipt, or an
 * error raised after the response had already begun.
 */
async function readStream(response: Response) {
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    streamedText: events
      .filter((event) => event.type === "text")
      .map((event) => event.value as string)
      .join(""),
    terminal: events.find(
      (event) => event.type === "done" || event.type === "error"
    ) as Record<string, unknown> | undefined,
  };
}

beforeAll(async () => {
  const routeModule = await import("@/app/api/ai/assistant/route");
  postAssistant = routeModule.POST;
  routeMaxDuration = routeModule.maxDuration;
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persisted.length = 0;
  mocks.stored.clear();
  mocks.storedMessages.length = 0;
  mocks.verifyIdToken.mockResolvedValue({ uid: "user-1" });
  mocks.checkBudget.mockResolvedValue({
    allowed: true,
    reason: null,
    retryAfterSeconds: 0,
    grant: { key: "assistant:user-1", action: "assistant" },
  });
  mocks.resolveContext.mockResolvedValue({
    currentId: "card-1",
    currentLabel: "Current card",
    currentParts: [{ text: "Card front and answer" }],
    studyLevelContext:
      "Study-level preference: A level, IB or equivalent level (account default).",
    sources: [
      {
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
      },
    ],
  });
  mocks.prepareSource.mockResolvedValue({
    sourceId: "source-1",
    label: "Biology notes",
    inputBytes: 100,
    parts: [{ text: "Plants capture light energy." }],
  });
  mocks.retrieveChunks.mockResolvedValue(evidence());
  mocks.after.mockReset();
  const validAnswer = JSON.stringify({
    answer: "Plants turn light energy into stored chemical energy.",
    sourceRefs: ["S1"],
    usedCurrentContext: true,
    usedGeneralKnowledge: true,
    usedWebResearch: false,
  });
  mocks.streamText.mockResolvedValue(validAnswer);
  mocks.generateText.mockResolvedValue(validAnswer);
});

describe("universal Jami assistant route", () => {
  it("returns a validated answer and exact per-response Used context", async () => {
    const response = await postAssistant(request(validBody()));
    const { streamedText, terminal } = await readStream(response);

    expect(response.status).toBe(200);
    expect(streamedText).toBe(
      "Plants turn light energy into stored chemical energy."
    );
    expect(terminal).toMatchObject({
      type: "done",
      reply: "Plants turn light energy into stored chemical energy.",
      used: [
        { kind: "current-context", id: "card-1", label: "Current card" },
        { kind: "source", id: "source-1", label: "Biology notes" },
        { kind: "general-knowledge", label: "general knowledge" },
      ],
    });
    // A simple question gets its answer, not a row of offers under it.
    expect(terminal).not.toHaveProperty("followUps");
    expect(terminal).not.toHaveProperty("studyMaterialOffers");
    expect(mocks.resolveContext).toHaveBeenCalledWith({
      uid: "user-1",
      message: "What is photosynthesis?",
      context: { surface: "learn", cardId: "card-1", phase: "answer" },
      useRelatedSources: true,
      firstTurn: true,
    });
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        generationConfig: expect.objectContaining({
          maxOutputTokens: 1_500,
          responseSchema: expect.objectContaining({
            required: [
              "answer",
              "sourceRefs",
              "usedCurrentContext",
              "usedGeneralKnowledge",
              "usedWebResearch",
              "graphs",
            ],
          }),
        }),
        request: expect.objectContaining({
          systemInstruction: expect.stringMatching(
            /A level, IB or equivalent[\s\S]*give it directly[\s\S]*specification defines expected scope[\s\S]*current context C1 is authoritative[\s\S]*valid TeX delimiters[\s\S]*BRIEF mode/
          ),
        }),
      })
    );
    const generationRequest = mocks.streamText.mock.calls[0]?.[0] as {
      request: { contents: Array<{ parts: Array<{ text?: string }> }> };
    };
    const finalParts = generationRequest.request.contents.at(-1)?.parts ?? [];
    const referenceOrder = finalParts
      .map((part) => part.text ?? "")
      .join("\n");
    expect(referenceOrder.indexOf("REFERENCE S1")).toBeLessThan(
      referenceOrder.indexOf("REFERENCE C1")
    );
    expect(referenceOrder.indexOf("REFERENCE C1")).toBeLessThan(
      referenceOrder.indexOf("GROUNDING PRIORITY")
    );
    expect(referenceOrder).toContain(
      "ignore it completely when it is about something else"
    );
  });

  it("carries a chat started in the Library on in another place, and moves it there", async () => {
    const sourcesContext = { surface: "sources", sourceIds: ["source-1"] };
    mocks.stored.set("users/user-1/assistantThreads/thread-1", {
      title: "Enzymes",
      surface: "sources",
      context: sourcesContext,
      contextKey: getJamiAssistantContextKey(sourcesContext as never),
      contextLabel: "Biology notes",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
    });
    // What the old place decided about withholding answers does not follow the chat.
    mocks.stored.set("users/user-1/assistantRouteState/thread-1", { phase: "question" });
    mocks.storedMessages.push(
      { id: "m1", data: { threadId: "thread-1", role: "user", text: "Why do enzymes denature?", createdAt: 1 } },
      { id: "m2", data: { threadId: "thread-1", role: "assistant", text: "Heat breaks the bonds that hold their shape.", createdAt: 2 } }
    );

    const response = await postAssistant(request(validBody({ threadId: "thread-1" })));
    const { terminal } = await readStream(response);

    expect(response.status).toBe(200);
    const generation = mocks.streamText.mock.calls[0]?.[0] as {
      request: { systemInstruction: string; contents: Array<{ parts: Array<{ text?: string }> }> };
    };
    // Tutor knows where it began and where it is now, and keeps the dialogue.
    expect(generation.request.systemInstruction).toContain("This conversation began about their material in the Library");
    expect(generation.request.systemInstruction).toContain("while reviewing flashcards");
    expect(JSON.stringify(generation.request.contents)).toContain("Heat breaks the bonds");
    // The chat now lives where the student carried it on.
    const threadWrite = mocks.persisted.find((entry) => entry.path === "users/user-1/assistantThreads/thread-1");
    expect(threadWrite?.data).toMatchObject({ surface: "learn", context: { surface: "learn", cardId: "card-1" } });
    expect(terminal).toMatchObject({ savedThread: { id: "thread-1", surface: "learn" } });
  });

  it("asks what to make first when the student names nothing, and makes nothing yet", async () => {
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: "Happy to. What should they focus on?",
        sourceRefs: [],
        usedCurrentContext: false,
        usedGeneralKnowledge: true,
        usedWebResearch: false,
        graphs: [],
        studyMaterial: "none",
        studyMaterialFocus: "",
        studyMaterialTopics: ["Osmosis", "Enzymes", "Osmosis"],
      })
    );

    const response = await postAssistant(
      request(validBody({ message: "make me flashcards", context: { surface: "sources", sourceIds: ["source-1"] } }))
    );
    const { terminal } = await readStream(response);

    expect(terminal).toMatchObject({
      type: "done",
      studyMaterialSetup: { kind: "flashcards", kinds: ["flashcards", "practice"], topics: ["Osmosis", "Enzymes"] },
    });
    expect(terminal).not.toHaveProperty("studyMaterialRequest");
    expect(terminal).not.toHaveProperty("studyMaterialOffers");
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ systemInstruction: expect.stringContaining("has not said what on") }),
      })
    );
    const savedAnswer = mocks.persisted.find(
      (entry) => entry.kind === "create" && (entry.data as { role?: string }).role === "assistant"
    );
    expect(savedAnswer?.data).toMatchObject({ studyMaterialSetup: { kind: "flashcards" } });
  });

  it("agrees to make flashcards a student asks for, from any chat, and records it", async () => {
    const answer = JSON.stringify({
      answer: "Making you flashcards on the light reactions now.",
      sourceRefs: [],
      usedCurrentContext: true,
      usedGeneralKnowledge: false,
      usedWebResearch: false,
      graphs: [],
      studyMaterial: "flashcards",
      studyMaterialFocus: "photosynthesis: the light reactions",
    });
    mocks.streamText.mockResolvedValueOnce(answer);

    const response = await postAssistant(
      request(
        validBody({
          message: "can you make me 8 flashcards on this please?",
          context: { surface: "sources", sourceIds: ["source-1"] },
        })
      )
    );
    const { terminal } = await readStream(response);

    expect(terminal).toMatchObject({
      type: "done",
      studyMaterialRequest: {
        kind: "flashcards",
        focus: "photosynthesis: the light reactions",
        count: 8,
      },
    });
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          systemInstruction: expect.stringMatching(
            /never send them to Sources[\s\S]*The student has asked for flashcards\. Set studyMaterial to "flashcards"/
          ),
        }),
      })
    );
    const savedAnswer = mocks.persisted.find(
      (entry) =>
        entry.kind === "create" &&
        (entry.data as { role?: string }).role === "assistant"
    );
    expect(savedAnswer?.data).toMatchObject({
      studyMaterialRequest: { kind: "flashcards", focus: "photosynthesis: the light reactions" },
      studyMaterialFocus: "photosynthesis: the light reactions",
    });
  });

  it("knows the app: links to real places, and adds the pages a student asks for", async () => {
    const resolved = await mocks.resolveContext.getMockImplementation()?.({});
    mocks.resolveContext.mockResolvedValueOnce({
      ...(resolved as Record<string, unknown>),
      folderIds: ["bio"],
    });
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: "Adding ten pages to this notebook. Your decks live in [Flashcards](jami:flashcards), not [here](jami:made_up).",
        sourceRefs: [],
        usedCurrentContext: true,
        usedGeneralKnowledge: false,
        usedWebResearch: false,
        graphs: [],
        appActions: [
          { type: "add_pages", count: 10 },
          { type: "open", destination: "this_folder" },
          { type: "open", destination: "admin_panel" },
        ],
      })
    );

    const response = await postAssistant(
      request(
        validBody({
          message: "can you add 10 pages to this notebook?",
          context: { surface: "notebook", notebookId: "nb1", pageId: "p1" },
        })
      )
    );
    const { terminal } = await readStream(response);

    expect(terminal).toMatchObject({
      type: "done",
      reply: "Adding ten pages to this notebook. Your decks live in [Flashcards](/dashboard/decks), not here.",
      appActions: [
        { type: "add_pages", count: 10, autoRun: true },
        { type: "open", destination: "this_folder", href: "/dashboard/folders/bio", autoRun: false },
      ],
      appScope: { folderId: "bio", notebookId: "nb1" },
    });
    const call = mocks.streamText.mock.calls[0]?.[0] as {
      request: { systemInstruction: string };
      generationConfig: { responseSchema: { properties: Record<string, unknown> } };
    };
    expect(call.request.systemInstruction).toContain("HOW JAMI WORKS");
    expect(call.request.systemInstruction).toContain("add_pages: add blank pages");
    expect(call.generationConfig.responseSchema.properties).toHaveProperty("appActions");
    const savedAnswer = mocks.persisted.find(
      (entry) => entry.kind === "create" && (entry.data as { role?: string }).role === "assistant"
    );
    expect(savedAnswer?.data).toMatchObject({
      appActions: [{ type: "add_pages", count: 10 }, { type: "open", destination: "this_folder" }],
    });
  });

  it("offers only what Tutor suggests after teaching", async () => {
    const answer = JSON.stringify({
      answer: `${"Light is absorbed by chlorophyll and drives the splitting of water. ".repeat(6)}`,
      sourceRefs: [],
      usedCurrentContext: false,
      usedGeneralKnowledge: true,
      usedWebResearch: false,
      graphs: [],
      studyMaterial: "none",
      studyMaterialFocus: "why photosynthesis needs light",
      suggestions: ["practice"],
    });
    mocks.streamText.mockResolvedValueOnce(answer);

    const response = await postAssistant(
      request(validBody({ message: "I'm struggling to see why plants need light, can you explain?" }))
    );
    const { terminal } = await readStream(response);

    expect(terminal).toMatchObject({ studyMaterialOffers: ["practice"] });
    expect(terminal).not.toHaveProperty("followUps");
    expect(terminal).not.toHaveProperty("studyMaterialRequest");
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          responseSchema: expect.objectContaining({
            properties: expect.objectContaining({
              suggestions: expect.objectContaining({
                items: expect.objectContaining({
                  enum: ["steps", "flashcards", "practice"],
                }),
              }),
            }),
          }),
        }),
        request: expect.objectContaining({
          systemInstruction: expect.stringContaining(
            '"flashcards": when you have taught or explained something the student will need to remember later'
          ),
        }),
      })
    );
  });

  it("can offer several next steps when Tutor suggests several", async () => {
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: `${"Light is absorbed by chlorophyll and drives the splitting of water. ".repeat(6)}`,
        sourceRefs: [],
        usedCurrentContext: false,
        usedGeneralKnowledge: true,
        usedWebResearch: false,
        graphs: [],
        studyMaterial: "none",
        studyMaterialFocus: "why photosynthesis needs light",
        suggestions: ["flashcards", "practice"],
      })
    );

    const { terminal } = await readStream(
      await postAssistant(
        request(validBody({ message: "I'm struggling to see why plants need light, can you explain?" }))
      )
    );

    expect(terminal).toMatchObject({ studyMaterialOffers: ["flashcards", "practice"] });
  });

  it("offers nothing after teaching when Tutor suggests nothing", async () => {
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: `${"Light is absorbed by chlorophyll and drives the splitting of water. ".repeat(6)}`,
        sourceRefs: [],
        usedCurrentContext: false,
        usedGeneralKnowledge: true,
        usedWebResearch: false,
        graphs: [],
        studyMaterial: "none",
        studyMaterialFocus: "why photosynthesis needs light",
        suggestions: [],
      })
    );

    const { terminal } = await readStream(
      await postAssistant(
        request(validBody({ message: "I'm struggling to see why plants need light, can you explain?" }))
      )
    );

    expect(terminal).not.toHaveProperty("studyMaterialOffers");
    expect(terminal).not.toHaveProperty("followUps");
  });

  it("never offers Explain more; a student who wants more asks", async () => {
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: "Plants turn light energy into stored chemical energy.",
        sourceRefs: [],
        usedCurrentContext: true,
        usedGeneralKnowledge: true,
        usedWebResearch: false,
        suggestions: ["more"],
      })
    );

    const { terminal } = await readStream(await postAssistant(request(validBody())));

    expect(terminal).not.toHaveProperty("followUps");
  });

  it("puts the learner profile in the system instruction when there is one", async () => {
    const resolved = await mocks.resolveContext.getMockImplementation()?.({});
    mocks.resolveContext.mockResolvedValueOnce({
      ...(resolved as Record<string, unknown>),
      learningContext:
        '--- LEARNER PROFILE ---\nNeeds attention:\n- "Eigenvectors": mastery 43%\n--- END LEARNER PROFILE ---',
    });

    const response = await postAssistant(request(validBody()));
    await readStream(response);

    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          systemInstruction: expect.stringMatching(
            /Work in a notebook often runs across a page break[\s\S]*--- LEARNER PROFILE ---[\s\S]*"Eigenvectors": mastery 43%[\s\S]*Return JSON only/
          ),
        }),
      })
    );
  });

  it("returns the reply with its Markdown and LaTeX intact", async () => {
    mocks.streamText.mockResolvedValue(
      JSON.stringify({
        answer:
          "**Method**\n\n1. Differentiate: $f'(x) = 2x$\n2. Solve for $x_1$.\n\n$$\\frac{n(n+1)}{2}$$",
        sourceRefs: [],
        usedCurrentContext: true,
        usedGeneralKnowledge: false,
      })
    );

    const { terminal } = await readStream(
      await postAssistant(request(validBody()))
    );
    const body = terminal as { reply: string };

    expect(body.reply).toContain("**Method**");
    expect(body.reply).toContain("$f'(x) = 2x$");
    expect(body.reply).toContain("$x_1$");
    expect(body.reply).toContain("\\frac{n(n+1)}{2}");
  });

  it("uses the larger response budget only for an explicit depth request", async () => {
    // Read to the end: a Think answer looks things up first, inside the stream.
    await readStream(await postAssistant(request(validBody({ message: "Walk me through this in detail, step by step." }))));

    // Worked through on the fast model thinking hard, with the detailed answer's budget.
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        reasoningEffort: "high",
        generationConfig: expect.objectContaining({ maxOutputTokens: 6_000 }),
        request: expect.objectContaining({
          systemInstruction: expect.stringContaining("DETAILED mode"),
        }),
      })
    );
  });

  it("rejects unauthenticated and invalid surface requests before generation", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new Error("expired"));
    const unauthorized = await postAssistant(request(validBody()));
    expect(unauthorized.status).toBe(401);

    const invalid = await postAssistant(
      request(validBody({ context: { surface: "goals", id: "goal-1" } }))
    );
    expect(invalid.status).toBe(400);
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("does not expose or continue with an unowned current context", async () => {
    mocks.resolveContext.mockRejectedValueOnce(
      new mocks.ContextError("This card could not be found.")
    );
    const response = await postAssistant(request(validBody()));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "context_not_found" });
    expect(mocks.checkBudget).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("rejects obviously oversized source selections before charging", async () => {
    mocks.resolveContext.mockResolvedValueOnce({
      currentId: "card-1",
      currentLabel: "Current card",
      currentParts: [{ text: "Card front and answer" }],
      sources: [
        {
          id: "source-large",
          title: "Large paper",
          type: "file",
          folderIds: [],
          topicIds: [],
          status: "active",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
          sizeBytes: 31 * 1024 * 1024,
        },
      ],
      // Chosen by the student, so it would be read whole.
      pinnedSourceIds: ["source-large"],
    });

    const response = await postAssistant(request(validBody()));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "sources_too_large",
    });
    expect(mocks.checkBudget).not.toHaveBeenCalled();
    expect(mocks.prepareSource).not.toHaveBeenCalled();
  });

  it("never reports an invented source reference, and keeps the answer the student has read", async () => {
    const invalidAnswer = JSON.stringify({
      answer: "Unsupported answer.",
      sourceRefs: ["S9"],
      usedCurrentContext: false,
      usedGeneralKnowledge: true,
    });
    mocks.streamText.mockResolvedValue(invalidAnswer);
    mocks.generateText.mockResolvedValue(invalidAnswer);

    const response = await postAssistant(request(validBody()));
    const { streamedText, terminal } = await readStream(response);

    expect(response.status).toBe(200);
    expect(streamedText).toBe("Unsupported answer.");
    expect(terminal).toMatchObject({
      type: "done",
      reply: "Unsupported answer.",
      used: [{ kind: "general-knowledge", label: "general knowledge" }],
    });
    // Asking again would only replace the answer already on screen.
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("retries one malformed structured response with the alternate model", async () => {
    mocks.streamText.mockResolvedValue('{"answer":"Incomplete');

    const response = await postAssistant(request(validBody()));
    const { terminal } = await readStream(response);

    expect(response.status).toBe(200);
    expect(terminal).toMatchObject({ type: "done" });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.generateText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        role: "worker",
        generationConfig: expect.objectContaining({ maxOutputTokens: 8_000 }),
        request: expect.objectContaining({
          systemInstruction: expect.stringContaining(
            "This is a structured-output retry"
          ),
        }),
      })
    );
  });

  it("can answer from general knowledge when a related source is unreadable", async () => {
    mocks.prepareSource.mockRejectedValueOnce(new Error("Unreadable file"));
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: "A general explanation.",
        sourceRefs: [],
        usedCurrentContext: false,
        usedGeneralKnowledge: true,
      })
    );
    const response = await postAssistant(request(validBody()));
    const { terminal } = await readStream(response);

    expect(response.status).toBe(200);
    expect(terminal).toMatchObject({
      type: "done",
      reply: "A general explanation.",
      used: [{ kind: "general-knowledge", label: "general knowledge" }],
      sourceFailures: [
        {
          id: "source-1",
          title: "Biology notes",
          reason: "Unreadable file",
        },
      ],
    });
  });

  it("leaves out an indexed folder source that has nothing relevant, rather than reading it whole", async () => {
    const resolved = (await mocks.resolveContext.getMockImplementation()?.({})) as {
      sources: Array<Record<string, unknown>>;
    };
    mocks.resolveContext.mockResolvedValueOnce({
      ...resolved,
      sources: [{ ...resolved.sources[0], indexStatus: "ready" }],
    });
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: "A general explanation.",
        sourceRefs: [],
        usedCurrentContext: true,
        usedGeneralKnowledge: true,
      })
    );

    const { terminal } = await readStream(await postAssistant(request(validBody())));

    expect(terminal).toMatchObject({ type: "done", reply: "A general explanation." });
    expect(terminal).not.toHaveProperty("sourceFailures");
    expect(mocks.prepareSource).not.toHaveBeenCalled();
  });

  it("gives each chosen source its own search and sends passages, not whole documents", async () => {
    const resolved = (await mocks.resolveContext.getMockImplementation()?.({})) as {
      sources: Array<Record<string, unknown>>;
    };
    mocks.resolveContext.mockResolvedValueOnce({
      ...resolved,
      pinnedSourceIds: ["source-1"],
      sources: [{ ...resolved.sources[0], indexStatus: "ready" }],
    });
    mocks.retrieveChunks.mockResolvedValueOnce(evidence([
      {
        id: "source-1-0003",
        sourceId: "source-1",
        sourceTitle: "Biology notes",
        chunkIndex: 3,
        text: "Chlorophyll absorbs red and blue light.",
        pageStart: 2,
        pageEnd: 2,
        distance: 0.2,
      },
    ]));

    await readStream(await postAssistant(request(validBody())));

    expect(mocks.retrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedSourceIds: ["source-1"], relatedSourceIds: [] })
    );
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    const generationRequest = mocks.streamText.mock.calls[0]?.[0] as {
      request: { contents: Array<{ parts: Array<{ text?: string }> }>; systemInstruction: string };
    };
    const sent = generationRequest.request.contents
      .at(-1)
      ?.parts.map((part) => part.text ?? "")
      .join("\n");
    expect(sent).toContain("[p. 2]\nChlorophyll absorbs red and blue light.");
    expect(generationRequest.request.systemInstruction).toContain("Teach the ideas; do not reproduce the passages.");
  });

  it("reads the lecture a student names from a long pack, and labels where each passage is", async () => {
    const resolved = (await mocks.resolveContext.getMockImplementation()?.({})) as {
      sources: Array<Record<string, unknown>>;
    };
    mocks.resolveContext.mockResolvedValueOnce({
      ...resolved,
      pinnedSourceIds: ["source-1"],
      sources: [{ ...resolved.sources[0], title: "Thermal physics pack", indexStatus: "ready", indexVersion: 2 }],
    });
    const lecture4 = {
      key: "lecture:4",
      kind: "lecture",
      number: 4,
      title: "Entropy",
      label: "Lecture 4: Entropy",
      pageStart: 26,
      pageEnd: 33,
      chunkStart: 9,
      chunkEnd: 10,
    };
    mocks.retrieveChunks.mockResolvedValueOnce(evidence(
      [
        {
          id: "source-1-0009",
          sourceId: "source-1",
          sourceTitle: "Thermal physics pack",
          chunkIndex: 9,
          text: "Entropy of an isolated system never decreases.",
          pageStart: 26,
          pageEnd: 29,
          sectionLabel: "Lecture 4: Entropy",
          distance: 0.3,
          targeted: true,
        },
      ],
      {
        outlines: new Map([["source-1", {
          sourceId: "source-1",
          pageKind: "page",
          sections: [
            { ...lecture4, key: "lecture:3", number: 3, title: "The first law", label: "Lecture 3: The first law", pageStart: 18, pageEnd: 25, chunkStart: 7, chunkEnd: 8 },
            lecture4,
          ],
          chunkCount: 11,
          chunkPageStarts: [],
          chunkPageEnds: [],
        }]]),
        targets: new Map([["source-1", {
          chunkIndexes: [9, 10],
          sections: [lecture4],
          missing: [],
          via: "named",
        }]]),
      }
    ));

    await readStream(await postAssistant(request(validBody({
      message: "In lecture 4, why does entropy increase?",
    }))));

    expect(mocks.retrieveChunks).toHaveBeenCalledWith(expect.objectContaining({
      references: { sections: [{ kind: "lecture", number: 4 }], pages: [] },
      focusText: "In lecture 4, why does entropy increase?",
    }));
    const generationRequest = mocks.streamText.mock.calls[0]?.[0] as {
      request: { contents: Array<{ parts: Array<{ text?: string }> }>; systemInstruction: string };
    };
    const sent = generationRequest.request.contents
      .at(-1)
      ?.parts.map((part) => part.text ?? "")
      .join("\n");
    expect(sent).toContain("- Lecture 4: Entropy (pp. 26–33)  <- asked about");
    expect(sent).toContain("The student asked about Lecture 4: Entropy");
    expect(sent).toContain("[Lecture 4: Entropy · pp. 26–29]\nEntropy of an isolated system never decreases.");
    expect(generationRequest.request.systemInstruction).toContain(
      "When the student names a part of their material"
    );
    // A current index is not rebuilt.
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("searches a folder's file for the named lecture as if the student had chosen it", async () => {
    const resolved = (await mocks.resolveContext.getMockImplementation()?.({})) as {
      sources: Array<Record<string, unknown>>;
    };
    mocks.resolveContext.mockResolvedValueOnce({
      ...resolved,
      pinnedSourceIds: [],
      sources: [
        { ...resolved.sources[0], id: "lecture-3", title: "Lecture 3 - Heat engines.pdf", indexStatus: "ready", indexVersion: 2 },
        { ...resolved.sources[0], id: "lecture-4", title: "Lecture 4 - Entropy.pdf", indexStatus: "ready", indexVersion: 2 },
      ],
    });

    await readStream(await postAssistant(request(validBody({
      message: "What did lecture 4 say about the second law?",
    }))));

    expect(mocks.retrieveChunks).toHaveBeenCalledWith(expect.objectContaining({
      pinnedSourceIds: ["lecture-4"],
      relatedSourceIds: ["lecture-3"],
    }));
  });

  it("rebuilds an older index through the indexing route once the answer is on its way", async () => {
    const resolved = (await mocks.resolveContext.getMockImplementation()?.({})) as {
      sources: Array<Record<string, unknown>>;
    };
    mocks.resolveContext.mockResolvedValueOnce({
      ...resolved,
      pinnedSourceIds: ["source-1"],
      sources: [{ ...resolved.sources[0], indexStatus: "ready" }],
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await readStream(await postAssistant(request(validBody())));
      expect(mocks.after).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();

      await (mocks.after.mock.calls[0][0] as () => Promise<void>)();
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("http://localhost/api/ai/source-index"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
          body: JSON.stringify({ sourceId: "source-1" }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tells Tutor what it remembers, lets it propose changes, and keeps them after the answer", async () => {
    const resolved = (await mocks.resolveContext.getMockImplementation()?.({})) as Record<string, unknown>;
    mocks.resolveContext.mockResolvedValueOnce({
      ...resolved,
      folderIds: ["chemistry"],
      topicIds: ["moles"],
      memoryContext: "--- BEGIN TUTOR MEMORY t ---\n[m1] (finds hard) \"Finds moles hard\"\n--- END TUTOR MEMORY t ---",
      memoryRefs: new Map([["m1", "memory-1"]]),
      memoryWritable: true,
    });
    const operations = [{ action: "remember", kind: "plan", text: "About to try the moles questions" }];
    mocks.streamText.mockResolvedValueOnce(JSON.stringify({
      answer: "Let's work through one together.",
      sourceRefs: [],
      usedCurrentContext: true,
      usedGeneralKnowledge: true,
      usedWebResearch: false,
      graphs: [],
      memory: operations,
    }));

    const { terminal } = await readStream(await postAssistant(request(validBody())));

    expect(terminal).toMatchObject({ type: "done", reply: "Let's work through one together." });
    expect(mocks.resolveContext).toHaveBeenCalledWith(
      expect.objectContaining({ firstTurn: true })
    );
    const call = mocks.streamText.mock.calls[0]?.[0] as {
      request: { systemInstruction: string };
      generationConfig: { responseSchema: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(call.request.systemInstruction).toContain('[m1] (finds hard) "Finds moles hard"');
    expect(call.generationConfig.responseSchema.properties).toHaveProperty("memory");
    // Optional, the model left it out of every answer, so nothing was ever saved.
    expect(call.generationConfig.responseSchema.required).toContain("memory");
    expect(call.request.systemInstruction).toContain('{"memory":[],"answer":');
    expect(mocks.applyMemory).toHaveBeenCalledWith(expect.objectContaining({
      uid: "user-1",
      operations,
      context: { folderId: "chemistry", topicIds: ["moles"], surface: "learn" },
      refs: new Map([["m1", "memory-1"]]),
    }));
  });

  it("offers no memory field and saves nothing when memory is not in play", async () => {
    mocks.streamText.mockResolvedValueOnce(JSON.stringify({
      answer: "An answer.",
      sourceRefs: [],
      usedCurrentContext: true,
      usedGeneralKnowledge: true,
      usedWebResearch: false,
      graphs: [],
      memory: [{ action: "remember", kind: "goal", text: "Planted by an answer" }],
    }));

    await readStream(await postAssistant(request(validBody())));

    const call = mocks.streamText.mock.calls[0]?.[0] as {
      request: { systemInstruction: string };
      generationConfig: { responseSchema: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(call.generationConfig.responseSchema.properties).not.toHaveProperty("memory");
    expect(call.generationConfig.responseSchema.required).not.toContain("memory");
    expect(call.request.systemInstruction).not.toContain('"memory":[]');
    expect(mocks.applyMemory).not.toHaveBeenCalled();
  });

  it("hands a request for flashcards to the study-material panel instead of writing cards inline", async () => {
    mocks.streamText.mockResolvedValueOnce(JSON.stringify({
      answer: "I'll make flashcards on how light energy is captured.",
      sourceRefs: ["S1"],
      usedCurrentContext: false,
      usedGeneralKnowledge: true,
      studyMaterial: "flashcards",
      studyMaterialFocus: "how chlorophyll captures light energy",
    }));

    const { terminal } = await readStream(
      await postAssistant(request(validBody({ message: "Make flashcards from this." })))
    );

    expect(terminal).toMatchObject({
      type: "done",
      studyMaterialRequest: { kind: "flashcards", focus: "how chlorophyll captures light energy" },
    });
    expect(terminal).not.toHaveProperty("suggestedCards");
    const schema = (mocks.streamText.mock.calls.at(-1)?.[0] as {
      generationConfig: { responseSchema: { properties: Record<string, unknown> } };
    }).generationConfig.responseSchema.properties;
    // One way to make cards: the panel. The inline field is never offered.
    expect(schema).not.toHaveProperty("cards");
    expect(schema).toHaveProperty("studyMaterial");
  });

  it("can offer flashcards after a short answer drawn from sources, when Tutor suggests them", async () => {
    mocks.streamText.mockResolvedValueOnce(
      JSON.stringify({
        answer: "Plants turn light energy into stored chemical energy.",
        sourceRefs: ["S1"],
        usedCurrentContext: true,
        usedGeneralKnowledge: true,
        usedWebResearch: false,
        suggestions: ["flashcards"],
      })
    );
    const { terminal } = await readStream(
      await postAssistant(
        request(validBody({ context: { surface: "sources", sourceIds: ["source-1"] } }))
      )
    );

    expect(terminal).toMatchObject({ studyMaterialOffers: ["flashcards"] });
  });

  it("does not offer flashcards Tutor did not suggest, even from sources", async () => {
    const { terminal } = await readStream(
      await postAssistant(
        request(validBody({ context: { surface: "sources", sourceIds: ["source-1"] } }))
      )
    );

    expect(terminal).not.toHaveProperty("studyMaterialOffers");
  });

  it("enforces the transactional daily budget before provider work", async () => {
    mocks.checkBudget.mockResolvedValueOnce({
      allowed: false,
      reason: "daily_limit",
      retryAfterSeconds: 4_000,
    });
    const response = await postAssistant(request(validBody()));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      code: "daily_limit",
      retryAfterSeconds: 4_000,
    });
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("returns retry timing for a burst rejection", async () => {
    mocks.checkBudget.mockResolvedValueOnce({
      allowed: false,
      reason: "burst_limit",
      retryAfterSeconds: 12,
    });

    const response = await postAssistant(request(validBody()));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    await expect(response.json()).resolves.toMatchObject({
      code: "burst_limit",
      retryAfterSeconds: 12,
    });
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("fails closed when the budget store cannot be reached", async () => {
    mocks.checkBudget.mockRejectedValueOnce(new Error("Firestore unavailable"));

    const response = await postAssistant(request(validBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "budget_unavailable",
    });
    expect(mocks.prepareSource).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  /**
   * The logger redacts by field name, which is only worth anything if the route
   * actually routes its logs through it. This drives a real request whose every
   * moving part carries recognisable student text, then reads back what was
   * written.
   */
  it("logs a correlated request without writing student work to the log", async () => {
    mocks.prepareSource.mockRejectedValue(
      new Error("This source could not be read.")
    );
    mocks.streamText.mockRejectedValue(
      Object.assign(new Error("Gemini is overloaded"), { status: 503 })
    );

    const { records, lines } = await captureStructuredLogs(async () =>
      readStream(
        await postAssistant(
          request(
            validBody({ message: "Explain SECRET_STUDENT_QUESTION to me." })
          )
        )
      )
    );

    expectRedactedLogs({
      records,
      lines,
      route: "ai.assistant",
      // The unreadable source and the provider failure are one story.
      events: ["source.prepare_failed", "provider.failed"],
      studentText: [
        "SECRET_STUDENT_QUESTION",
        "Biology notes",
        "Plants capture light energy.",
        "Card front and answer",
      ],
    });

    const failure = records.find((record) => record.event === "provider.failed");
    expect(failure?.error).toMatchObject({ status: 503 });
    expect(failure?.uid).toBe("[redacted]");
  });
});

/**
 * The request budget, which is three numbers that have to agree.
 *
 * The platform's limit has to cover the route's own deadline, and the optional
 * work before the answer has to leave the answer enough of that deadline to
 * finish in. When they disagreed, a tutor reply either stopped mid-sentence
 * because the function was killed, or failed at once because the time had gone
 * on reading and researching.
 */
describe("request budget", () => {
  it("declares a platform duration that covers the route's own deadline", () => {
    // The route plans for 50s of work and then has to persist the turn. A
    // function without this ran on the account default, which is 10-15s.
    expect(routeMaxDuration).toBeGreaterThanOrEqual(50);
  });

  it("leaves the answer its share of the deadline when research runs first", async () => {
    mocks.generateResearch.mockResolvedValueOnce({
      ok: false,
      reason: "not_configured",
    });

    await readStream(await postAssistant(request(validBody({ message: "Search the web for the latest exam specification." }))));

    expect(mocks.generateResearch).toHaveBeenCalledTimes(1);
    const research = mocks.generateResearch.mock.calls[0][0];
    // It used to ask for 22s of a 50s deadline no matter how much had already
    // been spent, which on a slow read left the answer starting after its own
    // deadline had passed.
    expect(research.timeoutMs).toBeGreaterThan(0);
    expect(research.timeoutMs).toBeLessThanOrEqual(20_000);

    const answer = mocks.streamText.mock.calls[0]?.[0] as {
      deadlineAt: number;
      timeoutMs: number;
    };
    expect(answer.deadlineAt - Date.now()).toBeGreaterThanOrEqual(
      answer.timeoutMs - 1_000
    );
  });
});
