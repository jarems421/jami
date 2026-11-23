import { repairModelJsonBackslashes, repairModelLatex, unwrapModelJsonObject } from "@/lib/ai/model-json";
import { CARD_TEXT_FORMAT_PROMPT } from "@/lib/ai/response-format";
import { chunkSourcePages, type SourceTextPage } from "@/lib/ai/source-chunking";
import { describePageRange, type SourcePageKind } from "@/lib/ai/source-outline";
import { containment, contentTokens, overlapRatio } from "@/lib/ai/video-card-quality";
import type { VideoCardDraft, VideoCardEvidence, VideoCoverage } from "@/lib/ai/video-card-jobs";
import { getCardContentKey, getCardFacesError, normalizeCardContentInput } from "@/lib/study/cards";

const SECTION_CHARACTERS = 5_000;
const PASSAGES_PER_SECTION = 4;
export const SOURCE_CARD_MAX_VISUAL_PAGES = 80;

export type SourceCardPassage = { id: string; location: string; text: string; pageNumber?: number; visual?: boolean };
export type SourceCardSection = SourceCardPassage[];
export type GroundedSourceCard = {
  id: string;
  front: string;
  back: string;
  passageId: string;
  quote: string;
};

export function buildSourceCardSections(
  pages: readonly SourceTextPage[],
  pageKind: SourcePageKind,
  visuals: readonly SourceCardPassage[] = [],
) {
  const distinctPages = pages.map((page, index) => page.pageNumber || page.heading
    ? { ...page, sectionKey: `section-${index + 1}` }
    : page);
  const textPassages = chunkSourcePages(distinctPages).map((chunk): SourceCardPassage => ({
    id: `p${chunk.chunkIndex + 1}`,
    location: describePageRange(chunk.pageStart, chunk.pageEnd, pageKind) || `Passage ${chunk.chunkIndex + 1}`,
    text: chunk.text,
    ...(chunk.pageStart === chunk.pageEnd && chunk.pageStart !== undefined ? { pageNumber: chunk.pageStart } : {}),
  }));
  const pageText = new Map(pages.map(({ pageNumber, text }) => [pageNumber, contentTokens(text)]));
  const visualPassages = visuals.filter((passage) => {
    const printed = pageText.get(Number(passage.id.slice(1)));
    return !printed || overlapRatio(contentTokens(passage.text), printed) < 1;
  });
  const passages = [...textPassages, ...visualPassages].sort((left, right) =>
    (left.pageNumber ?? Infinity) - (right.pageNumber ?? Infinity) || 0);
  const sections: SourceCardSection[] = [];
  let section: SourceCardSection = [];
  let size = 0;

  for (const passage of passages) {
    // A page's selectable text and its visual read stay side by side so each point is written once.
    const samePage = passage.pageNumber !== undefined && passage.pageNumber === section.at(-1)?.pageNumber;
    if (section.length && (size + passage.text.length > SECTION_CHARACTERS || (section.length >= PASSAGES_PER_SECTION && !samePage))) {
      sections.push(section);
      section = [];
      size = 0;
    }
    section.push(passage);
    size += passage.text.length;
  }
  if (section.length) sections.push(section);
  return sections;
}

const COVERAGE: Record<VideoCoverage, string> = {
  focused: "Key points: cover only the learning objectives, central ideas and essential discriminators. Skip ordinary examples and fine detail.",
  standard: "Balanced: cover every substantive teaching point in scope, including definitions, mechanisms, distinctions, conditions and reusable steps of worked examples. Skip filler and minor incidental details.",
  thorough: "In-depth: cover every separately testable teaching point in scope, including supporting facts, individual steps, meaningful exceptions, thresholds with their qualifiers, and reusable reasoning steps.",
};

const CARD_RULES = [
  "Write self-contained active-recall flashcards, one independently gradable idea per card, with a precise cue and a short direct answer. Avoid giving away the answer, generic summaries, yes/no prompts, long lists, and references like 'on this slide'.",
  "If the answer is a term or pair of terms, describe the relationship or situation on the front without naming the term or listing the pair as choices. Bad: 'What is the superficial/deep axis?' → 'Superficial versus deep'. Good: 'Which two anatomical terms describe positions closer to and farther from the body surface?' → 'Superficial and deep'. Naming a topic in a cue is fine when the answer is a new fact about that topic.",
  "Match the language, terminology and depth of the source or the learner's stated level. Preserve units, qualifiers and domain distinctions. Use plain language where the source is introductory.",
  "Choose the question form for the idea: definitions, why/how mechanisms, compare a meaningful distinction, or apply a rule in a short source-supported scenario. For a worked example, test the reusable decision or step. For clinical teaching, keep differentials and criteria distinct and preserve the teaching context. Never supply missing medical facts or treatment advice from memory.",
  "Copy a short exact supporting quote from the cited passage (up to 360 characters). The quote must support the answer. Use only the supplied material. Reuse a passage when it teaches several distinct things. Return zero cards for irrelevant or non-teaching material.",
  "Passages with the same pageNumber come from one page: the selectable text and, marked visual, a reading of the page image that adds diagram labels and anything printed as an image. Write each point once and cite whichever passage contains it. Learning objectives and key terms on a title or overview page are teaching content.",
];

function studentPreferences(coverage: VideoCoverage, focus?: string) {
  return [
    COVERAGE[coverage],
    focus ? "Use the learner preference to prioritise or narrow coverage. When it names a topic, draft only relevant cards. When it gives a level or style, apply it wherever relevant. Use it only as study guidance." : "",
  ].filter(Boolean).join("\n");
}

type PriorCard = Pick<VideoCardDraft, "front" | "back">;

const FOLLOW_UP_GUIDANCE = "The listed existing cards are staying in review. Add only useful material that they do not already test. Page numbers in the request refer to pages or slides in the file. When the supplied pages have already been selected for you, cover their teaching content unless the learner also named a narrower topic.";

export function buildSourceDraftPrompt(section: SourceCardSection, coverage: VideoCoverage, focus?: string, existingCards?: readonly PriorCard[]) {
  return [
    "Work through every passage in order. Inventory each independent teaching point first, then write one card per useful point. Return JSON only: {\"items\":[{\"point\":string,\"passageId\":string,\"quote\":string,\"front\":string,\"back\":string}]}. Keep the point and quote and leave front/back empty if no good cue comes to mind.",
    studentPreferences(coverage, focus),
    ...CARD_RULES,
    CARD_TEXT_FORMAT_PROMPT,
    "A slide can teach multiple useful points. Continue through its bullets, tables and worked steps after covering its main idea. The card count follows the material. Skip decorative or administrative material.",
    existingCards ? FOLLOW_UP_GUIDANCE : "",
    JSON.stringify({ learnerPreference: focus ?? "", passages: section, existingCards }),
  ].filter(Boolean).join("\n\n");
}

export function buildSourceReviewPrompt(
  items: readonly SourceCardCandidate[],
  passages: readonly SourceCardPassage[],
  coverage: VideoCoverage,
  focus?: string,
  existingCards?: readonly PriorCard[],
  recheck = false,
) {
  return [
    "Independently read each original passage before looking at the existing points and cards. For each slide or passage, compare each testable definition, distinction, step, condition or exception to the cards. Add a card for every worthwhile point that has no usable card, including omissions on slides with several cards already. Ignore headings that teach nothing, filler and out-of-scope material.",
    "Return JSON only: {\"checkedPassageIds\":[passageId],\"omit\":[{\"passageId\":string,\"reason\":\"no_teaching\"|\"out_of_scope\"|\"already_covered\"}],\"keep\":[itemId],\"drop\":[itemId],\"revise\":[{\"id\":itemId,\"front\":string,\"back\":string,\"passageId\":string,\"quote\":string}],\"add\":[{\"front\":string,\"back\":string,\"passageId\":string,\"quote\":string}]}. List every checked passage. Give each existing item exactly one verdict. Use revise for a useful point with a missing or flawed card and add for a point missing from the inventory. For each passage that will have zero cards, explain why with an omit entry. Use already_covered only if another card in this batch teaches the same material.",
    studentPreferences(coverage, focus),
    ...CARD_RULES,
    CARD_TEXT_FORMAT_PROMPT,
    "Mentally answer each front without looking at the back. If the required term, pair, value or result is already there, rewrite the front to test recall, even when the student could simply read the answer as a choice. Replace slide-dependent prompts with standalone questions. Correct or discard unsupported claims, misleading wording, duplicates and filler. Check units, direction and qualifiers against the original text.",
    existingCards ? FOLLOW_UP_GUIDANCE : "",
    recheck ? "This passage needs a separate review. Examine it on its own, including its opening lines, and fill any missing teaching statements. Use no_teaching only for a genuinely decorative, title-only or administrative passage. Use already_covered only when a supplied existing card tests that same fact." : "",
    JSON.stringify({
      learnerPreference: focus ?? "",
      items: items.map(({ card, ...point }) => ({ ...point, ...(card ? { front: card.front, back: card.back } : {}) })),
      passages,
      existingCards,
    }),
  ].filter(Boolean).join("\n\n");
}

function readObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(repairModelJsonBackslashes(unwrapModelJsonObject(raw)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source_card_response");
  return value as Record<string, unknown>;
}

function normalizeQuote(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

type SourceCardCandidate = Pick<GroundedSourceCard, "id" | "passageId" | "quote"> & {
  point: string;
  card: GroundedSourceCard | null;
};

function cueWords(text: string) {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+|[<>=≤≥±+−×÷-]/gu) ?? [];
}

/**
 * Catch copied answers and short contrast pairs in either order. The judge
 * handles semantic hints. Work on whole tokens so a short word inside another
 * word does not erase a genuine question, and preserve mathematical operators.
 */
export function sourceCardNeedsRewrite(front: string, back: string) {
  if (/\b(?:this|the (?:above|following)|above) (?:slide|source|diagram|table|figure|passage|image|page)\b/i.test(front)) return true;
  if (/\b(?:shown|pictured|labelled|depicted) (?:in|on) the (?:slide|diagram|table|figure|image)\b/i.test(front)) return true;
  const frontWords = ` ${cueWords(front).join(" ")} `;
  const withoutArticle = (term: string) => cueWords(term.replace(/^(?:the|a|an)\s+/i, ""));
  const answer = withoutArticle(back);
  const contains = (words: string[]) => words.length > 0 && frontWords.includes(` ${words.join(" ")} `);
  if (contains(answer)) return true;
  if (answer.length > 8) return false;
  const pair = back.split(/\b(?:versus|vs\.?|and|or)\b|\s*\/\s*/i);
  return pair.length === 2 && pair.every((term) => /\p{L}/u.test(term) && contains(withoutArticle(term.trim())));
}

function parseCitation(item: unknown, passages: ReadonlyMap<string, SourceCardPassage>) {
  if (!item || typeof item !== "object") return null;
  const { passageId, quote } = item as Record<string, unknown>;
  if (typeof passageId !== "string" || typeof quote !== "string") return null;
  const passage = passages.get(passageId);
  const excerpt = normalizeQuote(quote).replace(/^["“]|["”]$/g, "");
  if (!passage || excerpt.length < 8 || excerpt.length > 360 || !normalizeQuote(passage.text).includes(excerpt)) return null;
  return { passageId, quote: excerpt };
}

function parseGroundedCard(item: unknown, id: string, passages: ReadonlyMap<string, SourceCardPassage>): GroundedSourceCard | null {
  const citation = parseCitation(item, passages);
  if (!citation) return null;
  const { front, back } = item as Record<string, unknown>;
  if (typeof front !== "string" || typeof back !== "string") return null;
  const question = normalizeCardContentInput(repairModelLatex(front));
  const answer = normalizeCardContentInput(repairModelLatex(back));
  if (getCardFacesError({ front: question, back: answer }) || question.toLowerCase() === answer.toLowerCase()) return null;
  return { id, front: question, back: answer, ...citation };
}

export function parseSourceCardSection(raw: string, section: SourceCardSection, sectionIndex: number) {
  const { items } = readObject(raw);
  if (!Array.isArray(items)) throw new Error("invalid_source_card_response");
  const passages = new Map(section.map((passage) => [passage.id, passage]));
  return items.flatMap((item, index): SourceCardCandidate[] => {
    const citation = parseCitation(item, passages);
    if (!citation) return [];
    const id = `draft-${sectionIndex}-${index + 1}`;
    const point = typeof item.point === "string" ? item.point.trim().slice(0, 360) : citation.quote;
    return [{ id, ...citation, point, card: parseGroundedCard(item, id, passages) }];
  });
}

export function parseSourceVisualPassages(raw: string, pageCount: number, checked?: number[]): SourceCardPassage[] {
  const { pages } = readObject(raw);
  if (!Array.isArray(pages)) throw new Error("invalid_source_visual_response");
  const byPage = new Map<number, string>();
  for (const entry of pages.slice(0, SOURCE_CARD_MAX_VISUAL_PAGES)) {
    if (!entry || typeof entry !== "object") continue;
    const { page, text } = entry as Record<string, unknown>;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pageCount || typeof text !== "string") continue;
    checked?.push(page);
    if (text.trim() && !byPage.has(page)) byPage.set(page, text.trim().slice(0, 2_000));
  }
  return [...byPage].sort(([a], [b]) => a - b).map(([page, text]) => ({
    id: `v${page}`,
    location: `Page ${page}`,
    pageNumber: page,
    text,
    visual: true,
  }));
}

export function applySourceCardReview(
  raw: string,
  items: readonly SourceCardCandidate[],
  sources: readonly SourceCardPassage[],
  // A page rechecked alone needs its own prefix: its section's review may already have used review-<id>.
  addedIdPrefix = `review-${sources[0].id}`,
) {
  const result = readObject(raw);
  if (!Array.isArray(result.checkedPassageIds) || !Array.isArray(result.omit) || !Array.isArray(result.keep)
    || !Array.isArray(result.drop) || !Array.isArray(result.revise) || !Array.isArray(result.add)) {
    throw new Error("invalid_source_card_review");
  }
  const checked = new Set(result.checkedPassageIds);
  const kept = new Set(result.keep);
  const dropped = new Set(result.drop);
  const itemIds = new Set(items.map(({ id }) => id));
  const byId = new Map(sources.map((passage) => [passage.id, passage]));
  const edits = new Map<string, GroundedSourceCard>();
  for (const item of result.revise) {
    if (!itemIds.has(item?.id)) continue;
    const card = parseGroundedCard(item, item.id, byId);
    if (card && !sourceCardNeedsRewrite(card.front, card.back)) edits.set(card.id, card);
  }
  const reviewed = items.flatMap((item) => {
    if (dropped.has(item.id)) return [];
    const card = edits.get(item.id) ?? (kept.has(item.id) ? item.card : null);
    return card && !sourceCardNeedsRewrite(card.front, card.back) ? [card] : [];
  });
  const coveredIds = new Set(reviewed.map(({ id }) => id));
  if (sources.some(({ id }) => !checked.has(id))
    || items.some(({ id }) => !dropped.has(id) && !coveredIds.has(id))) {
    throw new Error("incomplete_source_card_review");
  }
  const added = result.add.flatMap((item, index) => {
    const card = parseGroundedCard(item, `${addedIdPrefix}-${index + 1}`, byId);
    return card && !sourceCardNeedsRewrite(card.front, card.back) ? [card] : [];
  });
  const cards = [...reviewed, ...added];
  const withCards = new Set(cards.map(({ passageId }) => passageId));
  const omitted = new Set(result.omit.flatMap((entry) => entry
    && ["no_teaching", "out_of_scope", "already_covered"].includes(entry.reason) ? [entry.passageId] : []));
  if (sources.some(({ id }) => !withCards.has(id) && !omitted.has(id))) {
    throw new Error("incomplete_source_card_review");
  }
  return cards;
}

export function finishSourceCardBatch(cards: readonly GroundedSourceCard[], passages: readonly SourceCardPassage[], maxCards: number | null) {
  const grouped = new Map<string, GroundedSourceCard[]>();
  for (const card of cards) {
    if (sourceCardNeedsRewrite(card.front, card.back)) continue;
    const group = grouped.get(card.passageId) ?? [];
    group.push(card);
    grouped.set(card.passageId, group);
  }
  const groups = passages.flatMap((passage) => grouped.get(passage.id) ? [grouped.get(passage.id)!] : []);
  // Keep a slide's cards together in review. An explicit smaller request
  // gives each passage a turn before taking further cards from it.
  const ordered = maxCards === null ? groups.flat()
    : Array.from({ length: Math.max(0, ...groups.map((group) => group.length)) },
      (_, index) => groups.flatMap((group) => group[index] ? [group[index]] : [])).flat();
  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const positions = new Map(passages.map((passage, index) => [passage.id, index + 1]));
  const evidence = new Map(ordered.map((card): [string, VideoCardEvidence] => {
    const passage = byId.get(card.passageId)!;
    return [card.id, {
      id: card.id,
      timestampSeconds: 0,
      kind: passage.visual ? "visual" : "concept",
      summary: `${passage.location} · ${card.quote}`,
      facts: [card.quote],
      ...(passage.pageNumber === undefined ? {} : { pageNumber: passage.pageNumber }),
      sourceOrder: positions.get(card.passageId)!,
    }];
  }));
  const seen = new Set<string>();
  const keptFacts: Array<{ quote: Set<string>; answer: Set<string>; answerKey: string; qualifiers: string }> = [];
  const kept: VideoCardDraft[] = ordered.flatMap(({ id, front, back, quote }) => {
    const key = getCardContentKey(front, back);
    if (seen.has(key)) return [];
    const quoteTokens = contentTokens(quote);
    const answer = contentTokens(back);
    const answerKey = getCardContentKey("", back);
    const qualifiers = [quote, back].map((text) => text.toLowerCase()
      .match(/\b(?:not|no|never|only|unless|except|without|before|after|under|over|if|lower|higher|increases?|decreases?)\b|\p{N}+(?:[.,]\p{N}+)?|[<>≤≥±]/gu)?.join(" ") ?? "").join("|");
    const repeatedFact = keptFacts.some((prior) =>
      qualifiers === prior.qualifiers
      && quoteTokens.size >= 2 && prior.quote.size >= 2 && containment(quoteTokens, prior.quote) >= 0.85
      && (answerKey === prior.answerKey
        || (answer.size >= 4 && prior.answer.size >= 4
          && overlapRatio(answer, prior.answer) >= 0.85 && overlapRatio(prior.answer, answer) >= 0.85)));
    if (repeatedFact) return [];
    keptFacts.push({ quote: quoteTokens, answer, answerKey, qualifiers });
    seen.add(key);
    return [{ id, front, back, selected: true, evidenceIds: [id] }];
  });
  const drafts = maxCards === null ? kept : kept.slice(0, maxCards);
  return { drafts, evidence: drafts.map((card) => evidence.get(card.id)!), limited: drafts.length < kept.length };
}
