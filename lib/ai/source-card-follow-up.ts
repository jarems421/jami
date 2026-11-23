import { canStoreSourceCardReview, type VideoCardDraft, type VideoCardEvidence } from "@/lib/ai/video-card-jobs";
import { getCardContentKey } from "@/lib/study/cards";

const ordinalPages = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** Resolve explicit locators against file order before sending any text to the model. */
export function requestedSourcePages(instruction: string): Set<number> {
  const numbers = new Set<number>();
  const ordinals = new RegExp(`\\b(${ordinalPages.join("|")}|\\d{1,4}(?:st|nd|rd|th))\\s+(?:slide|page)\\b`, "gi");
  for (const [, ordinal] of instruction.matchAll(ordinals)) {
    numbers.add(Number.parseInt(ordinal, 10) || ordinalPages.indexOf(ordinal.toLowerCase()) + 1);
  }
  for (const [, list] of instruction.matchAll(/\b(?:slides?|pages?)\s+#?(\d{1,4}(?:\s*(?:,|and\b|[-–—]|to\b)\s*\d{1,4})*)/gi)) {
    for (const entry of list.split(/\s*(?:,|\band\b)\s*/i)) {
      const [first, last = first] = entry.split(/\s*(?:[-–—]|\bto\b)\s*/i).map(Number);
      for (let page = first; page <= Math.min(last, 1500); page += 1) if (page > 0) numbers.add(page);
    }
  }
  return numbers;
}

export function appendSourceCardDrafts(
  job: { drafts: readonly VideoCardDraft[]; evidence: readonly VideoCardEvidence[] },
  batch: { drafts: readonly VideoCardDraft[]; evidence: readonly VideoCardEvidence[] },
  requestId: string,
) {
  const seen = new Set(job.drafts.map(({ front, back }) => getCardContentKey(front, back)));
  const references = new Map(batch.evidence.map((entry) => [entry.id, entry]));
  const drafts = [...job.drafts];
  const evidence = [...job.evidence];
  for (const draft of batch.drafts) {
    const key = getCardContentKey(draft.front, draft.back);
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({ ...draft, id: `${requestId}:${draft.id}`, evidenceIds: draft.evidenceIds.map((id) => `${requestId}:${id}`) });
    for (const id of draft.evidenceIds) {
      const entry = references.get(id);
      if (entry) evidence.push({ ...entry, id: `${requestId}:${entry.id}` });
    }
  }
  if (!canStoreSourceCardReview(drafts, evidence)) throw new Error("source_card_review_too_large");
  const allEvidence = new Map(evidence.map((entry) => [entry.id, entry]));
  const locate = (draft: VideoCardDraft) => {
    for (const id of draft.evidenceIds) {
      const entry = allEvidence.get(id);
      if (!entry) continue;
      const legacy = Number(entry.summary.match(/^(?:slides?|pages?|passage|pp?\.)\s+(\d+)/i)?.[1]);
      const position = entry.pageNumber ?? (Number.isFinite(legacy) ? legacy : entry.sourceOrder);
      if (position !== undefined) return position;
    }
    return Infinity;
  };
  const ordered = drafts.map((card) => ({ card, position: locate(card) }))
    .sort((left, right) => left.position - right.position)
    .map(({ card }) => card);
  return { drafts: ordered, evidence, added: drafts.length - job.drafts.length };
}
