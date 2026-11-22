import { describe, expect, it, vi } from "vitest";
import { generateSourceCardBatch } from "@/services/ai/source-card-generation.server";
import {
  applySourceCardReview,
  buildSourceCardSections,
  finishSourceCardBatch,
  parseSourceCardSection,
  parseSourceVisualPassages,
  sourceCardNeedsRewrite,
  type SourceCardPassage,
} from "@/lib/ai/source-card-generation";
import type { Source } from "@/lib/material/sources";

const { generate, extract } = vi.hoisted(() => ({ generate: vi.fn(), extract: vi.fn() }));
vi.mock("@/lib/ai/provider-router", () => ({ generateAiText: generate }));
vi.mock("@/lib/ai/source-extraction", () => ({ extractSourcePagesForIndex: extract }));

const facts = [
  ["osmosis", "Water crosses a selectively permeable membrane."],
  ["diffusion", "Particles move down their concentration gradient."],
  ["mitosis", "The daughter nuclei have identical chromosome sets."],
  ["meiosis", "The chromosome number is halved in the daughter cells."],
  ["photosynthesis", "Light energy drives the formation of sugars."],
  ["respiration", "Oxidation of substrates releases energy for ATP production."],
  ["transpiration", "Water vapour exits leaves through the stomata."],
  ["translocation", "Sucrose travels from sources to sinks in the phloem."],
  ["denaturation", "The active site loses its shape at excessive temperatures."],
  ["digestion", "Large molecules are broken down into small soluble molecules."],
  ["translation", "Ribosomes read mRNA codons to build a polypeptide."],
  ["transcription", "RNA polymerase copies a DNA template into RNA."],
] as const;

const passages = facts.map(([topic, quote], index) => ({
  id: `p${index + 1}`,
  location: `slide ${index + 1}`,
  text: `${topic}\n${quote}`,
}));

function draft(passage: SourceCardPassage, front?: string) {
  const [topic, quote] = passage.text.split("\n");
  return { passageId: passage.id, quote, front: front ?? `What happens in ${topic}?`, back: quote };
}

describe("source flashcard generation", () => {
  it("keeps every slide in a long deck including those between the old sampled sections", () => {
    const slides = Array.from({ length: 90 }, (_, index) => ({
      pageNumber: index + 1,
      text: `The content of slide ${index + 1} includes a supporting example.`,
    }));
    const sections = buildSourceCardSections(slides, "slide");
    expect(sections.flat().map(({ location }) => location)).toEqual(slides.map(({ pageNumber }) => `slide ${pageNumber}`));
    expect(sections.every((section) => section.length <= 4)).toBe(true);
  });

  it("rejects invented quotes, keeps valid source locators and deduplicates exact cards", () => {
    const value = draft(passages[0]);
    const initial = parseSourceCardSection(JSON.stringify({ items: [
      value,
      { ...value, quote: "This sentence is made up." },
      { ...value, passageId: "unknown" },
      value,
    ] }), passages, 1);
    expect(initial).toHaveLength(2);
    const batch = finishSourceCardBatch(initial.map(({ card }) => card!), passages, null);
    expect(batch.drafts).toHaveLength(1);
    expect(batch.evidence[0].summary).toBe(`slide 1 · ${facts[0][1]}`);
  });

  it("applies only grounded corrections and additions and respects explicit drops", () => {
    const initial = parseSourceCardSection(JSON.stringify({ items: passages.slice(0, 3).map((passage) => draft(passage)) }), passages, 1);
    const corrected = "What does the membrane allow in osmosis?";
    const result = applySourceCardReview(JSON.stringify({
      checkedPassageIds: passages.map(({ id }) => id),
      omit: passages.filter((_, index) => index === 1 || index > 3).map(({ id }) => ({ passageId: id, reason: "out_of_scope" })),
      keep: [initial[2].id],
      drop: [initial[1].id],
      revise: [
        { ...draft(passages[0], corrected), id: initial[0].id },
        { ...draft(passages[2]), quote: "Made up.", id: initial[2].id },
      ],
      add: [draft(passages[3])],
    }), initial, passages);
    expect(result.map((card) => card.front)).toEqual([corrected, initial[2].card!.front, draft(passages[3]).front]);
    expect(finishSourceCardBatch(result, passages, 2).limited).toBe(true);
  });

  it("removes alternate wordings of the same fact while keeping distinct facts from one passage", () => {
    const passage = {
      id: "p1", location: "p. 1",
      text: "Rail connections let towns sell goods to more distant markets. Steam trains reduced the cost of moving bulky goods.",
    };
    const result = parseSourceCardSection(JSON.stringify({ items: [
      { front: "How did railways widen the area towns traded with?", back: "Towns could sell goods to more distant markets.", quote: "Rail connections let towns sell goods to more distant markets." },
      { front: "What happened to markets after rail connections arrived?", back: "Towns could sell their goods to distant markets.", quote: "towns sell goods to more distant markets" },
      { front: "What effect did steam trains have on the cost of carrying freight?", back: "They reduced the cost of moving bulky goods.", quote: "Steam trains reduced the cost of moving bulky goods." },
    ].map((card) => ({ ...card, passageId: passage.id })) }), [passage], 1);
    expect(finishSourceCardBatch(result.map(({ card }) => card!), [passage], null).drafts.map((card) => card.front)).toEqual([
      result[0].card!.front, result[2].card!.front,
    ]);
  });

  it("uses only valid page numbers from document vision and preserves source order", () => {
    const result = parseSourceVisualPassages(JSON.stringify({ pages: [
      { page: 3, text: "Third page" }, { page: 1, text: "First page" },
      { page: 3, text: "Repeated page" }, { page: 4, text: "Out of bounds" },
    ] }), 3);
    expect(result.map(({ id, text }) => [id, text])).toEqual([["v1", "First page"], ["v3", "Third page"]]);
  });

  it("checks every slide and recovers missing cards from both covered and uncovered slides", async () => {
    generate.mockReset();
    const extraOsmosis = "The net movement stops at equilibrium.";
    extract.mockResolvedValue({
      pages: passages.map((passage, index) => ({
        text: index === 0 ? `${passage.text}\n${extraOsmosis}` : passage.text, pageNumber: index + 1,
      })),
      pageKind: "slide",
      truncated: false,
    });
    generate.mockImplementation(async (options) => {
      const prompt: string = options.request.contents[0].parts[0].text;
      const payload = JSON.parse(prompt.split("\n\n").at(-1)!);
      expect(payload.learnerPreference).toBe("GCSE mechanisms");
      const section: SourceCardPassage[] = payload.passages;
      if (options.role === "worker") {
        return JSON.stringify({ items: section.slice(0, -1).map((passage) => draft(passage)) });
      }
      expect(options.role).toBe("juror");
      expect(section).toHaveLength(4);
      expect(payload.items).toHaveLength(3);
      return JSON.stringify({
        checkedPassageIds: section.map(({ id }) => id),
        omit: [],
        keep: payload.items.map(({ id }: { id: string }) => id),
        drop: [], revise: [],
        add: [
          draft(section.at(-1)!),
          ...(section[0].id === "p1" ? [{ front: "When does net movement stop in osmosis?", back: "At equilibrium.", passageId: "p1", quote: extraOsmosis }] : []),
        ],
      });
    });
    const update = vi.fn(async () => true);
    const result = await generateSourceCardBatch({
      source: { fileType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" } as Source,
      loadFile: vi.fn(),
      coverage: "thorough",
      focus: "GCSE mechanisms",
      maxCards: null,
      update,
    });
    expect(generate).toHaveBeenCalledTimes(6);
    expect(update).toHaveBeenLastCalledWith("checking_cards", 95);
    expect(result?.drafts).toHaveLength(13);
    expect(result?.evidence.filter(({ summary }) => summary.startsWith("slide 1 ·"))).toHaveLength(2);
    expect(result?.drafts.some((card) => card.front.includes("transcription"))).toBe(true);
    expect(result?.reviewed).toBe(true);
  });

  it("blocks the feedback example and lets the reviewer give the same teaching point a useful cue", () => {
    const slide = { id: "p1", location: "slide 1", text: "Superficial means closer to the body surface. Deep means farther from the body surface." };
    const leaked = { front: "What is the superficial/deep axis of an anatomical location?", back: "Superficial versus deep.", passageId: slide.id, quote: slide.text };
    const rewritten = "Which two anatomical terms describe positions closer to and farther from the body surface?";
    const items = parseSourceCardSection(JSON.stringify({ items: [leaked] }), [slide], 1);
    expect(sourceCardNeedsRewrite(leaked.front, leaked.back)).toBe(true);
    expect(sourceCardNeedsRewrite("What distinguishes superficial from deep structures?", "Their relative distance from the body surface.")).toBe(false);
    expect(sourceCardNeedsRewrite("What does the label on this slide mean?", "A directional term.")).toBe(true);
    expect(sourceCardNeedsRewrite("What is the opposite relation to x < 2?", "$x > 2$")).toBe(false);
    expect(finishSourceCardBatch([items[0].card!], [slide], null).drafts).toEqual([]);
    const verdict = { checkedPassageIds: [slide.id], omit: [], keep: [], drop: [], revise: [], add: [] };
    expect(() => applySourceCardReview(JSON.stringify({ ...verdict, keep: [items[0].id] }), items, [slide])).toThrow("incomplete_source_card_review");
    const review = applySourceCardReview(JSON.stringify({
      ...verdict, revise: [{ ...leaked, id: items[0].id, front: rewritten }],
    }), items, [slide]);
    expect(review[0].front).toBe(rewritten);
  });

  it("requires a card or an explicit omission for every checked passage", () => {
    const section = passages.slice(0, 2);
    const items = parseSourceCardSection(JSON.stringify({ items: [draft(section[0])] }), section, 1);
    const verdict = {
      checkedPassageIds: section.map(({ id }) => id),
      keep: [items[0].id], drop: [], revise: [], add: [], omit: [],
    };
    expect(() => applySourceCardReview(JSON.stringify(verdict), items, section)).toThrow("incomplete_source_card_review");
    expect(applySourceCardReview(JSON.stringify({
      ...verdict, omit: [{ passageId: section[1].id, reason: "out_of_scope" }],
    }), items, section)).toEqual([items[0].card]);
  });

  it("keeps more than 60 useful cards and preserves answers separated by a meaningful number", () => {
    const slides = Array.from({ length: 84 }, (_, index) => ({
      id: `p${index + 1}`, location: `Slide ${index + 1}`, text: `The measured depth was exactly ${index + 3} centimetres.`,
    }));
    const items = slides.map((slide, index) => ({
      front: `What depth was measured at site ${index + 200}?`, back: slide.text, passageId: slide.id, quote: slide.text,
    }));
    const cards = parseSourceCardSection(JSON.stringify({ items }), slides, 1).map(({ card }) => card!);
    expect(finishSourceCardBatch(cards, slides, null).drafts).toHaveLength(84);
    expect(finishSourceCardBatch(cards, slides, 12)).toMatchObject({ limited: true, drafts: expect.any(Array) });
  });
});
