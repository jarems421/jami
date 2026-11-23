import type { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
import type { StudyAsset } from "@/lib/ai/study-assets";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), write: vi.fn() }));
type Ref = { collection: string; id: string };

function card(id: string) {
  return { userId: "student", deckId: "deck", front: `Which term is used in example ${id}?`, back: "Alpha" };
}

vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (collection: string) => ({
      doc: (id: string) => ({ collection, id, get: async () => ({ exists: true, data: () => ({ userId: "student" }) }), set: mocks.write }),
    }),
    getAll: async (...refs: Ref[]) => refs.map(({ collection, id }) => ({
      id, data: () => collection === "cards" ? card(id) : undefined,
    })),
    runTransaction: (run: (transaction: { get: (ref: Ref) => Promise<{ data: () => ReturnType<typeof card> | undefined }>; set: typeof mocks.write }) => unknown) => run({
      get: async ({ collection, id }) => ({ data: () => collection === "cards" ? card(id) : undefined }),
      set: mocks.write,
    }),
  }),
}));
vi.mock("@/services/auth/authenticate-request.server", () => ({ authenticateRequest: async () => "student" }));
vi.mock("@/services/ai/budgets", () => ({ checkAiBudget: async () => ({ allowed: true, grant: {} }), refundAiBudget: vi.fn() }));
vi.mock("@/services/ai/spend.server", () => ({ aiSpendContextFor: () => ({}) }));
vi.mock("@/lib/ai/provider-router", () => ({ isAnyAiProviderConfigured: () => true }));
vi.mock("@/lib/app/feature-flags", () => ({ featureFlags: { enableStudyModes: true } }));
vi.mock("@/services/ai/study-asset-generation.server", () => ({ generateMultipleChoiceBatch: mocks.generate, generateStudyAssetBatch: mocks.generate }));

const { POST } = await import("@/app/api/ai/study-assets/jobs/route");

function result(cardId: string) {
  const asset: StudyAsset = {
    cardId, answerShape: "short", acceptedAliases: [], requiredConcepts: [], clozeCandidates: [],
    distractors: [], misconceptions: {}, confidence: 1, ambiguous: false,
    mcqVariants: [{ id: "variant", correctAnswer: "Alpha", distractors: ["Beta", "Gamma", "Delta"], explanations: {} }],
  };
  return { assets: [asset], declinedCardIds: [] };
}

it("streams the first saved question without waiting for other cards", async () => {
  let finish: () => void = () => {};
  const slow = new Promise<void>((resolve) => { finish = resolve; });
  mocks.generate.mockImplementation(async (cards: Array<{ id: string }>) => {
    const [{ id }] = cards;
    if (id === "last") await slow;
    return result(id);
  });
  const response = await POST(new Request("http://localhost/api/ai/study-assets/jobs", {
    method: "POST", headers: { Accept: "application/x-ndjson" },
    body: JSON.stringify({ deckId: "deck", cardIds: ["first", "last"], purpose: "multiple-choice" }),
  }) as NextRequest);
  const reader = response.body!.getReader();
  const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value));
  try {
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await next()).toEqual({ type: "started" });
    expect(await next()).toMatchObject({ type: "asset", asset: { cardId: "first", mcqOnly: true } });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ id: "first" }), expect.objectContaining({ cardId: "first" }), { merge: true });
  } finally {
    finish();
  }
  expect(await next()).toMatchObject({ type: "asset", asset: { cardId: "last" } });
  expect(await next()).toMatchObject({ type: "complete", summary: { prepared: 2 } });
  expect((await reader.read()).done).toBe(true);
});
