import type { AiBudgetAction } from "@/lib/ai/budgets";

/**
 * Jami's plans and what each includes a month.
 *
 * The numbers are the ones agreed in `docs/plans-and-stardust.md` (§2, revised
 * 1 Oct 2026): generous on what is cheap and used constantly, strict on what is
 * expensive and rare, a little strict on what is expensive and frequent. That
 * doc carries the cost of every unit and the profit at typical, moderate and
 * maxed use; change a number here and change it there.
 *
 * Pure: no Firebase, no clock. The server reads the plan and the usage and asks
 * this file what is allowed.
 */

export type PlanId = "free" | "plus" | "pro" | "lifetime";

/** The plans a student can be on and pay for. Lifetime is granted, not sold. */
export const PAID_PLAN_IDS = ["plus", "pro"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

export const PLAN_PRICES_PENCE: Record<PaidPlanId, number> = {
  plus: 799,
  pro: 1499,
};

/**
 * What students see the plans called (agreed 2 Oct 2026). The ids stay
 * `plus` and `pro` in code, Stripe metadata and stored plan documents; only
 * these names are shown. Free keeps a plain name so £0 is never in doubt.
 */
export const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  plus: "Nova",
  pro: "Celestial",
  lifetime: "Lifetime",
};

/**
 * How much room a plan has, separate from the monthly allowances: Free keeps
 * three folders and three notebooks of the student's own in each (agreed
 * 2 Oct 2026). Null is no limit. Nothing already made is ever removed; a
 * student over the limit simply cannot make another until there is room.
 */
export const PLAN_SPACE_LIMITS: Record<PlanId, { folders: number | null; notebooksPerFolder: number | null }> = {
  free: { folders: 3, notebooksPerFolder: 3 },
  plus: { folders: null, notebooksPerFolder: null },
  pro: { folders: null, notebooksPerFolder: null },
  lifetime: { folders: null, notebooksPerFolder: null },
};

/** Every monthly allowance a plan can include. */
export const ALLOWANCE_KEYS = [
  "tutor",
  "searches",
  "photos",
  "diagrams",
  "answers",
  "papers",
  "paperMarkings",
  "revisionSessions",
  "pages",
  "diagramLabels",
  "videos",
  "fileCards",
  "filePractice",
  "drafts",
  "deckPrep",
  "answerChecks",
  "planner",
  "weakTopic",
  "constellations",
  "photoBackgrounds",
] as const;
export type AllowanceKey = (typeof ALLOWANCE_KEYS)[number];

/**
 * One allowance on one plan.
 *
 * `shown: "unlimited"` is what the student sees; `limit` is still enforced, as
 * a ceiling set near a genuinely heavy student's month so a loop or an
 * exploiter cannot run the cost up. See "Hidden ceilings" in the doc.
 */
export type Allowance = { limit: number; shown: "count" | "unlimited" };

const count = (limit: number): Allowance => ({ limit, shown: "count" });
const unlimited = (ceiling: number): Allowance => ({ limit: ceiling, shown: "unlimited" });

/** The same hidden ceilings on both paid plans. */
const PAID_EVERYDAY = {
  diagrams: unlimited(300),
  fileCards: unlimited(300),
  filePractice: unlimited(300),
  drafts: unlimited(1_500),
  deckPrep: unlimited(600),
  answerChecks: unlimited(2_000),
  planner: unlimited(300),
  weakTopic: unlimited(120),
  constellations: unlimited(60),
  photoBackgrounds: unlimited(20),
} satisfies Partial<Record<AllowanceKey, Allowance>>;

export const PLAN_ALLOWANCES: Record<
  Exclude<PlanId, "lifetime">,
  Record<AllowanceKey, Allowance>
> = {
  free: {
    tutor: count(60),
    searches: count(5),
    photos: count(0),
    diagrams: unlimited(30),
    answers: count(25),
    papers: count(1),
    paperMarkings: count(1),
    revisionSessions: count(8),
    pages: count(500),
    diagramLabels: count(10),
    videos: count(3),
    fileCards: count(10),
    filePractice: count(10),
    drafts: count(50),
    deckPrep: count(20),
    answerChecks: count(100),
    planner: count(10),
    weakTopic: count(5),
    constellations: unlimited(20),
    photoBackgrounds: unlimited(3),
  },
  plus: {
    tutor: count(500),
    searches: count(30),
    photos: count(10),
    answers: count(250),
    papers: count(8),
    // A Jami paper's first marking comes with the paper. This is for papers a
    // student brings -- their own past papers -- and for marking one again.
    paperMarkings: count(6),
    revisionSessions: count(60),
    pages: unlimited(10_000),
    diagramLabels: count(60),
    videos: count(30),
    ...PAID_EVERYDAY,
  },
  pro: {
    tutor: count(1_000),
    searches: count(60),
    photos: count(24),
    answers: count(600),
    papers: count(14),
    paperMarkings: count(12),
    revisionSessions: count(120),
    pages: unlimited(20_000),
    diagramLabels: count(150),
    videos: count(60),
    ...PAID_EVERYDAY,
  },
};

/**
 * Which allowance each metered AI action spends, or null where it spends none.
 *
 * A `Record` over every action, so a new AI route cannot be added without
 * deciding here what it costs a student. `revisionMarking` is part of a
 * session already counted when it started. `tutorIllustration` is charged to
 * drawn diagrams; a generated photo is charged separately where the image
 * model is actually called, since the route only learns which it is making
 * after it has started. Web searches are charged inside the Tutor before
 * research runs, for the same reason.
 */
export const ACTION_ALLOWANCE: Record<AiBudgetAction, AllowanceKey | null> = {
  assistant: "tutor",
  tutorIllustration: "diagrams",
  examQuestionMarking: "answers",
  examQuestionReview: "answers",
  practicePaperGeneration: "papers",
  practicePaperMarking: "paperMarkings",
  revisionLesson: "revisionSessions",
  revisionMarking: null,
  // Part of a session already counted when it started, like its marking.
  revisionQuestion: null,
  sourceIndexing: "pages",
  diagramLabelDetection: "diagramLabels",
  videoCardImport: "videos",
  sourceFlashcardDrafts: "fileCards",
  sourcePracticeDrafts: "filePractice",
  autocompleteCard: "drafts",
  studyAssetGeneration: "deckPrep",
  studyAnswerCheck: "answerChecks",
  planDraft: "planner",
  interventionMaterial: "weakTopic",
  constellationPattern: "constellations",
  photoBackgroundRestore: "photoBackgrounds",
};

/** What a student sees an allowance called, in "You've used this month's …". */
export const ALLOWANCE_LABELS: Record<AllowanceKey, string> = {
  tutor: "Tutor messages",
  searches: "Tutor web searches",
  photos: "Tutor photos",
  diagrams: "Tutor diagrams",
  answers: "marked answers",
  papers: "Jami papers",
  paperMarkings: "paper markings",
  revisionSessions: "Revision Sessions",
  pages: "searchable pages",
  diagramLabels: "label finds",
  videos: "video imports",
  fileCards: "flashcard batches",
  filePractice: "practice question batches",
  drafts: "card drafts",
  deckPrep: "deck preparations",
  answerChecks: "answer checks",
  planner: "planner chats",
  weakTopic: "topic materials",
  constellations: "sky arrangements",
  photoBackgrounds: "photo touch-ups",
};

/**
 * The limit on one allowance for a plan, or null for no monthly limit at all.
 *
 * Lifetime accounts -- everyone who joined before launch -- have none: today's
 * daily limits, and nothing per month, for good (doc §8).
 */
export function getAllowance(plan: PlanId, key: AllowanceKey): Allowance | null {
  if (plan === "lifetime") return null;
  return PLAN_ALLOWANCES[plan][key];
}

export type AllowancePeriod = {
  /** Stable id for the period, e.g. "2026-10-28". */
  key: string;
  start: number;
  end: number;
};

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function anniversary(anchor: Date, year: number, month: number) {
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(
    year,
    month,
    day,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds()
  );
}

/**
 * The allowance month that `now` falls in, counted from `anchor`.
 *
 * Monthly on the anniversary of the day the plan started (Free: the day the
 * account was made), not on the 1st, so a student who joins on the 28th does
 * not get two months in four days. A plan started on the 31st renews on the
 * last day of shorter months, then on the 31st again.
 */
export function getAllowancePeriod(anchor: number, now: number): AllowancePeriod {
  const anchorDate = new Date(Math.min(anchor, now));
  const nowDate = new Date(now);
  let year = nowDate.getUTCFullYear();
  let month = nowDate.getUTCMonth();
  let start = anniversary(anchorDate, year, month);
  if (start > now) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = anniversary(anchorDate, year, month);
  }
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  const end = anniversary(anchorDate, nextYear, nextMonth);
  return { key: new Date(start).toISOString().slice(0, 10), start, end };
}

export type AllowanceUsage = {
  used: Partial<Record<AllowanceKey, number>>;
  /** Bought or granted on top of the plan's allowance; never expires with the period. */
  extra: Partial<Record<AllowanceKey, number>>;
};

export type AllowanceDecision =
  | { allowed: true; remainingAfter: number | null }
  | { allowed: false; limit: number; used: number };

/**
 * Whether `amount` more of an allowance may be used this period.
 *
 * A request is allowed while anything is left, even if `amount` would take it
 * past the limit -- pages are counted after a source is read, and refusing a
 * 120-page pack because 100 pages were left would be worse than letting it run
 * over by twenty.
 */
export function decideAllowance(input: {
  plan: PlanId;
  key: AllowanceKey;
  usage: AllowanceUsage;
  amount?: number;
}): AllowanceDecision {
  const allowance = getAllowance(input.plan, input.key);
  if (!allowance) return { allowed: true, remainingAfter: null };
  const used = Math.max(0, input.usage.used[input.key] ?? 0);
  const extra = Math.max(0, input.usage.extra[input.key] ?? 0);
  const limit = allowance.limit + extra;
  if (used >= limit) return { allowed: false, limit, used };
  return {
    allowed: true,
    remainingAfter: Math.max(0, limit - used - Math.max(0, input.amount ?? 1)),
  };
}

/** The message a refused request shows, naming the allowance and the reset. */
export function describeAllowanceRefusal(input: {
  plan: PlanId;
  key: AllowanceKey;
  periodEnd: number;
}) {
  const resets = new Date(input.periodEnd).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const what = ALLOWANCE_LABELS[input.key];
  // Nothing included at all on this plan (Free's photos): there was nothing to use up.
  if (getAllowance(input.plan, input.key)?.limit === 0) {
    return `${what[0].toUpperCase()}${what.slice(1)} come with ${PLAN_LABELS.plus} and ${PLAN_LABELS.pro}.`;
  }
  const upgrade =
    input.plan === "free"
      ? ` ${PLAN_LABELS.plus} and ${PLAN_LABELS.pro} include far more.`
      : input.plan === "plus"
        ? ` ${PLAN_LABELS.pro} includes more.`
        : "";
  return `You've used this month's ${what}. They reset on ${resets}.${upgrade}`;
}

/**
 * The Exam Pass (doc §3): one payment lasting until 31 July of the exam year,
 * priced at the months left (August and September buy a full ten-month year),
 * less 25% on Plus or 15% on Pro. Pro's discount is smaller because Pro is
 * already the better value per allowance; 30% lost money on a maxed Pro month.
 */
export const EXAM_PASS_DISCOUNT: Record<PaidPlanId, number> = { plus: 0.25, pro: 0.15 };

export function getExamPassMonths(now: number) {
  const month = new Date(now).getUTCMonth(); // 0 = January
  if (month === 7 || month === 8) return 10;
  const monthsLeft = month <= 6 ? 7 - month : 7 + (12 - month);
  return Math.min(10, monthsLeft);
}

export function getExamPassPricePence(plan: PaidPlanId, now: number) {
  const months = getExamPassMonths(now);
  const pounds =
    (PLAN_PRICES_PENCE[plan] / 100) * months * (1 - EXAM_PASS_DISCOUNT[plan]);
  // Rounded first so float noise (41.95000001) cannot add a pound.
  return Math.ceil(Math.round(pounds * 1000) / 1000) * 100 - 1;
}

/** When a pass bought at `now` runs out: the end of 31 July of its exam year. */
export function getExamPassExpiry(now: number) {
  const date = new Date(now);
  const year =
    date.getUTCMonth() >= 7 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
  return Date.UTC(year, 6, 31, 23, 59, 59, 999);
}
