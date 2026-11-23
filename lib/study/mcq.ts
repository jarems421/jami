import { getCardAcceptedAnswers, type Card } from "@/lib/study/cards";
import { markTypedAnswer, normalizeAnswerText, parseNumericAnswer } from "@/lib/study/answer-marking";
import { getDiagramDistractorPool } from "@/lib/study/image-occlusion";
import { getCardContentHash, type StudyMcqVariant } from "@/lib/study/study-modes";
import {
  condensesAnswer,
  optionsLookGuessable,
  withoutStemEcho,
  wordCount,
} from "@/lib/study/mcq-shape";

export type McqOption = { id: string; text: string };

export type McqQuestion = {
  options: McqOption[];
  correctOptionId: string;
  explanations: Record<string, string>;
  variantId?: string;
};

function comparableAnswer(value: string) {
  return normalizeAnswerText(value)
    .replace(/^(?:the\s+)?(?:answer|speed|value|result|distance|time|mass|force)\s+(?:is|=)\s+/i, "")
    .trim();
}

function equivalentOption(left: string, right: string) {
  if (markTypedAnswer({ response: left, expectedAnswer: right }).verdict === "correct" ||
    markTypedAnswer({ response: right, expectedAnswer: left }).verdict === "correct") return true;
  const a = parseNumericAnswer(comparableAnswer(left));
  const b = parseNumericAnswer(comparableAnswer(right));
  if (a && b) {
    return Math.abs(a.value - b.value) <= Math.max(1e-9, Math.abs(b.value) * 1e-9) &&
      a.unit.normalize("NFKC").replace(/\s+/g, "") === b.unit.normalize("NFKC").replace(/\s+/g, "");
  }
  return comparableAnswer(left) === comparableAnswer(right);
}

export const MCQ_OPTION_COUNT = 4;
const REQUIRED_DISTRACTORS = MCQ_OPTION_COUNT - 1;
/** Anything longer is a paragraph, and four of them is a reading test. */
const MAX_OPTION_LENGTH = 160;

/**
 * A small deterministic generator.
 *
 * Option order has to survive a refresh, so it is derived from the session seed
 * and the card rather than from Math.random.
 */
function createRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function seedFrom(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function shuffle<T>(items: T[], random: () => number) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/**
 * How much an option *looks* like the answer, ignoring what it says.
 *
 * Nothing here reads meaning -- that is the model's job during preparation, and
 * the student's when they write their own. This measures only the surface tells
 * a student uses to skip the question: length, whether it is written as a
 * sentence, whether it is capitalised like a term, whether it leads with a
 * number. Lower is a better match.
 *
 * It exists because preparation returns five or six distractors and a question
 * only needs three. Taking the first three wastes the choice; taking the three
 * that wear the same clothes as the answer is what makes the four options
 * indistinguishable until you actually know the material.
 */
function shapeDistance(answer: string, option: string) {
  const answerWords = wordCount(answer);
  const optionWords = wordCount(option);
  // Ratio rather than difference: two words against four is a real mismatch,
  // twenty against twenty-two is not.
  const lengthRatio =
    Math.max(answerWords, optionWords) / Math.max(1, Math.min(answerWords, optionWords));

  let distance = (lengthRatio - 1) * 4;
  const endsSentence = (text: string) => /[.!?]$/.test(text.trim());
  if (endsSentence(answer) !== endsSentence(option)) distance += 1.5;
  const startsUpper = (text: string) => /^[A-Z]/.test(text.trim());
  if (startsUpper(answer) !== startsUpper(option)) distance += 1;
  const startsNumber = (text: string) => /^[+-]?\d/.test(text.trim());
  if (startsNumber(answer) !== startsNumber(option)) distance += 2;
  return distance;
}

/**
 * The wrong options that can stand beside `correctAnswer`: short enough to be an
 * option, and neither a repeat nor another way of saying the right answer or
 * one the card accepts.
 */
function usableDistractors(card: Card, correctAnswer: string, written: readonly string[]) {
  const seen = new Set([normalizeAnswerText(correctAnswer)]);
  const accepted = getCardAcceptedAnswers(card);
  const distractors: string[] = [];
  for (const text of written) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_OPTION_LENGTH) continue;
    const key = normalizeAnswerText(trimmed);
    if (!key || seen.has(key) || equivalentOption(trimmed, correctAnswer) ||
      distractors.some((shown) => equivalentOption(trimmed, shown)) ||
      accepted.some((alias) => equivalentOption(trimmed, alias))) continue;
    seen.add(key);
    distractors.push(trimmed);
  }
  return distractors;
}

/** What Learn will make of a card's own wrong answers, for the card editor to say. */
export type AuthorMultipleChoiceStatus =
  | { kind: "none" }
  | { kind: "ready" }
  | { kind: "needs-more"; usable: number; needed: number }
  | { kind: "answer-too-long" }
  | { kind: "answer-stands-out" };

/**
 * Whether the author's own wrong answers make a question, and if not, why.
 *
 * Asked exactly as Learn asks it: wrong answers of the author's own replace
 * anything Jami prepared, so these are judged alone. Three are needed that are
 * not the answer said another way, and the four options must not give the
 * answer away by looking different from the rest.
 */
export function describeAuthorMultipleChoice(card: Card): AuthorMultipleChoiceStatus {
  const own = card.studySettings?.mcqDistractors;
  if (!own || own.length === 0 || card.occlusion) return { kind: "none" };
  const answer = card.back.trim();
  if (answer.length > MAX_OPTION_LENGTH) return { kind: "answer-too-long" };
  const usable = usableDistractors(card, answer, own).length;
  if (usable < REQUIRED_DISTRACTORS) return { kind: "needs-more", usable, needed: REQUIRED_DISTRACTORS };
  const authorOnly = { ...card, studySettings: { ...card.studySettings, generatedStudy: undefined } };
  return buildMultipleChoiceQuestion({ card: authorOnly }) ? { kind: "ready" } : { kind: "answer-stands-out" };
}

/**
 * Build a multiple-choice question, or refuse.
 *
 * One source: wrong options written *for this card* -- by Jami during
 * preparation, or by its author in the card editor's study options. (A
 * diagram's labels are the exception, below.) A numeric answer is prepared like any other: moving
 * its number about made generic wrong answers rather than ones written for
 * the question, so that is no longer done.
 *
 * There used to be another: the answers off other cards in the same deck,
 * ranked by how similar they looked. It produced questions that could be
 * answered without knowing anything, because the one option that actually
 * addressed the question was the right one. Distractors have to be wrong
 * answers *to this question*, and no amount of ranking turns an answer to a
 * different question into one.
 *
 * So a card with nothing prepared gets no question at all, and is asked
 * another way instead. Nor does having three wrong options settle it: they
 * have to be three the answer can hide among, or the question is refused here
 * and the card is asked a way that cannot be guessed.
 */
export function buildMultipleChoiceQuestion(input: {
  card: Card;
  seed?: number;
  variantIndex?: number;
  recentVariantIds?: string[];
}): McqQuestion | null {
  const { card } = input;
  const variants = activeMcqVariants(card);
  const presentation = input.variantIndex ?? 0;
  const seed = (input.seed ?? 0) ^ Math.imul(presentation, 0x9e3779b1);
  if (variants.length === 0) return buildQuestion(card, seed);
  const recent = input.recentVariantIds ?? [];
  const offset = presentation % variants.length;
  const priority = [...variants.slice(offset), ...variants.slice(0, offset)].sort(
    (left, right) => recent.lastIndexOf(left.id) - recent.lastIndexOf(right.id),
  );
  for (const variant of priority) {
    const question = buildQuestion(card, seed, variant);
    if (question) return question;
  }
  return null;
}

function activeMcqVariants(card: Card) {
  if (card.occlusion || card.studySettings?.mcqDistractors !== undefined) return [];
  const generated = card.studySettings?.generatedStudy;
  return (generated?.mcqVariants ?? []).filter(({ id }) => !generated?.retiredVariantIds?.includes(id));
}

export function getPlayableMcqVariantIds(card: Card): string[] {
  return activeMcqVariants(card).filter((variant) => buildQuestion(card, 0, variant)).map(({ id }) => id);
}

function buildQuestion(card: Card, seed: number, variant?: StudyMcqVariant): McqQuestion | null {
  const answerText = card.back.trim();
  if (!answerText) return null;
  /*
   * A prepared correct option is kept when it is the card's answer said
   * another way, or the card's answer said more briefly.
   *
   * The condensation case is the one that matters. The prompt asks the model to
   * write this option in the distractors' shape, so on any card with a long
   * answer it comes back shortened -- deliberately, and correctly. That was
   * then failing `equivalentOption`, which is an answer-marking test and does
   * not recognise a summary; the option was discarded, the card's raw answer
   * put back in its place, and the question refused a line later for standing
   * out against three much shorter wrong ones. The variant was unusable from
   * the moment it was written, and Multiple Choice sessions lost most of their
   * queue to it.
   */
  const preparedCorrect = variant?.correctAnswer?.trim();
  if (preparedCorrect && !(
    equivalentOption(preparedCorrect, answerText) ||
    condensesAnswer(preparedCorrect, answerText) ||
    getCardAcceptedAnswers(card).some((alias) => equivalentOption(preparedCorrect, alias))
  )) return null;
  const correctAnswer = preparedCorrect || answerText;

  /*
   * The cap belongs to the option that is shown, not to the card.
   *
   * It was applied to the card's raw answer before this point, which refused
   * every long-answer card outright -- including the ones preparation had
   * handled properly by writing a short correct option and three short wrong
   * ones. Four readable options is the thing the limit protects; where a
   * condensed correct option exists, the card's own answer length says nothing
   * about whether the student is faced with a wall of text.
   */
  if (correctAnswer.length > MAX_OPTION_LENGTH) return null;

  /*
   * A diagram label's wrong options are the diagram's other labels -- the one
   * place borrowing answers is right, for the reason `getDiagramDistractorPool`
   * gives. Nothing is prepared for a diagram card, so there is no variant here.
   */
  const written = card.occlusion
    ? getDiagramDistractorPool(card.occlusion)
    : variant?.distractors ?? card.studySettings?.mcqDistractors ?? [];
  const distractors = usableDistractors(card, correctAnswer, written);

  if (distractors.length < REQUIRED_DISTRACTORS) return null;

  const random = createRandom(
    seed ^ seedFrom(card.id + getCardContentHash(card) + (variant?.id ?? ""))
  );
  const correctOptionId = "opt-0";
  /*
   * Preparation is asked for five or six so the weakest can be dropped, and
   * this is where that choice is spent. Ties break on the original order, which
   * is the order they were written in: author distractors first, then the
   * model's, so a student's own wrong answers keep their priority.
   */
  const chosen = distractors
    .map((text, position) => ({ text, position }))
    .sort(
      (left, right) =>
        shapeDistance(correctAnswer, left.text) - shapeDistance(correctAnswer, right.text) ||
        left.position - right.position
    )
    .slice(0, REQUIRED_DISTRACTORS)
    .map((entry) => entry.text);

  const front = card.front ?? "";
  if (optionsLookGuessable(front, correctAnswer, chosen)) return null;
  const shownAnswer = withoutStemEcho(front, correctAnswer, chosen);

  const options = shuffle(
    [
      { id: correctOptionId, text: shownAnswer },
      ...chosen.map((text, position) => ({
        id: `opt-${position + 1}`,
        text,
      })),
    ],
    random
  );

  // Why a student might have picked this one, when Jami worked it out during
  // preparation. Keyed by the distractor's text rather than its option id,
  // because the ids are assigned here and the misconceptions were written
  // before the shuffle.
  const reasons = variant?.explanations ?? card.studySettings?.mcqExplanations ?? {};
  const explanations: Record<string, string> = {
    [correctOptionId]: card.occlusion
      ? "This is the label under the box."
      : reasons[correctAnswer] ?? reasons[shownAnswer] ?? "This matches the idea the question is testing.",
  };
  for (const option of options) {
    if (option.id === correctOptionId) continue;
    explanations[option.id] = card.occlusion
      ? "That is another label on this diagram."
      : reasons[option.text] ?? "Close, but not what this card asks for.";
  }

  return { options, correctOptionId, explanations, ...(variant ? { variantId: variant.id } : {}) };
}
