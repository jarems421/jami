import { describe, expect, it } from "vitest";
import {
  LEGACY_UNREACHABLE_ACCURACY,
  applyGoalEdit,
  defaultGoalName,
  getGoalDisplayName,
  goalDocument,
  goalDraftProblem,
  goalEditFields,
  goalFromDraft,
  goalProgressFields,
  goalStarEffort,
  goalStarGlow,
  goalStarLabel,
  goalToDraft,
  normalizeGoal,
  type GoalDraft,
} from "@/lib/goals/model";
import { endOfStudyDay } from "@/lib/goals/deadlines";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";

const NOW = Date.UTC(2026, 9, 20, 12);
const TODAY = getStudyDayKey(NOW);

function draft(overrides: Partial<GoalDraft> = {}): GoalDraft {
  return {
    name: "",
    measure: "cards",
    cadence: "total",
    target: 40,
    days: 0,
    scope: { type: "all" },
    deadline: endOfStudyDay(shiftStudyDayKey(TODAY, 5)),
    ...overrides,
  };
}

describe("goals from before kinds", () => {
  const legacy = normalizeGoal("old", {
    name: "Biology review",
    scope: { type: "deck", id: "deck-a", label: "Biology" },
    targetCards: 20,
    targetAccuracy: 0.8,
    deadline: 5_000,
    progress: { cardsCompleted: 12, correctAnswers: 9, totalAnswers: 12 },
    status: "active",
    createdAt: 10,
  });

  it("read as flashcard totals that keep their accuracy condition", () => {
    expect(legacy).toMatchObject({
      schemaVersion: 1,
      measure: "cards",
      cadence: "total",
      target: 20,
      accuracyGate: 0.8,
      progress: { count: 12, correct: 9, answered: 12 },
    });
  });

  it("write their progress back into the fields they were stored with", () => {
    expect(goalProgressFields({ ...legacy, progress: { ...legacy.progress, count: 13, correct: 10, answered: 13 } })).toEqual({
      progress: { cardsCompleted: 13, correctAnswers: 10, totalAnswers: 13 },
      status: "active",
    });
  });

  it("are named for their card count when they never had a name", () => {
    expect(normalizeGoal("x", { targetCards: 15 }).name).toBe("Review 15 cards");
  });

  it("keep their star exactly as it was: sized by cards, glowing by accuracy", () => {
    expect(goalStarEffort(legacy)).toBe(20);
    expect(goalStarGlow(legacy)).toBe(0.8);
  });

  it("edit only the fields an old copy of the app understands", () => {
    expect(goalEditFields(legacy, { name: "", target: 30, days: 0, deadline: 0 })).toEqual({
      name: "Review 30 cards",
      targetCards: 30,
      deadline: 0,
    });
  });
});

describe("new goal documents", () => {
  it("carry everything a goal needs, with nothing counted yet", () => {
    const stored = goalDocument(draft({ measure: "questions", target: 12, scope: { type: "folder", id: "f1", label: "Chemistry" } }), NOW);
    expect(stored).toMatchObject({
      schemaVersion: 2,
      name: "Answer 12 practice questions",
      measure: "questions",
      cadence: "total",
      target: 12,
      days: 0,
      scope: { type: "folder", id: "f1", label: "Chemistry" },
      progress: { count: 0, answered: 0, correct: 0, scoreSum: 0, dayCount: 0, daysHit: 0 },
      status: "active",
      createdAt: NOW,
    });
  });

  it("can never be finished by a copy of the app from before kinds", () => {
    // An old copy finishes a goal when cardsCompleted >= targetCards and
    // accuracy >= targetAccuracy. No accuracy reaches two.
    const stored = goalDocument(draft(), NOW);
    expect(stored.targetAccuracy).toBe(LEGACY_UNREACHABLE_ACCURACY);
    expect(stored.targetAccuracy).toBeGreaterThan(1);
    expect(stored.targetCards).toBe(40);
  });

  it("read back the same as they were written", () => {
    const goal = goalFromDraft("g1", draft({ cadence: "daily", target: 20, days: 5, deadline: 0 }), NOW);
    expect(goal).toMatchObject({ id: "g1", schemaVersion: 2, cadence: "daily", target: 20, days: 5, accuracyGate: 0 });
    expect(goalToDraft(goal)).toMatchObject({ measure: "cards", cadence: "daily", target: 20, days: 5, deadline: 0 });
  });

  it("keep only a topic for topic goals, and a topic goal has nothing to count to", () => {
    const stored = goalDocument(
      draft({
        measure: "topic",
        cadence: "daily",
        target: 50,
        scope: { type: "folder", id: "f1", label: "Biology" },
        topic: { key: "topic:enzymes", label: "Enzymes" },
      }),
      NOW
    );
    expect(stored).toMatchObject({ cadence: "total", target: 1, days: 0, topic: { key: "topic:enzymes", label: "Enzymes" } });
    expect(stored.name).toBe("Get Enzymes to strong");
  });

  it("drops a malformed exam link rather than trusting it", () => {
    const goal = normalizeGoal("g", { schemaVersion: 2, measure: "cards", target: 5, exam: { planId: "p", examId: "e", label: "Mock", dayKey: "soon" } });
    expect(goal.exam).toBeUndefined();
  });
});

describe("names and stars", () => {
  it("names a goal for what it counts", () => {
    expect(defaultGoalName({ measure: "cards", cadence: "total", target: 1 })).toBe("Review 1 card");
    expect(defaultGoalName({ measure: "cards", cadence: "daily", target: 20 })).toBe("20 cards a day");
    expect(defaultGoalName({ measure: "questions", cadence: "daily", target: 3 })).toBe("3 practice questions a day");
    expect(getGoalDisplayName({ name: "  ", measure: "questions", cadence: "total", target: 8 })).toBe("Answer 8 practice questions");
  });

  it("sizes a star by the work behind it, so a bigger goal earns a bigger star", () => {
    const small = goalStarEffort({ measure: "cards", cadence: "total", target: 10, days: 0 });
    const habit = goalStarEffort({ measure: "cards", cadence: "daily", target: 10, days: 5 });
    const questions = goalStarEffort({ measure: "questions", cadence: "total", target: 10, days: 0 });
    expect(habit).toBe(50);
    expect(questions).toBeGreaterThan(small);
    expect(goalStarEffort({ measure: "topic", cadence: "total", target: 1, days: 0 })).toBeGreaterThan(questions);
  });

  it("says what a star in the sky was earned for", () => {
    expect(goalStarLabel({ measure: "cards", cadence: "total", target: 20, days: 0 })).toBe("Earned for a 20-card goal");
    expect(goalStarLabel({ measure: "questions", cadence: "daily", target: 3, days: 5 })).toBe(
      "Earned for 3 questions a day on 5 days"
    );
    expect(goalStarLabel({ measure: "topic", cadence: "total", target: 1, days: 0, topic: { key: "k", label: "Waves" } })).toBe(
      "Earned for getting Waves to strong"
    );
  });
});

describe("what makes a draft savable", () => {
  it("accepts a ready draft", () => {
    expect(goalDraftProblem(draft(), NOW)).toBeNull();
  });

  it("asks for an amount, within the limit for its kind", () => {
    expect(goalDraftProblem(draft({ target: 0 }), NOW)).toBe("Choose how many.");
    expect(goalDraftProblem(draft({ measure: "questions", target: 501 }), NOW)).toMatch(/500 or fewer/);
  });

  it("keeps practice questions to everything or one folder", () => {
    expect(goalDraftProblem(draft({ measure: "questions", scope: { type: "deck", id: "d1" } }), NOW)).toMatch(/one folder/);
  });

  it("needs a folder and a topic for a topic goal", () => {
    expect(goalDraftProblem(draft({ measure: "topic", scope: { type: "all" } }), NOW)).toBe("Choose the folder the topic is in.");
    expect(goalDraftProblem(draft({ measure: "topic", scope: { type: "folder", id: "f1" } }), NOW)).toBe("Choose a topic.");
  });

  it("refuses a deadline that has passed", () => {
    expect(goalDraftProblem(draft({ deadline: NOW - 1 }), NOW)).toMatch(/has not passed/);
  });

  it("refuses a daily goal whose days cannot fit before its deadline", () => {
    const tomorrow = endOfStudyDay(shiftStudyDayKey(TODAY, 1));
    expect(goalDraftProblem(draft({ cadence: "daily", target: 10, days: 5, deadline: tomorrow }), NOW)).toBe(
      "There are only 2 days before the deadline."
    );
  });

  it("lets a habit already under way be edited when the days it still needs fit", () => {
    const tomorrow = endOfStudyDay(shiftStudyDayKey(TODAY, 1));
    const underWay = draft({ cadence: "daily", target: 10, days: 5, deadline: tomorrow });
    expect(goalDraftProblem(underWay, NOW, 3)).toBeNull();
    expect(goalDraftProblem(underWay, NOW, 2)).toBe("There are only 2 days before the deadline.");
  });
});

describe("editing a running goal", () => {
  const goal = goalFromDraft(
    "g",
    draft({ exam: { planId: "p", examId: "e1", label: "Paper 1", dayKey: shiftStudyDayKey(TODAY, 9) } }),
    NOW
  );

  it("changes how much and by when, and keeps the progress", () => {
    const counted = { ...goal, progress: { ...goal.progress, count: 7 } };
    const edited = applyGoalEdit(counted, { name: "Big push", target: 60, days: 0, deadline: 0 });
    expect(edited).toMatchObject({ name: "Big push", target: 60, deadline: 0, progress: { count: 7 } });
    expect(edited.exam).toEqual(goal.exam);
  });

  it("can drop the exam it was set for", () => {
    const edited = applyGoalEdit(goal, { name: "", target: 40, days: 0, deadline: 0, exam: null });
    expect(edited.exam).toBeUndefined();
    expect(goalEditFields(goal, { name: "", target: 40, days: 0, deadline: 0, exam: null })).toMatchObject({ exam: null });
  });
});
