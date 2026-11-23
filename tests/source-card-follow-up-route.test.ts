import { beforeEach, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/video-card-jobs/[jobId]/more/route";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), budget: vi.fn(), refund: vi.fn(), start: vi.fn(), fail: vi.fn() }));
vi.mock("@/services/auth/authenticate-request.server", async (importOriginal) => ({
  ...await importOriginal<object>(), authenticateRequest: async () => "student",
}));
vi.mock("@/services/firebase/admin", () => ({ getAdminDb: () => ({
  collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: mocks.read }) }) }) }),
  runTransaction: (handle: (transaction: { get: typeof mocks.read; update: typeof mocks.write }) => unknown) => handle({ get: mocks.read, update: mocks.write }),
}) }));
vi.mock("@/services/ai/budgets", () => ({ checkAiBudget: mocks.budget, refundAiBudget: mocks.refund }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/video-card-generation", () => ({ generateVideoCardWorkflow: () => undefined }));
vi.mock("@/services/ai/source-card-follow-up.server", () => ({ failSourceCardFollowUp: mocks.fail }));

const id = "test-source-card-job";
const original = { id: "draft-1", front: "Original question", back: "Original answer", selected: true, evidenceIds: ["ref"] };
const edited = { ...original, back: "Edited answer", selected: false };
const raw = { deckId: "deck", status: "ready", sourceKind: "text", contentText: "Original notes", updatedAt: 100, drafts: [original] };

function post(updatedAt = 100) {
  return POST(new Request(`http://localhost/api/ai/video-card-jobs/${id}/more`, {
    method: "POST", body: JSON.stringify({ focus: "Cover the first slide", updatedAt, drafts: [edited] }),
  }) as NextRequest, { params: Promise.resolve({ jobId: id }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ data: () => raw });
  mocks.budget.mockResolvedValue({ allowed: true, grant: { action: "videoCardImport" } });
  mocks.refund.mockResolvedValue(undefined);
});

it("saves current edits before starting the follow-up, and keeps the raw notes out of the response", async () => {
  const response = await post();
  expect(response.status).toBe(202);
  const view = await response.json();
  expect(view).toMatchObject({ status: "ready", drafts: [edited], followUp: { status: "running" } });
  expect(view).not.toHaveProperty("contentText");
  expect(view.followUp).not.toHaveProperty("focus");
  expect(mocks.write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ drafts: [edited] }));
  expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), ["student", id, view.followUp.id]);
});

it("rejects stale edits and refunds a request that loses its claim before starting", async () => {
  expect((await post(101)).status).toBe(409);
  expect(mocks.budget).not.toHaveBeenCalled();
  mocks.read.mockResolvedValueOnce({ data: () => raw }).mockResolvedValueOnce({ data: () => ({ ...raw, updatedAt: 102 }) });
  expect((await post()).status).toBe(409);
  expect(mocks.refund).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
});
