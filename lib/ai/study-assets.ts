import { createHash } from "node:crypto";
import type { CardStudySettings } from "@/lib/study/study-modes";
import type { StudyLearningTask } from "@/lib/study/learning-task";
import { condensesAnswer, optionsLookGuessable } from "@/lib/study/mcq-shape";
import {
  closeUnbalancedJson,
  repairModelJsonBackslashes,
  unwrapModelJsonObject,
} from "@/lib/ai/model-json";
export { STUDY_ASSET_PROMPT_VERSION, STUDY_ASSET_SCHEMA_VERSION } from "@/lib/study/study-asset-versions";
import { STUDY_ASSET_PROMPT_VERSION, STUDY_ASSET_SCHEMA_VERSION } from "@/lib/study/study-asset-versions";

/**
 * Everything a model is asked to add to one card, in one document.
 *
 * One combined asset rather than four calls: the aliases, the concepts, the
 * safe gaps and the distractors all depend on reading the same answer, and
 * asking four times would pay for that reading four times.
 */
export type StudyAsset = {
  cardId: string;
  /** Attached by the client loader; not part of model output. */
  cacheKey?: string;
  sourceFingerprint?: string;
  repairRequested?: boolean;
  bundleRevision?: string;
  validatorVersion?: number;
  answerShape: "numeric" | "list" | "short" | "prose";
  acceptedAliases: string[];
  requiredConcepts: string[];
  clozeCandidates: string[];
  distractors: string[];
  misconceptions: Record<string, string>;
  confidence: number;
  ambiguous: boolean;
  task?: StudyLearningTask;
  preferredModes?: Array<"classic" | "type-answer" | "gap-fill" | "multiple-choice">;
  suitableModes?: Array<"classic" | "type-answer" | "gap-fill" | "multiple-choice">;
  gapVariants?: Array<{ id: string; gaps: Array<{ start: number; end: number; answer: string; acceptedAnswers: string[]; concept: string }> }>;
  mcqVariants?: Array<{ id: string; correctAnswer: string; distractors: string[]; explanations: Record<string, string> }>;
  retiredVariantIds?: string[];
  /**
   * Attached by the client loader: this card already had its one second try
   * at multiple choice under the current prompt, so a session pinned to that
   * mode does not ask again.
   */
  mcqRetried?: boolean;
  /** This preparation only wrote questions for a Multiple Choice session. */
  mcqOnly?: boolean;
  /** Attached by the loader. Back off between refresh attempts. */
  mcqRefreshAfter?: number;
};

/**
 * Bumped when the distractor rules were tightened to demand the same shape as
 * the answer. Every cached asset written under the old prompt carries the wrong
 * options this was meant to stop -- short phrases beside a full-sentence answer,
 * guessable on length alone -- so they are re-read rather than served.
 */

/** Below this the asset is discarded rather than used with a warning. */
export const MIN_ASSET_CONFIDENCE = 0.6;

export const MAX_CARDS_PER_JOB = 100;

/**
 * Small batches, many at once.
 *
 * This was twenty cards to a request, which is the right shape for cost and the
 * wrong one for waiting: output tokens dominate the latency of a call, so one
 * request carrying twenty cards' worth of aliases, gaps and distractors takes
 * roughly twenty times as long to emit as one carrying a single card, and a
 * student sat in front of "preparing your session" is watching all of it.
 *
 * Six cards a request was the next step. One is where it ends: measured on the
 * worker (30 Sep 2026, scripts/eval/study-mcq-readiness.ts), a single card
 * takes a median of 15 seconds through generation and review, and a batch of
 * six held all six back until the slowest had been written and checked.
 * Each card now lands on its own and is saved the moment it does, so the first
 * question in a session is ready when its own card is, not when five others
 * are. The trade is the system prompt sent once a card rather than once a
 * batch: a fraction of a penny across a whole deck.
 */
export const MAX_CARDS_PER_BATCH = 1;
export const MAX_CONCURRENT_BATCHES = 8;

const MAX_ALIASES = 6;
const MAX_CONCEPTS = 5;
const MAX_CLOZE_CANDIDATES = 4;
const MAX_DISTRACTORS = 6;
const MAX_FIELD_LENGTH = 200;

/**
 * The cache key.
 *
 * Includes both version numbers, so changing the prompt or the shape of the
 * asset invalidates every cached document rather than mixing two generations of
 * output in one deck. Author settings are in the key too: a card whose accepted
 * answers changed is, for this purpose, a different card.
 */
export function getStudyAssetCacheKey(input: {
  front: string;
  back: string;
  studySettings?: CardStudySettings;
}) {
  const material = JSON.stringify({
    front: input.front.normalize("NFKC").trim(),
    back: input.back.normalize("NFKC").trim(),
    settings: input.studySettings ?? null,
    schema: STUDY_ASSET_SCHEMA_VERSION,
    prompt: STUDY_ASSET_PROMPT_VERSION,
  });
  return createHash("sha256").update(material).digest("hex");
}

export const STUDY_ASSET_SYSTEM_PROMPT = `You prepare study material for flashcards a student already wrote.

Return ONLY a JSON object. No prose, no markdown fence.

For each card you are given, produce one entry:
{
  "cardId": string,
  "answerShape": "numeric" | "list" | "short" | "prose",
  "acceptedAliases": string[],
  "requiredConcepts": string[],
  "confidence": number between 0 and 1,
  "ambiguous": boolean,
  "task": "term" | "definition" | "quantity" | "calculation" | "list" | "process" | "comparison" | "explanation" | "formula" | "quotation" | "extended" | "ambiguous",
  "preferredModes": ("classic" | "type-answer" | "gap-fill" | "multiple-choice")[],
  "suitableModes": ("classic" | "type-answer" | "gap-fill" | "multiple-choice")[],
  "gapVariants": [{ "id": string, "gaps": [{ "answer": string, "acceptedAnswers": string[], "concept": string }] }],
  "mcqVariants": [{ "id": string, "correctAnswer": string, "distractors": string[], "explanations": { "<option text>": "<why it is right or wrong>" } }]
}

Rules you must not break:
- NEVER rewrite, correct, improve or replace the card's answer. You are adding to it, not editing it.
- acceptedAliases are other ways to write THE SAME answer. Not related answers. Not broader answers.
- requiredConcepts are the ideas a correct answer must contain, each a short noun phrase.
- Set ambiguous true and confidence low when the card is unclear, has more than one defensible answer, or you are guessing.
- An honest low confidence is worth more than a confident invention.
- Read the question and answer together. Pick only formats that genuinely suit the learning task. Classic is a normal preferred mode, especially for explanations, definitions, formulae and ambiguous material.
- Produce one or two substantively different variants for each suitable interactive format. One sound variant is better than two weak ones.
- Keep every explanation to one short sentence. Write nothing the student will not see.

gapVariants -- the words worth hiding:
- Each gap answer must be an exact substring of the card's answer, copied character for character.
- Choose the word that carries the meaning: the term being defined, the quantity, the mechanism, the one word a student who half-knew this would get wrong.
- Never choose a word the question already contains, and never a word whose absence leaves a sentence anyone could complete from grammar alone.
- Prefer one word or a short phrase. Hiding half the answer is not a gap, it is the whole question again.
- A variant may contain one to three non-overlapping gaps. Across a variant, hide no more than one third of the answer. Different variants must test different concepts or combinations, not cosmetic wording.

mcqVariants -- multiple choice, and the part that matters most. Each variant has exactly three wrong options in "distractors":
- Each wrong option must be a plausible answer TO THIS QUESTION and definitely wrong. Not a fact about something else, not an answer to a neighbouring topic.
- Write the mistakes a student actually makes: the neighbouring concept people confuse this with, the right idea at the wrong scale or stage, the common misremembering, the plausible-sounding invention.
- A student who has not learned this should have no way to tell which is right by looking at the options alone. If one option is obviously the only real answer, you have failed.
- Never a second correct answer, never a synonym, never a broader or narrower version of the true answer.
- MATCH THE ANSWER'S SHAPE, and treat this as a hard requirement rather than a preference. Count the words in the correct option. Every wrong option must be within roughly half to twice that count, carry the same grammatical form, the same register, the same capitalisation, and the same final punctuation.
  - If the answer is a full sentence ending in a full stop, every wrong option is a full sentence ending in a full stop.
  - If the answer is one word or a short phrase, every wrong option is one word or a short phrase.
  - If the answer names a thing, every wrong option names a thing of the same kind. Do not answer "which organelle" with three organelles and one process.
  Length is the tell students use to skip the question: a set where the true answer is the long, complete, specific one is guessable by somebody who cannot read the subject, and it is worse than no question at all.
- Be specific in the wrong options too. One that is vague, hedged, or obviously a non-answer ("none of these", "it varies", "a type of cell") gives the game away as surely as a short one.
- NEVER let one option restate the question and the others not. If the card's answer opens by repeating the question back ("When a plant cell is placed in pure water, water moves in...") then either every wrong option opens with that same clause, or none does and you write the correct option without it ("Water moves in..."). An option that names the question it is answering is the one a student picks without reading the others.
- All four options must be interchangeable on sight: same opening word class, same tense, same length to within a few words, same level of detail. Read your four options with the answer hidden. If you can still tell which is right, rewrite them.
- Make the wrong options genuinely tempting. The best one is the option a student who half-learned this would defend: the right mechanism with the wrong direction, the right process under the wrong name, the correct effect for the opposite condition.
- explanations has one entry for each of the four options, keyed by that option's exact text: for a wrong option, what a student choosing it was probably thinking of, teaching the difference rather than scolding; for the correct option, why it is right.
- Variants must use substantively different wrong options; shuffling does not make a new variant.
- correctAnswer is where you match the shape. Write the card's answer the way the three wrong options are written -- same length, same opening, no restatement of the question -- while saying exactly and only what the card's answer says. Never narrow it, broaden it or add a claim the card does not make.
- When the card's answer is maths, correctAnswer is the card's answer copied exactly, and every wrong option is maths in the same notation and form, inside $...$ like the answer. Do not change the form: a fraction stays a fraction rather than a decimal, and a factorised expression keeps its order. The best wrong options are the slips a student makes: a sign error, a missing factor, the wrong power, the inverse relationship.
- If you cannot write three genuinely wrong-but-tempting options for this card, return an empty mcqVariants array. That costs the student nothing. A guessable question costs them a wrong idea about what they know.
- Every mcqVariant is checked after you return it: any variant whose wrong options are not within roughly half to twice the correct option's word count, or where only one option restates the question, is discarded. A variant you take care over is worth two you do not.

Respond as: { "assets": [ ... ] }`;

export function buildStudyAssetUserPrompt(
  cards: ReadonlyArray<{ id: string; front: string; back: string }>
) {
  return cards
    .map(
      (card, index) =>
        `--- Card ${index + 1} (id: ${card.id}) ---\nQuestion: ${card.front}\nAnswer: ${card.back}`
    )
    .join("\n\n");
}

function cleanStrings(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, MAX_FIELD_LENGTH);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
    if (cleaned.length >= limit) break;
  }
  return cleaned;
}

function isAnswerShape(value: unknown): value is StudyAsset["answerShape"] {
  return (
    value === "numeric" || value === "list" || value === "short" || value === "prose"
  );
}

const TASKS = new Set<StudyLearningTask>([
  "term", "definition", "quantity", "calculation", "list", "process",
  "comparison", "explanation", "formula", "quotation", "extended", "ambiguous",
]);
const MODES = new Set(["classic", "type-answer", "gap-fill", "multiple-choice"]);

function cleanModes(value: unknown) {
  return cleanStrings(value, 4).filter((mode) => MODES.has(mode)) as StudyAsset["suitableModes"];
}

function cleanGapVariants(value: unknown, back: string): NonNullable<StudyAsset["gapVariants"]> {
  if (!Array.isArray(value)) return [];
  const variants: NonNullable<StudyAsset["gapVariants"]> = [];
  for (const raw of value.slice(0, 3)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 80) : `gap-${variants.length + 1}`;
    if (!Array.isArray(item.gaps)) continue;
    let searchCursor = 0;
    const totalWords = back.trim().split(/\s+/).filter(Boolean).length;
    const maxGaps = totalWords < 4 ? 0 : totalWords <= 12 ? 1 : totalWords <= 35 ? 2 : 3;
    const gaps = item.gaps.slice(0, maxGaps).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const gap = candidate as Record<string, unknown>;
      const answer = typeof gap.answer === "string" ? gap.answer.trim() : "";
      const start = answer ? back.indexOf(answer, searchCursor) : -1;
      if (start < 0) return [];
      searchCursor = start + answer.length;
      return [{
        start,
        end: start + answer.length,
        answer,
        acceptedAnswers: cleanStrings(gap.acceptedAnswers, MAX_ALIASES),
        concept: typeof gap.concept === "string" ? gap.concept.trim().slice(0, MAX_FIELD_LENGTH) : answer,
      }];
    });
    const hiddenWords = gaps.reduce((sum, gap) => sum + gap.answer.split(/\s+/).length, 0);
    if (gaps.length === 0 || hiddenWords / Math.max(1, totalWords) > 1 / 3) continue;
    const positions = gaps.map((gap) => ({ start: gap.start, end: gap.end })).sort((a, b) => a.start - b.start);
    if (positions.some((position, index) => index > 0 && position.start < positions[index - 1].end)) continue;
    variants.push({ id, gaps });
  }
  return variants;
}

/**
 * Keep the variants a student could not answer by looking at them.
 *
 * The prompt asks for options of a matching shape and says this check exists,
 * and a model still returns the occasional set where the right answer is the
 * long one, or the only one that opens by restating the question. Those are
 * dropped here rather than shown: the card is asked another way, which teaches
 * nothing but costs nothing, where a guessable question teaches a student that
 * they know something they do not.
 */
/** The maths inside `$...$` or `$$...$$`, when that is the whole of the text. */
function wholeMaths(text: string): string | null {
  const match = /^\$\$?([^$]+?)\$?\$$/.exec(text.trim());
  return match ? match[1].trim() : null;
}

const sameMaths = (left: string, right: string) =>
  left.replace(/\s+/g, "") === right.replace(/\s+/g, "");

/**
 * A variant for a maths answer, with its options written the way the card is.
 *
 * Asked about `$3x^2$`, the model writes its options as `3x^2`, `x^3`, `3x^3`
 * -- the right maths without the delimiters. The check that the correct option
 * is still the card's answer compared the text as written and refused every
 * one, so half of all maths cards came out with no question at all, and the
 * wrong options would have shown as raw `x^3` rather than typeset anyway.
 * Options are read as maths here: the correct one, once it is the card's
 * maths, becomes the card's own text, and every option is put in delimiters
 * so it is typeset like the answer beside it. Explanations are keyed by option
 * text, so they are moved to the new spellings too.
 */
function inCardMathsNotation(item: Record<string, unknown>, answer: string): Record<string, unknown> {
  const answerMaths = wholeMaths(answer);
  if (answerMaths === null) return item;
  const display = (option: string) => {
    const maths = wholeMaths(option) ?? option.trim();
    return sameMaths(maths, answerMaths) ? answer.trim() : `$${maths}$`;
  };
  const asDisplayed = (value: unknown) => (typeof value === "string" && value.trim() ? display(value) : value);
  const explanations =
    item.explanations && typeof item.explanations === "object" && !Array.isArray(item.explanations)
      ? Object.fromEntries(
          Object.entries(item.explanations as Record<string, unknown>).map(([option, text]) => [display(option), text])
        )
      : item.explanations;
  return {
    ...item,
    correctAnswer: asDisplayed(item.correctAnswer),
    distractors: Array.isArray(item.distractors) ? item.distractors.map(asDisplayed) : item.distractors,
    explanations,
  };
}

function cleanMcqVariants(
  value: unknown,
  answer: string,
  front: string
): NonNullable<StudyAsset["mcqVariants"]> {
  if (!Array.isArray(value)) return [];
  const variants: NonNullable<StudyAsset["mcqVariants"]> = [];
  for (const raw of value.slice(0, 3)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = inCardMathsNotation(raw as Record<string, unknown>, answer);
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 80) : `mcq-${variants.length + 1}`;
    const correctAnswer = typeof item.correctAnswer === "string" && item.correctAnswer.trim()
      ? item.correctAnswer.trim().slice(0, MAX_FIELD_LENGTH)
      : answer.trim();
    const distractors = cleanStrings(item.distractors, 3).filter(
      (option) => option.toLocaleLowerCase() !== correctAnswer.toLocaleLowerCase() && option.toLocaleLowerCase() !== answer.trim().toLocaleLowerCase()
    );
    if (distractors.length !== 3) continue;
    const explanations: Record<string, string> = {};
    if (item.explanations && typeof item.explanations === "object" && !Array.isArray(item.explanations)) {
      for (const [option, explanation] of Object.entries(item.explanations as Record<string, unknown>)) {
        if (typeof explanation === "string" && explanation.trim()) explanations[option] = explanation.trim().slice(0, MAX_FIELD_LENGTH);
      }
    }
    if (![correctAnswer, ...distractors].every((option) => Boolean(explanations[option]))) continue;
    if (optionsLookGuessable(front, correctAnswer, distractors)) continue;
    /*
     * The correct option has to still be the card's answer.
     *
     * Nothing checked this, so a variant whose correct option said something
     * the card did not was stored and shown, and a student was marked on a
     * claim their own card never made. It also let through rewrites the builder
     * would refuse, which is how a stored variant could be unusable -- the
     * builder applies this same pair of tests, and the two must agree or cards
     * are admitted to a session they can never be asked in.
     */
    const restatesAnswer =
      correctAnswer.trim().toLocaleLowerCase() === answer.trim().toLocaleLowerCase() ||
      condensesAnswer(correctAnswer, answer);
    if (!restatesAnswer) continue;
    variants.push({ id, correctAnswer, distractors, explanations });
  }
  return variants;
}

/**
 * Turn one model entry into an asset, or refuse it.
 *
 * The refusals matter more than the parsing. A cloze candidate that is not
 * actually in the answer would blank text that is not there; a distractor equal
 * to the answer would make a question with two right choices. Both are dropped
 * here rather than weakened into a warning downstream.
 */
export function validateStudyAsset(
  value: unknown,
  card: { id: string; front?: string; back: string }
): StudyAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.cardId !== "string" || data.cardId.trim() !== card.id) return null;

  const confidence =
    typeof data.confidence === "number" && Number.isFinite(data.confidence)
      ? Math.min(1, Math.max(0, data.confidence))
      : 0;
  const ambiguous = data.ambiguous === true;
  if (ambiguous || confidence < MIN_ASSET_CONFIDENCE) return null;

  const answerNormalized = card.back.trim().toLowerCase();
  const clozeCandidates = cleanStrings(data.clozeCandidates, MAX_CLOZE_CANDIDATES)
    // Must exist verbatim in the immutable answer, or the blank would hide text
    // the student never sees.
    .filter((candidate) => card.back.includes(candidate));

  const distractors = cleanStrings(data.distractors, MAX_DISTRACTORS).filter(
    (distractor) => distractor.trim().toLowerCase() !== answerNormalized
  );

  const misconceptions: Record<string, string> = {};
  if (data.misconceptions && typeof data.misconceptions === "object") {
    for (const [key, text] of Object.entries(
      data.misconceptions as Record<string, unknown>
    )) {
      if (typeof text !== "string" || !text.trim()) continue;
      if (!distractors.includes(key)) continue;
      misconceptions[key] = text.trim().slice(0, MAX_FIELD_LENGTH);
    }
  }

  const task = typeof data.task === "string" && TASKS.has(data.task as StudyLearningTask)
    ? data.task as StudyLearningTask
    : undefined;
  const preferredModes = cleanModes(data.preferredModes);
  const suitableModes = cleanModes(data.suitableModes);
  const gapVariants = cleanGapVariants(data.gapVariants, card.back);
  const mcqVariants = cleanMcqVariants(data.mcqVariants, card.back, card.front ?? "");

  return {
    cardId: card.id,
    answerShape: isAnswerShape(data.answerShape) ? data.answerShape : "short",
    acceptedAliases: cleanStrings(data.acceptedAliases, MAX_ALIASES).filter(
      (alias) => alias.trim().toLowerCase() !== answerNormalized
    ),
    requiredConcepts: cleanStrings(data.requiredConcepts, MAX_CONCEPTS),
    clozeCandidates,
    distractors,
    misconceptions,
    confidence,
    ambiguous: false,
    ...(task ? { task } : {}),
    ...(preferredModes?.length ? { preferredModes } : {}),
    ...(suitableModes?.length ? { suitableModes } : {}),
    ...(gapVariants.length ? { gapVariants } : {}),
    ...(mcqVariants.length ? { mcqVariants } : {}),
  };
}

/**
 * The JSON in a model's reply, or null when there is none to be had.
 *
 * A bare JSON.parse lost whole batches. Cards on maths and physics carry LaTeX,
 * and one `\frac` the model forgot to escape failed the parse for every card in
 * the request -- six at a time, and then the same six again on the retry. The
 * repairs are the ones the Tutor's answers already go through: stray LaTeX
 * backslashes doubled, a fence or a sentence around the object dropped, and a
 * miscounted run of closing brackets put right.
 */
export function readModelJson(text: string): unknown | null {
  const body = unwrapModelJsonObject(text);
  /*
   * Repaired first, not only when the plain parse fails: `\frac` and `\times`
   * begin with valid JSON escapes, so they parse without complaint into a form
   * feed or a tab and the maths is quietly lost. The repair leaves correctly
   * escaped text exactly as it was.
   */
  const repaired = repairModelJsonBackslashes(body);
  // A bare list, which the object-finder above would cut down to its first item's braces.
  const whole = repairModelJsonBackslashes(
    text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  );
  for (const candidate of [repaired, closeUnbalancedJson(repaired), body, whole]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the repaired text, then give up.
    }
  }
  return null;
}

/** The reply could not be read at all -- worth asking again, unlike a refusal. */
export class StudyAssetReplyUnreadableError extends Error {
  constructor(message = "The study preparation reply could not be read.") {
    super(message);
    this.name = "StudyAssetReplyUnreadableError";
  }
}

/**
 * Like parseStudyAssetResponse, but an unreadable reply throws.
 *
 * The difference matters to what is kept. A reply that parsed and turned a
 * card down is the model's answer about that card, and asking again would
 * spend the same money on the same refusal. A reply that could not be read
 * says nothing about the card at all, and recording it as a refusal is what
 * left cards unable to be asked as multiple choice until they were edited.
 */
export function parseStudyAssetReply(
  text: string,
  cards: ReadonlyArray<{ id: string; front?: string; back: string }>
): { assets: StudyAsset[]; declinedCardIds: string[] } {
  const parsed = readModelJson(text);
  const container =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).assets
      : parsed;
  if (!Array.isArray(container)) throw new StudyAssetReplyUnreadableError();
  const assets = assetsFromEntries(container, cards);
  /*
   * Declined: the model wrote an entry for the card and it did not survive --
   * marked ambiguous, or too unsure to use. A card the reply simply left out
   * is not in this list; nothing was said about it, so it is asked again.
   */
  const answered = new Set(
    container.flatMap((entry) => {
      const cardId =
        entry && typeof entry === "object" ? (entry as Record<string, unknown>).cardId : null;
      return typeof cardId === "string" ? [cardId.trim()] : [];
    })
  );
  const kept = new Set(assets.map((asset) => asset.cardId));
  return {
    assets,
    declinedCardIds: cards
      .map((card) => card.id)
      .filter((id) => answered.has(id) && !kept.has(id)),
  };
}

export function parseStudyAssetResponse(
  text: string,
  cards: ReadonlyArray<{ id: string; front?: string; back: string }>
): StudyAsset[] {
  try {
    return parseStudyAssetReply(text, cards).assets;
  } catch {
    return [];
  }
}

function assetsFromEntries(
  container: unknown[],
  cards: ReadonlyArray<{ id: string; front?: string; back: string }>
): StudyAsset[] {

  const byId = new Map(cards.map((card) => [card.id, card]));
  const assets: StudyAsset[] = [];
  for (const entry of container) {
    const cardId =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).cardId
        : null;
    const card = typeof cardId === "string" ? byId.get(cardId.trim()) : undefined;
    if (!card) continue;
    const asset = validateStudyAsset(entry, card);
    if (asset) assets.push(asset);
  }
  return assets;
}
