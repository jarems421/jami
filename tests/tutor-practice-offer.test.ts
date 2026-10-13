import { describe, expect, it } from "vitest";
import { buildLearnerProfile } from "@/lib/learning/profile/build-learner-profile";
import { buildStudyActions } from "@/lib/learning/actions/study-actions";
import {
  materialTopicKeys,
  practiceActionForMaterial,
} from "@/lib/learning/actions/practice-for-material";
import type { PastPaperEvidenceAttempt } from "@/lib/learning/profile/past-paper-signals";
import type { LearnerEvidence } from "@/lib/learning/profile/build-learner-profile";
import { describeStudyAction } from "@/lib/dashboard/today-plan";
import {
  buildTutorPracticeOffer,
  normalizeTutorPracticeOffer,
} from "@/lib/ai/tutor-practice-offer";
import { serializeLearnerProfileForTutor } from "@/lib/learning/serialize/tutor-context";

/**
 * Tutor offering the engine's own practice for the topic in front of the
 * student -- only when the student is struggling and exam questions are how
 * the engine would meet that, and only as the action Today would show.
 */

const NOW = Date.parse("2026-09-21T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const FOLDER = "f1";
const CTS = "spec:completing-the-square";

function examAnswers(count: number, conceptId: string, awardedMarks: number): PastPaperEvidenceAttempt[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a-${conceptId}-${index}`,
    questionId: `q-${conceptId}-${index}`,
    topicIds: [],
    conceptIds: [conceptId],
    attemptNumber: 1,
    markedAt: NOW - (index + 1) * DAY,
    updatedAt: NOW - (index + 1) * DAY,
    result: { attempted: true, counted: true, awardedMarks, maxMarks: 4 },
  }));
}

function evidence(partial: Partial<LearnerEvidence>): LearnerEvidence {
  return {
    cards: [],
    flashcardReviewEvents: [],
    pastPaperAttempts: [],
    practicePaperAttempts: [],
    topicLabels: {},
    concepts: [
      {
        key: CTS,
        label: "Completing the square",
        source: "specification",
        provenance: "verified_specification",
        verified: true,
        parentKey: "spec:algebra",
      },
    ],
    specification: { id: "8300", title: "AQA GCSE Mathematics", topics: [{ id: "algebra", label: "Algebra" }] },
    ...partial,
  };
}

function actionsFor(partial: Partial<LearnerEvidence>, history?: Parameters<typeof buildStudyActions>[2]) {
  const profile = buildLearnerProfile({ scope: { folderId: FOLDER }, evidence: evidence(partial), now: NOW });
  const actions = buildStudyActions(
    profile,
    { questionPracticeAvailable: true, canGenerate: { flashcards: true, practice: true } },
    history,
    NOW
  );
  return { profile, actions };
}

// A few exam answers gone wrong: too few to call, so the engine checks with exam questions.
const SUSPECTED = { pastPaperAttempts: examAnswers(3, "completing-the-square", 1) };

describe("where the material sits", () => {
  it("names a card by its Topics, or by its deck when it has none", () => {
    expect(materialTopicKeys({ topicIds: ["eigen"], deckId: "deck-1" })).toEqual(["topic:eigen"]);
    expect(materialTopicKeys({ topicIds: [], deckId: "deck-1" })).toEqual(["deck:deck-1"]);
  });

  it("names a past-paper question by its specification topics and concepts", () => {
    expect(materialTopicKeys({ specificationIds: ["algebra", "completing-the-square", "algebra"] })).toEqual([
      "spec:algebra",
      CTS,
    ]);
  });
});

describe("which advice Tutor offers", () => {
  it("offers exam questions on a topic the student may be struggling with", () => {
    const { actions } = actionsFor(SUSPECTED);
    const action = practiceActionForMaterial(actions, [CTS]);

    expect(action?.target).toMatchObject({ kind: "topic", topicKey: CTS });
    expect(action?.intervention?.type).toBe("past_paper");
    expect(action?.destination?.href).toBe(
      `/dashboard/practice/questions/new?folderId=${FOLDER}&concepts=completing-the-square`
    );
  });

  it("offers nothing about a topic the student does not have open", () => {
    const { actions } = actionsFor(SUSPECTED);
    expect(practiceActionForMaterial(actions, ["topic:something-else"])).toBeUndefined();
    expect(practiceActionForMaterial(actions, [])).toBeUndefined();
  });

  it("offers nothing the student has already turned down three times", () => {
    const { actions: fresh } = actionsFor(SUSPECTED);
    const id = practiceActionForMaterial(fresh, [CTS])?.id ?? "";
    const { actions } = actionsFor(
      SUSPECTED,
      new Map([[id, { dismissals: 3, lastDismissedAt: NOW - DAY, abandons: 0 }]])
    );
    expect(practiceActionForMaterial(actions, [CTS])).toBeUndefined();
  });

  it("offers practice on a student's own Topic they recall well but lose marks writing up", () => {
    const cards = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      deckId: "deck-1",
      topicIds: ["eigen"],
      reps: 6,
      lapses: 0,
      difficulty: 3,
      fsrsState: 2,
      stability: 60,
      lastReview: NOW - 2 * DAY,
      dueDate: NOW + 30 * DAY,
      createdAt: NOW - 90 * DAY,
    }));
    const flashcardReviewEvents = cards.flatMap((card, cardIndex) =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `r-${card.id}-${index}`,
        cardId: card.id,
        deckId: "deck-1",
        reviewedAt: NOW - (cardIndex * 3 + index + 1) * DAY,
        studyDayKey: "2026-09-10",
        correct: true,
        rating: "good" as const,
      }))
    );
    const notebookMarkings = Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`,
      notebookId: "nb",
      pageId: `p${index}`,
      topicKeys: ["topic:eigen"],
      itemId: `notebook:nb:p${index}`,
      markedAt: NOW - (index + 1) * DAY,
      result: { attempted: true, counted: true, awardedMarks: 1, maxMarks: 6 },
    }));
    const { actions } = actionsFor({
      cards,
      flashcardReviewEvents,
      notebookMarkings,
      topicLabels: { "topic:eigen": { label: "Eigenvectors", source: "student-topic" } },
    });
    const action = practiceActionForMaterial(actions, ["topic:eigen"]);

    expect(action?.action).toBe("practice");
    expect(action?.destination?.href).toBe(`/dashboard/folders/${FOLDER}?tab=practice`);
  });

  it("offers nothing for a topic that is going well", () => {
    const { actions } = actionsFor({ pastPaperAttempts: examAnswers(8, "completing-the-square", 4) });
    expect(practiceActionForMaterial(actions, [CTS])).toBeUndefined();
  });
});

describe("the offer as it travels", () => {
  function offerFor() {
    const { actions } = actionsFor(SUSPECTED);
    const action = practiceActionForMaterial(actions, [CTS]);
    if (!action) throw new Error("expected an action");
    const offer = buildTutorPracticeOffer(action, describeStudyAction(action));
    if (!offer) throw new Error("expected an offer");
    return { action, offer };
  }

  it("carries Today's own words and link, under the action's own id", () => {
    const { action, offer } = offerFor();
    expect(offer.actionId).toBe(action.id);
    expect(offer.title).toBe(describeStudyAction(action).title);
    expect(offer.href).toBe(action.destination?.href);
  });

  it("survives the trip to the browser intact", () => {
    const { offer } = offerFor();
    expect(normalizeTutorPracticeOffer(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
  });

  it("is dropped when it points outside the app or disagrees with its own id", () => {
    const { offer } = offerFor();
    expect(normalizeTutorPracticeOffer({ ...offer, href: "https://example.com" })).toBeUndefined();
    expect(normalizeTutorPracticeOffer({ ...offer, href: "//example.com/dashboard/" })).toBeUndefined();
    expect(
      normalizeTutorPracticeOffer({ ...offer, target: { ...offer.target, topicKey: "spec:other" } })
    ).toBeUndefined();
    expect(normalizeTutorPracticeOffer(null)).toBeUndefined();
  });
});

describe("what the model is told", () => {
  it("names the offered practice inside the learner data, quoted", () => {
    const { profile } = actionsFor(SUSPECTED);
    const text = serializeLearnerProfileForTutor(profile, {
      boundaryToken: "tok",
      practiceFocus: { label: "Completing the square", reason: "low_confidence", because: "suspected_gap" },
    });
    const inside = text?.split("--- BEGIN LEARNER DATA tok ---")[1]?.split("--- END LEARNER DATA tok ---")[0] ?? "";

    expect(inside).toContain('Practice offered under your answer: exam-style questions on "Completing the square"');
    expect(text).toContain("try the exam questions below");
  });

  it("says nothing about practice when none is offered", () => {
    const { profile } = actionsFor(SUSPECTED);
    const text = serializeLearnerProfileForTutor(profile, { boundaryToken: "tok" });
    expect(text).not.toContain("Practice offered");
    expect(text).not.toContain("try the exam questions below");
  });
});
