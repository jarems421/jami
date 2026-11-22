import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { PATCH } from "@/app/api/ai/video-card-jobs/[jobId]/route";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/services/auth/authenticate-request.server", () => ({ authenticateRequest: async () => "student" }));
vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({}) }) }) }),
    runTransaction: (run: (transaction: typeof mocks) => unknown) => run(mocks),
  }),
}));

const drafts = Array.from({ length: 75 }, (_, index) => ({
  id: `source-card-${index}`, front: `Front ${index}`, back: `Back ${index}`, selected: true, evidenceIds: [],
}));
const params = Promise.resolve({ jobId: "source-card-test-job" });

function patch(submitted: typeof drafts) {
  const request = new Request("http://localhost/api/ai/video-card-jobs/source-card-test-job", {
    method: "PATCH", body: JSON.stringify({ drafts: submitted }),
  }) as NextRequest;
  return PATCH(request, { params });
}

describe("saving card import review", () => {
  it("saves edits and selections past card 60 from notes", async () => {
    mocks.update.mockClear();
    mocks.get.mockResolvedValue({ data: () => ({ status: "ready", sourceKind: "text", drafts }) });
    const edited = drafts.map((draft, index) => index === 70 ? { ...draft, back: "Edited", selected: false } : draft);
    const result = await patch(edited);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ drafts: edited });
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ drafts: edited }));
  });

  it("rejects duplicate draft IDs and retains the video review bound", async () => {
    mocks.update.mockClear();
    mocks.get.mockResolvedValue({ data: () => ({ status: "ready", sourceKind: "file", drafts }) });
    expect((await patch([drafts[0], drafts[0]])).status).toBe(400);
    mocks.get.mockResolvedValue({ data: () => ({ status: "ready", sourceKind: "youtube", drafts }) });
    expect((await patch(drafts)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
