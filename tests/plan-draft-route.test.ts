import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Planning with Jami, at the route: counted against the daily planning budget
 * like every other AI request, handed the timetable on the student's screen
 * only after it is cleaned, and never charged for an answer that did not come.
 */

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  checkAiBudget: vi.fn(),
  refundAiBudget: vi.fn(),
  draftRevisionPlan: vi.fn(),
  loadStudyActions: vi.fn(),
}));

vi.mock("@/services/auth/authenticate-request.server", () => ({
  authenticateRequest: mocks.authenticateRequest,
  apiFailure: (error: string, status: number, code: string) => Response.json({ error, code }, { status }),
}));
vi.mock("@/services/ai/budgets", () => ({
  checkAiBudget: mocks.checkAiBudget,
  refundAiBudget: mocks.refundAiBudget,
  createAiBudgetLimitResponse: (_action: string, decision: { reason: string }) =>
    Response.json({ error: "Jami has helped shape as many plans as it can today.", code: decision.reason }, { status: 429 }),
}));
vi.mock("@/services/ai/spend.server", () => ({ aiSpendContextFor: () => ({}) }));
vi.mock("@/lib/ai/spend-context", () => ({ enterAiSpendContext: () => undefined }));
vi.mock("@/lib/ai/provider-router", () => ({ isAnyAiProviderConfigured: () => true }));
vi.mock("@/services/ai/plan-draft.server", () => ({
  draftRevisionPlan: mocks.draftRevisionPlan,
  MAX_PLAN_MESSAGE_LENGTH: 600,
  MAX_PLAN_TURNS: 20,
}));
vi.mock("@/services/learning/study-actions.server", () => ({ loadStudyActions: mocks.loadStudyActions }));

const { POST } = await import("@/app/api/ai/plan-draft/route");

function request(body: unknown) {
  return new NextRequest("http://localhost/api/ai/plan-draft", { method: "POST", body: JSON.stringify(body) });
}

const GRANT = { uid: "user-1", action: "planDraft", dayKey: "1" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authenticateRequest.mockResolvedValue("user-1");
  mocks.checkAiBudget.mockResolvedValue({ allowed: true, grant: GRANT });
  mocks.loadStudyActions.mockResolvedValue({ actions: [], folders: [{ id: "bio", name: "Biology", topicIds: [] }] });
});

describe("POST /api/ai/plan-draft", () => {
  it("stops at the daily planning limit before the model is asked", async () => {
    mocks.checkAiBudget.mockResolvedValue({ allowed: false, reason: "daily_limit", retryAfterSeconds: 60 });
    const response = await POST(request({ message: "Plan my week" }));
    expect(response.status).toBe(429);
    expect(mocks.checkAiBudget).toHaveBeenCalledWith({ uid: "user-1", action: "planDraft" });
    expect(mocks.draftRevisionPlan).not.toHaveBeenCalled();
  });

  it("hands the model the timetable on screen, cleaned, and returns the changes it proposed", async () => {
    mocks.draftRevisionPlan.mockResolvedValue({
      reply: "Moved.",
      plan: null,
      changes: [{ kind: "clear", dayKey: "2026-10-19" }],
    });
    const response = await POST(
      request({
        message: "Make Monday a rest day",
        draft: { title: "Summer", scopes: [{ folderId: "bio", weight: 2 }], sessions: [{ id: "m", weekday: 1, minutes: 30 }], startDayKey: "2026-10-19", endDayKey: "2026-11-30" },
        timetable: [
          { dayKey: "2026-10-19", activities: [{ id: "a", title: "Homeostasis", minutes: 30, scopeKey: "folder:bio", href: "https://elsewhere.example" }], doneIds: [] },
          { dayKey: "not a day", activities: [] },
        ],
      })
    );
    expect(response.status).toBe(200);
    const input = mocks.draftRevisionPlan.mock.calls[0]?.[0];
    expect(input.timetable).toHaveLength(1);
    expect(input.timetable[0].activities[0].href).toBeUndefined();
    expect(input.planEndDayKey).toBe("2026-11-30");
    expect(input.step).toBeUndefined();
    await expect(response.json()).resolves.toMatchObject({ reply: "Moved.", changes: [{ kind: "clear", dayKey: "2026-10-19" }] });
    expect(mocks.refundAiBudget).not.toHaveBeenCalled();
  });

  it("gives the request back when Jami could not answer", async () => {
    mocks.draftRevisionPlan.mockRejectedValue(new Error("Request timed out"));
    const response = await POST(request({ message: "Plan my week" }));
    expect(response.status).toBe(504);
    expect(mocks.refundAiBudget).toHaveBeenCalledWith(GRANT);
  });
});
