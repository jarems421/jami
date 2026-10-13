import { describe, expect, it } from "vitest";
import {
  buildLearnerProfile,
  type LearnerEvidence,
} from "@/lib/learning/profile/build-learner-profile";
import type { FlashcardEvidenceCard } from "@/lib/learning/profile/flashcard-signals";
import type { FlashcardReviewEvent } from "@/lib/learning/events/flashcard-review-event";
import type { PastPaperEvidenceAttempt } from "@/lib/learning/profile/past-paper-signals";
import type { PracticePaperEvidenceAttempt } from "@/lib/learning/profile/practice-signals";
import type { NotebookMarkedWorking } from "@/lib/learning/profile/notebook-signals";

/**
 * Four surfaces, one learner, and evidence that disagrees.
 *
 * This is the end of the road P0 and P1 were built for. A student drills
 * "Quadratics" on flashcards and gets them right; sits generated practice on
 * completing the square and does middlingly; sits real exam questions on the
 * same concept and does badly; and has a notebook page on it marked poorly.
 *
 * Every one of those four streams used to land somewhere different -- two
 * unrelated concept namespaces, one with no concept at all, and one that was
 * not recorded. Now they meet, and the thing that must NOT happen is that they
 * average into a single number. "72% at quadratics" would be a worse answer
 * than any of the four pieces of evidence taken alone.
 *
 * What must happen instead: the broad Topic reads as the student's recall
 * looks, the specific concept reads as their application looks, and the two
 * numbers stay apart with their sources attached, so Jami can say which is
 * which.
 */

const NOW = Date.parse("2026-09-21T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const CONCEPT = "completing-the-square";

function card(id: string): FlashcardEvidenceCard {
  return {
    id,
    deckId: "deck-maths",
    topicIds: ["quadratics"],
    reps: 5,
    lapses: 0,
    difficulty: 3,
    fsrsState: 2,
    stability: 90,
    lastReview: NOW - 2 * DAY,
    dueDate: NOW + 40 * DAY,
    createdAt: NOW - 120 * DAY,
  } as FlashcardEvidenceCard;
}

/** Ten cards answered correctly: recall looks good. */
function flashcards() {
  const cards = Array.from({ length: 10 }, (_, index) => card(`c${index}`));
  const events: FlashcardReviewEvent[] = cards.map((entry, index) => ({
    id: `rev-${index}`,
    cardId: entry.id,
    deckId: "deck-maths",
    reviewedAt: NOW - (index + 1) * DAY,
    studyDayKey: "2026-09-12",
    correct: true,
    rating: "good",
  }));
  return { cards, events };
}

/** Five generated questions, roughly half marks: application looks shaky. */
function generatedPractice(): PracticePaperEvidenceAttempt {
  return {
    id: "practice-attempt-1",
    paperId: "paper-1",
    assisted: false,
    markedAt: NOW - 4 * DAY,
    updatedAt: NOW - 4 * DAY,
    questionResults: Array.from({ length: 5 }, (_, index) => ({
      questionId: `pq${index}`,
      attempted: true,
      counted: true,
      awardedMarks: 2,
      maxMarks: 4,
    })),
    conceptIdsByQuestion: Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`pq${index}`, [CONCEPT]])
    ),
  };
}

/** Three real exam questions, mostly wrong: application is genuinely weak. */
function pastPapers(): PastPaperEvidenceAttempt[] {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `exam-attempt-${index}`,
    questionId: `eq${index}`,
    topicIds: [],
    conceptIds: [CONCEPT],
    attemptNumber: 1,
    markedAt: NOW - (index + 2) * DAY,
    updatedAt: NOW - (index + 2) * DAY,
    result: { attempted: true, counted: true, awardedMarks: 1, maxMarks: 6 },
  })) as unknown as PastPaperEvidenceAttempt[];
}

/** One marked notebook page, also poor. */
function notebook(): NotebookMarkedWorking[] {
  return [
    {
      id: "marking-1",
      notebookId: "nb-1",
      pageId: "page-3",
      topicKeys: ["topic:quadratics"],
      itemId: "notebook:nb-1:page-3",
      markedAt: NOW - 3 * DAY,
      result: { attempted: true, counted: true, awardedMarks: 1, maxMarks: 5 },
    },
  ];
}

function evidence(): LearnerEvidence {
  const { cards, events } = flashcards();
  return {
    cards,
    flashcardReviewEvents: events,
    pastPaperAttempts: pastPapers(),
    practicePaperAttempts: [generatedPractice()],
    notebookMarkings: notebook(),
    topicLabels: { "topic:quadratics": { label: "Quadratics", source: "student-topic" } },
    concepts: [
      {
        key: `spec:${CONCEPT}`,
        label: "Completing the square",
        source: "specification",
        provenance: "verified_specification",
        verified: true,
        parentKey: "spec:algebra",
      },
    ],
    specification: { topics: [{ id: "algebra", label: "Algebra" }] },
    topicRelations: [
      {
        topicId: "quadratics",
        relation: { type: "covers", conceptIds: [CONCEPT], confirmedByOwner: true },
      },
    ],
  } as unknown as LearnerEvidence;
}

function profile() {
  return buildLearnerProfile({ scope: { folderId: "f1" }, evidence: evidence(), now: NOW });
}

describe("four surfaces, one learner", () => {
  it("brings every surface's evidence into one concept hierarchy", () => {
    const built = profile();
    const concept = built.topics.find((entry) => entry.topicKey === `spec:${CONCEPT}`);
    const topic = built.topics.find((entry) => entry.topicKey === "topic:quadratics");

    // The concept carries the two streams written against it.
    expect(concept?.signal?.evidence).toEqual(
      expect.arrayContaining(["practice", "past-paper"])
    );
    // The Topic carries its own, plus everything that rolled up.
    expect(topic?.signal?.evidence).toEqual(
      expect.arrayContaining(["flashcards", "notebook", "practice", "past-paper"])
    );
  });

  it("does not average four disagreeing sources into one number", () => {
    const built = profile();
    const concept = built.topics.find((entry) => entry.topicKey === `spec:${CONCEPT}`);
    const topic = built.topics.find((entry) => entry.topicKey === "topic:quadratics");

    const recall = topic?.signal?.evidenceMastery ?? 0;
    const application = concept?.signal?.evidenceMastery ?? 0;

    // The distinction survives: recall reads higher than application.
    expect(recall).toBeGreaterThan(application);
    // And by a margin worth saying out loud, not a rounding difference.
    expect(recall - application).toBeGreaterThan(0.1);
  });

  it("keeps generated practice and real exam evidence distinguishable", () => {
    const built = profile();
    const concept = built.topics.find((entry) => entry.topicKey === `spec:${CONCEPT}`);
    // Both are present and named, so a consumer can weigh them differently.
    expect(concept?.signal?.evidence).toContain("practice");
    expect(concept?.signal?.evidence).toContain("past-paper");
  });

  it("still does not let broad recall reach the specific concept", () => {
    const built = profile();
    const concept = built.topics.find((entry) => entry.topicKey === `spec:${CONCEPT}`);
    // Flashcards and notebook were tagged to the Topic, never to the concept.
    expect(concept?.signal?.evidence).not.toContain("flashcards");
    expect(concept?.signal?.evidence).not.toContain("notebook");
    // Five generated questions plus three exam answers. Not eighteen.
    expect(concept?.signal?.attempts).toBe(8);
  });

  it("acts on the weakness rather than the strength", () => {
    const built = profile();
    const targets = built.recommendedFocus.map((entry) =>
      entry.target.kind === "topic" ? entry.target.topicKey : null
    );
    expect(targets).toContain(`spec:${CONCEPT}`);
  });

  it("counts untagged generated practice towards no concept at all", () => {
    const untagged = evidence();
    const attempt = { ...generatedPractice() };
    delete (attempt as { conceptIdsByQuestion?: unknown }).conceptIdsByQuestion;
    const built = buildLearnerProfile({
      scope: { folderId: "f1" },
      evidence: { ...untagged, practicePaperAttempts: [attempt] },
      now: NOW,
    });
    const concept = built.topics.find((entry) => entry.topicKey === `spec:${CONCEPT}`);
    // Only the three exam answers remain attributable.
    expect(concept?.signal?.attempts).toBe(3);
    expect(concept?.signal?.evidence).not.toContain("practice");
  });
});
