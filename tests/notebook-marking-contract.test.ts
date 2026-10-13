import { describe, expect, it } from "vitest";
import {
  invitesNotebookMarking,
  parseJamiAssistantModelAnswer,
} from "@/lib/ai/jami-assistant";
import { readNotebookMarking } from "@/lib/learning/events/notebook-marking";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";

/**
 * The contract between Tutor and the learner profile, benchmarked at the two
 * places it can leak.
 *
 * The gate decides whether a turn may produce evidence at all. The validator
 * decides whether what came back is a verdict. Neither trusts the other, and
 * both fail closed -- so the question these answer is not "does the model
 * behave" but "if it misbehaves, does anything reach the profile".
 */

const NOW = Date.parse("2026-09-21T10:00:00.000Z");

function context(overrides: Partial<JamiAssistantContext> = {}): JamiAssistantContext {
  return {
    surface: "notebook",
    notebookId: "nb-1",
    pageId: "page-3",
    hasInk: true,
    ...overrides,
  } as JamiAssistantContext;
}

describe("when marking is invited at all", () => {
  it("invites it for an explicit request to be marked", () => {
    for (const message of [
      "mark my working please",
      "how many marks would this get?",
      "grade this for me",
      "what would I score on this?",
      "mark this out of 6",
    ]) {
      expect(invitesNotebookMarking({ message, context: context() })).toBe(true);
    }
  });

  it("refuses ordinary help, however close the wording", () => {
    for (const message of [
      "can you check my working",
      "review this page for me",
      "any feedback on this?",
      "is this correct?",
      "have a look at this",
    ]) {
      expect(invitesNotebookMarking({ message, context: context() })).toBe(false);
    }
  });

  it("refuses a request to understand even when a mark word is in it", () => {
    expect(
      invitesNotebookMarking({
        message: "explain why this would only get 2 marks",
        context: context(),
      })
    ).toBe(false);
    expect(
      invitesNotebookMarking({
        message: "mark this and walk me through where I went wrong",
        context: context(),
      })
    ).toBe(false);
  });

  it("refuses anywhere there is no page to attach a verdict to", () => {
    expect(invitesNotebookMarking({ message: "mark my working", context: context({ pageId: "" }) })).toBe(false);
    expect(
      invitesNotebookMarking({
        message: "mark my working",
        context: context({ surface: "sources" }),
      })
    ).toBe(false);
  });
});

describe("what the model sends back", () => {
  const base = {
    answer: "You have the method right; the final line loses a mark.",
    sourceRefs: [],
    usedCurrentContext: true,
    usedGeneralKnowledge: true,
    usedWebResearch: false,
    graphs: [],
  };

  const parse = (payload: object) =>
    parseJamiAssistantModelAnswer(JSON.stringify(payload), [], { webResearchAvailable: true });

  const validate = (marking: unknown) =>
    readNotebookMarking({
      verdict: marking,
      notebookId: "nb-1",
      pageId: "page-3",
      learning: { conceptKeys: ["topic:quadratics"], attribution: "notebook-topics", workItemId: "notebook:nb-1:page-3" },
      markedAt: NOW,
    });

  it("carries a well-formed verdict through untouched", () => {
    const marking = {
      awardedMarks: 3,
      maxMarks: 5,
      criterionResults: [
        { criterion: "Correct method", awarded: true, awardedMarks: 3 },
        { criterion: "Final answer in required form", awarded: false, awardedMarks: 2 },
      ],
    };
    const parsed = parse({ ...base, marking });
    expect(parsed?.marking).toEqual(marking);
    expect(validate(parsed?.marking).ok).toBe(true);
  });

  it("treats an absent marking as the normal case", () => {
    const parsed = parse(base);
    expect(parsed).not.toBeNull();
    expect(parsed?.marking).toBeUndefined();
    expect(validate(parsed?.marking).ok).toBe(false);
  });

  it("keeps the answer when the model abstains from marking", () => {
    // Abstention must not cost the student their reply.
    const parsed = parse({ ...base, marking: null });
    expect(parsed?.answer).toContain("method right");
    expect(parsed?.marking).toBeUndefined();
  });

  it("lets nothing through that is not a verdict", () => {
    for (const bad of [
      "probably 4 out of 5",
      { awardedMarks: 4, maxMarks: 5 },
      { awardedMarks: 4, maxMarks: 5, criterionResults: [] },
      { awardedMarks: 9, maxMarks: 5, criterionResults: [{ criterion: "x", awarded: true }] },
      { maxMarks: 5, criterionResults: [{ criterion: "x", awarded: true }] },
    ]) {
      const parsed = parse({ ...base, marking: bad });
      // The parser is a courier, not a judge: it carries whatever arrived...
      expect(parsed).not.toBeNull();
      // ...and the one gate refuses it.
      expect(validate(parsed?.marking).ok).toBe(false);
    }
  });

  it("refuses a total the criteria do not support", () => {
    const parsed = parse({
      ...base,
      marking: {
        awardedMarks: 5,
        maxMarks: 6,
        criterionResults: [
          { criterion: "Method", awarded: true, awardedMarks: 2 },
          { criterion: "Answer", awarded: false, awardedMarks: 4 },
        ],
      },
    });
    expect(validate(parsed?.marking)).toEqual({
      ok: false,
      reason: "criteria_disagree_with_total",
    });
  });

  it("does not let a marking rescue an otherwise broken answer", () => {
    // A reply with no answer is rejected whatever else it carries.
    expect(
      parse({
        ...base,
        answer: "",
        marking: { awardedMarks: 1, maxMarks: 2, criterionResults: [{ criterion: "x", awarded: true }] },
      })
    ).toBeNull();
  });
});
