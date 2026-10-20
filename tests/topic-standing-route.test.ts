import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The topic-standing endpoint: the student's own folder only, reads only, and a clean failure. */

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  loadTopicStandings: vi.fn(),
}));

vi.mock("@/services/auth/authenticate-request.server", () => ({
  authenticateRequest: mocks.authenticateRequest,
  apiFailure: (error: string, status: number, code: string) => Response.json({ error, code }, { status }),
}));
vi.mock("@/services/learning/topic-standing.server", () => ({
  loadTopicStandings: mocks.loadTopicStandings,
}));

const { GET } = await import("@/app/api/learning/topic-standing/route");

function request(folderId?: string) {
  const query = folderId === undefined ? "" : `?folderId=${encodeURIComponent(folderId)}`;
  return new NextRequest(`http://localhost/api/learning/topic-standing${query}`);
}

beforeEach(() => {
  mocks.authenticateRequest.mockReset();
  mocks.loadTopicStandings.mockReset();
});

describe("GET /api/learning/topic-standing", () => {
  it("refuses a request without a signed-in student", async () => {
    mocks.authenticateRequest.mockResolvedValue(null);
    expect((await GET(request("chem"))).status).toBe(401);
    expect(mocks.loadTopicStandings).not.toHaveBeenCalled();
  });

  it("asks for a folder, and will not take a path for one", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    expect((await GET(request())).status).toBe(400);
    expect((await GET(request("a/b"))).status).toBe(400);
    expect(mocks.loadTopicStandings).not.toHaveBeenCalled();
  });

  it("returns where the student's own topics stand", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadTopicStandings.mockResolvedValue([{ key: "topic:t", label: "Waves", demonstration: "weak" }]);
    const response = await GET(request("physics"));
    expect(response.status).toBe(200);
    expect(mocks.loadTopicStandings).toHaveBeenCalledWith({ uid: "user-1", folderId: "physics" });
    await expect(response.json()).resolves.toMatchObject({ topics: [{ key: "topic:t", demonstration: "weak" }] });
  });

  it("says when the folder is gone", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadTopicStandings.mockResolvedValue(null);
    expect((await GET(request("deleted"))).status).toBe(404);
  });

  it("fails cleanly when the engine cannot answer", async () => {
    mocks.authenticateRequest.mockResolvedValue("user-1");
    mocks.loadTopicStandings.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
    const response = await GET(request("chem"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "topic_standing_unavailable" });
  });
});
