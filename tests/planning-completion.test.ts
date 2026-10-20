import { describe, expect, it } from "vitest";
import {
  buildPlanCompletionEvidence,
  planDayCompletion,
  type PlanCompletionCard,
} from "@/lib/planning/plan-completion";
import { MONDAY, TUESDAY, planActivity } from "./support/plan-fixtures";

/**
 * A planned task is done when its own work was done -- not when something
 * happened in the same subject. The bug this replaced: reviewing any Biology
 * card ticked "10 homeostasis exam questions".
 */

const decks = [
  { id: "bio-deck", folderIds: ["biology"] },
  { id: "homeostasis-deck", folderIds: ["biology"] },
  { id: "chem-deck", folderIds: ["chemistry"] },
];

const REVIEWED = 1_000;

function cards(count: number, deckId: string, reviewed: number, topicIds?: string[]): PlanCompletionCard[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${deckId}-${index}`,
    deckId,
    ...(topicIds ? { topicIds } : {}),
    ...(index < reviewed ? { lastReview: REVIEWED } : {}),
  }));
}

function evidence(allCards: PlanCompletionCard[], completed: Record<string, string[]> = {}) {
  return buildPlanCompletionEvidence({
    cards: allCards,
    decks,
    reviewDayKey: TUESDAY,
    dayOf: (timestamp) => (timestamp === REVIEWED ? TUESDAY : MONDAY),
    completedActionIds: new Map(Object.entries(completed).map(([day, ids]) => [day, new Set(ids)])),
  });
}

describe("what reviewing cards completes", () => {
  it("never ticks an exam-question task, however many cards in its subject were reviewed", () => {
    const questions = planActivity({ id: "q", title: "Homeostasis", method: "practice", targetItems: 10 });
    const review = planActivity({ id: "r", title: "Review your cards", method: "flashcards" });
    const done = planDayCompletion(TUESDAY, [questions, review], {}, evidence(cards(30, "bio-deck", 30)));
    expect(done.has("q")).toBe(false);
    expect(done.get("r")).toMatchObject({ by: "activity", observed: true });
  });

  it("never ticks another subject's cards, or a task the student wrote", () => {
    const biology = planActivity({ id: "bio", method: "flashcards" });
    const own = planActivity({ id: "own", title: "Redo question 3", method: "other" });
    const done = planDayCompletion(TUESDAY, [biology, own], {}, evidence(cards(30, "chem-deck", 30)));
    expect(done.size).toBe(0);
  });

  it("ticks a topic's task only from that topic's cards", () => {
    const topicTask = planActivity({
      id: "t",
      method: "flashcards",
      topic: { kind: "topic", id: "homeostasis", label: "Homeostasis" },
    });
    const otherCards = evidence(cards(20, "bio-deck", 20));
    expect(planDayCompletion(TUESDAY, [topicTask], {}, otherCards).has("t")).toBe(false);
    const ownCards = evidence(cards(12, "homeostasis-deck", 10, ["homeostasis"]));
    expect(planDayCompletion(TUESDAY, [topicTask], {}, ownCards).has("t")).toBe(true);
  });

  it("finishes a short deck after all of it, not never", () => {
    const task = planActivity({ id: "d", method: "flashcards", topic: { kind: "deck", id: "chem-deck", label: "Bonding" } });
    expect(planDayCompletion(TUESDAY, [task], {}, evidence(cards(6, "chem-deck", 6))).has("d")).toBe(true);
    expect(planDayCompletion(TUESDAY, [task], {}, evidence(cards(6, "chem-deck", 5))).has("d")).toBe(false);
  });

  it("shares reviews out rather than counting them twice", () => {
    const first = planActivity({ id: "a", method: "flashcards", targetItems: 20 });
    const second = planActivity({ id: "b", method: "flashcards", targetItems: 20 });
    const done = planDayCompletion(TUESDAY, [first, second], {}, evidence(cards(40, "bio-deck", 20)));
    expect([...done.keys()]).toEqual(["a"]);
  });

  it("reads card reviews only for the day they are known for", () => {
    // A card keeps only its latest review, so reading Monday from it would
    // un-tick Monday's work the moment the same cards were seen again.
    const task = planActivity({ id: "r", method: "flashcards" });
    expect(planDayCompletion(MONDAY, [task], {}, evidence(cards(30, "bio-deck", 30))).size).toBe(0);
  });
});

describe("what finishing a session completes", () => {
  it("ticks exactly the task it was opened from, on any day it is known for", () => {
    const opened = planActivity({ id: "q", actionId: "folder:biology|low_mastery|topic:homeostasis" });
    const other = planActivity({ id: "o", actionId: "folder:biology|low_mastery|topic:enzymes" });
    const done = planDayCompletion(
      MONDAY,
      [opened, other],
      {},
      evidence([], { [MONDAY]: ["folder:biology|low_mastery|topic:homeostasis"] })
    );
    expect([...done.keys()]).toEqual(["q"]);
  });

  it("keeps what was written down, and never ticks a free session", () => {
    const open = { ...planActivity({ id: "free" }), title: "", open: true };
    const done = planDayCompletion(
      TUESDAY,
      [planActivity({ id: "a" }), open],
      { a: { by: "manual", at: 3 }, free: { by: "manual", at: 3 } },
      undefined
    );
    expect([...done.entries()]).toEqual([["a", { by: "manual", at: 3 }]]);
  });
});
