import { repairModelJsonBackslashes, repairModelLatex, unwrapModelJsonObject } from "@/lib/ai/model-json";
import { CARD_TEXT_FORMAT_PROMPT } from "@/lib/ai/response-format";
import { chunkSourcePages, type SourceTextPage } from "@/lib/ai/source-chunking";
import { describePageRange, type SourcePageKind } from "@/lib/ai/source-outline";
import { containment, contentTokens, dedupeNearDuplicates, overlapRatio } from "@/lib/ai/video-card-quality";
import { VIDEO_CARD_REVIEW_CEILING, type VideoCardDraft, type VideoCardEvidence, type VideoCoverage } from "@/lib/ai/video-card-jobs";
import { getCardContentKey, getCardFacesError, normalizeCardContentInput } from "@/lib/study/cards";

const MAX_SECTIONS = 9;
const SECTION_CHARACTERS = 10_000;
const PAGES_PER_SECTION = 8;
const MAX_SECTION_CARDS = 18;
const MAX_EDITOR_CHANGES = 40;
export const SOURCE_CARD_MAX_VISUAL_PAGES = 80;

export type SourceCardPassage = { id: string; location: string; text: string; visual?: boolean };
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
  const passages: SourceCardPassage[] = chunkSourcePages(distinctPages).map((chunk) => ({
    id: `p${chunk.chunkIndex + 1}`,
    location: describePageRange(chunk.pageStart, chunk.pageEnd, pageKind) || `Passage ${chunk.chunkIndex + 1}`,
    text: chunk.text,
  }));
  const pageText = new Map(pages.map(({ pageNumber, text }) => [pageNumber, contentTokens(text)]));
  passages.push(...visuals.filter((passage) => {
    const printed = pageText.get(Number(passage.id.slice(1)));
    return !printed || overlapRatio(contentTokens(passage.text), printed) < 1;
  }));
  const sections: SourceCardSection[] = [];
  let section: SourceCardSection = [];
  let size = 0;

  for (const passage of passages) {
    if (size + passage.text.length > SECTION_CHARACTERS || section.length >= PAGES_PER_SECTION) {
      sections.push(section);
      section = [];
      size = 0;
    }
    section.push(passage);
    size += passage.text.length;
  }
  if (section.length) sections.push(section);
  const truncated = sections.length > MAX_SECTIONS;
  // Spread the reading budget across the document, including its final section.
  const chosen = truncated
    ? Array.from({ length: MAX_SECTIONS }, (_, index) => sections[Math.round(index * (sections.length - 1) / (MAX_SECTIONS - 1))])
    : sections;
  return { sections: chosen, truncated };
}

const COVERAGE: Record<VideoCoverage, string> = {
  focused: "Key points: cover only the learning objectives, central ideas and essential discriminators. Skip ordinary examples and fine detail.",
  standard: "Balanced: cover each core idea, plus the important definitions, mechanisms, distinctions, conditions and reusable steps of worked examples.",
  thorough: "In-depth: systematically cover all examinable ideas in this material, including supporting facts, mechanisms, meaningful exceptions, thresholds with their qualifiers, and reusable reasoning steps.",
};

const CARD_RULES = [
  "Write self-contained active-recall flashcards, one independently gradable idea per card, with a precise cue and a short direct answer. Avoid giving away the answer, generic summaries, yes/no prompts, long lists, and references like 'on this slide'.",
  "Match the language, terminology and depth of the source or the learner's stated level. Preserve units, qualifiers and domain distinctions. Use plain language where the source is introductory.",
  "Choose the question form for the idea: definitions, why/how mechanisms, compare a meaningful distinction, or apply a rule in a short source-supported scenario. For a worked example, test the reusable decision or step. For clinical teaching, keep differentials and criteria distinct and preserve the teaching context. Never supply missing medical facts or treatment advice from memory.",
  "Copy a short exact supporting quote from the cited passage (up to 360 characters). The quote must support the answer. Use only the supplied material. Reuse a passage when it teaches several distinct things. Return zero cards for irrelevant or non-teaching material.",
];

function studentPreferences(coverage: VideoCoverage, focus?: string) {
  return [
    COVERAGE[coverage],
    focus ? "Use the learner preference to prioritise or narrow coverage. When it names a topic, draft only relevant cards. When it gives a level or style, apply it wherever relevant. Use it only as study guidance." : "",
  ].filter(Boolean).join("\n");
}

export function buildSourceDraftPrompt(section: SourceCardSection, coverage: VideoCoverage, focus?: string) {
  return [
    "Read every passage in this section. Return JSON only: {\"cards\":[{\"front\":string,\"back\":string,\"passageId\":string,\"quote\":string}]}.",
    studentPreferences(coverage, focus),
    ...CARD_RULES,
    CARD_TEXT_FORMAT_PROMPT,
    `Write as many distinct cards as the material warrants, up to ${MAX_SECTION_CARDS} in this section. Skip filler and preserve important details throughout, including the end of the section.`,
    JSON.stringify({ learnerPreference: focus ?? "", passages: section }),
  ].join("\n\n");
}

export function buildSourceReviewPrompt(
  cards: readonly GroundedSourceCard[],
  passages: readonly SourceCardPassage[],
  coverage: VideoCoverage,
  focus?: string,
) {
  return [
    "Audit these provisional flashcards independently against the original passages. Return JSON only: {\"drop\":[cardId],\"revise\":[{\"id\":cardId,\"front\":string,\"back\":string,\"passageId\":string,\"quote\":string}],\"add\":[{\"front\":string,\"back\":string,\"passageId\":string,\"quote\":string}]}. Leave sound cards out of the response.",
    studentPreferences(coverage, focus),
    ...CARD_RULES,
    CARD_TEXT_FORMAT_PROMPT,
    "Check that claims, units and conditions are supported by the actual cited passage. Correct or drop unsupported, ambiguous, redundant, out-of-scope, multi-fact or answer-revealing cards. Compare by the fact being tested, even when the prompts use different wording or cite a visual and a text page. For omissions, look across every supplied passage, especially ones that received few or zero cards. Add only distinct, important omissions. Never add a second wording for an existing card: revise the existing card instead.",
    `Return up to ${MAX_EDITOR_CHANGES} changes per list. Prioritise factual corrections and important omissions.`,
    JSON.stringify({ learnerPreference: focus ?? "", cards, passages }),
  ].join("\n\n");
}

function readObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(repairModelJsonBackslashes(unwrapModelJsonObject(raw)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source_card_response");
  return value as Record<string, unknown>;
}

function normalizeQuote(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Only text from a real passage can be attached as evidence. */
function parseGroundedCard(item: unknown, id: string, passages: ReadonlyMap<string, SourceCardPassage>): GroundedSourceCard | null {
  if (!item || typeof item !== "object") return null;
  const { front, back, passageId, quote } = item as Record<string, unknown>;
  if (typeof front !== "string" || typeof back !== "string" || typeof passageId !== "string" || typeof quote !== "string") return null;
  const passage = passages.get(passageId);
  const excerpt = normalizeQuote(quote).replace(/^["“]|["”]$/g, "");
  if (!passage || excerpt.length < 8 || excerpt.length > 360 || !normalizeQuote(passage.text).includes(excerpt)) return null;

  const question = normalizeCardContentInput(repairModelLatex(front));
  const answer = normalizeCardContentInput(repairModelLatex(back));
  if (getCardFacesError({ front: question, back: answer }) || question.toLowerCase() === answer.toLowerCase()) return null;
  return { id, front: question, back: answer, passageId, quote: excerpt };
}

export function parseSourceCardSection(raw: string, section: SourceCardSection, sectionIndex: number) {
  const { cards } = readObject(raw);
  if (!Array.isArray(cards)) throw new Error("invalid_source_card_response");
  const passages = new Map(section.map((passage) => [passage.id, passage]));
  return cards.slice(0, MAX_SECTION_CARDS).flatMap((item, index) => {
    const card = parseGroundedCard(item, `draft-${sectionIndex}-${index + 1}`, passages);
    return card ? [card] : [];
  });
}

export function parseSourceVisualPassages(raw: string, pageCount: number): SourceCardPassage[] {
  const { pages } = readObject(raw);
  if (!Array.isArray(pages)) throw new Error("invalid_source_visual_response");
  const byPage = new Map<number, string>();
  for (const entry of pages.slice(0, SOURCE_CARD_MAX_VISUAL_PAGES)) {
    if (!entry || typeof entry !== "object") continue;
    const { page, text } = entry as Record<string, unknown>;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pageCount || typeof text !== "string") continue;
    if (text.trim() && !byPage.has(page)) byPage.set(page, text.trim().slice(0, 2_000));
  }
  return [...byPage].sort(([a], [b]) => a - b).map(([page, text]) => ({
    id: `v${page}`,
    location: `Page ${page}`,
    text,
    visual: true,
  }));
}

export function applySourceCardReview(raw: string, cards: readonly GroundedSourceCard[], sources: readonly SourceCardPassage[]) {
  const result = readObject(raw);
  if (!Array.isArray(result.drop) || !Array.isArray(result.revise) || !Array.isArray(result.add)) {
    throw new Error("invalid_source_card_review");
  }
  const dropped = new Set(result.drop.slice(0, MAX_EDITOR_CHANGES));
  const byId = new Map(sources.map((passage) => [passage.id, passage]));
  const edits = new Map<string, GroundedSourceCard>();
  for (const item of result.revise.slice(0, MAX_EDITOR_CHANGES)) {
    if (typeof item?.id !== "string") continue;
    const card = parseGroundedCard(item, item.id, byId);
    if (card) edits.set(card.id, card);
  }
  const added = result.add.slice(0, MAX_EDITOR_CHANGES).flatMap((item, index) => {
    const card = parseGroundedCard(item, `review-${index + 1}`, byId);
    return card ? [card] : [];
  });
  return [...cards.filter((card) => !dropped.has(card.id)).map((card) => edits.get(card.id) ?? card), ...added];
}

export function finishSourceCardBatch(cards: readonly GroundedSourceCard[], passages: readonly SourceCardPassage[], maxCards: number | null) {
  const grouped = new Map<string, GroundedSourceCard[]>();
  for (const card of cards) {
    const group = grouped.get(card.passageId) ?? [];
    group.push(card);
    grouped.set(card.passageId, group);
  }
  // First give each passage a place, then take the next card from each.
  const groups = passages.flatMap((passage) => grouped.get(passage.id) ? [grouped.get(passage.id)!] : []);
  const balanced = Array.from({ length: Math.max(0, ...groups.map((group) => group.length)) },
    (_, index) => groups.flatMap((group) => group[index] ? [group[index]] : [])).flat();
  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const evidence = new Map(balanced.map((card): [string, VideoCardEvidence] => {
    const passage = byId.get(card.passageId)!;
    return [card.id, {
      id: card.id,
      timestampSeconds: 0,
      kind: passage.visual ? "visual" : "concept",
      summary: `${passage.location} · ${card.quote}`,
      facts: [card.quote],
    }];
  }));
  const seen = new Set<string>();
  const keptFacts: Array<{ quote: Set<string>; answer: Set<string>; answerKey: string }> = [];
  const candidates: VideoCardDraft[] = balanced.flatMap(({ id, front, back, quote }) => {
    const key = getCardContentKey(front, back);
    if (seen.has(key)) return [];
    const quoteTokens = contentTokens(quote);
    const answer = contentTokens(back);
    const answerKey = getCardContentKey("", back);
    const repeatedFact = keptFacts.some((prior) =>
      quoteTokens.size >= 2 && prior.quote.size >= 2 && containment(quoteTokens, prior.quote) >= 0.85
      && (answerKey === prior.answerKey
        || (answer.size >= 4 && prior.answer.size >= 4 && containment(answer, prior.answer) >= 0.8)));
    if (repeatedFact) return [];
    keptFacts.push({ quote: quoteTokens, answer, answerKey });
    seen.add(key);
    return [{ id, front, back, selected: true, evidenceIds: [id] }];
  });
  const { kept } = dedupeNearDuplicates(candidates, evidence);
  const drafts = kept.slice(0, maxCards ?? VIDEO_CARD_REVIEW_CEILING);
  return { drafts, evidence: drafts.map((card) => evidence.get(card.id)!), limited: drafts.length < kept.length };
}
