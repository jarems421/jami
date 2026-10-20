import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyAction } from "@/lib/learning/actions/study-actions";

/**
 * The engine's actions for a revision plan's own subjects: each decided from
 * that subject's evidence alone, only work that leads somewhere and is not
 * resting, and a subject that could not be read told apart from one with
 * nothing to do.
 */

const mocks = vi.hoisted(() => ({
  folders: new Map<string, Record<string, unknown>>(),
  loadLearnerProfileWithMaterial: vi.fn(),
  buildStudyActions: vi.fn(),
}));

vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id: string) => ({
            get: async () => ({ exists: mocks.folders.has(id), id, data: () => mocks.folders.get(id) }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/services/learning/learner-profile.server", () => ({
  loadLearnerProfileWithMaterial: mocks.loadLearnerProfileWithMaterial,
}));
vi.mock("@/services/learning/study-action-history.server", () => ({
  loadStudyActionHistory: async () => ({ history: new Map(), available: true }),
}));
vi.mock("@/services/learning/revision-session-context.server", () => ({ revisionSessionsEnabled: () => false }));
vi.mock("@/lib/learning/actions/study-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/learning/actions/study-actions")>()),
  buildStudyActions: mocks.buildStudyActions,
}));

const { loadStudyActionsForScopes, PLAN_ACTIONS_PER_SCOPE } = await import("@/services/learning/study-actions.server");

function action(id: string, overrides: Partial<StudyAction> = {}): StudyAction {
  return {
    id,
    destination: { kind: "flashcards", href: `/dashboard/study?x=${id}`, selection: {} },
    ...overrides,
  } as StudyAction;
}

beforeEach(() => {
  mocks.folders.clear();
  mocks.loadLearnerProfileWithMaterial.mockReset();
  mocks.buildStudyActions.mockReset();
});

describe("a plan's subjects, asked about one by one", () => {
  it("keeps each subject's own actions, leading somewhere and not resting, up to its share", async () => {
    mocks.folders.set("bio", { name: "Biology", archived: false, topicIds: [] });
    mocks.loadLearnerProfileWithMaterial.mockImplementation(async (input: { folderId?: string; deckId?: string }) =>
      input.folderId === "bio" || input.deckId === "verbs" ? { profile: { scope: input }, notebookMaterial: {} } : null
    );
    mocks.buildStudyActions.mockImplementation((profile: { scope: { folderId?: string } }) =>
      profile.scope.folderId === "bio"
        ? [
            action("dead-end", { destination: undefined }),
            action("resting", { cooldown: { reason: "started", until: 0 } as never }),
            ...Array.from({ length: 12 }, (_, index) => action(`bio-${index}`)),
          ]
        : [action("verbs-1")]
    );

    const result = await loadStudyActionsForScopes({ uid: "user-1", scopeKeys: ["folder:bio", "deck:verbs", "folder:gone"] });
    expect(result.scopes.map((scope) => [scope.scopeKey, scope.status, scope.actions.length])).toEqual([
      ["folder:bio", "ok", PLAN_ACTIONS_PER_SCOPE],
      ["deck:verbs", "ok", 1],
      ["folder:gone", "missing", 0],
    ]);
    expect(result.scopes[0]?.actions.map((entry) => entry.id)).not.toContain("dead-end");
    expect(result.scopes[0]?.actions.map((entry) => entry.id)).not.toContain("resting");
    expect(result.folders.map((folder) => folder.id)).toEqual(["bio"]);
  });

  it("says a subject failed rather than that it has nothing to do", async () => {
    mocks.folders.set("bio", { name: "Biology", archived: false, topicIds: [] });
    mocks.loadLearnerProfileWithMaterial.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
    const result = await loadStudyActionsForScopes({ uid: "user-1", scopeKeys: ["folder:bio"] });
    expect(result.scopes).toEqual([{ scopeKey: "folder:bio", status: "failed", actions: [] }]);
  });

  it("reads nothing for keys that name nothing, or past the six a plan holds", async () => {
    mocks.loadLearnerProfileWithMaterial.mockResolvedValue(null);
    const keys = ["none", "folder:", "ghost", ...Array.from({ length: 8 }, (_, index) => `deck:d${index}`)];
    const result = await loadStudyActionsForScopes({ uid: "user-1", scopeKeys: keys });
    expect(result.scopes.map((scope) => scope.scopeKey)).toEqual(["deck:d0", "deck:d1", "deck:d2", "deck:d3", "deck:d4", "deck:d5"]);
    expect(await loadStudyActionsForScopes({ uid: " ", scopeKeys: ["deck:d0"] })).toMatchObject({ scopes: [] });
  });
});
