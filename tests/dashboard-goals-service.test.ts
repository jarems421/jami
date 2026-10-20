import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  addDoc: vi.fn(),
  deleteField: vi.fn(() => "__delete__"),
  collection: vi.fn(
    (_db: unknown, ...segments: string[]) => ({
      kind: "collection",
      path: segments.join("/"),
    })
  ),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({
    kind: "document",
    path: segments.join("/"),
  })),
  documentId: vi.fn(() => "__name__"),
  getCountFromServer: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn((value: number) => ({ kind: "limit", value })),
  orderBy: vi.fn((field: string, direction: string) => ({
    kind: "orderBy",
    field,
    direction,
  })),
  query: vi.fn((base: unknown, ...constraints: unknown[]) => ({
    kind: "query",
    base,
    constraints,
  })),
  startAfter: vi.fn((...values: unknown[]) => ({ kind: "startAfter", values })),
  updateDoc: vi.fn(),
  where: vi.fn((field: string, operator: string, value: unknown) => ({
    kind: "where",
    field,
    operator,
    value,
  })),
}));

vi.mock("firebase/firestore", () => firestore);
vi.mock("@/services/firebase/client", () => ({ db: {} }));
vi.mock("@/services/firebase/firestore", () => ({
  withTimeout: vi.fn(async (promise: Promise<unknown>) => await promise),
}));
vi.mock("@/services/dashboard/cache", () => ({
  invalidateDashboardData: vi.fn(),
}));
const stars = vi.hoisted(() => ({ createStarForGoalIfMissing: vi.fn() }));
vi.mock("@/services/constellation/stars", () => stars);

function goalDocument(
  id: string,
  data: Record<string, unknown>
) {
  return { id, data: () => data };
}

function snapshot(docs: ReturnType<typeof goalDocument>[]) {
  return { docs, empty: docs.length === 0 };
}

function queryStatus(target: unknown) {
  if (!target || typeof target !== "object" || !("constraints" in target)) {
    return null;
  }
  const constraints = (target as { constraints: unknown[] }).constraints;
  const status = constraints.find(
    (constraint) =>
      constraint &&
      typeof constraint === "object" &&
      (constraint as { kind?: unknown }).kind === "where" &&
      (constraint as { field?: unknown }).field === "status"
  ) as { value?: unknown } | undefined;
  return status?.value ?? null;
}

/**
 * The summary now asks whether a star exists rather than whether a goal was
 * completed, because a goal finished against a full constellation mints no
 * star. That read goes to a different collection, and the mocks route on goal
 * status, so without this it fell through to the legacy-compatibility branch
 * and was counted as one.
 */
function isStarsQuery(target: unknown) {
  const base =
    target && typeof target === "object" && "base" in target
      ? (target as { base?: { path?: unknown } }).base
      : (target as { path?: unknown } | null);
  return typeof base?.path === "string" && base.path.endsWith("/stars");
}

describe("dashboard goal summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestore.updateDoc.mockResolvedValue(undefined);
  });

  it("loads only the active goals, and reads stars rather than completed goals", async () => {
    let activeReads = 0;
    firestore.getDocs.mockImplementation(async (target: unknown) => {
      if (isStarsQuery(target)) return snapshot([goalDocument("star-1", {})]);
      if (queryStatus(target) === "active") {
        activeReads += 1;
        return snapshot([
          goalDocument("current", {
            name: "Current goal",
            status: "active",
            deadline: 2_000,
            createdAt: 30,
          }),
        ]);
      }
      return snapshot([]);
    });

    const { getDashboardGoalSummary } = await import("@/services/study/goals");
    const first = await getDashboardGoalSummary("dashboard-goals-user", 1_000);
    const second = await getDashboardGoalSummary("dashboard-goals-user", 1_000);

    expect(first.activeGoals.map((goal) => goal.id)).toEqual(["current"]);
    expect(first.hasEarnedStars).toBe(true);
    expect(second).toEqual(first);
    /*
     * Twice, deliberately recorded: goals are the one active list not behind
     * the read-through cache, so Today re-reads them on every visit. What the
     * deleted compatibility layer cached was its own full-collection scan, not
     * this query -- so removing it cost no caching and saved a scan.
     */
    expect(activeReads).toBe(2);
    expect(firestore.where).toHaveBeenCalledWith("status", "==", "active");
    /*
     * The summary reads stars, not completed goals. It used to ask for one
     * completed goal and report it as an earned star, so a goal finished
     * against a full constellation -- which mints nothing -- still told the
     * student on Today that a reward was waiting.
     */
    expect(firestore.collection).toHaveBeenCalledWith(
      expect.anything(),
      "users",
      "dashboard-goals-user",
      "stars"
    );
    expect(firestore.where).not.toHaveBeenCalledWith("status", "==", "completed");
    expect(firestore.limit).toHaveBeenCalledWith(1);
  });

  it("re-reads the summary after a goal is written", async () => {
    let activeReads = 0;
    firestore.getDocs.mockImplementation(async (target: unknown) => {
      if (isStarsQuery(target)) return snapshot([]);
      if (queryStatus(target) === "active") activeReads += 1;
      return snapshot([]);
    });

    const { getDashboardGoalSummary, endGoal } = await import(
      "@/services/study/goals"
    );
    await getDashboardGoalSummary("dashboard-goals-write-user", 1_000);
    await endGoal("dashboard-goals-write-user", "goal-1");
    await getDashboardGoalSummary("dashboard-goals-write-user", 1_000);
    expect(firestore.updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: "users/dashboard-goals-write-user/goals/goal-1" }),
      { status: "cancelled" }
    );

    // A write has to drop the cached summary, or Today keeps showing a goal
    // the student has just finished.
    expect(activeReads).toBe(2);
  });

  it("pages goal history newest first, on one indexed query", async () => {
    firestore.getDocs.mockImplementation(async (target: unknown) => {
      if (isStarsQuery(target)) return snapshot([goalDocument("star-1", {})]);
      if (Array.isArray(queryStatus(target))) {
        return snapshot([
          goalDocument("current", {
            name: "Current history",
            status: "completed",
            createdAt: 30,
          }),
        ]);
      }
      return snapshot([]);
    });

    const { getGoalHistoryPage } = await import("@/services/study/goals");
    const page = await getGoalHistoryPage("dashboard-goals-history-user", {
      pageSize: 2,
    });

    expect(page.items.map((goal) => goal.id)).toEqual(["current"]);
    expect(page.nextCursor).toBeNull();
    expect(firestore.where).toHaveBeenCalledWith(
      "status",
      "in",
      ["completed", "failed", "cancelled"]
    );
    expect(firestore.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(firestore.orderBy).toHaveBeenCalledWith("__name__", "desc");
    expect(firestore.limit).toHaveBeenCalledWith(3);
  });

  it("applies answer progress and completes a goal that has been met", async () => {
    firestore.getDocs.mockImplementation(async (target: unknown) => {
      if (queryStatus(target) !== "active") return snapshot([]);
      return snapshot([
        goalDocument("active-goal", {
          name: "Active goal",
          status: "active",
          targetCards: 1,
          targetAccuracy: 0.8,
          deadline: 5_000,
          createdAt: 10,
          progress: {
            cardsCompleted: 0,
            correctAnswers: 0,
            totalAnswers: 0,
          },
        }),
      ]);
    });

    const { applyGoalProgressForAnswer } = await import(
      "@/services/study/goals"
    );
    const result = await applyGoalProgressForAnswer(
      "dashboard-goals-progress-user",
      true,
      1_000
    );

    expect(result.completedGoals).toBe(1);
    expect(firestore.updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "users/dashboard-goals-progress-user/goals/active-goal",
      }),
      expect.objectContaining({
        progress: {
          cardsCompleted: 1,
          correctAnswers: 1,
          totalAnswers: 1,
        },
        status: "completed",
      })
    );
  });
});

function queryValue(target: unknown, field: string) {
  if (!target || typeof target !== "object" || !("constraints" in target)) return undefined;
  const match = (target as { constraints: unknown[] }).constraints.find(
    (constraint) =>
      constraint &&
      typeof constraint === "object" &&
      (constraint as { kind?: unknown }).kind === "where" &&
      (constraint as { field?: unknown }).field === field
  ) as { value?: unknown } | undefined;
  return match?.value;
}

describe("making and finishing goals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestore.updateDoc.mockResolvedValue(undefined);
  });

  it("writes a new goal with everything it needs, guarded against older copies of the app", async () => {
    firestore.addDoc.mockResolvedValue({ id: "new-goal" });
    const { createGoal } = await import("@/services/study/goals");
    const goal = await createGoal(
      "goal-maker",
      {
        name: "",
        measure: "questions",
        cadence: "total",
        target: 12,
        days: 0,
        scope: { type: "folder", id: "chem", label: "Chemistry" },
        deadline: 0,
      },
      1_000
    );
    expect(goal).toMatchObject({ id: "new-goal", schemaVersion: 2, measure: "questions", target: 12, status: "active" });
    expect(firestore.addDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: "users/goal-maker/goals" }),
      expect.objectContaining({ schemaVersion: 2, targetCards: 12, targetAccuracy: 2, createdAt: 1_000 })
    );
  });

  it("lights the stars of goals that finished elsewhere, then stops waiting for them", async () => {
    const star = { id: "server-goal", goalId: "server-goal", constellationId: "c", size: 1, glow: 0.85, position: { x: 1, y: 1 }, createdAt: 2 };
    stars.createStarForGoalIfMissing.mockResolvedValue(star);
    firestore.getDocs.mockImplementation(async (target: unknown) =>
      queryValue(target, "rewardPending") === true
        ? snapshot([
            {
              id: "server-goal",
              ref: { path: "users/claimer/goals/server-goal" },
              data: () => ({ schemaVersion: 2, measure: "questions", target: 5, status: "completed", rewardPending: true }),
            } as ReturnType<typeof goalDocument>,
          ])
        : snapshot([])
    );
    const { claimGoalRewards } = await import("@/services/study/goals");
    const rewards = await claimGoalRewards("claimer");
    expect(rewards).toEqual([{ star, goalName: "Answer 5 practice questions" }]);
    expect(firestore.updateDoc).toHaveBeenCalledWith({ path: "users/claimer/goals/server-goal" }, { rewardPending: "__delete__" });
  });

  it("finishes a goal there and then when an edit brings its target within reach", async () => {
    stars.createStarForGoalIfMissing.mockResolvedValue(null);
    firestore.getDocs.mockResolvedValue(snapshot([]));
    const { editGoal } = await import("@/services/study/goals");
    const { goalFromDraft } = await import("@/lib/goals/model");
    const running = goalFromDraft(
      "edited",
      { name: "", measure: "cards", cadence: "total", target: 50, days: 0, scope: { type: "all" }, deadline: 0 },
      1_000
    );
    const counted = { ...running, progress: { ...running.progress, count: 30, answered: 30 } };
    const saved = await editGoal("editor", counted, { name: "", target: 25, days: 0, deadline: 0 }, 2_000);
    expect(saved.goal).toMatchObject({ status: "completed", completedAt: 2_000, target: 25 });
    expect(firestore.updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: "users/editor/goals/edited" }),
      expect.objectContaining({ target: 25, status: "completed", rewardPending: true })
    );
  });
});
