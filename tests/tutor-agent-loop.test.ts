import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TutorAgentLiveStep } from "@/lib/ai/tutor-agent";
import type { TutorTurnSource } from "@/lib/ai/tutor-turn-prompt";
import type { Source } from "@/lib/material/sources";
import type { Logger } from "@/lib/observability/logger";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  retrieve: vi.fn(),
  research: vi.fn(),
  researchConfigured: vi.fn(() => true),
  charge: vi.fn(),
  recall: vi.fn(),
}));

vi.mock("@/lib/ai/provider-router", () => ({
  generateAiText: (...args: unknown[]) => mocks.generateText(...args),
}));
vi.mock("@/services/ai/source-index.server", () => ({
  retrieveTutorEvidence: (...args: unknown[]) => mocks.retrieve(...args),
}));
vi.mock("@/lib/ai/gemini", () => ({
  generateGroundedResearch: (...args: unknown[]) => mocks.research(...args),
  isGroundedResearchConfigured: () => mocks.researchConfigured(),
}));
vi.mock("@/services/billing/allowances.server", () => ({
  chargeAllowance: (...args: unknown[]) => mocks.charge(...args),
}));
vi.mock("@/services/ai/tutor-chat-recall.server", () => ({
  loadTutorChatRecall: (...args: unknown[]) => mocks.recall(...args),
}));

const { runTutorAgent } = await import("@/services/ai/tutor-agent.server");

const source = (id: string, title: string) => ({ id, title, type: "file", updatedAt: 0 }) as unknown as Source;
const lecture = source("lecture", "Lecture 4 - Entropy");
const sheet = source("sheet", "Problem sheet 2");
const inHandLecture: TutorTurnSource = {
  source: lecture,
  sourceRef: "S1",
  prepared: { sourceId: "lecture", label: lecture.title, parts: [{ text: "Entropy is a measure of disorder." }], inputBytes: 30 },
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const step = (tool: string, query = "") => JSON.stringify({ tool, query });

function run(overrides: { signal?: AbortSignal; steps?: TutorAgentLiveStep[] } = {}) {
  const live = overrides.steps ?? [];
  return runTutorAgent({
    uid: "u1",
    message: "Why does entropy increase when gases mix?",
    history: [],
    currentText: "",
    scope: { sources: [lecture, sheet], pinnedSourceIds: ["lecture"] },
    inHand: { readable: [inHandLecture], research: { ok: false, reason: "invalid_query" }, recall: null },
    recallFrom: { earlierInThread: [] },
    deadlineAt: Date.now() + 28_000,
    signal: overrides.signal ?? new AbortController().signal,
    providerDiagnostics: [],
    onStep: (each) => live.push(each),
    log,
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.researchConfigured.mockReturnValue(true);
  mocks.charge.mockResolvedValue({ allowed: true, refund: vi.fn(async () => undefined) });
});

describe("the Tutor agent's look-ups", () => {
  it("runs the steps the planner chooses, gathers what they find under the right references, and stops when it is done", async () => {
    mocks.generateText
      .mockResolvedValueOnce(step("search_sources", "entropy of mixing"))
      .mockResolvedValueOnce(step("done"));
    mocks.retrieve.mockResolvedValueOnce({
      passages: [
        { id: "c2", sourceId: "sheet", sourceTitle: sheet.title, chunkIndex: 2, text: "Q3: two ideal gases mix at constant T.", distance: 0.2, pageStart: 3 },
        { id: "c1", sourceId: "lecture", sourceTitle: lecture.title, chunkIndex: 1, text: "Mixing increases the number of microstates.", distance: 0.1 },
        // Already in front of the answer: not added twice.
        { id: "c0", sourceId: "lecture", sourceTitle: lecture.title, chunkIndex: 0, text: "Entropy is a measure of disorder.", distance: 0.05 },
      ],
      outlines: new Map(),
      targets: new Map(),
    });
    const live: TutorAgentLiveStep[] = [];
    const gathered = await run({ steps: live });

    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: "entropy of mixing", pinnedSourceIds: ["lecture"], relatedSourceIds: ["sheet"] })
    );
    expect(gathered.readable.map((entry) => entry.sourceRef)).toEqual(["S1", "S2"]);
    expect(gathered.readable[0].prepared.parts).toHaveLength(2);
    expect(gathered.readable[1].source.id).toBe("sheet");
    expect(JSON.stringify(gathered.readable[1].prepared.parts)).toContain("page 3");
    // What was in hand is not changed underneath the caller.
    expect(inHandLecture.prepared.parts).toHaveLength(1);
    expect(live).toEqual([
      { tool: "search_sources", doing: "Searching your material for “entropy of mixing”", done: "Searched your material for “entropy of mixing”" },
    ]);
    expect(gathered.steps).toEqual([{ tool: "search_sources", label: "Searched your material for “entropy of mixing”" }]);
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
  });

  it("spends one of the student's searches on the web, and gives it back when the search fails", async () => {
    const refund = vi.fn(async () => undefined);
    mocks.charge.mockResolvedValue({ allowed: true, refund });
    mocks.generateText
      .mockResolvedValueOnce(step("search_web", "AQA 2025 specification entropy"))
      .mockResolvedValueOnce(step("done"));
    mocks.research.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    const gathered = await run();
    expect(mocks.charge).toHaveBeenCalledWith({ uid: "u1", key: "searches" });
    expect(refund).toHaveBeenCalledTimes(1);
    expect(gathered.research.ok).toBe(false);
  });

  it("says when the month's searches are used up, and keeps a brief that came back", async () => {
    mocks.charge.mockResolvedValueOnce({ allowed: false, refund: vi.fn() });
    mocks.generateText.mockResolvedValueOnce(step("search_web", "AQA specification entropy")).mockResolvedValueOnce(step("done"));
    expect((await run()).searchAllowanceUsed).toBe(true);

    mocks.generateText.mockResolvedValueOnce(step("search_web", "AQA specification entropy")).mockResolvedValueOnce(step("done"));
    mocks.research.mockResolvedValueOnce({ ok: true, brief: "The board requires...", citations: [] });
    const gathered = await run();
    expect(gathered.research).toMatchObject({ ok: true, brief: "The board requires..." });
  });

  it("never runs a tool past its uses, or the planner past its steps", async () => {
    // Asked for the web twice: the second time it is not on offer, so the choice is refused.
    mocks.generateText.mockResolvedValue(step("search_web", "AQA specification entropy"));
    mocks.research.mockResolvedValue({ ok: false, reason: "unavailable" });
    const gathered = await run();
    expect(mocks.research).toHaveBeenCalledTimes(1);
    expect(gathered.steps).toHaveLength(1);

    mocks.generateText.mockReset();
    mocks.generateText.mockResolvedValue(step("search_sources", "something"));
    mocks.retrieve.mockResolvedValue({ passages: [], outlines: new Map(), targets: new Map() });
    await run();
    expect(mocks.retrieve).toHaveBeenCalledTimes(3);
  });

  it("has a problem worked through independently, for the answer to check against", async () => {
    mocks.generateText
      .mockResolvedValueOnce(step("work_out", "Find ΔS when 1 mol of ideal gas doubles its volume isothermally."))
      .mockResolvedValueOnce("ΔS = R ln 2 ≈ 5.76 J/K")
      .mockResolvedValueOnce(step("done"));
    const gathered = await run();
    expect(gathered.workings).toEqual(["ΔS = R ln 2 ≈ 5.76 J/K"]);
    expect(mocks.generateText.mock.calls[1][0]).toMatchObject({ role: "worker", routeReason: "agent_check", reasoningEffort: "high" });
  });

  it("lets the answer go ahead with what it has when the planner fails", async () => {
    mocks.generateText.mockRejectedValueOnce(new Error("provider down"));
    const gathered = await run();
    expect(gathered.steps).toEqual([]);
    expect(gathered.readable).toHaveLength(1);
  });

  it("stops at once when the student leaves", async () => {
    const controller = new AbortController();
    controller.abort("client_gone");
    await expect(run({ signal: controller.signal })).rejects.toBeDefined();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
