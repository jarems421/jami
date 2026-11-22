import { describe, expect, it, vi } from "vitest";
import { generateSourceCardBatch } from "@/services/ai/source-card-generation.server";
import {
  applySourceCardReview,
  buildSourceCardSections,
  finishSourceCardBatch,
  parseSourceCardSection,
  parseSourceVisualPassages,
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
  it("spreads a bounded pass across a long slide deck including its ending", () => {
    const slides = Array.from({ length: 90 }, (_, index) => ({
      pageNumber: index + 1,
      text: `The content of slide ${index + 1} includes a supporting example.`,
    }));
    const { sections, truncated } = buildSourceCardSections(slides, "slide");
    expect(truncated).toBe(true);
    expect(sections).toHaveLength(9);
    expect(sections[0][0].location).toBe("slide 1");
    expect(sections.at(-1)?.at(-1)?.location).toBe("slide 90");
  });

  it("rejects invented quotes, keeps valid source locators and deduplicates exact cards", () => {
    const value = draft(passages[0]);
    const initial = parseSourceCardSection(JSON.stringify({ cards: [
      value,
      { ...value, quote: "This sentence is made up." },
      { ...value, passageId: "unknown" },
      value,
    ] }), passages, 1);
    expect(initial).toHaveLength(2);
    const batch = finishSourceCardBatch(initial, passages, null);
    expect(batch.drafts).toHaveLength(1);
    expect(batch.evidence[0].summary).toBe(`slide 1 · ${facts[0][1]}`);
  });

  it("applies only grounded corrections and additions and respects explicit drops", () => {
    const initial = parseSourceCardSection(JSON.stringify({ cards: passages.slice(0, 3).map((passage) => draft(passage)) }), passages, 1);
    const corrected = "What does the membrane allow in osmosis?";
    const result = applySourceCardReview(JSON.stringify({
      drop: [initial[1].id],
      revise: [
        { ...draft(passages[0], corrected), id: initial[0].id },
        { ...draft(passages[2]), quote: "Made up.", id: initial[2].id },
      ],
      add: [draft(passages[3])],
    }), initial, passages);
    expect(result.map((card) => card.front)).toEqual([corrected, initial[2].front, draft(passages[3]).front]);
    expect(finishSourceCardBatch(result, passages, 2).limited).toBe(true);
  });

  it("removes alternate wordings of the same fact while keeping distinct facts from one passage", () => {
    const passage = {
      id: "p1", location: "p. 1",
      text: "Rail connections let towns sell goods to more distant markets. Steam trains reduced the cost of moving bulky goods.",
    };
    const result = parseSourceCardSection(JSON.stringify({ cards: [
      { front: "How did railways widen the area towns traded with?", back: "Towns could sell goods to more distant markets.", quote: "Rail connections let towns sell goods to more distant markets." },
      { front: "What happened to markets after rail connections arrived?", back: "Rail connections let towns sell goods to more distant markets.", quote: "towns sell goods to more distant markets" },
      { front: "What effect did steam trains have on the cost of carrying freight?", back: "They reduced the cost of moving bulky goods.", quote: "Steam trains reduced the cost of moving bulky goods." },
    ].map((card) => ({ ...card, passageId: passage.id })) }), [passage], 1);
    expect(finishSourceCardBatch(result, [passage], null).drafts.map((card) => card.front)).toEqual([
      result[0].front, result[2].front,
    ]);
  });

  it("uses only valid page numbers from document vision and preserves source order", () => {
    const result = parseSourceVisualPassages(JSON.stringify({ pages: [
      { page: 3, text: "Third page" }, { page: 1, text: "First page" },
      { page: 3, text: "Repeated page" }, { page: 4, text: "Out of bounds" },
    ] }), 3);
    expect(result.map(({ id, text }) => [id, text])).toEqual([["v1", "First page"], ["v3", "Third page"]]);
  });

  it("reads every slide across draft passes and recovers a missed section in an independent audit", async () => {
    generate.mockReset();
    extract.mockResolvedValue({
      pages: passages.map((passage, index) => ({ text: passage.text, pageNumber: index + 1 })),
      pageKind: "slide",
      truncated: false,
    });
    generate.mockImplementation(async (options) => {
      const prompt: string = options.request.contents[0].parts[0].text;
      const payload = JSON.parse(prompt.split("\n\n").at(-1)!);
      expect(payload.learnerPreference).toBe("GCSE mechanisms");
      if (options.role === "worker") {
        return JSON.stringify({ cards: payload.passages.slice(0, -1).map((passage: SourceCardPassage) => draft(passage)) });
      }
      expect(options.role).toBe("juror");
      expect(payload.passages).toHaveLength(12);
      expect(payload.cards).toHaveLength(10);
      return JSON.stringify({ drop: [], revise: [], add: [draft(payload.passages.at(-1))] });
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
    expect(generate).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith("checking_cards", 82);
    expect(result?.drafts).toHaveLength(11);
    expect(result?.drafts.some((card) => card.front.includes("transcription"))).toBe(true);
    expect(result?.reviewed).toBe(true);
  });
});
