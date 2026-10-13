import { describe, expect, it } from "vitest";
import { advanceRevisionSession, createRevisionSteps } from "@/lib/revision/session-machine";
import type { RevisionLesson, RevisionSessionRecord, RevisionTask } from "@/lib/revision/types";
import { projectRevisionSession, type RevisionStepView } from "@/lib/revision/view";
import {
  buildRevisionLessonInstruction,
  buildRevisionQuestionInstruction,
  buildRevisionRetryInstruction,
  describeCourseMaterial,
} from "@/services/ai/revision-session.server";

const task = (answer: string, hint: string): RevisionTask => ({
  prompt: `Write x^2 + 8x + 3 in completed-square form (${answer.length})`,
  hint,
  answer,
  markScheme: ["Correct bracket", "Correct constant"],
  solution: "Half of 8 is 4, so (x + 4)^2 - 16 + 3.",
});

const lesson: RevisionLesson = {
  goals: ["Complete the square", "Solve with it", "Spot when to use it"],
  orientation: "It turns a quadratic into something you can read.",
  explanation: {
    body: "Rewrite $x^2 + bx$ as $(x + b/2)^2 - (b/2)^2$.",
    example: { problem: "$x^2 + 6x + 5$", steps: ["Half of 6 is 3", "$(x+3)^2 - 4$"] },
  },
  guided: task("(x + 4)^2 - 13", "Halve the coefficient of x first."),
  independent: task("(x + 5)^2 - 28", "Same again."),
  apply: task("x = -5 ± 2√7", "Set it to zero."),
  retrieve: task("Halve b, square it, subtract", "Think of the example."),
};

function record(): RevisionSessionRecord {
  return {
    id: "s1",
    schemaVersion: 1,
    policy: "teach",
    status: "active",
    target: { topicKey: "topic:q", source: "student-topic", conceptLabel: "Completing the square", folderId: "f1" },
    why: [],
    lesson,
    steps: createRevisionSteps("teach"),
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** The session moved on to its guided question, unanswered. */
function onGuided(): RevisionStepView {
  let current = record();
  for (let index = 0; index < 2; index += 1) {
    const moved = advanceRevisionSession(current, { type: "continue" });
    if (!moved.ok) throw new Error("refused");
    current = { ...current, steps: moved.steps, position: moved.position };
  }
  const step = projectRevisionSession(current).step;
  if (!step || step.kind !== "guided") throw new Error(`expected the guided step, got ${step?.kind}`);
  return step;
}

const context = { conceptLabel: "Completing the square", course: "AQA GCSE Mathematics" };

describe("a question asked mid-session", () => {
  it("is asked with what is on screen, never an answer or hint the student has not unlocked", () => {
    const instruction = buildRevisionQuestionInstruction({ context, step: onGuided() });
    expect(instruction).toContain("Write x^2 + 8x + 3 in completed-square form");
    expect(instruction).not.toContain("(x + 4)^2 - 13");
    expect(instruction).not.toContain("Halve the coefficient of x first.");
    expect(instruction).toContain("never give its answer");
  });

  it("may talk about the answer once the step is over", () => {
    const step = onGuided();
    if (step.kind === "orient" || step.kind === "explain") throw new Error("expected a task");
    const finished: RevisionStepView = {
      ...step,
      outcome: { skipped: false, selfGraded: false, answer: "(x + 4)^2 - 13", solution: "Worked." },
    };
    const instruction = buildRevisionQuestionInstruction({ context, step: finished });
    expect(instruction).toContain("(x + 4)^2 - 13");
    expect(instruction).not.toContain("never give its answer");
  });
});

describe("teaching from the student's own material", () => {
  const material = [
    { title: "Lecture 3 - Quadratics", location: "page 4", text: "We write a(x - p)^2 + q, with p the turning point." },
  ];

  it("says nothing when the folder has none, so a lesson is written as it always was", () => {
    expect(describeCourseMaterial(context)).toBe("");
    expect(buildRevisionLessonInstruction(context)).not.toContain("UNTRUSTED MATERIAL");
  });

  it("puts the passages inside their own untrusted markers, for the lesson, the retry and a question", () => {
    const grounded = { ...context, material };
    const described = describeCourseMaterial(grounded);
    const begin = described.indexOf("--- BEGIN UNTRUSTED MATERIAL");
    const end = described.indexOf("--- END UNTRUSTED MATERIAL");
    expect(begin).toBeGreaterThan(-1);
    expect(described.indexOf("a(x - p)^2 + q")).toBeGreaterThan(begin);
    expect(described.indexOf("a(x - p)^2 + q")).toBeLessThan(end);
    expect(described).toContain("\"Lecture 3 - Quadratics\" (page 4)");
    expect(described).toContain("Never copy their sentences or questions");

    expect(buildRevisionLessonInstruction(grounded)).toContain("a(x - p)^2 + q");
    expect(buildRevisionRetryInstruction({ context: grounded, lesson })).toContain("a(x - p)^2 + q");
    expect(buildRevisionQuestionInstruction({ context: grounded, step: onGuided() })).toContain("a(x - p)^2 + q");
  });
});
