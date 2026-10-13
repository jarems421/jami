import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The in-memory transaction serializes writers like Firestore does. This lets
 * the boundary tests prove concurrent requests cannot all consume the same
 * final allowance.
 */
const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  let transactionInFlight = false;

  const db = {
    collection: (collectionName: string) => ({
      doc: (docId: string) => ({ path: `${collectionName}/${docId}` }),
    }),
    runTransaction: async <T>(
      run: (transaction: {
        get: (ref: { path: string }) => Promise<{
          data: () => Record<string, unknown> | undefined;
        }>;
        set: (ref: { path: string }, value: Record<string, unknown>) => void;
      }) => Promise<T>
    ): Promise<T> => {
      while (transactionInFlight) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      transactionInFlight = true;
      try {
        return await run({
          get: async (ref) => ({ data: () => store.get(ref.path) }),
          set: (ref, value) => {
            store.set(ref.path, { ...store.get(ref.path), ...value });
          },
        });
      } finally {
        transactionInFlight = false;
      }
    },
  };

  return { store, db, emailAllowsAi: vi.fn(async () => true) };
});

vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => mocks.db,
}));

vi.mock("@/services/auth/email-confirmation.server", () => ({
  emailAllowsAi: mocks.emailAllowsAi,
}));

const { AI_BUDGETS, getAiTokenCap } = await import("@/lib/ai/budgets");
const { checkAiBudget, createAiBudgetLimitResponse, refundAiBudget } =
  await import("@/services/ai/budgets");

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mocks.store.clear();
  mocks.emailAllowsAi.mockResolvedValue(true);
});

describe("AI budget configuration", () => {
  it("covers every route that calls a model", () => {
    expect(Object.keys(AI_BUDGETS).sort()).toEqual(
      [
        "assistant",
        "autocompleteCard",
        "diagramLabelDetection",
        "constellationPattern",
        "tutorIllustration",
        "practicePaperGeneration",
        "practicePaperMarking",
        "examQuestionMarking",
        "examQuestionReview",
        "planDraft",
        "sourceFlashcardDrafts",
        "sourcePracticeDrafts",
        "interventionMaterial",
        "videoCardImport",
        "studyAssetGeneration",
        "studyAnswerCheck",
        "photoBackgroundRestore",
        "revisionLesson",
        "revisionMarking",
        "revisionQuestion",
        "sourceIndexing",
      ].sort()
    );
  });

  it("gives the study modes their own burst allowance", () => {
    // Preparing a deck must not eat the allowance the tutor needs to answer a
    // question in the middle of a session.
    expect(AI_BUDGETS.studyAssetGeneration.burstScope).toBe("studyModes");
    expect(AI_BUDGETS.studyAnswerCheck.burstScope).toBe("studyModes");
    expect(AI_BUDGETS.assistant.burstScope).not.toBe("studyModes");
  });

  it("caps what one preparation job may be sent", () => {
    // A hundred cards of text is the one input here that a student can grow
    // without noticing.
    expect(AI_BUDGETS.studyAssetGeneration.inputTokenCap).toBeGreaterThan(0);
    expect(AI_BUDGETS.studyAnswerCheck.inputTokenCap).toBeGreaterThan(0);
  });

  it("uses the agreed daily and burst allowances", () => {
    expect(AI_BUDGETS.assistant).toMatchObject({
      dailyRequestLimit: 40,
      burstRequestLimit: 6,
      burstWindowMs: MINUTE_MS,
    });
    expect(AI_BUDGETS.autocompleteCard.burstRequestLimit).toBe(6);
    expect(AI_BUDGETS.autocompleteCard.burstScope).toBe(
      AI_BUDGETS.assistant.burstScope
    );
    // Raised 1 Oct 2026 with the plans: a draft costs hundredths of a penny,
    // and every way of asking for flashcards shares the source-drafts limit.
    expect(AI_BUDGETS.autocompleteCard.dailyRequestLimit).toBe(150);
    expect(AI_BUDGETS.sourceIndexing).toMatchObject({
      dailyRequestLimit: 60,
      burstScope: "sourceIndexing",
    });
    expect(AI_BUDGETS.sourceFlashcardDrafts).toMatchObject({
      dailyRequestLimit: 20,
      burstRequestLimit: 2,
      burstScope: "sourceDrafts",
    });
    expect(AI_BUDGETS.videoCardImport).toMatchObject({
      dailyRequestLimit: 10,
      burstRequestLimit: 2,
      burstScope: "sourceDrafts",
    });
    expect(AI_BUDGETS.sourcePracticeDrafts.burstScope).toBe("sourceDrafts");
    expect(AI_BUDGETS.tutorIllustration).toMatchObject({
      dailyRequestLimit: 10,
      burstRequestLimit: 3,
      burstScope: "tutorIllustrations",
    });
    /*
     * 16,000, raised from 8,000 after a benchmark truncated one marking in six
     * against the old ceiling and paid for every one of them. The report is not
     * what needs the room: on the identical prompt the worker wrote its whole
     * report in a median of 1,197 tokens while the supervisor -- a reasoning
     * model whose thinking is billed inside this cap -- used 5,408 and reached
     * the ceiling.
     */
    expect(AI_BUDGETS.examQuestionMarking).toMatchObject({
      dailyRequestLimit: 60,
      burstRequestLimit: 12,
      tokenCap: 16_000,
      inputTokenCap: 32_000,
    });
    expect(AI_BUDGETS.examQuestionReview.dailyRequestLimit).toBe(20);
  });

  it("exposes a token cap for each action", () => {
    for (const action of Object.keys(AI_BUDGETS) as (keyof typeof AI_BUDGETS)[]) {
      expect(getAiTokenCap(action)).toBeGreaterThan(0);
    }
  });
});

describe("checkAiBudget", () => {
  it("gives an account with an unconfirmed email no allowance, and counts nothing", async () => {
    mocks.emailAllowsAi.mockResolvedValue(false);
    const decision = await checkAiBudget({ uid: "unconfirmed", action: "assistant" });
    expect(decision).toEqual({
      allowed: false,
      reason: "email_unconfirmed",
      retryAfterSeconds: 0,
    });
    expect(mocks.store.size).toBe(0);

    if (decision.allowed) throw new Error("expected a refusal");
    const response = createAiBudgetLimitResponse("assistant", decision);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "email_unconfirmed",
      error: expect.stringContaining("confirmed email"),
    });
  });

  it("allows requests up to the daily limit and refuses the next one", async () => {
    const now = 1_700_000_000_000;
    for (
      let index = 0;
      index < AI_BUDGETS.sourceFlashcardDrafts.dailyRequestLimit;
      index += 1
    ) {
      await expect(
        checkAiBudget({
          uid: "user-1",
          action: "sourceFlashcardDrafts",
          now: now + index * MINUTE_MS,
        })
      ).resolves.toMatchObject({ allowed: true, reason: null });
    }

    await expect(
      checkAiBudget({
        uid: "user-1",
        action: "sourceFlashcardDrafts",
        now: now + 10 * MINUTE_MS,
      })
    ).resolves.toMatchObject({ allowed: false, reason: "daily_limit" });
  });

  it("cannot exceed a burst allowance under concurrency", async () => {
    const now = 1_700_000_000_000;
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        checkAiBudget({ uid: "user-1", action: "assistant", now })
      )
    );

    expect(results.filter((decision) => decision.allowed)).toHaveLength(6);
    expect(
      results.filter(
        (decision) => !decision.allowed && decision.reason === "burst_limit"
      )
    ).toHaveLength(24);
  });

  it("shares six interactive requests across assistant and autocomplete", async () => {
    const now = 1_700_000_000_000;
    const actions = [
      "assistant",
      "autocompleteCard",
      "assistant",
      "autocompleteCard",
      "assistant",
      "autocompleteCard",
      "assistant",
      "autocompleteCard",
    ] as const;
    const results = await Promise.all(
      actions.map((action) => checkAiBudget({ uid: "user-1", action, now }))
    );

    expect(results.filter((decision) => decision.allowed)).toHaveLength(6);
    expect(
      results.filter(
        (decision) => !decision.allowed && decision.reason === "burst_limit"
      )
    ).toHaveLength(2);
  });

  it("cannot exceed the final daily allowance under concurrency", async () => {
    const now = 1_700_000_000_000;
    const dayKey = Math.floor(now / DAY_MS).toString();
    mocks.store.set(`aiBudgets/user-1:assistant:${dayKey}`, {
      count: AI_BUDGETS.assistant.dailyRequestLimit - 1,
      burstCount: 0,
      burstWindowStartedAt: now,
    });

    const results = await Promise.all([
      checkAiBudget({ uid: "user-1", action: "assistant", now }),
      checkAiBudget({ uid: "user-1", action: "assistant", now }),
    ]);

    expect(results.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(results.filter((decision) => decision.reason === "daily_limit")).toHaveLength(1);
  });

  it("shares the two-request source burst across both draft kinds", async () => {
    const now = 1_700_000_000_000;
    await expect(
      checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      checkAiBudget({ uid: "user-1", action: "sourcePracticeDrafts", now })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now })
    ).resolves.toMatchObject({ allowed: false, reason: "burst_limit" });
  });

  it("lets durable jobs queue without consuming the shared short-window burst", async () => {
    const now = 1_700_000_000_000;
    for (let index = 0; index < 6; index += 1) {
      await expect(checkAiBudget({
        uid: "user-1",
        action: "practicePaperGeneration",
        now,
        skipBurstLimit: true,
      })).resolves.toMatchObject({ allowed: true });
    }
    await expect(
      checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now })
    ).resolves.toMatchObject({ allowed: true });
  });

  it("keeps the daily allowance separate for each source draft kind", async () => {
    const now = 1_700_000_000_000;
    for (
      let index = 0;
      index < AI_BUDGETS.sourceFlashcardDrafts.dailyRequestLimit;
      index += 1
    ) {
      await checkAiBudget({
        uid: "user-1",
        action: "sourceFlashcardDrafts",
        now: now + index * MINUTE_MS,
      });
    }

    await expect(
      checkAiBudget({
        uid: "user-1",
        action: "sourceFlashcardDrafts",
        now: now + 10 * MINUTE_MS,
      })
    ).resolves.toMatchObject({ allowed: false, reason: "daily_limit" });
    await expect(
      checkAiBudget({
        uid: "user-1",
        action: "sourcePracticeDrafts",
        now: now + 10 * MINUTE_MS,
      })
    ).resolves.toMatchObject({ allowed: true });
  });

  it("budgets each user separately", async () => {
    const now = 1_700_000_000_000;
    await checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now });
    await checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now });

    await expect(
      checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now })
    ).resolves.toMatchObject({ allowed: false, reason: "burst_limit" });
    await expect(
      checkAiBudget({ uid: "user-2", action: "sourceFlashcardDrafts", now })
    ).resolves.toMatchObject({ allowed: true });
  });

  it("resets burst and daily windows at their boundaries", async () => {
    const now = 1_700_000_000_000;
    await checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now });
    await checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now });
    await expect(
      checkAiBudget({
        uid: "user-1",
        action: "sourceFlashcardDrafts",
        now: now + MINUTE_MS,
      })
    ).resolves.toMatchObject({ allowed: true });

    const nextDay = now + DAY_MS;
    await expect(
      checkAiBudget({
        uid: "user-1",
        action: "sourceFlashcardDrafts",
        now: nextDay,
      })
    ).resolves.toMatchObject({ allowed: true });
  });

  it("returns a whole-second retry delay for a burst rejection", async () => {
    const now = 1_700_000_000_000;
    await checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now });
    await checkAiBudget({ uid: "user-1", action: "sourceFlashcardDrafts", now });

    await expect(
      checkAiBudget({
        uid: "user-1",
        action: "sourceFlashcardDrafts",
        now: now + 30_001,
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "burst_limit",
      retryAfterSeconds: 30,
    });
  });
});

describe("AI budget route responses", () => {
  it("adds a stable daily code without a short-window retry header", async () => {
    const response = createAiBudgetLimitResponse("assistant", {
      allowed: false,
      reason: "daily_limit",
      retryAfterSeconds: 3_600,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "daily_limit",
      retryAfterSeconds: 3_600,
    });
  });

  it("adds Retry-After for a burst rejection", async () => {
    const response = createAiBudgetLimitResponse("sourceFlashcardDrafts", {
      allowed: false,
      reason: "burst_limit",
      retryAfterSeconds: 23,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("23");
    await expect(response.json()).resolves.toMatchObject({
      code: "burst_limit",
      retryAfterSeconds: 23,
    });
  });
});

/**
 * A request was charged the moment it was allowed, and nothing ever gave it
 * back — so a provider timeout, or closing the drawer mid-answer, still cost
 * one of the day's forty with nothing to show for it.
 */
describe("giving a charged request back", () => {
  const allow = async (now: number) => {
    const decision = await checkAiBudget({ uid: "u1", action: "assistant", now });
    if (!decision.allowed) throw new Error("expected the request to be allowed");
    return decision.grant;
  };

  it("frees the request for another try", async () => {
    const now = 5 * DAY_MS;
    const grant = await allow(now);
    await refundAiBudget(grant);

    // Spend the whole day's allowance; it is only reachable if the refund
    // actually returned the first request.
    for (let index = 0; index < AI_BUDGETS.assistant.dailyRequestLimit; index += 1) {
      const decision = await checkAiBudget({
        uid: "u1",
        action: "assistant",
        // Spread across burst windows so only the daily limit is in play.
        now: now + index * MINUTE_MS,
      });
      expect(decision.allowed, `request ${index + 1}`).toBe(true);
    }
  });

  it("frees the burst allowance too", async () => {
    const now = 6 * DAY_MS;
    const grants = [];
    for (let index = 0; index < AI_BUDGETS.assistant.burstRequestLimit; index += 1) {
      grants.push(await allow(now));
    }
    expect((await checkAiBudget({ uid: "u1", action: "assistant", now })).allowed).toBe(
      false
    );

    await refundAiBudget(grants[0]);
    expect((await checkAiBudget({ uid: "u1", action: "assistant", now })).allowed).toBe(
      true
    );
  });

  it("cannot put a later burst window into credit", async () => {
    /*
     * A refund arriving after the window has rolled — a request that timed out
     * a minute after it started — must not hand its allowance to the new
     * window, or a slow failure would quietly raise the burst limit.
     */
    const now = 7 * DAY_MS;
    const grant = await allow(now);
    const laterWindow = now + AI_BUDGETS.assistant.burstWindowMs + 1;

    // Open the new window and fill it.
    for (let index = 0; index < AI_BUDGETS.assistant.burstRequestLimit; index += 1) {
      expect(
        (await checkAiBudget({ uid: "u1", action: "assistant", now: laterWindow }))
          .allowed,
        `request ${index + 1}`
      ).toBe(true);
    }
    await refundAiBudget(grant);

    expect(
      (await checkAiBudget({ uid: "u1", action: "assistant", now: laterWindow }))
        .allowed
    ).toBe(false);
  });

  it("never drops a counter below nothing", async () => {
    const now = 8 * DAY_MS;
    const grant = await allow(now);
    await refundAiBudget(grant);
    await refundAiBudget(grant);
    await refundAiBudget(grant);

    for (let index = 0; index < AI_BUDGETS.assistant.dailyRequestLimit; index += 1) {
      expect(
        (await checkAiBudget({
          uid: "u1",
          action: "assistant",
          now: now + index * MINUTE_MS,
        })).allowed,
        `request ${index + 1}`
      ).toBe(true);
    }
    expect(
      (await checkAiBudget({
        uid: "u1",
        action: "assistant",
        now: now + AI_BUDGETS.assistant.dailyRequestLimit * MINUTE_MS,
      })).allowed
    ).toBe(false);
  });
});
