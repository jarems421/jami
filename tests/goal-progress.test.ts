import { describe, expect, it } from "vitest";
import { goalFromDraft, normalizeGoal, type Goal, type GoalDraft } from "@/lib/goals/model";
import {
  applyGoalEvent,
  applyTopicReading,
  getGoalStatusAtTime,
  goalAccuracy,
  goalAverageScore,
  goalCountsEvent,
  isGoalMet,
} from "@/lib/goals/progress";
import { getStudyDayStartFromKey, shiftStudyDayKey } from "@/lib/study/day";

const DAY = "2026-10-20";
const at = (dayKey: string, hours = 10) => getStudyDayStartFromKey(dayKey) + hours * 60 * 60 * 1000;
const NOW = at(DAY);

function goal(overrides: Partial<GoalDraft> = {}): Goal {
  return goalFromDraft(
    "g",
    {
      name: "",
      measure: "cards",
      cadence: "total",
      target: 3,
      days: 0,
      scope: { type: "all" },
      deadline: 0,
      ...overrides,
    },
    NOW - 1000
  );
}

const card = (correct = true, when = NOW, context: { deckId?: string; topicIds?: string[]; folderIds?: string[] } = {}) => ({
  kind: "card" as const,
  correct,
  at: when,
  ...context,
});

describe("flashcard goals", () => {
  it("count each review and finish at the target", () => {
    let current = goal();
    current = applyGoalEvent(current, card(true));
    current = applyGoalEvent(current, card(false));
    expect(current).toMatchObject({ status: "active", progress: { count: 2, correct: 1 } });
    current = applyGoalEvent(current, card(true, NOW + 5));
    expect(current.status).toBe("completed");
    expect(current.completedAt).toBe(NOW + 5);
    expect(goalAccuracy(current)).toBeCloseTo(2 / 3);
  });

  it("only count reviews from where they count", () => {
    const deckGoal = goal({ scope: { type: "deck", id: "deck-a" } });
    expect(applyGoalEvent(deckGoal, card(true, NOW, { deckId: "deck-b" }))).toBe(deckGoal);
    expect(applyGoalEvent(deckGoal, card(true, NOW, { deckId: "deck-a" })).progress.count).toBe(1);
    expect(goalCountsEvent(goal({ scope: { type: "topic", id: "t1" } }), card(true, NOW, { topicIds: ["t1"] }))).toBe(true);
    expect(goalCountsEvent(goal({ scope: { type: "folder", id: "f1" } }), card(true, NOW, { folderIds: ["f1"] }))).toBe(true);
    expect(goalCountsEvent(goal({ scope: { type: "folder", id: "f1" } }), card(true, NOW, { folderIds: ["f2"] }))).toBe(false);
  });

  it("are not moved by marked answers, and question goals are not moved by cards", () => {
    const questions = goal({ measure: "questions" });
    expect(applyGoalEvent(goal(), { kind: "question", score: 1, at: NOW })).toMatchObject({ progress: { count: 0 } });
    expect(applyGoalEvent(questions, card())).toBe(questions);
  });

  it("end, rather than count, once the deadline has passed", () => {
    const due = goal({ deadline: NOW + 10 });
    expect(applyGoalEvent(due, card(true, NOW + 11))).toMatchObject({ status: "failed", progress: { count: 0 } });
    expect(getGoalStatusAtTime(due, NOW + 11)).toBe("failed");
    expect(getGoalStatusAtTime(goal(), Number.MAX_SAFE_INTEGER)).toBe("active");
  });

  it("leave finished and ended goals alone", () => {
    const done = { ...goal(), status: "completed" as const };
    expect(applyGoalEvent(done, card())).toBe(done);
    expect(getGoalStatusAtTime({ ...goal(), status: "cancelled" }, NOW)).toBe("cancelled");
  });
});

describe("the oldest goals' accuracy condition", () => {
  const legacy = normalizeGoal("old", {
    targetCards: 2,
    targetAccuracy: 0.75,
    progress: { cardsCompleted: 1, correctAnswers: 1, totalAnswers: 1 },
    status: "active",
  });

  it("still has to be met alongside the count", () => {
    const missed = applyGoalEvent(legacy, card(false));
    expect(missed.progress.count).toBe(2);
    expect(missed.status).toBe("active");
    expect(isGoalMet(missed)).toBe(false);
    const met = applyGoalEvent(applyGoalEvent(missed, card(true)), card(true));
    expect(met.status).toBe("completed");
  });
});

describe("daily goals", () => {
  const daily = () => goal({ cadence: "daily", target: 2, days: 2 });

  it("hit a day when its amount is reached, once", () => {
    let current = daily();
    current = applyGoalEvent(current, card(true, at(DAY, 1)));
    current = applyGoalEvent(current, card(true, at(DAY, 2)));
    current = applyGoalEvent(current, card(true, at(DAY, 3)));
    expect(current.progress).toMatchObject({ dayKey: DAY, dayCount: 3, daysHit: 1, count: 3 });
    expect(current.status).toBe("active");
  });

  it("start each day from nothing, and finish on the last day hit", () => {
    const next = shiftStudyDayKey(DAY, 2);
    let current = daily();
    current = applyGoalEvent(applyGoalEvent(current, card(true, at(DAY))), card(true, at(DAY, 2)));
    current = applyGoalEvent(current, card(true, at(next)));
    expect(current.progress).toMatchObject({ dayKey: next, dayCount: 1, daysHit: 1 });
    current = applyGoalEvent(current, card(false, at(next, 2)));
    expect(current.status).toBe("completed");
  });

  it("count an answer synced late from an earlier day in the total, but not in today", () => {
    let current = applyGoalEvent(daily(), card(true, at(DAY)));
    current = applyGoalEvent(current, card(true, at(shiftStudyDayKey(DAY, -1))));
    expect(current.progress).toMatchObject({ dayKey: DAY, dayCount: 1, daysHit: 0, count: 2 });
  });
});

describe("practice-question goals", () => {
  it("count marked answers from their folder and keep the share of marks", () => {
    const folderGoal = goal({ measure: "questions", target: 2, scope: { type: "folder", id: "chem" } });
    expect(applyGoalEvent(folderGoal, { kind: "question", score: 1, at: NOW, folderId: "bio" })).toBe(folderGoal);
    let current = applyGoalEvent(folderGoal, { kind: "question", score: 0.5, at: NOW, folderId: "chem" });
    current = applyGoalEvent(current, { kind: "question", score: 1.4, at: NOW, folderId: "chem" });
    expect(current.status).toBe("completed");
    expect(goalAverageScore(current)).toBeCloseTo(0.75);
  });

  it("count from anywhere when they are not narrowed", () => {
    expect(goalCountsEvent(goal({ measure: "questions" }), { kind: "question", score: 1, at: NOW })).toBe(true);
  });
});

describe("topic goals", () => {
  const topicGoal = goal({
    measure: "topic",
    scope: { type: "folder", id: "bio", label: "Biology" },
    topic: { key: "topic:enzymes", label: "Enzymes" },
  });

  it("take the engine's reading and finish only on strong", () => {
    const developing = applyTopicReading(topicGoal, "developing", NOW);
    expect(developing).toMatchObject({ status: "active", progress: { demonstration: "developing", checkedAt: NOW } });
    expect(applyTopicReading(developing, "developing", NOW + 1)).toBe(developing);
    expect(applyTopicReading(developing, "strong", NOW + 2)).toMatchObject({ status: "completed", completedAt: NOW + 2 });
  });

  it("are never moved by work counted directly", () => {
    expect(applyGoalEvent(topicGoal, card())).toBe(topicGoal);
    expect(applyGoalEvent(topicGoal, { kind: "question", score: 1, at: NOW, folderId: "bio" })).toBe(topicGoal);
  });

  it("leave other kinds of goal alone", () => {
    const cards = goal();
    expect(applyTopicReading(cards, "strong", NOW)).toBe(cards);
  });
});
