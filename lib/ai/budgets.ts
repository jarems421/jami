import "server-only";

import type { AllowanceKey } from "@/lib/billing/plans";

export type AiBudgetAction =
  | "autocompleteCard"
  | "diagramLabelDetection"
  | "constellationPattern"
  | "assistant"
  | "planDraft"
  | "tutorIllustration"
  | "practicePaperGeneration"
  | "practicePaperMarking"
  | "examQuestionMarking"
  | "examQuestionReview"
  | "videoCardImport"
  | "sourceFlashcardDrafts"
  | "sourcePracticeDrafts"
  | "interventionMaterial"
  | "studyAssetGeneration"
  | "studyAnswerCheck"
  | "photoBackgroundRestore"
  | "revisionLesson"
  | "revisionMarking"
  | "revisionQuestion"
  | "sourceIndexing";

type AiBudgetConfig = {
  dailyRequestLimit: number;
  burstRequestLimit: number;
  burstWindowMs: number;
  burstScope:
    | "assistantInteractive"
    | "tutorIllustrations"
    | "sourceDrafts"
    // Its own scope so preparing a deck cannot use up the allowance the
    // tutor needs to answer a question mid-session.
    | "studyModes"
    // Restoring a background photo is paid image work, not text, and must not
    // eat into what the tutor has left.
    | "photoBackgrounds"
    // A Revision Session marks every answer, so it gets its own window rather
    // than spending the tutor's while a student works through one.
    | "revisionSessions"
    // Indexing runs on its own when a source is added or changed, so it must
    // never use up a window a student is actively spending.
    | "sourceIndexing";
  tokenCap: number;
  /**
   * Ceiling on what one request may cost to *send*, or null where the input is
   * already bounded by construction.
   *
   * The daily limit bounds how many requests a student can make, not how big
   * one can be, and only the output was capped. The assistant can be handed
   * several PDFs, so one request there had no cost ceiling at all.
   */
  inputTokenCap: number | null;
};

/**
 * Why a request got no allowance. `email_unconfirmed` is not a limit being
 * reached: an account made around Jami's sign-up, with an address nobody has
 * proved, has no allowance at all.
 */
export type AiBudgetLimitReason =
  | "daily_limit"
  | "burst_limit"
  | "email_unconfirmed"
  /** This month's plan allowance is used up (docs/plans-and-stardust.md). */
  | "allowance_used";

/**
 * A receipt for one charged request, so it can be given back.
 *
 * It names the exact counters that were incremented. A refund that simply
 * decremented today's count could otherwise hand back a request charged in a
 * burst window that has since rolled over, which would let the next window
 * start already in credit.
 */
export type AiBudgetGrant = {
  uid: string;
  action: AiBudgetAction;
  dayKey: string;
  burstWindowStartedAt: number;
  /** False for durable jobs intentionally excluded from short-window limits. */
  burstCharged?: boolean;
  /** The monthly allowance this request was charged to, so a refund returns it too. */
  allowance?: { periodKey: string; key: AllowanceKey; amount: number };
};

export type AiBudgetDecision =
  | {
      allowed: true;
      reason: null;
      retryAfterSeconds: 0;
      grant: AiBudgetGrant;
    }
  | {
      allowed: false;
      reason: AiBudgetLimitReason;
      retryAfterSeconds: number;
      /** For `allowance_used`: what ran out and when it resets, for the student. */
      message?: string;
      /** For `allowance_used`: which allowance, so the app can offer what includes more. */
      allowanceKey?: AllowanceKey;
    };

/**
 * tokenCap is passed to the provider as maxOutputTokens. These models count
 * thinking tokens against that budget, so the caps are deliberately generous
 * relative to the requested answer length: too tight and a reply comes back
 * truncated with finishReason MAX_TOKENS instead of shorter.
 */
export const AI_BUDGETS: Record<AiBudgetAction, AiBudgetConfig> = {
  // One request here can cost up to three provider calls because the route
  // retries an incomplete draft, so the daily limit is not a call count.
  // Built from one card front and a handful of nearby cards, all length-capped,
  // so the input cannot run away.
  // 150 rather than 40: typing up a hundred-card deck in one sitting is a
  // normal evening, and at a few hundredths of a penny a draft the daily limit
  // only has to stop a loop. See docs/plans-and-stardust.md.
  autocompleteCard: {
    dailyRequestLimit: 150,
    burstRequestLimit: 6,
    burstWindowMs: 60_000,
    burstScope: "assistantInteractive",
    tokenCap: 900,
    inputTokenCap: null,
  },
  // One picture, sent once when a student asks Jami to find a diagram's
  // labels. The picture is scaled down in the browser first, so the input is
  // bounded; the output is up to sixty short labels with their boxes.
  diagramLabelDetection: {
    dailyRequestLimit: 25,
    burstRequestLimit: 4,
    burstWindowMs: 60_000,
    burstScope: "assistantInteractive",
    tokenCap: 3_000,
    inputTokenCap: null,
  },
  // One worker call over at most forty stars and a short request, so the input
  // is bounded by construction. The cap leaves room for the model's thinking on
  // top of a full arrangement of positions and lines.
  constellationPattern: {
    dailyRequestLimit: 20,
    burstRequestLimit: 4,
    burstWindowMs: 60_000,
    burstScope: "assistantInteractive",
    tokenCap: 4_000,
    inputTokenCap: null,
  },
  assistant: {
    dailyRequestLimit: 40,
    burstRequestLimit: 6,
    burstWindowMs: 60_000,
    burstScope: "assistantInteractive",
    tokenCap: 8_000,
    // Comfortably above a full set of chosen sources and well below the model's
    // window, so it only ever catches a request that is genuinely outsized.
    inputTokenCap: 250_000,
  },
  /*
   * Shaping a week is a short conversation, and the reply is a couple of
   * sentences plus a small JSON object.
   *
   * The cap was 700, which looked generous for that and was not: the worker
   * model reasons before it answers and its reasoning tokens are excluded
   * from the content, so they spent the whole allowance and the completion
   * came back empty -- which the provider client raises as an error. Every
   * message to Jami failed. Four thousand leaves room for the thinking and
   * still refuses a model that has started writing an essay.
   */
  planDraft: {
    dailyRequestLimit: 40,
    burstRequestLimit: 8,
    burstWindowMs: 60_000,
    burstScope: "assistantInteractive",
    tokenCap: 4_000,
    // The prompt carries at most eight subjects and eight short turns, so the
    // input is bounded by construction long before this would catch anything.
    inputTokenCap: 8_000,
  },
  tutorIllustration: {
    dailyRequestLimit: 10,
    burstRequestLimit: 3,
    burstWindowMs: 60_000,
    burstScope: "tutorIllustrations",
    // A visual is first asked of the text model as an SVG diagram, which with
    // its labels, leader lines and the model's reasoning runs to several
    // thousand tokens. Only a picture of what something looks like reaches the
    // image model, whose bytes are billed separately and limited by the route.
    tokenCap: 16_000,
    inputTokenCap: null,
  },
  practicePaperGeneration: {
    dailyRequestLimit: 6,
    burstRequestLimit: 2,
    burstWindowMs: 60_000,
    burstScope: "sourceDrafts",
    tokenCap: 24_000,
    inputTokenCap: 250_000,
  },
  // Raised from 18,000 once the distribution was known: the longest supervisor
  // report logged ran to 16,491 tokens, which left 8% of headroom under the old
  // cap, and a report that hits the cap is discarded rather than shortened.
  practicePaperMarking: {
    dailyRequestLimit: 8,
    burstRequestLimit: 2,
    burstWindowMs: 60_000,
    burstScope: "sourceDrafts",
    tokenCap: 24_000,
    inputTokenCap: 250_000,
  },
  examQuestionMarking: {
    dailyRequestLimit: 60,
    burstRequestLimit: 12,
    burstWindowMs: 60_000,
    burstScope: "studyModes",
    /*
     * Sized for what the supervisor emits, not for what the report contains.
     *
     * At 8,000 this truncated 8 of 41 supervisor calls in a 40-record
     * benchmark -- one marking in six -- and every one of those was paid for in
     * full and thrown away: 18% of the run's spend bought nothing. A cap that
     * cuts a report off mid-JSON does not save the money, it wastes it.
     *
     * The report is not what needs the room. Given the identical prompt on the
     * identical question, the worker wrote its whole report in a median of
     * 1,197 tokens while the supervisor used 4,634 and reached 8,000. The
     * supervisor is a reasoning model and its thinking is billed and counted
     * against this ceiling, so a terser instruction -- the fix this file's
     * neighbour anticipated -- would trim the 1,200 and leave the rest.
     *
     * 16,000 is chosen to see the distribution rather than to fit it: the old
     * ceiling censored everything above it, so how far the tail runs is still
     * unknown. Observed generation ran near 80 tokens/second, so even a
     * maximal call lands inside the 408-second per-call timeout with room.
     * If timeouts start appearing here instead, `ROLE_OUTPUT_CEILING` is the
     * next number to revisit -- it still assumes 7,600.
     */
    tokenCap: 16_000,
    inputTokenCap: 32_000,
  },
  examQuestionReview: {
    dailyRequestLimit: 20,
    burstRequestLimit: 4,
    burstWindowMs: 60_000,
    burstScope: "studyModes",
    tokenCap: 8_000,
    inputTokenCap: 32_000,
  },
  videoCardImport: {
    dailyRequestLimit: 10,
    burstRequestLimit: 2,
    burstWindowMs: 60_000,
    burstScope: "sourceDrafts",
    tokenCap: 16_000,
    inputTokenCap: null,
  },
  // The source text is sliced to a fixed length before it is sent. Every way of
  // asking Jami for flashcards counts here -- from a file, and from the Tutor
  // out of the student's sources or the chat -- so twenty a day, about 480
  // cards, is what an exam-week student turning a folder into cards needs.
  sourceFlashcardDrafts: {
    dailyRequestLimit: 20,
    burstRequestLimit: 2,
    burstWindowMs: 60_000,
    burstScope: "sourceDrafts",
    tokenCap: 12_000,
    inputTokenCap: null,
  },
  sourcePracticeDrafts: {
    dailyRequestLimit: 10,
    burstRequestLimit: 2,
    burstWindowMs: 60_000,
    burstScope: "sourceDrafts",
    tokenCap: 12_000,
    inputTokenCap: null,
  },
  /*
   * Material written in answer to a recommendation, from Today.
   *
   * Its own action rather than a share of `sourceFlashcardDrafts`: this is
   * pressed on the home page, several times over a revision session, and a
   * student who used it up would find the button on their most-visited surface
   * quietly stops working. The daily limit is generous for that and still far
   * below what a loop could spend, because nothing here retries.
   *
   * Input is a concept label and at most forty existing fronts, all
   * length-capped, so it is bounded by construction.
   */
  interventionMaterial: {
    dailyRequestLimit: 20,
    burstRequestLimit: 3,
    burstWindowMs: 60_000,
    burstScope: "sourceDrafts",
    tokenCap: 12_000,
    inputTokenCap: null,
  },
  // One job prepares up to a hundred cards, so the daily limit is a job count
  // rather than a card count.
  //
  // This was ten a day, set when preparation was a button a student pressed on
  // a deck. It runs at the start of a session now, so the limit has to survive
  // a normal day's studying rather than a deliberate act -- and because a
  // prepared card is cached until it is edited, a returning student's session
  // spends nothing at all. Sixty is generous for new material and still a
  // ceiling on a runaway loop.
  studyAssetGeneration: {
    dailyRequestLimit: 60,
    burstRequestLimit: 10,
    burstWindowMs: 60_000,
    burstScope: "studyModes",
    tokenCap: 10_000,
    inputTokenCap: 30_000,
  },
  // Reached only when a typed prose answer is locally uncertain, so most
  // sessions never touch it. Running out costs a self-grade tap, not a broken
  // session, which is why the cap can be generous without being risky.
  studyAnswerCheck: {
    dailyRequestLimit: 150,
    burstRequestLimit: 12,
    burstWindowMs: 60_000,
    burstScope: "studyModes",
    tokenCap: 600,
    inputTokenCap: 4_000,
  },
  // One image-model run per photo a student chooses, a fraction of a penny
  // each. Nobody changes their background eight times in a day on purpose,
  // so the limit only exists to stop the route being used as a free upscaler.
  // No text model is involved; the token cap is never passed to one and is
  // kept at the smallest value the budget table allows.
  photoBackgroundRestore: {
    dailyRequestLimit: 8,
    burstRequestLimit: 3,
    burstWindowMs: 60_000,
    burstScope: "photoBackgrounds",
    tokenCap: 1,
    inputTokenCap: null,
  },
  /*
   * Writing a Revision Session: the lesson at the start, and a second
   * explanation if the guided question goes wrong. At most two a session, so
   * twenty-four is a dozen sessions a day -- far more than anyone studies, and
   * still a ceiling on a loop. Input is a concept label, a course line and at
   * most one earlier task, so it is bounded by construction. The cap is
   * generous because the worker model reasons before it writes, and a lesson
   * is the longest thing it writes for a student.
   */
  revisionLesson: {
    dailyRequestLimit: 24,
    burstRequestLimit: 4,
    burstWindowMs: 60_000,
    burstScope: "revisionSessions",
    tokenCap: 12_000,
    inputTokenCap: null,
  },
  /*
   * Marking one answer in a Revision Session. Up to five a session, and an
   * exact match against the expected answer is marked locally without one.
   */
  revisionMarking: {
    dailyRequestLimit: 120,
    burstRequestLimit: 12,
    burstWindowMs: 60_000,
    burstScope: "revisionSessions",
    tokenCap: 2_000,
    inputTokenCap: 6_000,
  },
  /*
   * A question asked mid-session ("why did you divide by two?"). Answered from
   * the step on screen and a few passages of the student's own material, so the
   * input is bounded by construction but larger than a mark's. Sixty a day is
   * several questions a session across more sessions than anyone does.
   */
  revisionQuestion: {
    dailyRequestLimit: 60,
    burstRequestLimit: 6,
    burstWindowMs: 60_000,
    burstScope: "revisionSessions",
    tokenCap: 2_500,
    inputTokenCap: 8_000,
  },
  /*
   * Indexing a source so the Tutor can search it: cut into passages and
   * embedded, no text model at all. Until 1 Oct 2026 this was the one AI route
   * with no limit. It is cheap -- about 0.01p a page, 6p for the largest pack
   * -- but it runs by itself whenever a source is added or changed, and again
   * when the Tutor finds a stale index, so a loop could run it without anyone
   * pressing anything. Sixty a day is a whole term's handouts at once.
   *
   * No text model is involved; the token cap is never passed to one and is
   * kept at the smallest value the budget table allows.
   */
  sourceIndexing: {
    dailyRequestLimit: 60,
    burstRequestLimit: 20,
    burstWindowMs: 60_000,
    burstScope: "sourceIndexing",
    tokenCap: 1,
    inputTokenCap: null,
  },
};

export function getAiTokenCap(action: AiBudgetAction) {
  return AI_BUDGETS[action].tokenCap;
}

export function getAiInputTokenCap(action: AiBudgetAction) {
  return AI_BUDGETS[action].inputTokenCap;
}
