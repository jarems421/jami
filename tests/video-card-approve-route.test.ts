import { expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/video-card-jobs/[jobId]/approve/route";

const created = vi.hoisted(() => [] as Array<{ front: string; createdAt: number }>);
vi.mock("@/services/auth/authenticate-request.server", async (importOriginal) => ({
  ...await importOriginal<object>(), authenticateRequest: async () => "student",
}));
const drafts = ["Slide 1", "Slide 2", "Slide 3"].map((front, index) => ({
  id: `draft-${index}`, front, back: `${front} answer`, selected: true, evidenceIds: [],
}));
vi.mock("@/services/firebase/admin", () => {
  let next = 0;
  const doc = () => ({ id: `card-${(next += 1)}`, collection: () => ({ doc }) });
  return {
    getAdminDb: () => ({
      collection: () => ({ doc }),
      runTransaction: (handle: (transaction: unknown) => unknown) => handle({
        get: async () => ({ exists: true, data: () => ({ deckId: "deck", status: "ready", drafts, userId: "student" }) }),
        create: (_ref: unknown, data: { front: string; createdAt: number }) => created.push(data),
        update: () => undefined,
      }),
    }),
    getAdminStorageBucket: () => ({ file: () => ({ delete: async () => undefined }) }),
  };
});

it("stamps an import's first slide oldest, so study follows the lecture from the start", async () => {
  const response = await POST(new Request("http://localhost/api/ai/video-card-jobs/test-source-card-job/approve", { method: "POST" }) as NextRequest,
    { params: Promise.resolve({ jobId: "test-source-card-job" }) });
  expect(response.status).toBe(200);
  const oldestFirst = [...created].sort((left, right) => left.createdAt - right.createdAt).map(({ front }) => front);
  expect(oldestFirst).toEqual(["Slide 1", "Slide 2", "Slide 3"]);
  expect(Math.max(...created.map(({ createdAt }) => createdAt))).toBeLessThanOrEqual(Date.now());
});
