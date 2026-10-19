import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A video import as its workflow runs it: each part its own step, so no one
 * function has to download, upload, wait for Gemini and read a long lecture
 * inside one time limit. The directives are plain strings here, so the steps
 * run in-line against mocked services.
 */

const mocks = vi.hoisted(() => ({
  sleep: vi.fn(async () => undefined),
  startVideoCardJob: vi.fn(),
  uploadVideoCardSource: vi.fn(),
  checkVideoCardSource: vi.fn(),
  readVideoCardSource: vi.fn(),
  finishVideoCardJob: vi.fn(async () => undefined),
  removeVideoCardSourceCopy: vi.fn(async () => undefined),
  jobUpdate: vi.fn(async () => undefined),
  deleteUpload: vi.fn(async () => undefined),
}));

vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@/services/ai/video-card-generation.server", () => ({
  startVideoCardJob: mocks.startVideoCardJob,
  uploadVideoCardSource: mocks.uploadVideoCardSource,
  checkVideoCardSource: mocks.checkVideoCardSource,
  readVideoCardSource: mocks.readVideoCardSource,
  finishVideoCardJob: mocks.finishVideoCardJob,
  removeVideoCardSourceCopy: mocks.removeVideoCardSourceCopy,
}));
vi.mock("@/services/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ data: () => ({ status: "running", sourceKind: "upload", storagePath: "users/u/v.mp4" }) }),
            update: mocks.jobUpdate,
          }),
        }),
      }),
    }),
  }),
  getAdminStorageBucket: () => ({ file: () => ({ delete: mocks.deleteUpload }) }),
}));

const { generateVideoCardWorkflow } = await import("@/workflows/video-card-generation");

const uploaded = { uri: "https://files/abc", name: "files/abc", mimeType: "video/mp4", state: "PROCESSING" };
const read = { generation: { cards: [] }, durationSeconds: 3600, provider: "Google", model: "m", usage: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startVideoCardJob.mockResolvedValue({ kind: "upload" });
  mocks.uploadVideoCardSource.mockResolvedValue(uploaded);
  mocks.checkVideoCardSource.mockResolvedValue({ ...uploaded, state: "ACTIVE" });
  mocks.readVideoCardSource.mockResolvedValue(read);
});

describe("a video import", () => {
  it("uploads, waits between steps until Gemini is ready, reads, finishes, and removes Gemini's copy", async () => {
    mocks.checkVideoCardSource
      .mockResolvedValueOnce({ ...uploaded, state: "PROCESSING" })
      .mockResolvedValueOnce({ ...uploaded, state: "ACTIVE" });

    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "ready" });

    expect(mocks.sleep).toHaveBeenCalledTimes(2);
    expect(mocks.readVideoCardSource).toHaveBeenCalledWith("u", "job", { ...uploaded, state: "ACTIVE" });
    expect(mocks.finishVideoCardJob).toHaveBeenCalledWith("u", "job", { ...uploaded, state: "ACTIVE" }, read);
    expect(mocks.removeVideoCardSourceCopy).toHaveBeenCalledWith({ ...uploaded, state: "ACTIVE" });
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
  });

  it("fails the import when Gemini cannot process the upload, and still removes its copy", async () => {
    mocks.checkVideoCardSource.mockResolvedValue({ ...uploaded, state: "FAILED" });

    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "failed" });

    expect(mocks.readVideoCardSource).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(mocks.deleteUpload).toHaveBeenCalled();
    expect(mocks.removeVideoCardSourceCopy).toHaveBeenCalled();
  });

  it("gives up on an upload Gemini is still processing after ten minutes", async () => {
    mocks.checkVideoCardSource.mockResolvedValue(uploaded);

    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "failed" });

    expect(mocks.sleep).toHaveBeenCalledTimes(60);
    expect(mocks.readVideoCardSource).not.toHaveBeenCalled();
  });

  it("reads a YouTube video straight away, with nothing to upload or remove", async () => {
    const youtube = { uri: "https://www.youtube.com/watch?v=abcdefghijk", mimeType: "video/mp4" };
    mocks.startVideoCardJob.mockResolvedValue({ kind: "youtube", video: youtube });

    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "ready" });

    expect(mocks.uploadVideoCardSource).not.toHaveBeenCalled();
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.readVideoCardSource).toHaveBeenCalledWith("u", "job", youtube);
    expect(mocks.removeVideoCardSourceCopy).not.toHaveBeenCalled();
  });

  it("stops after the start for a file, pasted notes, or a cancelled import", async () => {
    mocks.startVideoCardJob.mockResolvedValue({ kind: "done" });
    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "ready" });
    mocks.startVideoCardJob.mockResolvedValue({ kind: "stopped" });
    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "ready" });

    expect(mocks.uploadVideoCardSource).not.toHaveBeenCalled();
    expect(mocks.readVideoCardSource).not.toHaveBeenCalled();
  });

  it("finishes nothing when the student cancelled during the read", async () => {
    mocks.readVideoCardSource.mockResolvedValue(null);

    await expect(generateVideoCardWorkflow("u", "job")).resolves.toEqual({ status: "ready" });

    expect(mocks.finishVideoCardJob).not.toHaveBeenCalled();
    expect(mocks.removeVideoCardSourceCopy).toHaveBeenCalled();
  });
});
