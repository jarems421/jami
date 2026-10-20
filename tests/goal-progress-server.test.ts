import { beforeEach, describe, expect, it, vi } from "vitest";
import { goalDocument, type GoalDraft } from "@/lib/goals/model";

/*
 * Marked answers counted towards practice-question goals, against an in-memory
 * store shaped like the Admin SDK's: collections, a status query, and
 * transactions whose writes land only when they commit.
 */
const mocks = vi.hoisted(() => {
  type Data = Record<string, unknown>;
  type DocRef = { path: string; id: string; collection: (name: string) => CollectionRef };
  type CollectionRef = {
    path: string;
    doc: (id: string) => DocRef;
    where: (field: string, op: string, value: unknown) => { get: () => Promise<{ docs: unknown[] }> };
  };
  const store = new Map<string, Data>();
  const state = { transactions: 0, failQuery: false };
  const docRef = (path: string): DocRef => ({
    path,
    id: path.split("/").at(-1) ?? "",
    collection: (name: string) => collectionRef(`${path}/${name}`),
  });
  const collectionRef = (path: string): CollectionRef => ({
    path,
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => {
        if (state.failQuery) throw new Error("Firestore unavailable");
        const depth = path.split("/").length + 1;
        const docs = [...store.entries()]
          .filter(([key, data]) => key.startsWith(`${path}/`) && key.split("/").length === depth && data[field] === value)
          .map(([key, data]) => ({ id: key.split("/").at(-1), ref: docRef(key), data: () => data }));
        return { docs };
      },
    }),
  });
  const db = {
    collection: (name: string) => collectionRef(name),
    runTransaction: async <T>(
      run: (transaction: {
        get: (ref: DocRef) => Promise<{ exists: boolean; id: string; ref: DocRef; data: () => Data | undefined }>;
        update: (ref: DocRef, fields: Data) => void;
        set: (ref: DocRef, value: Data) => void;
      }) => Promise<T>
    ): Promise<T> => {
      state.transactions += 1;
      const writes: Array<() => void> = [];
      const result = await run({
        get: async (ref) => ({ exists: store.has(ref.path), id: ref.id, ref, data: () => store.get(ref.path) }),
        update: (ref, fields) => writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...fields })),
        set: (ref, value) => writes.push(() => store.set(ref.path, value)),
      });
      writes.forEach((write) => write());
      return result;
    },
  };
  return { store, state, db };
});

vi.mock("@/services/firebase/admin", () => ({ getAdminDb: () => mocks.db }));

const { countMarkedAnswersTowardGoals } = await import("@/services/study/goal-progress.server");

const NOW = Date.parse("2026-10-20T10:00:00Z");
const GOALS = "users/u1/goals";

function seed(id: string, overrides: Partial<GoalDraft>) {
  mocks.store.set(
    `${GOALS}/${id}`,
    goalDocument(
      {
        name: "",
        measure: "questions",
        cadence: "total",
        target: 3,
        days: 0,
        scope: { type: "folder", id: "chem", label: "Chemistry" },
        deadline: 0,
        ...overrides,
      },
      NOW - 1000
    )
  );
}

function progressOf(id: string) {
  return mocks.store.get(`${GOALS}/${id}`)?.progress as Record<string, number> | undefined;
}

beforeEach(() => {
  mocks.store.clear();
  mocks.state.transactions = 0;
  mocks.state.failQuery = false;
});

describe("marked answers towards practice-question goals", () => {
  it("count once per marking, however often the marking is reported", async () => {
    seed("chem-goal", {});
    const input = { uid: "u1", receiptId: "exam:a1", folderId: "chem", scores: [0.5], at: NOW };
    expect(await countMarkedAnswersTowardGoals(input)).toEqual({ counted: 1, completed: 0 });
    expect(await countMarkedAnswersTowardGoals(input)).toEqual({ counted: 0, completed: 0 });
    expect(progressOf("chem-goal")).toMatchObject({ count: 1, scoreSum: 0.5 });
  });

  it("count every answered question of a paper together", async () => {
    seed("chem-goal", { target: 10 });
    await countMarkedAnswersTowardGoals({ uid: "u1", receiptId: "paper:p1", folderId: "chem", scores: [1, 0.5, 0], at: NOW });
    expect(progressOf("chem-goal")).toMatchObject({ count: 3, scoreSum: 1.5 });
  });

  it("finish a goal and leave its star for the next screen to light", async () => {
    seed("chem-goal", { target: 1 });
    expect(
      await countMarkedAnswersTowardGoals({ uid: "u1", receiptId: "exam:a2", folderId: "chem", scores: [1], at: NOW })
    ).toEqual({ counted: 1, completed: 1 });
    expect(mocks.store.get(`${GOALS}/chem-goal`)).toMatchObject({ status: "completed", completedAt: NOW, rewardPending: true });
  });

  it("leave goals from other folders and of other kinds alone", async () => {
    seed("bio-goal", { scope: { type: "folder", id: "bio" } });
    seed("cards-goal", { measure: "cards", scope: { type: "all" } });
    await countMarkedAnswersTowardGoals({ uid: "u1", receiptId: "exam:a3", folderId: "chem", scores: [1], at: NOW });
    expect(progressOf("bio-goal")).toMatchObject({ count: 0 });
    expect(progressOf("cards-goal")).toMatchObject({ count: 0 });
  });

  it("cost a student with no question goal one small read and no transaction", async () => {
    seed("cards-goal", { measure: "cards", scope: { type: "all" } });
    await countMarkedAnswersTowardGoals({ uid: "u1", receiptId: "exam:a4", folderId: "chem", scores: [1], at: NOW });
    expect(mocks.state.transactions).toBe(0);
  });

  it("never fail the marking that called it", async () => {
    seed("chem-goal", {});
    mocks.state.failQuery = true;
    await expect(
      countMarkedAnswersTowardGoals({ uid: "u1", receiptId: "exam:a5", folderId: "chem", scores: [1], at: NOW })
    ).resolves.toEqual({ counted: 0, completed: 0 });
  });

  it("do nothing for a blank paper", async () => {
    seed("chem-goal", {});
    await countMarkedAnswersTowardGoals({ uid: "u1", receiptId: "paper:p2", folderId: "chem", scores: [], at: NOW });
    expect(mocks.state.transactions).toBe(0);
    expect(progressOf("chem-goal")).toMatchObject({ count: 0 });
  });
});
