import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The study-actions endpoint: signed-in students only, and a clean failure when the engine cannot answer. */

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  loadStudyActions: vi.fn(),
  loadStudyActionsForScopes: vi.fn(),
}));

vi.mock("@/services/auth/authenticate-request.server", () => ({
  authenticateRequest: mocks.authenticateRequest,
  apiFailure: (error: string, status: number, code: string) => Response.json({ error, code }, { status }),
}));
vi.mock("@/services/learning/study-actions.server", () => ({
  MAX_PLAN_ACTION_SCOPES: 6,
  loadStudyActions: mocks.loadStudyActions,
  loadStudyActionsForScopes: mocks.loadStudyActionsForScopes,
}));

const { GET } = await import("@/app/api/learning/study-actions/route");

function request(query = "") {
  return new NextRequest(`http://localhost/api/learning/study-actions${query}`);
}

beforeEach(() => {
  mocks.authenticateRequest.mockReset();
  mocks.loadStudyActions.mockReset();
  mocks.loadStudyActionsForScopes.mockReset();
});

describe("GET /api/learning/study-actions?scopes=", () => {
  it("answers for a plan's own subjects, each on its own, and only the student's", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadStudyActionsForScopes.mockResolvedValue({
      scopes: [
        { scopeKey: "folder:bio", status: "ok", actions: [] },
        { scopeKey: "deck:verbs", status: "failed", actions: [] },
      ],
      folders: [{ id: "bio", name: "Biology", examCourse: { board: "aqa" } }],
      generatedAt: 1,
    });
    const response = await GET(request(`?scopes=${encodeURIComponent("folder:bio,deck:verbs")}`));
    expect(response.status).toBe(200);
    expect(mocks.loadStudyActionsForScopes).toHaveBeenCalledWith({ uid: "user-1", scopeKeys: ["folder:bio", "deck:verbs"] });
    expect(mocks.loadStudyActions).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.scopes).toHaveLength(2);
    // Narrowed at the boundary, as Today's answer is.
    expect(body.folders).toEqual([{ id: "bio", name: "Biology" }]);
  });

  it("asks about no more subjects than a plan can hold", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadStudyActionsForScopes.mockResolvedValue({ scopes: [], folders: [], generatedAt: 1 });
    const many = Array.from({ length: 10 }, (_, index) => `folder:f${index}`).join(",");
    await GET(request(`?scopes=${encodeURIComponent(many)}`));
    expect(mocks.loadStudyActionsForScopes.mock.calls[0]?.[0].scopeKeys).toHaveLength(6);
  });
});

describe("GET /api/learning/study-actions", () => {
  it("refuses a request without a signed-in student", async () => {
    mocks.authenticateRequest.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.loadStudyActions).not.toHaveBeenCalled();
  });

  it("returns the student's own study actions", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadStudyActions.mockResolvedValue({
      actions: [],
      folders: [{ id: "folder-1", name: "Maths" }],
      evaluatedFolders: 1,
      failedFolders: 0,
      generatedAt: 1,
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.loadStudyActions).toHaveBeenCalledWith({ uid: "user-1" });
    await expect(response.json()).resolves.toMatchObject({ folders: [{ id: "folder-1" }] });
  });

  it("fails cleanly when the engine cannot answer", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadStudyActions.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "study_actions_unavailable" });
  });
});
