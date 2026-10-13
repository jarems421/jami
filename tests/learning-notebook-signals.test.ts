import { describe, expect, it } from "vitest";
import {
  notebookObservations,
  type NotebookMarkedWorking,
} from "@/lib/learning/profile/notebook-signals";
import { masteryScore } from "@/lib/learning/scoring/mastery-score";
import { sourceWeight } from "@/lib/learning/scoring/item-weights";
import { DEFAULT_LEARNING_TUNING } from "@/lib/learning/scoring/tuning";
import { evidenceConfidence } from "@/lib/learning/scoring/confidence-score";
import { MIN_STRENGTH_CONFIDENCE } from "@/lib/learning/profile/thresholds";

const NOW = Date.parse("2026-09-21T10:00:00.000Z");

function marking(overrides: Partial<NotebookMarkedWorking> = {}): NotebookMarkedWorking {
  return {
    id: "m1",
    notebookId: "n1",
    pageId: "p1",
    topicKeys: ["topic:osmosis"],
    itemId: "notebook:n1:p1",
    markedAt: NOW,
    result: { attempted: true, counted: true, awardedMarks: 3, maxMarks: 4 },
    ...overrides,
  };
}

describe("marked notebook working as evidence", () => {
  it("scores marked working against the credit it earned", () => {
    const [observation] = notebookObservations([marking()]);
    expect(observation?.kind).toBe("notebook");
    expect(observation?.score).toBeCloseTo(0.75, 5);
    expect(observation?.topicKeys).toEqual(["topic:osmosis"]);
    expect(observation?.trendEligible).toBe(true);
  });

  it("counts for less than an answer marked against a scheme", () => {
    const [observation] = notebookObservations([marking()]);
    // Scales with the marks like every marked source; how far it is trusted
    // is `evidenceSourceWeight.notebook`, applied by the scorer.
    expect(sourceWeight(observation!)).toBeLessThan(observation!.weight);
    expect(DEFAULT_LEARNING_TUNING.evidenceSourceWeight.notebook).toBeLessThan(
      DEFAULT_LEARNING_TUNING.evidenceSourceWeight["past-paper"]
    );
  });

  it("cannot by itself make a topic read as well evidenced", () => {
    // A page marked every day for a fortnight is still one page, marked often.
    const markings = Array.from({ length: 14 }, (_, index) =>
      marking({ id: `m${index}`, markedAt: NOW - index * 86_400_000 })
    );
    const observations = notebookObservations(markings);
    expect(observations).toHaveLength(1);
    expect(evidenceConfidence(observations, NOW)).toBeLessThan(MIN_STRENGTH_CONFIDENCE);
  });

  it("counts a page once however many times it was marked", () => {
    const observations = notebookObservations([
      marking({ id: "m1", markedAt: NOW - 1000 }),
      marking({ id: "m2", markedAt: NOW }),
    ]);
    expect(observations).toHaveLength(1);
  });

  it("counts two pages of the same question as one piece of work", () => {
    const observations = notebookObservations([
      marking({ id: "m1", pageId: "p6", itemId: "paper:paper-1:q4", markedAt: NOW - 1000 }),
      marking({ id: "m2", pageId: "p7", itemId: "paper:paper-1:q4", markedAt: NOW }),
    ]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.evidenceId).toBe("notebook-marking:m2");
    expect(observations[0]?.itemId).toBe("paper:paper-1:q4");
  });

  it("carries the study action the student was following", () => {
    const [followed] = notebookObservations([marking({ interventionId: "folder:f1|low_mastery|topic:osmosis" })]);
    const [unprompted] = notebookObservations([marking()]);
    expect(followed?.interventionId).toBe("folder:f1|low_mastery|topic:osmosis");
    expect(unprompted).not.toHaveProperty("interventionId");
  });

  it("splits working that spans two topics between them", () => {
    const [observation] = notebookObservations([marking({ topicKeys: ["topic:osmosis", "topic:diffusion"] })]);
    expect(observation?.topicShares).toEqual({
      "topic:osmosis": 0.5,
      "topic:diffusion": 0.5,
    });
  });

  it("drops working that cannot be placed on a topic", () => {
    expect(notebookObservations([marking({ topicKeys: [] })])).toEqual([]);
    expect(notebookObservations([marking({ topicKeys: ["  "] })])).toEqual([]);
  });

  it("drops a marking with no usable time or result", () => {
    expect(notebookObservations([marking({ markedAt: 0 })])).toEqual([]);
    expect(notebookObservations([marking({ result: { attempted: false } })])).toEqual([]);
  });

  it("moves a mastery estimate, but less than a marked exam answer would", () => {
    const notebook = notebookObservations([marking({ result: { attempted: true, counted: true, awardedMarks: 0, maxMarks: 4 } })]);
    // The same answer, reconsidered as if a real paper had asked it: the only
    // thing that changes is where it came from.
    const asExamAnswer = notebook.map((observation) => ({
      ...observation,
      kind: "past-paper" as const,
    }));
    const neutral = masteryScore([], NOW);
    expect(masteryScore(notebook, NOW)).toBeLessThan(neutral);
    expect(masteryScore(notebook, NOW)).toBeGreaterThan(masteryScore(asExamAnswer, NOW));
  });
});
