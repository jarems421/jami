/**
 * The surface of a multiple-choice question: length, shape, and how much of the
 * question each option says back.
 *
 * Nothing here reads meaning. It exists because the two places that decide
 * whether a set of options is worth showing -- the validator that accepts what
 * a model wrote, and the builder that assembles the question a student sees --
 * have to agree on what a guessable set looks like. Splitting the rules across
 * both is how one of them drifts and starts serving questions the other would
 * have refused.
 */

export function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * How far the correct answer's length may stray from the wrong ones.
 *
 * The single loudest tell in a multiple-choice question is length. When the
 * real answer is the full sentence off the back of the card and the three wrong
 * ones are the phrases a model wrote, the question is answerable without
 * reading it: pick the long one. It is answerable the other way too -- a
 * two-word answer sat under three written-out clauses is just as obvious.
 */
export const OPTION_LENGTH_BAND = { min: 0.6, max: 1.7 };

/**
 * Whether a shorter correct option says only what the card's answer says.
 *
 * The prompt asks the model to write the correct option in the distractors'
 * shape -- "same length, same opening" -- because a twenty-nine word answer sat
 * under three ten-word wrong ones is answerable by looking at it. That rewrite
 * is the point, and it is also the risk: a condensation that quietly adds or
 * changes a claim would mark a student against something their card never said.
 *
 * So the test is containment rather than equivalence. Every content word of the
 * short option has to appear in the card's answer, which allows a faithful
 * condensation and refuses anything that brings in a new idea. It cannot catch
 * a condensation that *narrows* the answer -- only reading it can -- and the
 * prompt forbids that separately.
 *
 * Deliberately lives here, beside the other shape rules, because the validator
 * that stores a variant and the builder that shows it have to apply exactly the
 * same test. They did not: the validator accepted shortened correct options and
 * the builder then rejected them and fell back to the card's raw answer, which
 * failed the length band every time. Cards were stored with variants that could
 * never be built, and a Multiple Choice session dropped most of its queue.
 */
export function condensesAnswer(option: string, answer: string) {
  const short = contentWords(option).map(stemWord);
  const full = new Set(contentWords(answer).map(stemWord));
  if (short.length === 0 || full.size === 0) return false;
  if (wordCount(option) >= wordCount(answer)) return false;
  return short.every((word) => full.has(word));
}

/**
 * Enough of a stem to survive rewording, and no more.
 *
 * Shortening a sentence changes the grammar around the words that stay:
 * "by providing an alternative pathway" becomes "it provides an alternative
 * pathway", and an exact-match containment test reads that one ending as a new
 * claim and throws the variant away. Clipping the common endings fixes it.
 *
 * Deliberately not a real stemmer, and deliberately not a proportion of words
 * matched. The whole value of the check is that it refuses a condensation
 * carrying an idea the card does not -- and the dangerous version of that is a
 * single word, "lower" written as "higher". Those two do not share a stem, so
 * this still catches them, where "eighty per cent of the words matched" would
 * wave them through.
 */
function stemWord(word: string) {
  for (const ending of ["ing", "ed", "es", "s"]) {
    if (word.length > ending.length + 2 && word.endsWith(ending)) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return word;
}

/**
 * Whether the right answer hides among these three, or stands out from them.
 *
 * Only length is checked, because length is the tell that survives everything
 * else: a student who cannot read the subject can still count words. Every
 * distractor has to sit in the band, since any option that plainly does not
 * belong is one the student can discard without knowing anything, and two of
 * those turn a question into a coin toss.
 */
export function optionLengthsMatch(answer: string, distractors: string[]) {
  const answerWords = wordCount(answer);
  if (answerWords === 0) return false;
  return distractors.every((distractor) => {
    const ratio = wordCount(distractor) / answerWords;
    return ratio >= OPTION_LENGTH_BAND.min && ratio <= OPTION_LENGTH_BAND.max;
  });
}

/**
 * Words that carry meaning, for comparing an option against the question.
 *
 * Crude on purpose: no stemming, no lemmas. This counts how much of the
 * question an option has said back, and for that, matching the words a
 * student's eye matches is closer to the truth than matching roots they would
 * never notice.
 */
const STEM_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from",
  "happens", "how", "in", "into", "is", "it", "its", "of", "on", "or", "that",
  "the", "their", "then", "there", "they", "this", "to", "was", "were", "what",
  "when", "where", "which", "who", "why", "will", "with", "would",
]);

function contentWords(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STEM_STOPWORDS.has(word));
}

/** How much of its opening an option must borrow to count as an echo. */
const STEM_ECHO_SHARE = 0.6;
/** A clause shorter than this is a turn of phrase, not a restatement. */
const MIN_ECHO_CLAUSE_WORDS = 3;
/** Past here a comma is punctuation inside the answer, not a lead-in. */
const MAX_ECHO_CLAUSE_WORDS = 16;

/**
 * The opening clause of an option, when it is only the question said again.
 *
 * "When a plant cell is placed in pure water, water moves into the cell..."
 * answers "What happens to a plant cell in pure water?" twice: the clause
 * before the comma is the question, and only what follows it is recall. A
 * student who reads four options and sees one that opens by naming their own
 * question has been handed the answer without reading a word of biology.
 */
export function stemEcho(front: string, option: string) {
  const separator = option.indexOf(",");
  if (separator < 0) return null;
  const clause = option.slice(0, separator).trim();
  const rest = option.slice(separator + 1).trim();
  if (
    wordCount(clause) < MIN_ECHO_CLAUSE_WORDS ||
    wordCount(clause) > MAX_ECHO_CLAUSE_WORDS ||
    wordCount(rest) < MIN_ECHO_CLAUSE_WORDS
  ) {
    return null;
  }
  const asked = new Set(contentWords(front));
  const clauseContent = contentWords(clause);
  if (clauseContent.length === 0) return null;
  const shared = clauseContent.filter((word) => asked.has(word)).length;
  return shared / clauseContent.length >= STEM_ECHO_SHARE ? { clause, rest } : null;
}

/**
 * Drop an option's restatement of the question, when it alone carries one.
 *
 * The answer on the card is untouched -- this is the text of one option in one
 * question, and removing a lead-in that only repeats the question changes
 * nothing about what the option claims. It happens only when no wrong option
 * opens the same way, because the tell is the difference between the options
 * rather than the clause itself.
 */
export function withoutStemEcho(front: string, answer: string, distractors: string[]) {
  const echo = stemEcho(front, answer);
  if (!echo) return answer;
  if (distractors.some((distractor) => stemEcho(front, distractor))) return answer;
  return echo.rest.charAt(0).toLocaleUpperCase() + echo.rest.slice(1);
}

/**
 * Whether a student could pick the right option without knowing the material.
 *
 * Measured against the options as they would actually be shown, lead-in and
 * all, so a set that only looked lopsided because the card's answer restates
 * the question is judged on the text the student reads rather than the text on
 * the card. Two ways to fail: the right answer is a different length from the
 * wrong ones, or some options name the question they are answering and the
 * rest do not.
 */
export function optionsLookGuessable(front: string, answer: string, distractors: string[]) {
  if ([answer, ...distractors].some((option) =>
    /^(?:all|none|both|neither) of (?:the above|these|the options)\b/i.test(option.trim()))) return true;
  const shown = withoutStemEcho(front, answer, distractors);
  const terms = (value: string) => value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const answerTerms = terms(shown.replace(/^(?:a|an|the)\s+/i, ""));
  if (answerTerms.length >= 1 && answerTerms.length <= 5 && /^[\p{L}\p{N}\s.'’-]+$/u.test(shown)
    && ` ${terms(front).join(" ")} `.includes(` ${answerTerms.join(" ")} `)) return true;
  if (!optionLengthsMatch(shown, distractors)) return true;
  const echoes = [shown, ...distractors].filter((option) => stemEcho(front, option)).length;
  return echoes > 0 && echoes < distractors.length + 1;
}
