import { describe, expect, it } from "vitest";
import { selectRecentResults } from "@/lib/learning/profile/recent-results";
import { serializeLearnerProfileForTutor } from "@/lib/learning/serialize/tutor-context";
import type {
  LearnerProfile,
  LearningObservation,
  LearningTopicState,
} from "@/lib/learning/types";

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 24 * 60 * 60 * 1000;

function observation(overrides: Partial<LearningObservation> & Pick<LearningObservation, "itemId" | "score" | "at">): LearningObservation {
  return {
    kind: "flashcards",
    evidenceId: `${overrides.itemId}-${overrides.at}`,
    topicKeys: ["topic:chem", "topic:moles"],
    weight: 1,
    count: 1,
    trendEligible: true,
    errorChecks: [],
    ...overrides,
  };
}

function topic(topicKey: string, label: string, parentKey?: string): LearningTopicState {
  return {
    topicKey,
    label,
    source: "student-topic",
    provenance: "student_defined",
    ...(parentKey ? { parentKey } : {}),
    declared: false,
    exposure: { notebooks: 0, sources: 0, cards: 0 },
    demonstration: "none",
    memory: [],
  };
}

const TOPICS = [topic("topic:chem", "Chemistry"), topic("topic:moles", "Moles", "topic:chem")];

describe("recent results", () => {
  it("lists what went wrong first, most often wrong first, then part marks, then right", () => {
    const results = selectRecentResults({
      now: NOW,
      topics: TOPICS,
      observations: [
        observation({ itemId: "card:right", score: 1, at: NOW - DAY }),
        observation({ itemId: "card:once", score: 0, at: NOW - DAY }),
        observation({ itemId: "card:often", score: 0, at: NOW - 3 * DAY }),
        observation({ itemId: "card:often", score: 0, at: NOW - 2 * DAY }),
        observation({ itemId: "card:often", score: 1, at: NOW - 5 * DAY }),
        observation({
          kind: "practice",
          itemId: "paper:p1:q2",
          score: 0.5,
          at: NOW - DAY,
          errorChecks: [
            { category: "missing_units", missed: true, detection: "marking-values" },
            { category: "missing_working", missed: false, detection: "criterion-wording" },
          ],
        }),
      ],
    });

    expect(results.map((result) => [result.itemId, result.outcome])).toEqual([
      ["card:often", "missed"],
      ["card:once", "missed"],
      ["paper:p1:q2", "partial"],
      ["card:right", "correct"],
    ]);
    expect(results[0]).toMatchObject({ attempts: 3, misses: 2, at: NOW - 2 * DAY, topicLabel: "Moles" });
    expect(results[2].missedErrors).toEqual(["missing_units"]);
  });

  it("keeps to the last three weeks and to answers with a date", () => {
    const results = selectRecentResults({
      now: NOW,
      topics: TOPICS,
      observations: [
        observation({ itemId: "card:old", score: 0, at: NOW - 30 * DAY }),
        // A card scored from its scheduler state, not an answer on a day.
        observation({ itemId: "card:aggregate", score: 0, at: NOW - DAY, trendEligible: false }),
      ],
    });
    expect(results).toEqual([]);
  });
});

describe("recent results for Tutor", () => {
  function profile(recentResults: LearnerProfile["recentResults"]): LearnerProfile {
    return {
      algorithmVersion: "test",
      generatedAt: NOW,
      scope: { folderId: "folder-1" },
      strengths: [],
      weaknesses: [],
      uncertain: [],
      improving: [],
      topics: [],
      recurringErrors: [],
      recentTrend: "unknown",
      recommendedFocus: [],
      recentResults,
      evidenceSummary: { flashcardReviews: 4, flashcardReviewEvents: 4, practiceAttempts: 1, pastPaperAttempts: 1, notebookMarkings: 0, revisionAnswers: 0, tutorChecks: 0 },
      diagnostics: { observations: 4, droppedObservations: 0, topicSignals: 0, limitsReached: [], unavailableSources: [] },
    };
  }

  it("names the card or question when it can, and only the topic when it cannot", () => {
    const text = serializeLearnerProfileForTutor(
      profile([
        {
          kind: "flashcards", itemId: "card:a", topicLabel: "Moles", outcome: "missed", score: 0,
          at: NOW - 2 * DAY, attempts: 3, misses: 2, missedErrors: [],
        },
        {
          kind: "past-paper", itemId: "exam:q9", topicLabel: "Algebra: graphs", outcome: "partial", score: 0.25,
          at: NOW - DAY, attempts: 1, misses: 1, missedErrors: ["insufficient_justification"],
        },
        {
          kind: "practice", itemId: "paper:p:q", outcome: "correct", score: 1, at: NOW, attempts: 1, misses: 0,
          missedErrors: [],
        },
      ]),
      {
        boundaryToken: "t",
        recentItemText: new Map([
          ["card:a", "What is the limiting reagent?"],
          ["paper:p:q", "Calculate the moles in 5 g of NaCl."],
        ]),
      }
    );
    expect(text).toContain("Recent results, item by item, wrong answers first:");
    expect(text).toContain(
      '- Wrong: flashcard "What is the limiting reagent?" on "Moles", 2 days ago; wrong 2 of 3 times in the last three weeks'
    );
    expect(text).toContain(
      '- Part marks (25%): past-paper question on "Algebra: graphs", yesterday; lost marks for not justifying the answer or stating the conclusion'
    );
    expect(text).toContain('- Right: practice-paper question "Calculate the moles in 5 g of NaCl.", today');
    expect(text).toContain("target those");
  });

  it("is worth including on its own, before any topic has enough evidence", () => {
    expect(serializeLearnerProfileForTutor(profile([]), { boundaryToken: "t" })).toBeUndefined();
    expect(
      serializeLearnerProfileForTutor(
        profile([{ kind: "flashcards", itemId: "card:a", outcome: "missed", score: 0, at: NOW, attempts: 1, misses: 1, missedErrors: [] }]),
        { boundaryToken: "t" }
      )
    ).toContain("- Wrong: flashcard, today");
  });
});
