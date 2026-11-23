import { expect, it } from "vitest";
import { appendSourceCardDrafts, requestedSourcePages } from "@/lib/ai/source-card-follow-up";

it("resolves slide ordinals, explicit page numbers and ranges in the file", () => {
  expect([...requestedSourcePages("Please revisit the first slide and pages 4–6, 8 and 10")]).toEqual([1, 4, 5, 6, 8, 10]);
  expect([...requestedSourcePages("More about transport")]).toEqual([]);
});

it("inserts recovered drafts in slide order and keeps edits, deselections and evidence", () => {
  const card = (id: string, back = id, selected = true) => ({ id, front: `Question ${id}?`, back, selected, evidenceIds: [id] });
  const cite = (id: string, summary: string, pageNumber?: number) => ({ id, summary, pageNumber, kind: "concept" as const, timestampSeconds: 0, facts: [] });
  const edited = card("five", "My corrected answer", false);
  const retained = { drafts: [card("two"), edited, card("six")], evidence: [cite("two", "p. 2 · evidence"), cite("five", "slide 5 · evidence"), cite("six", "Page 6 · evidence")] };
  const batch = { drafts: [card("new-five"), card("one"), edited], evidence: [cite("new-five", "Recovered", 5), cite("one", "Recovered", 1)] };
  const result = appendSourceCardDrafts(retained, batch, "request");
  expect(result.drafts.map(({ id }) => id)).toEqual(["request:one", "two", "five", "request:new-five", "six"]);
  expect(result.drafts[2]).toEqual(edited);
  expect(result.added).toBe(2);
  expect(result.evidence.find(({ id }) => id === "request:one")?.pageNumber).toBe(1);
});
