import { describe, expect, it } from "vitest";
import { notebookObservations } from "@/lib/learning/profile/notebook-signals";
import {
  MAX_NOTEBOOK_MARKS,
  buildNotebookMarkingWrite,
  decodeNotebookMarking,
  notebookMarkingId,
  readNotebookMarking,
  toNotebookMarkedWorking,
} from "@/lib/learning/events/notebook-marking";
import type { NotebookPageLearningContext } from "@/lib/learning/notebook-page-context";
import { LEARNING_ERROR_CATEGORIES } from "@/lib/learning/types";
import { buildAssistantResponseSchema } from "@/app/api/ai/assistant/response-schema";

const NOW = Date.parse("2026-09-21T10:00:00.000Z");

const VERDICT = {
  awardedMarks: 3,
  maxMarks: 5,
  criterionResults: [
    { criterion: "States the gradient", awarded: true, awardedMarks: 2 },
    { criterion: "Substitutes the point correctly", awarded: true, awardedMarks: 1 },
    { criterion: "Gives the equation in the required form", awarded: false, awardedMarks: 2 },
  ],
};

const LEARNING: NotebookPageLearningContext = {
  conceptKeys: ["topic:quadratics"],
  attribution: "notebook-topics",
  workItemId: "notebook:nb-1:page-3",
};

function read(
  verdict: unknown,
  overrides: Record<string, unknown> = {},
  learning: Partial<NotebookPageLearningContext> = {}
) {
  return readNotebookMarking({
    verdict,
    notebookId: "nb-1",
    pageId: "page-3",
    learning: { ...LEARNING, ...learning },
    markedAt: NOW,
    ...overrides,
  });
}

describe("accepting a marking", () => {
  it("accepts a complete, coherent verdict", () => {
    const result = read(VERDICT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marking.awardedMarks).toBe(3);
    expect(result.marking.provenance).toBe("tutor");
    expect(result.marking.markerVersion).toBeTruthy();
  });

  it("accepts a tick-list with no per-point tariffs", () => {
    const result = read({
      awardedMarks: 2,
      maxMarks: 4,
      criterionResults: [
        { criterion: "Method is sound", awarded: true },
        { criterion: "Arithmetic is correct", awarded: false },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("failing closed", () => {
  it("refuses prose dressed up as a mark", () => {
    expect(read({ answer: "Looks mostly correct, probably 4 out of 5" }).ok).toBe(false);
    expect(read("4/5").ok).toBe(false);
    expect(read(null).ok).toBe(false);
  });

  it("refuses a verdict with no criteria behind it", () => {
    const result = read({ awardedMarks: 4, maxMarks: 5 });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a total its own criteria disagree with", () => {
    const result = read({
      ...VERDICT,
      // Criteria award 3; the total says 5.
      awardedMarks: 5,
    });
    expect(result).toEqual({ ok: false, reason: "criteria_disagree_with_total" });
  });

  it("refuses impossible marks", () => {
    const rejection = (verdict: unknown) => {
      const result = read(verdict);
      return result.ok ? null : result.reason;
    };
    expect(rejection({ ...VERDICT, awardedMarks: 9, maxMarks: 5 })).toBe("marks_out_of_range");
    expect(rejection({ ...VERDICT, awardedMarks: 0, maxMarks: 0 })).toBe("marks_out_of_range");
    expect(rejection({ ...VERDICT, awardedMarks: 1, maxMarks: MAX_NOTEBOOK_MARKS + 1 })).toBe(
      "marks_out_of_range"
    );
  });

  it("refuses working that cannot be placed on a concept", () => {
    expect(read(VERDICT, {}, { conceptKeys: [] })).toEqual({ ok: false, reason: "no_topics" });
    expect(read(VERDICT, {}, { conceptKeys: ["  "] })).toEqual({ ok: false, reason: "no_topics" });
    // Only student Topics and specification concepts place evidence.
    expect(read(VERDICT, {}, { conceptKeys: ["deck:d1"] })).toEqual({ ok: false, reason: "no_topics" });
    expect(read(VERDICT, {}, { conceptKeys: ["quadratics"] })).toEqual({ ok: false, reason: "no_topics" });
    expect(read(VERDICT, {}, { attribution: "none" })).toEqual({ ok: false, reason: "no_topics" });
  });

  it("refuses a marking with nothing to attach it to", () => {
    expect(read(VERDICT, { pageId: "" }).ok).toBe(false);
    expect(read(VERDICT, { notebookId: "" }).ok).toBe(false);
    expect(read(VERDICT, { markedAt: 0 }).ok).toBe(false);
    expect(read(VERDICT, {}, { workItemId: "" }).ok).toBe(false);
    expect(read(VERDICT, {}, { workItemId: "card:c1" }).ok).toBe(false);
  });

  it("keeps where the page sits: its concepts, its piece of work and the action followed", () => {
    const result = read(VERDICT, {}, {
      conceptKeys: ["spec:aqa-quadratics"],
      attribution: "linked-question",
      workItemId: "paper:paper-1:q4",
      interventionId: "folder:f1|practice|topic:spec:aqa-quadratics",
    });
    if (!result.ok) throw new Error("expected a marking");
    expect(result.marking.topicKeys).toEqual(["spec:aqa-quadratics"]);
    expect(result.marking.attribution).toBe("linked-question");
    expect(result.marking.itemId).toBe("paper:paper-1:q4");
    expect(result.marking.interventionId).toBe("folder:f1|practice|topic:spec:aqa-quadratics");
  });

  it("refuses a criterion list with a malformed entry", () => {
    expect(
      read({
        ...VERDICT,
        criterionResults: [{ criterion: "States the gradient" }],
      }).ok
    ).toBe(false);
  });
});

describe("declining to mark", () => {
  /*
   * The failure this exists to prevent, observed live before it was added:
   * asked to mark a page with nothing markable on it, the model wrote "I can't
   * mark this" in its answer and emitted a structurally perfect 0/6 underneath.
   * Every other rule here passed it, and it would have recorded a student
   * scoring zero on work nobody assessed.
   */
  it("treats a declined marking as a decline, not a malformed one", () => {
    const result = read({ ...VERDICT, canMark: false });
    expect(result).toEqual({ ok: false, reason: "declined" });
  });

  it("declines whatever else the verdict carries", () => {
    // The model may fill the other fields in anyway; canMark is the answer.
    expect(read({ canMark: false }).ok).toBe(false);
    expect(read({ canMark: false, awardedMarks: 0, maxMarks: 6, criterionResults: [] }).ok).toBe(
      false
    );
  });

  it("still marks when the model says it can", () => {
    expect(read({ ...VERDICT, canMark: true }).ok).toBe(true);
    // Absent means the model did not use the field; the other rules decide.
    expect(read(VERDICT).ok).toBe(true);
  });

  it("does not let a zero stand in for a decline", () => {
    // A genuine nought is a judgement about the student and is kept.
    const zero = read({
      canMark: true,
      awardedMarks: 0,
      maxMarks: 4,
      criterionResults: [{ criterion: "Correct method", awarded: false, awardedMarks: 4 }],
    });
    expect(zero.ok).toBe(true);
  });
});

describe("what a marking keeps", () => {
  it("never stores what the student wrote", () => {
    const result = read({
      ...VERDICT,
      criterionResults: VERDICT.criterionResults.map((entry) => ({
        ...entry,
        // A marker may offer this; a notebook marking must not keep it.
        candidateValue: "y = 3x + 7, the student's own line",
      })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = JSON.stringify(result.marking);
    expect(stored).not.toContain("student's own line");
    expect(stored).not.toContain("candidateValue");
  });

  it("keeps a fixed error category on a point lost, and nothing else the marker says about it", () => {
    const result = read({
      ...VERDICT,
      mistakeKind: "slip",
      criterionResults: [
        { criterion: "States the gradient", awarded: true, awardedMarks: 2, errorCategory: "missing_units" },
        { criterion: "Substitutes the point correctly", awarded: true, awardedMarks: 1 },
        { criterion: "Gives the equation with units", awarded: false, awardedMarks: 2, errorCategory: "missing_units" },
        { criterion: "Rounds sensibly", awarded: false, errorCategory: "sloppy_handwriting" },
      ],
    });
    if (!result.ok) throw new Error("expected a marking");
    const [earned, , lost, invented] = result.marking.criterionResults;
    // On a point earned it says nothing, and an invented one is dropped without losing the marking.
    expect(earned).not.toHaveProperty("errorCategory");
    expect(lost?.errorCategory).toBe("missing_units");
    expect(invented).not.toHaveProperty("errorCategory");
    // The kind of mistake chooses what Tutor offers next; it is never kept.
    expect(JSON.stringify(result.marking)).not.toContain("mistakeKind");

    const [observation] = notebookObservations([
      toNotebookMarkedWorking({ id: "nb-1_page-3", ...result.marking }),
    ]);
    expect(observation?.errorChecks).toContainEqual({
      category: "missing_units",
      missed: true,
      detection: expect.any(String),
    });
  });

  it("asks the marker only for categories and kinds from the fixed lists", () => {
    const schema = buildAssistantResponseSchema([], true);
    const marking = schema.properties?.marking;
    const criterion = marking?.properties?.criterionResults?.items;
    expect(criterion?.properties?.errorCategory?.enum).toEqual([...LEARNING_ERROR_CATEGORIES]);
    expect(marking?.properties?.mistakeKind?.enum).toEqual(["concept", "method", "slip"]);
    // Both optional: a marking without them is still a marking.
    expect(criterion?.required).not.toContain("errorCategory");
    expect(marking?.required).not.toContain("mistakeKind");
  });

  it("files one record per page, so re-marking replaces rather than adds", () => {
    expect(notebookMarkingId({ notebookId: "nb-1", pageId: "page-3" })).toBe("nb-1_page-3");
    expect(notebookMarkingId({ notebookId: "nb-1", pageId: "" })).toBeNull();
  });

  it("skips a stored record of an unknown schema or foreign provenance", () => {
    const result = read(VERDICT);
    if (!result.ok) throw new Error("expected a marking");
    const stored = buildNotebookMarkingWrite(result.marking, NOW);
    expect(decodeNotebookMarking("id", { ...stored })).not.toBeNull();
    expect(decodeNotebookMarking("id", { ...stored, schemaVersion: 3 })).toBeNull();
    expect(decodeNotebookMarking("id", { ...stored, attribution: "guessed" })).toBeNull();
    // A marking claiming to come from a real scheme is not one of ours.
    expect(decodeNotebookMarking("id", { ...stored, provenance: "official" })).toBeNull();
  });

  it("reads a version-1 record as it was: the notebook's Topics, the page as its own item", () => {
    const legacy = { ...VERDICT, notebookId: "nb-1", pageId: "p", topicIds: ["q"], markedAt: NOW };
    const decoded = decodeNotebookMarking("nb-1_p", { ...legacy, schemaVersion: 1, provenance: "tutor" });
    expect(decoded?.topicKeys).toEqual(["topic:q"]);
    expect(decoded?.attribution).toBe("notebook-topics");
    expect(decoded?.itemId).toBe("notebook:nb-1:p");
    expect(decodeNotebookMarking("id", { ...legacy, schemaVersion: 1, provenance: "official" })).toBeNull();
  });

  it("hands the profile the shape it already reads", () => {
    const result = read(VERDICT);
    if (!result.ok) throw new Error("expected a marking");
    const working = toNotebookMarkedWorking({ id: "nb-1_page-3", ...result.marking });
    expect(working.result.awardedMarks).toBe(3);
    expect(working.result.maxMarks).toBe(5);
    expect(working.topicKeys).toEqual(["topic:quadratics"]);
    expect(working.itemId).toBe("notebook:nb-1:page-3");
  });
});

/**
 * One completed marking action produces at most one piece of evidence.
 *
 * A Tutor turn can be retried by the route, regenerated by the student, or
 * re-sent by a client that lost the stream. None of those are three pieces of
 * evidence about the same page, and the protection is structural rather than
 * a rule applied later: the record is filed under the page, so a second
 * verdict replaces the first instead of joining it.
 */
describe("one page, one piece of evidence", () => {
  it("files every verdict for a page under the same id", () => {
    const first = notebookMarkingId({ notebookId: "nb-1", pageId: "page-3" });
    const retry = notebookMarkingId({ notebookId: "nb-1", pageId: "page-3" });
    expect(first).toBe(retry);
    // A different page is a different piece of evidence.
    expect(notebookMarkingId({ notebookId: "nb-1", pageId: "page-4" })).not.toBe(first);
  });

  it("gives the profile one observation however often a page was marked", () => {
    const marking = read(VERDICT);
    if (!marking.ok) throw new Error("expected a marking");
    const id = notebookMarkingId({ notebookId: "nb-1", pageId: "page-3" }) as string;

    // Three markings of one page, as three retries of one turn would produce.
    const observations = notebookObservations([
      toNotebookMarkedWorking({ id, ...marking.marking }),
      toNotebookMarkedWorking({ id, ...marking.marking, markedAt: NOW + 1_000 }),
      toNotebookMarkedWorking({ id, ...marking.marking, markedAt: NOW + 2_000 }),
    ]);
    expect(observations).toHaveLength(1);
  });

  it("keeps the most recent verdict when a page is marked again", () => {
    const id = notebookMarkingId({ notebookId: "nb-1", pageId: "page-3" }) as string;
    const worse = read({ ...VERDICT, awardedMarks: 0, criterionResults: [{ criterion: "Method", awarded: false }] });
    const better = read({ ...VERDICT, awardedMarks: 5, maxMarks: 5, criterionResults: [{ criterion: "Method", awarded: true }] });
    if (!worse.ok || !better.ok) throw new Error("expected markings");

    const [observation] = notebookObservations([
      toNotebookMarkedWorking({ id, ...worse.marking, markedAt: NOW }),
      toNotebookMarkedWorking({ id, ...better.marking, markedAt: NOW + 60_000 }),
    ]);
    // The later look at the page is the one that counts.
    expect(observation?.score).toBe(1);
  });
});
