import { afterEach, describe, expect, it } from "vitest";
import {
  chooseVideoRoute,
  formatVideoTimestamp,
  getVideoCoverageSelectivity,
  getVideoSamplingFps,
  isStalledVideoCardJob,
  mapVideoCardJobData,
  parseVideoCardLimit,
  VIDEO_CARD_REVIEW_CEILING,
  VIDEO_JOB_QUEUED_STALL_MS,
} from "@/lib/ai/video-card-jobs";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("video card routing", () => {
  /*
   * Every video goes to Gemini, and every video gets looked at.
   *
   * Two things were wrong before. Six video-capable models on OpenRouter --
   * Qwen, GLM, two Gemmas, a Qwen MoE, a ByteDance Seed -- all failed on real
   * video with 400, 405 or an empty 200, so the OpenRouter leg was removed.
   * And videos over twenty minutes were handed to Gemini's seeking mode, which
   * does not watch: on the app's own prompt it inventoried none of a lesson's
   * eleven visuals and called it "a host talking without diagrams".
   */
  it("samples every video rather than seeking through it", () => {
    for (const durationSeconds of [30, 300, 1_200, 5_400]) {
      const route = chooseVideoRoute({ durationSeconds });
      expect(route.provider, String(durationSeconds)).toBe("gemini");
      expect(route.fps, String(durationSeconds)).toBeGreaterThan(0);
    }
  });

  it("looks less often the longer the video, so a lecture still fits", () => {
    // Frames are billed linearly, so the rate is what keeps a long recording
    // inside its budget without giving up on watching it.
    const short = chooseVideoRoute({ durationSeconds: 300 }).fps;
    const medium = chooseVideoRoute({ durationSeconds: 1_800 }).fps;
    const long = chooseVideoRoute({ durationSeconds: 5_400 }).fps;

    expect(short).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(long);
  });

  it("never samples faster than once a second or slower than the floor", () => {
    // Above 1 fps buys nothing; below 0.1 a diagram on screen for eight seconds
    // can fall between two frames.
    expect(getVideoSamplingFps(1)).toBe(1);
    expect(getVideoSamplingFps(10)).toBe(1);
    expect(getVideoSamplingFps(100_000)).toBe(0.1);
  });

  it("keeps a long video's frame cost near the budget rather than unbounded", () => {
    // 270 tokens a frame, measured. An hour at one frame a second would be
    // nearly a million tokens on its own.
    for (const durationSeconds of [600, 1_800, 3_600]) {
      const frames = getVideoSamplingFps(durationSeconds) * durationSeconds;
      expect(frames * 270, String(durationSeconds)).toBeLessThanOrEqual(130_000);
    }
  });

  it("takes the model from the environment", () => {
    process.env.VIDEO_GEMINI_MODEL = "gemini-custom";
    expect(chooseVideoRoute({ durationSeconds: 300 }).model).toBe("gemini-custom");
  });

  /*
   * Coverage says what earns a card, not how many. A fixed range meant a
   * two-minute clip was asked for twenty cards and either padded to reach them
   * or failed `card_count_out_of_range` for not containing enough to say.
   */
  it("describes what earns a card rather than a count", () => {
    for (const coverage of ["focused", "standard", "thorough"] as const) {
      const text = getVideoCoverageSelectivity(coverage);
      expect(text, coverage).toBeTruthy();
      expect(text, coverage).not.toMatch(/\d+\s*(-|to|–)\s*\d+/);
    }
    // The levels get broader, not longer-winded, as they go up.
    expect(getVideoCoverageSelectivity("focused")).toContain("Only core teaching");
    expect(getVideoCoverageSelectivity("thorough")).toContain("supporting detail");
  });

  it("takes a limit only when the student sets one, and keeps it sane", () => {
    expect(parseVideoCardLimit(undefined)).toBeNull();
    expect(parseVideoCardLimit("")).toBeNull();
    expect(parseVideoCardLimit(0)).toBeNull();
    expect(parseVideoCardLimit(-4)).toBeNull();
    expect(parseVideoCardLimit(12)).toBe(12);
    expect(parseVideoCardLimit("12")).toBe(12);
    // Nobody reviews 500 drafts in a sitting, whatever they type.
    expect(parseVideoCardLimit(500)).toBe(VIDEO_CARD_REVIEW_CEILING);
  });

  it("keeps the timestamp label stable", () => {
    expect(formatVideoTimestamp(125)).toBe("2:05");
  });

  it("keeps file and pasted-text imports distinct from video jobs", () => {
    expect(mapVideoCardJobData("file-job", {
      sourceKind: "file",
      fileName: "Lecture 4.pptx",
      coverage: "standard",
    })).toMatchObject({ sourceKind: "file", fileName: "Lecture 4.pptx" });
    expect(mapVideoCardJobData("text-job", {
      sourceKind: "text",
      coverage: "thorough",
    })).toMatchObject({ sourceKind: "text", coverage: "thorough" });
  });
});

describe("stalled imports", () => {
  const now = 1_000_000_000;
  const old = now - VIDEO_JOB_QUEUED_STALL_MS - 1;

  it("calls a job stuck in the queue past the limit stalled", () => {
    expect(isStalledVideoCardJob({ status: "queued", createdAt: old }, now)).toBe(true);
  });

  it("leaves a fresh queued job, a started job and a finished job alone", () => {
    expect(isStalledVideoCardJob({ status: "queued", createdAt: now - 60_000 }, now)).toBe(false);
    expect(isStalledVideoCardJob({ status: "queued", createdAt: old, providerStartedAt: old + 1 }, now)).toBe(false);
    expect(isStalledVideoCardJob({ status: "running", createdAt: old }, now)).toBe(false);
    expect(isStalledVideoCardJob({ status: "ready", createdAt: old }, now)).toBe(false);
  });
});
