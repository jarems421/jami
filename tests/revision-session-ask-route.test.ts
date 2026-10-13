import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createRevisionSteps } from "@/lib/revision/session-machine";
import type { RevisionSessionRecord, RevisionTask } from "@/lib/revision/types";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(async () => "user-1" as string | null),
  load: vi.fn(),
  context: vi.fn(),
  answer: vi.fn(),
  checkBudget: vi.fn(),
  refundBudget: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/auth/authenticate-request.server", () => ({
  authenticateRequest: mocks.authenticate,
  apiFailure: (error: string, status: number, code: string) => Response.json({ error, code }, { status }),
}));
vi.mock("@/services/learning/revision-sessions.server", () => ({ loadRevisionSession: mocks.load }));
vi.mock("@/services/learning/revision-session-context.server", () => ({
  loadRevisionConceptContext: mocks.context,
  revisionSessionsUnavailable: () => null,
}));
vi.mock("@/services/ai/revision-session.server", () => ({
  answerRevisionQuestion: mocks.answer,
  MAX_REVISION_QUESTION_LENGTH: 500,
}));
vi.mock("@/services/ai/budgets", () => ({
  checkAiBudget: mocks.checkBudget,
  createAiBudgetLimitResponse: () => Response.json({ error: "limit" }, { status: 429 }),
  refundAiBudget: mocks.refundBudget,
}));
vi.mock("@/services/ai/spend.server", () => ({ aiSpendContextFor: () => ({}) }));
vi.mock("@/lib/ai/spend-context", () => ({ enterAiSpendContext: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const { POST } = await import("@/app/api/learning/revision-sessions/[sessionId]/ask/route");

const task: RevisionTask = { prompt: "Complete the square.", hint: "Halve it.", answer: "(x+4)^2-13", markScheme: ["a"], solution: "s" };
const session = (overrides: Partial<RevisionSessionRecord> = {}): RevisionSessionRecord => ({
  id: "s1",
  schemaVersion: 1,
  policy: "teach",
  status: "active",
  target: { topicKey: "topic:q", source: "student-topic", conceptLabel: "Completing the square", folderId: "f1" },
  why: [],
  lesson: {
    goals: ["a", "b", "c"],
    orientation: "o",
    explanation: { body: "b", example: { problem: "p", steps: ["s"] } },
    guided: task,
    independent: task,
    apply: task,
    retrieve: task,
  },
  steps: createRevisionSteps("teach"),
  position: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const ask = (question: unknown) =>
  POST(
    new Request("http://localhost/api/learning/revision-sessions/s1/ask", {
      method: "POST",
      body: JSON.stringify({ question }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ sessionId: "s1" }) }
  );

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.authenticate.mockResolvedValue("user-1");
  mocks.load.mockResolvedValue(session());
  mocks.context.mockResolvedValue({ conceptLabel: "Completing the square" });
  mocks.checkBudget.mockResolvedValue({ allowed: true, grant: { id: "g" } });
  mocks.refundBudget.mockResolvedValue(undefined);
  mocks.answer.mockResolvedValue("Because the bracket doubles the middle term.");
});

describe("asking a question mid-session", () => {
  it("answers about the step on screen, searching their material for the concept and the question", async () => {
    const response = await ask("Why do you halve it?");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Because the bracket doubles the middle term." });
    expect(mocks.context).toHaveBeenCalledWith("user-1", expect.objectContaining({ folderId: "f1" }), {
      materialQuery: "Completing the square: Why do you halve it?",
    });
    // What reaches the model is the projected step: the explanation, as the student sees it.
    expect(mocks.answer.mock.calls[0][0].step.kind).toBe("explain");
    expect(mocks.checkBudget).toHaveBeenCalledWith({ uid: "user-1", action: "revisionQuestion", allowance: null });
  });

  it("refuses an empty or overlong question, a stranger, and a session that is not running", async () => {
    expect((await ask("  ")).status).toBe(400);
    expect((await ask("x".repeat(501))).status).toBe(400);
    mocks.authenticate.mockResolvedValueOnce(null);
    expect((await ask("Why?")).status).toBe(401);
    mocks.load.mockResolvedValueOnce(null);
    expect((await ask("Why?")).status).toBe(404);
    mocks.load.mockResolvedValueOnce(session({ status: "completed" }));
    expect((await ask("Why?")).status).toBe(409);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("gives the budget back when no answer came", async () => {
    mocks.answer.mockResolvedValueOnce(null);
    expect((await ask("Why?")).status).toBe(503);
    expect(mocks.refundBudget).toHaveBeenCalledWith({ id: "g" });
  });
});
