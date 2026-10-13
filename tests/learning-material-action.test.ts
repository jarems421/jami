import { describe, expect, it } from "vitest";
import { materialConcepts, pickMaterialAction } from "@/lib/learning/actions/material-action";
import { placeNotebookPage } from "@/lib/learning/notebook-page-context";
import type { LearnerProfile, LearningTopicDecision, LearningTopicState } from "@/lib/learning/types";

/**
 * The engine's starting point for the material open in front of a student.
 *
 * Read from the engine's own decision, never made here: a concept left alone
 * or undecided gets none, and the page keeps its ordinary starting points.
 */

function state(topicKey: string, decision?: LearningTopicDecision, deferredTo?: string) {
  return {
    topicKey,
    label: topicKey.slice(topicKey.indexOf(":") + 1),
    ...(decision ? { decision } : {}),
    ...(deferredTo ? { deferredTo } : {}),
  } as LearningTopicState;
}

function profile(
  topics: LearningTopicState[],
  recommendedFocus: LearnerProfile["recommendedFocus"] = []
): Pick<LearnerProfile, "topics" | "recommendedFocus"> {
  return { topics, recommendedFocus };
}

/** The engine's starting point for material on these concepts, as the notebook reads it. */
function actionFor(value: Pick<LearnerProfile, "topics" | "recommendedFocus">, keys: string[]) {
  return pickMaterialAction(materialConcepts(value), keys);
}

describe("the engine's starting point for open material", () => {
  it.each([
    [{ action: "diagnose", reason: "untested_exposure" }, "quick-check"],
    [{ action: "diagnose", reason: "low_confidence" }, "quick-check"],
    [{ action: "teach", reason: "low_mastery" }, "teach"],
    [{ action: "practice", reason: "low_mastery" }, "exam-question"],
    [{ action: "practice", reason: "declining_mastery" }, "exam-question"],
    [{ action: "retrieve", reason: "knowledge_decay" }, "recall"],
    [{ action: "retrieve", reason: "due_for_retrieval" }, "recall"],
    [{ action: "reinforce", reason: "recent_improvement_needs_reinforcement" }, "harder"],
  ] as const)("reads %o as %s", (decision, kind) => {
    expect(actionFor(profile([state("topic:eigen", decision)]), ["topic:eigen"])?.kind).toBe(kind);
  });

  it("offers nothing for a concept the engine would leave alone, or has no decision on", () => {
    expect(
      actionFor(profile([state("topic:eigen", { action: "leave_alone", reason: "stable_strength" })]), [
        "topic:eigen",
      ])
    ).toBeUndefined();
    expect(actionFor(profile([state("topic:eigen")]), ["topic:eigen"])).toBeUndefined();
    expect(actionFor(profile([]), ["topic:eigen"])).toBeUndefined();
  });

  it("uses the broader concept's decision when the page's concept defers to it", () => {
    const action = actionFor(
      profile([
        state("spec:quadratics", undefined, "spec:algebra"),
        state("spec:algebra", { action: "diagnose", reason: "untested_exposure" }),
      ]),
      ["spec:quadratics"]
    );
    expect(action).toEqual({ kind: "quick-check", topicKey: "spec:algebra", label: "algebra" });
  });

  it("takes the concept the engine ranks highest when the page has several", () => {
    const action = actionFor(
      profile(
        [
          state("topic:a", { action: "diagnose", reason: "untested_exposure" }),
          state("topic:b", { action: "practice", reason: "low_mastery" }),
        ],
        [
          {
            reason: "low_mastery",
            action: "practice",
            priority: 6,
            target: { kind: "topic", topicKey: "topic:b", label: "b", source: "student-topic" },
            evidence: { count: 6, uniqueItems: 6, sources: ["notebook"] },
          },
        ]
      ),
      ["topic:a", "topic:b"]
    );
    expect(action?.topicKey).toBe("topic:b");
    expect(action?.kind).toBe("exam-question");
  });
});

describe("placing a page from its notebook's view", () => {
  const view = {
    notebookTopicIds: ["algebra"],
    linkedQuestions: {
      p4: { kind: "practice-paper" as const, paperId: "paper-1", questionId: "q4", specificationIds: ["cts"] },
    },
    concepts: materialConcepts(
      profile([
        state("topic:algebra", { action: "diagnose", reason: "untested_exposure" }),
        state("topic:eigen", { action: "retrieve", reason: "knowledge_decay" }),
        state("spec:cts", { action: "practice", reason: "low_mastery" }),
      ])
    ),
  };

  it("places each page with the same resolver as its markings, asking nothing", () => {
    expect(placeNotebookPage(view, "nb-1", { id: "p1" })).toEqual({
      attribution: "notebook-topics",
      concepts: [{ key: "topic:algebra", label: "algebra" }],
      action: { kind: "quick-check", topicKey: "topic:algebra", label: "algebra" },
    });
    expect(placeNotebookPage(view, "nb-1", { id: "p2", topicIds: ["eigen"] }).action?.kind).toBe("recall");
    expect(placeNotebookPage(view, "nb-1", { id: "p4", topicIds: ["eigen"] })).toMatchObject({
      attribution: "linked-question",
      action: { kind: "exam-question" },
    });
  });

  it("keeps only the concepts asked for, so a notebook is not sent the whole course", () => {
    const concepts = materialConcepts(
      profile([state("topic:eigen"), state("spec:cts"), state("spec:unrelated")]),
      (key) => key.startsWith("topic:") || key === "spec:cts"
    );
    expect(Object.keys(concepts).sort()).toEqual(["spec:cts", "topic:eigen"]);
  });
});
