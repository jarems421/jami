import { describe, expect, it } from "vitest";
import type { Goal } from "@/lib/goals/model";
import { planActivityGoal } from "@/lib/planning/plan-goals";
import { planActivity } from "./support/plan-fixtures";

/** Which running goal a planned task moves: only by the work that goal counts. */

function goal(overrides: Partial<Goal> & Pick<Goal, "measure" | "scope">): Goal {
  return { id: `${overrides.measure}-${overrides.scope.type}`, status: "active", name: "", ...overrides } as Goal;
}

const cardsInBiology = goal({ measure: "cards", scope: { type: "folder", id: "biology" } });
const questionsAnywhere = goal({ measure: "questions", scope: { type: "all" } });
const homeostasisTopic = goal({ measure: "topic", scope: { type: "topic", id: "t-homeo" }, topic: { key: "topic:t-homeo", label: "Homeostasis" } });

describe("the goal a planned task moves", () => {
  it("is a card goal for flashcards in its scope, and a question goal for practice", () => {
    const goals = [cardsInBiology, questionsAnywhere];
    expect(planActivityGoal(planActivity({ id: "f", method: "flashcards" }), goals)).toBe(cardsInBiology);
    expect(planActivityGoal(planActivity({ id: "p", method: "practice" }), goals)).toBe(questionsAnywhere);
    // Chemistry cards do not move a Biology card goal.
    expect(planActivityGoal(planActivity({ id: "c", method: "flashcards", scopeKey: "folder:chemistry" }), [cardsInBiology])).toBeUndefined();
  });

  it("is a topic goal for any work on that topic", () => {
    const task = planActivity({ id: "n", method: "notes", topic: { kind: "topic", id: "t-homeo", label: "Homeostasis" } });
    expect(planActivityGoal(task, [homeostasisTopic])).toBe(homeostasisTopic);
  });

  it("is nothing for the student's own task, a free session, or a goal that has ended", () => {
    expect(planActivityGoal(planActivity({ id: "o", method: "other" }), [cardsInBiology, questionsAnywhere])).toBeUndefined();
    expect(planActivityGoal({ ...planActivity({ id: "f", method: "flashcards" }), open: true }, [cardsInBiology])).toBeUndefined();
    expect(planActivityGoal(planActivity({ id: "f", method: "flashcards" }), [{ ...cardsInBiology, status: "completed" }])).toBeUndefined();
  });
});
