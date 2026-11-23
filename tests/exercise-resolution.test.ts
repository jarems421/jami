import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/study/cards";
import {
  exercisePinKey,
  resolveCurrentExercise,
  type ExercisePin,
} from "@/lib/study/exercise-resolution";
import { getCardContentHash } from "@/lib/study/study-modes";

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "c-1",
    deckId: "deck-1",
    userId: "user-1",
    front: "What is the capital of France?",
    back: "Paris",
    topicIds: [],
    due: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Card;
}

function input(overrides: Partial<Parameters<typeof resolveCurrentExercise>[0]> = {}) {
  const subject = card();
  return {
    card: subject,
    asked: subject,
    index: 0,
    presentation: 0,
    policy: { kind: "fixed" as const, mode: "classic" as const },
    sessionId: "session-1",
    seed: 7,
    pinned: null,
    restoredExercises: [],
    reportedPresentations: new Set<string>(),
    retiredVariantIds: [],
    isRetiredDraft: () => false,
    modeCounts: {},
    presentationIndex: 0,
    recentModes: [],
    recentVariantIds: [],
    recentOutcomes: [],
    newId: () => "fixed-id",
    ...overrides,
  };
}

describe("resolveCurrentExercise", () => {
  it("hands back the same question on a re-render, without minting a new pin", () => {
    const first = resolveCurrentExercise(input());
    expect(first.pin).toBeDefined();
    const second = resolveCurrentExercise(input({ pinned: first.pin as ExercisePin }));
    expect(second.exercise).toBe(first.exercise);
    expect(second.pin).toBeUndefined();
  });

  it("re-resolves when the card's own content changed under the pin", () => {
    const subject = card();
    const exercise = {
      cardId: subject.id,
      cardContentHash: "stale-hash",
      mode: "gap-fill" as const,
      prompt: subject.front,
      expectedAnswer: subject.back,
      source: "deterministic" as const,
    };
    const pinned: ExercisePin = { key: exercisePinKey({ cardId: subject.id, index: 0, presentation: 0, policy: { kind: "fixed", mode: "classic" } }), presentationId: "p-1", exercise };
    const result = resolveCurrentExercise(input({ pinned }));
    expect(result.pin).toBeDefined();
    expect(result.exercise).not.toBe(exercise);
  });

  it("keeps a pin whose exercise is null, rather than re-rolling Classic each render", () => {
    const first = resolveCurrentExercise(input());
    expect(first.exercise).toBeNull();
    const second = resolveCurrentExercise(input({ pinned: first.pin as ExercisePin }));
    expect(second.pin).toBeUndefined();
  });

  it("replaces a waiting placeholder with the arrived options and preserves its presentation ID", () => {
    const policy = { kind: "fixed", mode: "multiple-choice" } as const;
    const first = resolveCurrentExercise(input({ policy }));
    expect(first.pin?.waitingForQuestion).toBe(true);
    const asked = card({
      studySettings: { mcqDistractors: ["Berlin", "Rome", "Madrid"] },
    });
    const arrived = resolveCurrentExercise(input({ policy, pinned: first.pin!, asked }));
    expect(arrived.exercise?.mcq?.options).toHaveLength(4);
    expect(arrived.pin?.presentationId).toBe(first.pin?.presentationId);
    expect(arrived.pin?.waitingForQuestion).toBeUndefined();
    expect(resolveCurrentExercise(input({ policy, pinned: arrived.pin! })).exercise).toBe(arrived.exercise);
  });

  it("does not hand back a variant reported while it was on screen", () => {
    const subject = card();
    const key = exercisePinKey({ cardId: subject.id, index: 0, presentation: 0, policy: { kind: "fixed", mode: "classic" } });
    const pinned: ExercisePin = {
      key,
      presentationId: "p-1",
      exercise: {
        cardId: subject.id,
        cardContentHash: getCardContentHash(subject),
        mode: "multiple-choice",
        prompt: subject.front,
        expectedAnswer: subject.back,
        variantId: "v-9",
        source: "cached-ai",
      },
    };
    const result = resolveCurrentExercise(input({ pinned, retiredVariantIds: ["v-9"] }));
    expect(result.exercise).toBeNull();
    expect(result.pin?.recoveryNotice).toContain("reported");
  });

  it("treats a draft retirement flag the same as a persisted retirement", () => {
    const subject = card();
    const key = exercisePinKey({ cardId: subject.id, index: 0, presentation: 0, policy: { kind: "fixed", mode: "classic" } });
    const pinned: ExercisePin = {
      key,
      presentationId: "p-1",
      exercise: {
        cardId: subject.id,
        cardContentHash: getCardContentHash(subject),
        mode: "multiple-choice",
        prompt: subject.front,
        expectedAnswer: subject.back,
        variantId: "v-9",
        source: "cached-ai",
      },
    };
    const result = resolveCurrentExercise(input({ pinned, isRetiredDraft: (id) => id === "v-9" }));
    expect(result.exercise).toBeNull();
  });

  it("refuses to resume a saved exercise the current validator would reject", () => {
    const subject = card();
    const result = resolveCurrentExercise(
      input({
        restoredExercises: [
          {
            presentationId: "session-1:0:c-1:old",
            cardId: subject.id,
            mode: "multiple-choice",
            contentHash: getCardContentHash(subject),
          },
        ],
      })
    );
    expect(result.exercise).toBeNull();
    expect(result.pin?.recoveryNotice).toContain("needs updating");
  });

  it("resumes a saved Classic presentation under its original id", () => {
    const subject = card();
    const result = resolveCurrentExercise(
      input({
        restoredExercises: [
          {
            presentationId: "session-1:0:c-1:original",
            cardId: subject.id,
            mode: "classic",
            contentHash: getCardContentHash(subject),
          },
        ],
      })
    );
    expect(result.exercise).toBeNull();
    expect(result.pin?.presentationId).toBe("session-1:0:c-1:original");
  });

  it("does not resume a saved exercise belonging to a different presentation of the card", () => {
    const subject = card();
    const result = resolveCurrentExercise(
      input({
        restoredExercises: [
          {
            presentationId: "session-1:4:c-1:other",
            cardId: subject.id,
            mode: "classic",
            contentHash: getCardContentHash(subject),
          },
        ],
      })
    );
    expect(result.pin?.presentationId).not.toBe("session-1:4:c-1:other");
  });

  it("clears an exercise once the presentation has been reported", () => {
    const result = resolveCurrentExercise(
      input({ reportedPresentations: new Set(["c-1:0"]) })
    );
    expect(result.exercise).toBeNull();
    expect(result.pin).toBeDefined();
  });
});

describe("exercisePinKey", () => {
  it("separates two presentations of the same card in one session", () => {
    const base = { cardId: "c-1", index: 0, policy: { kind: "smart" as const } };
    expect(exercisePinKey({ ...base, presentation: 0 })).not.toBe(
      exercisePinKey({ ...base, presentation: 1 })
    );
  });

  it("separates one fixed mode from another", () => {
    const base = { cardId: "c-1", index: 0, presentation: 0 };
    expect(exercisePinKey({ ...base, policy: { kind: "fixed", mode: "gap-fill" } })).not.toBe(
      exercisePinKey({ ...base, policy: { kind: "fixed", mode: "multiple-choice" } })
    );
  });
});
