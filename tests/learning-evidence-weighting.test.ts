import { describe, expect, it } from "vitest";
import { masteryScore } from "@/lib/learning/scoring/mastery-score";
import { sourceWeight } from "@/lib/learning/scoring/item-weights";
import { evidenceConfidence } from "@/lib/learning/scoring/confidence-score";
import { pastPaperObservations } from "@/lib/learning/profile/past-paper-signals";
import { practicePaperObservations } from "@/lib/learning/profile/practice-signals";
import { notebookObservations } from "@/lib/learning/profile/notebook-signals";
import { flashcardObservations } from "@/lib/learning/profile/flashcard-signals";
import type { LearningObservation } from "@/lib/learning/types";

/**
 * What one piece of evidence is actually worth, against another.
 *
 * The cross-surface test proves the concept hierarchy routes evidence to the
 * right place. It does not prove the weights are right, and a fixture can be
 * accidentally correct: give exam questions more marks than practice questions
 * and exam evidence will look stronger whether or not anything in the model
 * says it should be.
 *
 * So these compare like for like -- same marks, same dates, same concept --
 * and assert the relationships the engine is supposed to hold.
 */

const NOW = Date.parse("2026-09-21T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const MARKS = 6;

/**
 * The weight the scorer actually uses: the observation's own, scaled for the
 * source it came from. Reading `observation.weight` directly would measure the
 * number before the engine has finished with it.
 */
function totalWeight(observations: readonly LearningObservation[]) {
  return observations.reduce((sum, entry) => sum + sourceWeight(entry), 0);
}

function examAnswers(count: number, awarded: number, attemptNumber = 1) {
  return pastPaperObservations(
    Array.from({ length: count }, (_, index) => ({
      id: `exam-${index}`,
      questionId: `eq${index}`,
      topicIds: [],
      conceptIds: ["cts"],
      attemptNumber,
      markedAt: NOW - (index + 1) * DAY,
      updatedAt: NOW - (index + 1) * DAY,
      result: { attempted: true, counted: true, awardedMarks: awarded, maxMarks: MARKS },
    })) as never
  );
}

function practiceAnswers(count: number, awarded: number, assisted = false) {
  return practicePaperObservations([
    {
      id: "practice-1",
      paperId: "p1",
      assisted,
      markedAt: NOW - DAY,
      updatedAt: NOW - DAY,
      questionResults: Array.from({ length: count }, (_, index) => ({
        questionId: `pq${index}`,
        attempted: true,
        counted: true,
        awardedMarks: awarded,
        maxMarks: MARKS,
      })),
      conceptIdsByQuestion: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`pq${index}`, ["cts"]])
      ),
    },
  ]);
}

function notebookPages(count: number, awarded: number) {
  return notebookObservations(
    Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      notebookId: "nb-1",
      pageId: `page-${index}`,
      topicKeys: ["topic:cts"],
      itemId: `notebook:nb-1:page-${index}`,
      markedAt: NOW - (index + 1) * DAY,
      result: { attempted: true, counted: true, awardedMarks: awarded, maxMarks: MARKS },
    }))
  );
}

function flashcardReviews(count: number, correct: boolean) {
  const cards = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    deckId: "d1",
    topicIds: ["cts"],
    reps: 3,
    lapses: correct ? 0 : 3,
    difficulty: 5,
    fsrsState: 2,
    stability: 30,
    lastReview: NOW - DAY,
    dueDate: NOW + DAY,
    createdAt: NOW - 90 * DAY,
  }));
  const events = cards.map((card, index) => ({
    id: `r${index}`,
    cardId: card.id,
    deckId: "d1",
    reviewedAt: NOW - (index + 1) * DAY,
    studyDayKey: "2026-09-12",
    correct,
    rating: correct ? ("good" as const) : ("again" as const),
  }));
  return flashcardObservations(cards as never, events, NOW);
}

describe("how much each source is worth", () => {
  it("weighs a real exam answer above a generated practice question of the same size", () => {
    const exam = totalWeight(examAnswers(1, 3));
    const practice = totalWeight(practiceAnswers(1, 3));
    expect(exam).toBeGreaterThan(practice);
  });

  it("does not let generated practice overwhelm real exam evidence through volume", () => {
    // Twelve mediocre generated answers against three poor real ones.
    const observations = [...practiceAnswers(12, 4), ...examAnswers(3, 1)];
    const mastery = masteryScore(observations, NOW);
    // The real evidence is bad; the estimate must not read as comfortable.
    expect(mastery).toBeLessThan(0.55);
  });

  /*
   * The invariant, stated as a relationship rather than a number.
   *
   * Generated practice is the one thing Jami has in unlimited supply, so the
   * failure worth guarding against is not "the number came out wrong today"
   * but "enough generated questions can stand in for real ones". What must
   * hold is that changing how the student did on three REAL questions still
   * moves the estimate by something worth saying, however much generated
   * practice is piled on either side of it.
   *
   * Asserting a mastery value here would be asserting today's constants. This
   * asserts the property those constants exist to produce.
   */
  it("never lets generated volume substitute for real examination evidence", () => {
    for (const volume of [12, 30, 60]) {
      const strongPractice = practiceAnswers(volume, 6);
      const weakPractice = practiceAnswers(volume, 1);

      const realEvidenceSwing =
        masteryScore([...strongPractice, ...examAnswers(3, 6)], NOW) -
        masteryScore([...strongPractice, ...examAnswers(3, 1)], NOW);
      // Three real answers still say something, buried in sixty generated ones.
      expect(realEvidenceSwing).toBeGreaterThan(0.05);

      // And the same holds when the generated evidence points the other way.
      const swingAgainstWeakPractice =
        masteryScore([...weakPractice, ...examAnswers(3, 6)], NOW) -
        masteryScore([...weakPractice, ...examAnswers(3, 1)], NOW);
      expect(swingAgainstWeakPractice).toBeGreaterThan(0.05);
    }
  });

  it("keeps a real answer worth more than a generated one, per question", () => {
    // The relationship the volume invariant rests on, stated directly.
    const perExam = totalWeight(examAnswers(1, 3));
    const perPractice = totalWeight(practiceAnswers(1, 3));
    expect(perExam / perPractice).toBeGreaterThan(1.4);
  });

  it("weighs marked notebook working below both", () => {
    const notebook = totalWeight(notebookPages(1, 3));
    expect(notebook).toBeLessThan(totalWeight(practiceAnswers(1, 3)));
    expect(notebook).toBeLessThan(totalWeight(examAnswers(1, 3)));
  });

  it("does not let notebook working dominate real evidence through volume", () => {
    const observations = [...notebookPages(10, 6), ...examAnswers(3, 1)];
    expect(masteryScore(observations, NOW)).toBeLessThan(0.6);
  });

  /*
   * Flashcards are NOT downweighted, and that is the design.
   *
   * A card answered is a card answered; the source is not suspect. What makes
   * ten perfect recalls fail to excuse three failed exam answers is not a
   * multiplier but the concept hierarchy: cards sit on the broad Topic, exam
   * answers on the concept beneath it, and evidence only ever travels upward.
   * Asserting it here as a weight would be asserting the wrong mechanism --
   * `learning-cross-surface-evidence` is where the real guarantee is tested.
   */
  it("treats a flashcard answer as trustworthy, just smaller than a six-mark question", () => {
    const oneCard = totalWeight(flashcardReviews(1, true));
    const oneExamAnswer = totalWeight(examAnswers(1, 3));
    expect(oneCard).toBeGreaterThan(0);
    expect(oneCard).toBeLessThan(oneExamAnswer);
  });

  it("halves a retried exam answer and an assisted sitting", () => {
    expect(totalWeight(examAnswers(1, 3, 2))).toBeCloseTo(
      totalWeight(examAnswers(1, 3)) / 2,
      5
    );
    expect(totalWeight(practiceAnswers(1, 3, true))).toBeCloseTo(
      totalWeight(practiceAnswers(1, 3)) / 2,
      5
    );
  });

  it("fades older evidence by the existing recency model", () => {
    const recent = examAnswers(1, 6);
    const old = recent.map((entry) => ({ ...entry, at: NOW - 200 * DAY }));
    // Same answer, long ago: it still counts, but for less.
    expect(masteryScore(old, NOW)).toBeLessThan(masteryScore(recent, NOW));
    expect(masteryScore(old, NOW)).toBeGreaterThan(0.5);
  });

  it("caps one item however many times it is retried", () => {
    const once = examAnswers(1, 6);
    const retried = [
      ...once,
      ...Array.from({ length: 8 }, (_, index) => ({
        ...once[0],
        evidenceId: `retry-${index}`,
        at: NOW - (index + 1) * 1000,
      })),
    ];
    // Nine answers to one question is not nine questions' worth of confidence.
    expect(evidenceConfidence(retried, NOW)).toBeLessThan(
      evidenceConfidence(examAnswers(9, 6), NOW)
    );
  });
});
