import { describe, expect, it } from "vitest";
import { readTopicStandings, topicStandingsFromProfile } from "@/lib/goals/topic-standing";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import type { LearningDemonstration, LearningTopicState } from "@/lib/learning/types";

function state(
  topicKey: string,
  label: string,
  demonstration: LearningDemonstration,
  overrides: Partial<LearningTopicState> = {}
): LearningTopicState {
  return {
    topicKey,
    label,
    source: "student-topic",
    provenance: "student_defined",
    declared: true,
    exposure: { notebooks: 0, sources: 0, cards: 0 },
    demonstration,
    memory: [],
    ...overrides,
  };
}

function action(topicKey: string, href: string, reason: StudyAction["reason"] = "low_mastery"): StudyAction {
  const made: StudyAction = {
    id: `folder:f|${reason}|${topicKey}`,
    reason,
    action: "practice",
    priority: 5,
    target: { kind: "topic", topicKey, label: topicKey, source: "student-topic" },
    evidence: { count: 3, uniqueItems: 3, sources: ["practice"] },
    scope: { folderId: "f" },
    explanationCode: `${reason}.practice`,
    destination: { kind: "question-practice", href, selection: {} },
  };
  return made;
}

describe("topic standings for goals", () => {
  it("list the topics worth aiming at first, with the engine's own next step", () => {
    const standings = topicStandingsFromProfile(
      {
        topics: [
          state("topic:strong", "Atoms", "strong"),
          state("topic:weak", "Bonding", "weak"),
          state("topic:new", "Moles", "none"),
          state("topic:dev", "Rates", "developing"),
        ],
      },
      [action("topic:weak", "/dashboard/practice/questions/new?folderId=f")]
    );
    expect(standings.map((topic) => topic.key)).toEqual(["topic:weak", "topic:dev", "topic:new", "topic:strong"]);
    expect(standings[0]).toEqual({
      key: "topic:weak",
      label: "Bonding",
      demonstration: "weak",
      action: { label: "Practise", href: "/dashboard/practice/questions/new?folderId=f" },
    });
    expect(standings[1]?.action).toBeUndefined();
  });

  it("borrow the step of the broader topic a thin one defers to", () => {
    const [only] = topicStandingsFromProfile(
      { topics: [state("spec:a1", "Quadratics", "insufficient", { deferredTo: "spec:a" })] },
      [action("spec:a", "/dashboard/revision/new?action=x")]
    );
    expect(only?.action?.href).toBe("/dashboard/revision/new?action=x");
  });

  it("leave out topics nothing is known or held about", () => {
    const standings = topicStandingsFromProfile(
      {
        topics: [
          state("topic:ghost", "Ghost", "none", { declared: false }),
          state("topic:seen", "Seen", "none", { declared: false, exposure: { notebooks: 1, sources: 0, cards: 0 } }),
        ],
      },
      []
    );
    expect(standings.map((topic) => topic.key)).toEqual(["topic:seen"]);
  });
});

describe("reading standings back from the route", () => {
  it("keeps only well-formed entries and links inside the app", () => {
    expect(
      readTopicStandings([
        { key: "a", label: "A", demonstration: "weak", action: { label: "Go", href: "/dashboard/x" } },
        { key: "b", label: "B", demonstration: "brilliant" },
        { key: "c", label: "C", demonstration: "strong", action: { label: "Go", href: "https://example.com" } },
        null,
      ])
    ).toEqual([
      { key: "a", label: "A", demonstration: "weak", action: { label: "Go", href: "/dashboard/x" } },
      { key: "c", label: "C", demonstration: "strong" },
    ]);
    expect(readTopicStandings("nope")).toEqual([]);
  });
});
