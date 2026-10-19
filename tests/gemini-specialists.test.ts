import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const createInteraction = vi.fn();
const uploadFile = vi.fn();
const getFile = vi.fn();
const deleteFile = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    interactions = { create: createInteraction };
    files = { upload: uploadFile, get: getFile, delete: deleteFile };
  },
}));
vi.mock("server-only", () => ({}));

const {
  generateGeminiImage,
  generateGeminiVideoText,
  generateGroundedResearch,
  readTemporaryGeminiVideoState,
  startTemporaryGeminiVideoUpload,
  geminiBilledTokens,
  groundedSearchCount,
} = await import("@/lib/ai/gemini");
const { runWithAiSpendContext } = await import("@/lib/ai/spend-context");
type AiSpendSample = import("@/lib/ai/spend").AiSpendSample;

/** Runs a call inside a spend context and returns what it metered. */
async function metered<T>(run: () => Promise<T>) {
  const samples: AiSpendSample[] = [];
  const result = await runWithAiSpendContext(
    { uid: "student", action: "assistant", record: (sample) => samples.push(sample) },
    run
  );
  return { result, samples };
}

const trackedEnv = [
  "GEMINI_API_KEY",
  "GEMINI_RESEARCH_MODEL",
  "GEMINI_ENABLED",
  "GEMINI_PRIVACY_APPROVED",
  "GEMINI_QUALITY_GATE_PASSED",
  "GEMINI_KILL_SWITCH",
  "AI_WEB_RESEARCH_ENABLED",
  "AI_TUTOR_IMAGES_ENABLED",
  "AI_PAPER_IMAGES_ENABLED",
] as const;
const originalEnv = Object.fromEntries(
  trackedEnv.map((key) => [key, process.env[key]])
);

describe("Gemini specialists", () => {
  beforeEach(() => {
    generateContent.mockReset();
    createInteraction.mockReset();
    uploadFile.mockReset();
    getFile.mockReset();
    deleteFile.mockReset().mockResolvedValue({});
    for (const key of trackedEnv) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_ENABLED = "true";
    process.env.GEMINI_PRIVACY_APPROVED = "true";
    process.env.GEMINI_QUALITY_GATE_PASSED = "true";
  });

  it("fails grounded research gracefully when its release gate is closed", async () => {
    await expect(generateGroundedResearch({
      sanitizedQuery: "AQA GCSE biology mitosis specification",
    })).resolves.toEqual({ ok: false, reason: "not_configured" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("uses Search and URL Context and returns citations", async () => {
    process.env.AI_WEB_RESEARCH_ENABLED = "true";
    generateContent.mockResolvedValueOnce({
      text: "Verified course evidence.",
      candidates: [{
        groundingMetadata: {
          groundingChunks: [{
            web: { title: "Official specification", uri: "https://example.edu/spec" },
          }],
        },
        urlContextMetadata: {
          urlMetadata: [{ retrievedUrl: "https://example.edu/module" }],
        },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    });
    await expect(generateGroundedResearch({
      sanitizedQuery: "university module exam format",
      urls: ["https://example.edu/module", "http://localhost/private"],
    })).resolves.toMatchObject({
      ok: true,
      brief: "Verified course evidence.",
      citations: [
        { title: "Official specification", url: "https://example.edu/spec" },
        { title: "https://example.edu/module", url: "https://example.edu/module" },
      ],
    });
    const params = generateContent.mock.calls[0][0];
    expect(params.model).toBe("gemini-3.5-flash-lite");
    expect(params.config.tools).toEqual([{ googleSearch: {} }, { urlContext: {} }]);
    expect(JSON.stringify(params.contents)).not.toContain("localhost");
  });

  it("never sends private URL targets or returns unsafe provider citations", async () => {
    process.env.AI_WEB_RESEARCH_ENABLED = "true";
    generateContent.mockResolvedValueOnce({
      text: "Verified public evidence.",
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { title: "Public", uri: "https://example.edu/spec#section" } },
            { web: { title: "Metadata", uri: "http://169.254.169.254/latest/meta-data" } },
            { web: { title: "Signed", uri: "https://example.edu/file?signature=secret" } },
          ],
        },
        urlContextMetadata: {
          urlMetadata: [
            { retrievedUrl: "https://example.edu/module" },
            { retrievedUrl: "http://10.0.0.4/private" },
          ],
        },
      }],
    });

    const result = await generateGroundedResearch({
      sanitizedQuery: "AQA GCSE biology specification",
      urls: [
        "https://example.edu/module#week-2",
        "http://10.0.0.4/private",
        "http://169.254.169.254/latest/meta-data",
        "https://example.edu/file?access_token=secret",
        "https://user:password@example.edu/private",
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      citations: [
        { title: "Public", url: "https://example.edu/spec" },
        { title: "https://example.edu/module", url: "https://example.edu/module" },
      ],
    });
    const requestText = JSON.stringify(generateContent.mock.calls[0][0].contents);
    expect(requestText).toContain("https://example.edu/module");
    expect(requestText).not.toMatch(/10\.0\.0\.4|169\.254\.169\.254|access_token|password/);
  });

  it("resolves the image model from role and returns private base64", async () => {
    process.env.AI_TUTOR_IMAGES_ENABLED = "true";
    generateContent.mockResolvedValueOnce({
      candidates: [{
        content: {
          parts: [
            { text: "A labelled cell diagram." },
            { inlineData: { data: "YWJj", mimeType: "image/png" } },
          ],
        },
      }],
    });
    await expect(generateGeminiImage({
      role: "tutorImage",
      prompt: "A labelled cell diagram",
    })).resolves.toEqual({
      data: "YWJj",
      mimeType: "image/png",
      description: "A labelled cell diagram.",
    });
    expect(generateContent.mock.calls[0][0]).toMatchObject({
      model: "gemini-3.1-flash-image",
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "4:3", imageSize: "1K" },
      },
    });
  });

  /*
   * Research and images reach Gemini directly, not through the router, and
   * were never metered: the spend report showed Gemini as almost free while it
   * was most of the bill.
   */
  describe("metering", () => {
    const groundedResponse = (webSearchQueries: string[]) => ({
      text: "Verified course evidence.",
      candidates: [{
        groundingMetadata: {
          webSearchQueries,
          groundingChunks: [{ web: { title: "Spec", uri: "https://example.edu/spec" } }],
        },
      }],
      usageMetadata: {
        promptTokenCount: 120,
        toolUsePromptTokenCount: 3_000,
        candidatesTokenCount: 400,
        thoughtsTokenCount: 250,
      },
    });

    it("records a Gemini 3 research call with every search query it ran", async () => {
      process.env.AI_WEB_RESEARCH_ENABLED = "true";
      generateContent.mockResolvedValueOnce(groundedResponse(["aqa biology paper 1 format", "aqa 8461 marks"]));

      const { samples } = await metered(() =>
        generateGroundedResearch({ sanitizedQuery: "AQA GCSE biology paper format" })
      );

      expect(samples).toEqual([{
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        promptTokens: 3_120,
        completionTokens: 650,
        audioPromptTokens: 0,
        imageCompletionTokens: 0,
        searches: 2,
      }]);
    });

    it("records one search for a grounded Gemini 2.5 prompt, however many queries it ran", async () => {
      process.env.AI_WEB_RESEARCH_ENABLED = "true";
      process.env.GEMINI_RESEARCH_MODEL = "gemini-2.5-flash-lite";
      generateContent.mockResolvedValueOnce(groundedResponse(["one", "two", "three"]));

      const { samples } = await metered(() =>
        generateGroundedResearch({ sanitizedQuery: "AQA GCSE biology paper format" })
      );

      expect(samples[0]).toMatchObject({ model: "gemini-2.5-flash-lite", searches: 1 });
    });

    it("records a research call that came back empty, because it was still billed", async () => {
      process.env.AI_WEB_RESEARCH_ENABLED = "true";
      generateContent.mockResolvedValueOnce({ text: "", candidates: [{}], usageMetadata: { promptTokenCount: 90 } });

      const { result, samples } = await metered(() =>
        generateGroundedResearch({ sanitizedQuery: "AQA GCSE biology paper format" })
      );

      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(samples).toHaveLength(1);
      expect(samples[0]).not.toHaveProperty("searches");
    });

    it("records a generated image's tokens as image output", async () => {
      process.env.AI_PAPER_IMAGES_ENABLED = "true";
      generateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ inlineData: { data: "YWJj", mimeType: "image/png" } }] } }],
        usageMetadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 1_150,
          candidatesTokensDetails: [
            { modality: "TEXT", tokenCount: 30 },
            { modality: "IMAGE", tokenCount: 1_120 },
          ],
        },
      });

      const { samples } = await metered(() =>
        generateGeminiImage({ role: "paperImage", prompt: "A micrograph of onion cells" })
      );

      expect(samples).toEqual([{
        provider: "gemini",
        model: "gemini-3.1-flash-image",
        promptTokens: 300,
        completionTokens: 1_150,
        audioPromptTokens: 0,
        imageCompletionTokens: 1_120,
      }]);
    });

    /*
     * The Interactions API names its counts `total_*_tokens`. The meter read
     * generateContent's names instead, so every video import was recorded as
     * a call of zero tokens.
     */
    it("records a video read from the Interactions API's own counts, audio apart", async () => {
      createInteraction.mockResolvedValueOnce({
        output_text: "{\"cards\":[]}",
        usage: {
          total_input_tokens: 240_000,
          total_output_tokens: 6_000,
          total_thought_tokens: 1_000,
          input_tokens_by_modality: [
            { modality: "video", tokens: 120_000 },
            { modality: "audio", tokens: 115_000 },
            { modality: "text", tokens: 5_000 },
          ],
        },
      });

      const { samples } = await metered(() =>
        generateGeminiVideoText({
          uri: "https://www.youtube.com/watch?v=lesson",
          mimeType: "video/mp4",
          model: "gemini-2.5-flash-lite",
          processing: { fps: 0.5 },
          prompt: "Make cards",
        })
      );

      expect(samples).toEqual([{
        provider: "gemini",
        model: "gemini-2.5-flash-lite",
        promptTokens: 240_000,
        completionTokens: 7_000,
        audioPromptTokens: 115_000,
      }]);
    });

    it("records an empty video read before refusing it, because it was billed", async () => {
      createInteraction.mockResolvedValueOnce({ output_text: " ", usage: { total_input_tokens: 50_000 } });

      const samples: AiSpendSample[] = [];
      const run = runWithAiSpendContext(
        { uid: "student", action: "videoCardImport", record: (sample) => samples.push(sample) },
        () =>
          generateGeminiVideoText({
            uri: "https://www.youtube.com/watch?v=lesson",
            mimeType: "video/mp4",
            model: "gemini-2.5-flash-lite",
            processing: { fps: 0.5 },
            prompt: "Make cards",
          })
      );

      await expect(run).rejects.toThrow("gemini_empty");
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({ promptTokens: 50_000 });
    });

    it("counts no search for an answer the model gave without searching", () => {
      expect(groundedSearchCount("gemini-3.5-flash-lite", { candidates: [{}] })).toBe(0);
      expect(groundedSearchCount("gemini-2.5-flash-lite", { candidates: [{}] })).toBe(0);
    });

    it("bills thinking as output and fetched pages as input", () => {
      expect(geminiBilledTokens({
        promptTokenCount: 10,
        toolUsePromptTokenCount: 5,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 3,
      })).toMatchObject({ promptTokens: 15, completionTokens: 10 });
      expect(geminiBilledTokens(undefined)).toEqual({});
    });
  });

  describe("uploaded videos", () => {
    const uploaded = { uri: "https://files/abc", name: "files/abc" };

    it("returns as soon as the upload is in, with Gemini's processing state, rather than waiting on it", async () => {
      uploadFile.mockResolvedValue({ ...uploaded, state: "PROCESSING" });
      await expect(startTemporaryGeminiVideoUpload({ path: "/tmp/v", mimeType: "video/mp4" })).resolves.toEqual({
        ...uploaded,
        state: "PROCESSING",
      });
      expect(uploadFile).toHaveBeenCalledWith({
        file: "/tmp/v",
        config: { mimeType: "video/mp4", displayName: "Temporary Jami video import" },
      });
      expect(getFile).not.toHaveBeenCalled();
    });

    it("refuses an upload Gemini gave no name or address", async () => {
      uploadFile.mockResolvedValue({ uri: "https://files/abc", state: "ACTIVE" });
      await expect(startTemporaryGeminiVideoUpload({ path: "/tmp/v", mimeType: "video/mp4" })).rejects.toThrow(
        "gemini_upload_failed"
      );
    });

    it("reads where Gemini is with processing an upload", async () => {
      getFile.mockResolvedValue({ state: "ACTIVE" });
      await expect(readTemporaryGeminiVideoState("files/abc")).resolves.toBe("ACTIVE");
      expect(getFile).toHaveBeenCalledWith({ name: "files/abc" });
    });
  });
});
