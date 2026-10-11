export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const VIDEO_MAX_SECONDS = 90 * 60;
export const CARD_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const CARD_SOURCE_TEXT_MAX_LENGTH = 60_000;

export type VideoCoverage = "focused" | "standard" | "thorough";
export type VideoVisualType = "diagram" | "table" | "graph" | "equation" | "slide" | "worked_example";
export type VideoVisualClassification = "core_teaching" | "worked_example" | "practice_question" | "contextual_support" | "decorative_administrative" | "uncertain";
export type VideoJobStatus = "queued" | "running" | "ready" | "approved" | "failed" | "cancelled";
export type VideoJobStage = "preparing" | "reading_video" | "creating_cards" | "ready";
export type CardImportSourceKind = "youtube" | "upload" | "file" | "text";

export type VideoCardDraft = {
  id: string;
  front: string;
  back: string;
  selected: boolean;
  timestampSeconds?: number;
  visualType?: VideoVisualType;
  evidenceIds: string[];
};

export type VideoCardWarning = {
  id: string;
  message: string;
  timestampSeconds?: number;
  visualType?: VideoVisualType;
};

/**
 * What the model says it saw, and where. Kept on the job only while the import
 * is under review: approving a batch clears it, so nothing about the video
 * survives into the deck.
 */
export type VideoCardEvidence = {
  id: string;
  timestampSeconds: number;
  kind: "concept" | "visual";
  visualType?: VideoVisualType;
  classification?: VideoVisualClassification;
  summary: string;
  facts: string[];
};

export type VideoCardJob = {
  id: string;
  status: VideoJobStatus;
  stage: VideoJobStage;
  progress: number;
  title: string;
  deckId: string;
  topicIds: string[];
  coverage: VideoCoverage;
  /** A ceiling the student asked for. Absent means "as many as the video supports". */
  maxCards?: number;
  focus?: string;
  durationSeconds: number;
  sourceKind: CardImportSourceKind;
  drafts: VideoCardDraft[];
  warnings: VideoCardWarning[];
  evidence: VideoCardEvidence[];
  /**
   * Where to play the video back while the student reviews. Both are dropped
   * the moment the import is approved or discarded.
   */
  youtubeUrl?: string;
  storagePath?: string;
  fileName?: string;
  provider?: string;
  fallbackReason?: string;
  createdAt: number;
  updatedAt: number;
  failureMessage?: string;
};

/**
 * What earns a card, rather than how many to make.
 *
 * Coverage was a fixed count per level -- thorough meant 20 to 35 cards -- and
 * a count is the one thing the video decides, not the student. A two-minute
 * clip asked for thirty cards either pads to reach them or fails the minimum
 * and apologises; an hour of lecture capped at thirty-five throws away the rest.
 *
 * So the levels describe how selective to be, and the number falls out of what
 * the video actually contains. The prompt already makes the model inventory
 * every diagram, worked example and teaching point as evidence before it writes
 * anything, which is the honest measure of how much is in there.
 */
const COVERAGE_SELECTIVITY: Record<VideoCoverage, string> = {
  focused:
    "Only core teaching: the points the video exists to make. Skip worked examples, asides and supporting detail.",
  standard:
    "Core teaching, plus worked examples and any named method or procedure the video demonstrates.",
  thorough:
    "Core teaching, worked examples, and the supporting detail around them -- definitions, conditions, common mistakes and contextual points a student would be expected to know.",
};

export function getVideoCoverageSelectivity(coverage: VideoCoverage) {
  return COVERAGE_SELECTIVITY[coverage];
}

/**
 * The most cards one import may return, when the student has not said.
 *
 * A review sanity bound, not a judgement about the video: it is how many drafts
 * a person will realistically read and approve in one sitting. A student who
 * wants fewer says so; nobody has to.
 */
export const VIDEO_CARD_REVIEW_CEILING = 60;

/** Clamps a student's own limit, if they gave one. */
export function parseVideoCardLimit(value: unknown): number | null {
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(limit)) return null;
  const rounded = Math.round(limit);
  if (rounded < 1) return null;
  return Math.min(rounded, VIDEO_CARD_REVIEW_CEILING);
}

export function parseVideoCoverage(value: unknown): VideoCoverage | null {
  return value === "focused" || value === "standard" || value === "thorough" ? value : null;
}

/**
 * Roughly what one sampled frame costs, in input tokens.
 *
 * Measured rather than assumed: a ten-minute film came back at 278 tokens per
 * frame and a thirteen-minute lesson at 268, both at one frame a second. Audio
 * is charged separately and does not move with the frame rate.
 */
const VIDEO_TOKENS_PER_FRAME = 270;

/**
 * How many input tokens of *frames* one import may spend.
 *
 * Not a cost ceiling so much as a shape: it is what keeps a long lecture inside
 * the model's context with room left for the prompt and the cards, and it is
 * what stops a ninety-minute recording costing fifteen times a six-minute one.
 */
const VIDEO_FRAME_TOKEN_BUDGET = 120_000;

/** The sampling floor and ceiling. Below 0.1 fps a diagram on screen for eight
 * seconds can fall between two frames; above 1 fps nothing is gained. */
const MIN_VIDEO_FPS = 0.1;
const MAX_VIDEO_FPS = 1;

/**
 * How often to look at a video, given how long it is.
 *
 * There used to be a mode switch here: a static pass at one frame a second
 * under twenty minutes, and Gemini's "agentic" processing above it. Measured on
 * the app's own prompt against a diagram-heavy lesson, that was the wrong axis
 * and the wrong default:
 *
 *   static, 1 fps    234,520 tokens   19 cards   11 visuals inventoried
 *   agentic              253 tokens   14 cards    0 visuals inventoried
 *
 * Agentic is nine hundred times cheaper because it is not watching. It works
 * from the transcript: asked outright whether that lesson taught with diagrams,
 * it answered "a host talking without diagrams or slides". So every video over
 * twenty minutes -- exactly the lectures most likely to be full of slides --
 * was having its slides ignored.
 *
 * Frame rate is the honest dial instead. Frames are billed linearly, so halving
 * the rate halves the cost of looking, and the same lesson at 0.2 fps still
 * inventoried ten of its eleven visuals for 67,252 tokens. So: always look,
 * and pick a rate that fits a long video inside its budget.
 *
 *   6 min   -> 1 fps      13 min -> 0.57 fps
 *   30 min  -> 0.25 fps   90 min -> 0.1 fps (the floor)
 */
export function getVideoSamplingFps(durationSeconds: number) {
  const seconds = Math.max(1, Math.floor(durationSeconds));
  const affordable = VIDEO_FRAME_TOKEN_BUDGET / (VIDEO_TOKENS_PER_FRAME * seconds);
  const fps = Math.min(MAX_VIDEO_FPS, Math.max(MIN_VIDEO_FPS, affordable));
  // Two decimals: the API takes a number, and a rate nobody can read back from
  // a log is a rate nobody can reason about when an import looks wrong.
  return Math.round(fps * 100) / 100;
}

/**
 * Which model reads a video, and how often it looks at it.
 *
 * One model and one processing mode. Gemini is not a preference here: six
 * video-capable models were tried through OpenRouter -- Qwen, GLM, two Gemmas,
 * a Qwen MoE and a ByteDance Seed -- against YouTube links and a direct MP4,
 * and every one answered 400, 405, or a 200 with an empty body. The `video`
 * input modality is advertised in OpenRouter's metadata and implemented by none
 * of them, while Gemini reads a YouTube URL natively.
 */
export function chooseVideoRoute(input: { durationSeconds: number }) {
  return {
    provider: "gemini" as const,
    model: process.env.VIDEO_GEMINI_MODEL?.trim() || "gemini-2.5-flash-lite",
    fps: getVideoSamplingFps(input.durationSeconds),
  };
}

function cleanText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

export function mapVideoCardJobData(id: string, raw: Record<string, unknown>): VideoCardJob {
  const drafts = Array.isArray(raw.drafts) ? raw.drafts.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const front = cleanText(value.front, 500);
    const back = cleanText(value.back, 4000);
    if (!front || !back) return [];
    return [{
      id: typeof value.id === "string" ? value.id : `card-${index + 1}`,
      front,
      back,
      selected: value.selected !== false,
      ...(typeof value.timestampSeconds === "number" ? { timestampSeconds: value.timestampSeconds } : {}),
      ...(typeof value.visualType === "string" ? { visualType: value.visualType as VideoVisualType } : {}),
      evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((entry): entry is string => typeof entry === "string").slice(0, 12) : [],
    }];
  }) : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const message = cleanText(value.message, 300);
    return message ? [{ id: typeof value.id === "string" ? value.id : `warning-${index + 1}`, message,
      ...(typeof value.timestampSeconds === "number" ? { timestampSeconds: value.timestampSeconds } : {}),
      ...(typeof value.visualType === "string" ? { visualType: value.visualType as VideoVisualType } : {}),
    }] : [];
  }) : [];
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const summary = cleanText(value.summary, 500);
    if (!summary) return [];
    return [{
      id: typeof value.id === "string" ? value.id : `evidence-${index + 1}`,
      timestampSeconds: typeof value.timestampSeconds === "number" ? value.timestampSeconds : 0,
      kind: value.kind === "visual" ? ("visual" as const) : ("concept" as const),
      ...(typeof value.visualType === "string" ? { visualType: value.visualType as VideoVisualType } : {}),
      ...(typeof value.classification === "string" ? { classification: value.classification as VideoVisualClassification } : {}),
      summary,
      facts: Array.isArray(value.facts) ? value.facts.map((fact) => cleanText(fact, 500)).filter(Boolean).slice(0, 12) : [],
    }];
  }) : [];
  return {
    id,
    status: (raw.status as VideoJobStatus) || "queued",
    stage: (raw.stage as VideoJobStage) || "preparing",
    progress: typeof raw.progress === "number" ? raw.progress : 0,
    title: cleanText(raw.title, 160) || "Video import",
    deckId: typeof raw.deckId === "string" ? raw.deckId : "",
    topicIds: Array.isArray(raw.topicIds) ? raw.topicIds.filter((v): v is string => typeof v === "string") : [],
    coverage: parseVideoCoverage(raw.coverage) || "standard",
    ...(parseVideoCardLimit(raw.maxCards) !== null
      ? { maxCards: parseVideoCardLimit(raw.maxCards) as number }
      : {}),
    ...(cleanText(raw.focus, 500) ? { focus: cleanText(raw.focus, 500) } : {}),
    durationSeconds: typeof raw.durationSeconds === "number" ? raw.durationSeconds : 0,
    sourceKind:
      raw.sourceKind === "upload" || raw.sourceKind === "file" || raw.sourceKind === "text"
        ? raw.sourceKind
        : "youtube",
    drafts,
    warnings,
    evidence,
    ...(typeof raw.youtubeUrl === "string" ? { youtubeUrl: raw.youtubeUrl } : {}),
    ...(typeof raw.storagePath === "string" ? { storagePath: raw.storagePath } : {}),
    ...(typeof raw.fileName === "string" ? { fileName: raw.fileName } : {}),
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    ...(typeof raw.fallbackReason === "string" ? { fallbackReason: raw.fallbackReason } : {}),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    ...(typeof raw.failureMessage === "string" ? { failureMessage: raw.failureMessage } : {}),
  };
}

/**
 * How long an import may sit queued before it is called stuck.
 *
 * A healthy workflow moves a job to "running" within seconds, before it reads
 * anything, so however long the video, a job still queued after this never
 * started. Without a limit the student watches 5% forever.
 */
export const VIDEO_JOB_QUEUED_STALL_MS = 10 * 60_000;

export function isStalledVideoCardJob(raw: Record<string, unknown>, now: number) {
  return (
    raw.status === "queued" &&
    !raw.providerStartedAt &&
    typeof raw.createdAt === "number" &&
    now - raw.createdAt > VIDEO_JOB_QUEUED_STALL_MS
  );
}

export function formatVideoTimestamp(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}
