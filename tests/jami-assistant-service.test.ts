import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(async () => "test-token"),
}));

vi.mock("@/services/firebase/client", () => ({
  auth: {
    currentUser: {
      getIdToken: mocks.getIdToken,
    },
  },
}));

import { sendJamiAssistantMessage } from "@/services/ai/jami-assistant";

const input = {
  message: "Explain this card.",
  history: [],
  context: {
    surface: "learn" as const,
    cardId: "card-1",
    phase: "answer" as const,
  },
  useRelatedSources: true,
};

/** Builds the newline-delimited stream the assistant route now returns. */
function streamedResponse(...events: Record<string, unknown>[]) {
  const body =
    events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("Jami assistant client service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends authenticated typed context and preserves the Used receipt", async () => {
    const fetchMock = vi.fn(async () =>
      streamedResponse({
        type: "done",
        reply: "A clear explanation.",
        used: [
          { kind: "current-context", id: "card-1", label: "Current card" },
          { kind: "general-knowledge", label: "general knowledge" },
        ],
        followUps: [
          { label: "Explain more", prompt: "Explain that in more detail." },
          { label: "", prompt: "Invalid" },
          { label: "Ignored third", prompt: "Only keep two valid actions." },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendJamiAssistantMessage(input)).resolves.toEqual({
      reply: "A clear explanation.",
      used: [
        { kind: "current-context", id: "card-1", label: "Current card" },
        { kind: "general-knowledge", label: "general knowledge" },
      ],
      followUps: [
        { label: "Explain more", prompt: "Explain that in more detail." },
        { label: "Ignored third", prompt: "Only keep two valid actions." },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/assistant",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        body: JSON.stringify(input),
      })
    );
  });

  it("settles on the answer as soon as it is done, while the route finishes its own bookkeeping", async () => {
    const encoder = new TextEncoder();
    let closeStream = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text", value: "Done already." })}\n`));
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "done", reply: "Done already.", used: [{ kind: "general-knowledge", label: "general knowledge" }] })}\n`
          )
        );
        // Left open, as the route leaves it while it updates Tutor memory.
        closeStream = () => controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await expect(sendJamiAssistantMessage(input)).resolves.toMatchObject({ reply: "Done already." });
    closeStream();
  });

  it("passes on each step Jami takes as it starts, and keeps the steps with the answer", async () => {
    const steps = [
      { type: "step", tool: "search_sources", doing: "Searching your material for “entropy”", done: "Searched your material for “entropy”" },
      { type: "step", tool: "made_up", doing: "x", done: "y" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamedResponse(...steps, {
          type: "done",
          reply: "Entropy rises.",
          used: [{ kind: "general-knowledge", label: "general knowledge" }],
          agentSteps: [{ tool: "search_sources", label: "Searched your material for “entropy”" }],
        })
      )
    );
    const seen: unknown[] = [];
    const response = await sendJamiAssistantMessage(input, undefined, undefined, (step) => seen.push(step));
    expect(seen).toEqual([
      { tool: "search_sources", doing: "Searching your material for “entropy”", done: "Searched your material for “entropy”" },
    ]);
    expect(response.agentSteps).toEqual([{ tool: "search_sources", label: "Searched your material for “entropy”" }]);
  });

  it("does not turn a provider failure into an assistant message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Jami could not finish that answer just now." },
          { status: 502 }
        )
      )
    );
    await expect(sendJamiAssistantMessage(input)).rejects.toThrow(
      "Jami could not finish that answer just now."
    );
  });

  it("describes a burst limit as temporary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "Jami is receiving requests too quickly. Try again in a moment.",
            code: "burst_limit",
            retryAfterSeconds: 14,
          },
          { status: 429 }
        )
      )
    );

    await expect(sendJamiAssistantMessage(input)).rejects.toThrow(/in a moment/i);
  });

  it("surfaces a temporary budget-store outage accurately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "AI usage limits are temporarily unavailable. Try again shortly.",
            code: "budget_unavailable",
          },
          { status: 503 }
        )
      )
    );

    await expect(sendJamiAssistantMessage(input)).rejects.toThrow(
      /usage limits are temporarily unavailable/i
    );
  });

  it("rejects successful responses that omit transparent usage data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ reply: "Incomplete", used: [] }))
    );
    await expect(sendJamiAssistantMessage(input)).rejects.toThrow(
      "Jami returned an incomplete answer"
    );
  });
});
