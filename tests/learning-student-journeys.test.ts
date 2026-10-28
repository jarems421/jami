import { describe, expect, it } from "vitest";
import { buildTodayMission } from "@/lib/dashboard/today-mission";
import { buildTodayPlan } from "@/lib/dashboard/today-plan";
import { buildStudyActions, type StudyAction } from "@/lib/learning/actions/study-actions";
import type { TopicRelationInput } from "@/lib/learning/concepts/topic-relations";
import type { FlashcardReviewEvent } from "@/lib/learning/events/flashcard-review-event";
import {
  selectIntervention,
  type InterventionAvailability,
  type InterventionReason,
} from "@/lib/learning/interventions/catalogue";
import {
  buildLearnerProfile,
  type LearnerEvidence,
} from "@/lib/learning/profile/build-learner-profile";
import type { FlashcardEvidenceCard } from "@/lib/learning/profile/flashcard-signals";
import type { PastPaperEvidenceAttempt } from "@/lib/learning/profile/past-paper-signals";
import {
  MIN_SIGNAL_CONFIDENCE,
  MIN_STRENGTH_CONFIDENCE,
  STRENGTH_MASTERY_FROM,
  TOPIC_FOCUS_CONFIDENCE,
  WEAKNESS_MASTERY_BELOW,
} from "@/lib/learning/profile/thresholds";
import {
  applicationGapOf,
  decideTopic,
  demonstrationOf,
  memoryOf,
} from "@/lib/learning/profile/topic-states";
import type {
  LearningClaimEstimate,
  LearningEvidenceKind,
  LearningSignal,
  LearningTopicSource,
  LearningTopicState,
  LearningTrend,
} from "@/lib/learning/types";

/**
 * What a student is actually told, from their history to the words on Today.
 *
 * Every other Learning Engine test checks one layer against states built by
 * hand, and that is how the engine came to have a sentence -- "your recall is
 * strong, but application is weaker" -- that the real decisions could never
 * reach: the catalogue was tested on a decision the engine does not make. These
 * run the whole pipeline instead, from raw review events and marked answers
 * through the profile, the study actions and the Today plan to the mission, and
 * check what comes out the other end.
 */

const NOW = Date.parse("2026-09-21T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const FOLDER = "f1";

function card(id: string, topicIds: string[], overrides: Partial<FlashcardEvidenceCard> = {}) {
  return {
    id,
    deckId: "deck-maths",
    topicIds,
    reps: 6,
    lapses: 0,
    difficulty: 3,
    fsrsState: 2,
    stability: 60,
    lastReview: NOW - 2 * DAY,
    dueDate: NOW + 30 * DAY,
    createdAt: NOW - 90 * DAY,
    ...overrides,
  } as FlashcardEvidenceCard;
}

/** `perCard` reviews of each card, one a day going back; `correct` sees the age index, 0 newest. */
function reviews(
  cards: readonly FlashcardEvidenceCard[],
  perCard: number,
  correct: (ageIndex: number) => boolean,
  startDaysAgo = 1
): FlashcardReviewEvent[] {
  return cards.flatMap((entry, cardIndex) =>
    Array.from({ length: perCard }, (_, index) => {
      const age = cardIndex * perCard + index;
      return {
        id: `r-${entry.id}-${index}`,
        cardId: entry.id,
        deckId: "deck-maths",
        reviewedAt: NOW - (age + startDaysAgo) * DAY,
        studyDayKey: "2026-09-10",
        correct: correct(age),
        rating: correct(age) ? ("good" as const) : ("again" as const),
      };
    })
  );
}

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

const SPECIFICATION = {
  id: "8300",
  title: "AQA GCSE Mathematics",
  topics: [{ id: "algebra", label: "Algebra" }],
};

const CONCEPTS = [
  { id: "completing-the-square", label: "Completing the square" },
  { id: "factorisation", label: "Factorisation" },
].map((concept) => ({
  key: `spec:${concept.id}`,
  label: concept.label,
  source: "specification" as const,
  provenance: "verified_specification" as const,
  verified: true,
  parentKey: "spec:algebra",
}));

const QUADRATIC_CARDS = Array.from({ length: 6 }, (_, index) => card(`c${index}`, ["quadratics"]));
const ALL_RIGHT = reviews(QUADRATIC_CARDS, 3, () => true);

const COVERS: TopicRelationInput[] = [
  {
    topicId: "quadratics",
    relation: {
      type: "covers",
      conceptIds: ["completing-the-square", "factorisation"],
      confirmedByOwner: true,
    },
  },
];

function evidence(partial: Partial<LearnerEvidence>): LearnerEvidence {
  return {
    cards: [],
    flashcardReviewEvents: [],
    pastPaperAttempts: [],
    practicePaperAttempts: [],
    topicLabels: {},
    concepts: CONCEPTS,
    specification: SPECIFICATION,
    ...partial,
  };
}

/** The whole pipeline, as Today runs it for a folder with an exam course and generation on. */
function studentSees(input: Partial<LearnerEvidence>) {
  const profile = buildLearnerProfile({ scope: { folderId: FOLDER }, evidence: evidence(input), now: NOW });
  const actions = buildStudyActions(
    profile,
    { questionPracticeAvailable: true, canGenerate: { flashcards: true, practice: true } },
    undefined,
    NOW
  );
  const plan = buildTodayPlan({
    decks: [],
    cards: [],
    topics: [],
    drafts: [],
    studyActions: actions,
    studyActionFolders: [{ id: FOLDER, name: "Maths" }],
    now: NOW,
  });
  const mission = buildTodayMission({ nextAction: plan.nextAction, studyActions: plan.studyActions });
  const on = (topicKey: string) =>
    actions.find((action) => action.target.kind === "topic" && action.target.topicKey === topicKey);
  const state = (topicKey: string) => profile.topics.find((topic) => topic.topicKey === topicKey);
  return { profile, actions, plan, mission, on, state };
}

const CTS = "spec:completing-the-square";
const QUESTIONS_ON_CTS = `/dashboard/practice/questions/new?folderId=${FOLDER}&concepts=completing-the-square`;

describe("recall holds, application does not", () => {
  it("says so, and sends the student to real questions, when both sit on one concept", () => {
    // Their own Topic "Completing the square" is the specification concept.
    const { mission, on } = studentSees({
      cards: QUADRATIC_CARDS.map((entry) => ({ ...entry, topicIds: ["cts"] })),
      flashcardReviewEvents: ALL_RIGHT,
      pastPaperAttempts: examAnswers(6, "completing-the-square", 1),
      topicLabels: { "topic:cts": { label: "Completing the square", source: "student-topic" } },
      topicRelations: [
        {
          topicId: "cts",
          relation: { type: "exact", conceptId: "completing-the-square", confirmedByOwner: true },
        },
      ],
    });

    expect(on(CTS)?.action).toBe("practice");
    expect(on(CTS)?.intervention?.because).toBe("recall_strong_application_weak");
    expect(mission.headline).toBe("Make completing the square exam-ready");
    expect(mission.summary).toBe("Your recall is strong, but application is weaker.");
    expect(mission.actionLabel).toBe("Start practicing");
    expect(mission.href).toBe(QUESTIONS_ON_CTS);
  });

  it("names the Topic they drilled when that Topic covers the concept", () => {
    const { on, plan } = studentSees({
      cards: QUADRATIC_CARDS,
      flashcardReviewEvents: ALL_RIGHT,
      pastPaperAttempts: examAnswers(3, "completing-the-square", 1),
      topicLabels: { "topic:quadratics": { label: "Quadratics", source: "student-topic" } },
      topicRelations: COVERS,
    });

    const action = on(CTS);
    expect(action?.intervention?.because).toBe("recall_strong_application_weak");
    expect(action?.intervention?.recallFrom).toEqual({ topicKey: "topic:quadratics", label: "Quadratics" });
    expect(action?.destination?.href).toBe(QUESTIONS_ON_CTS);
    // The broad Topic's cards say what kind of work is missing; they are never
    // evidence about the concept.
    expect(action?.evidence.sources).toEqual(["past-paper"]);
    expect(plan.studyActions[0]?.title).toBe("Check Completing the square in exam questions");
  });

  it("makes no recall claim at all when nothing links the Topic to the concept", () => {
    // Production today: relations off. Two unrelated concepts, so no sentence
    // may connect them.
    const { on, state } = studentSees({
      cards: QUADRATIC_CARDS,
      flashcardReviewEvents: ALL_RIGHT,
      pastPaperAttempts: examAnswers(3, "completing-the-square", 1),
      topicLabels: { "topic:quadratics": { label: "Quadratics", source: "student-topic" } },
    });

    expect(state(CTS)?.applicationGap).toBeUndefined();
    expect(on(CTS)?.intervention?.because).toBe("suspected_gap");
  });

  it("does not read moving from cards to exam questions as forgetting", () => {
    // Cards last month, all right; exam questions this week, mostly wrong. The
    // recent window is harder work, not a decline.
    const { state } = studentSees({
      cards: QUADRATIC_CARDS.map((entry) => ({ ...entry, topicIds: ["cts"] })),
      flashcardReviewEvents: reviews(
        QUADRATIC_CARDS.map((entry) => ({ ...entry, topicIds: ["cts"] })),
        3,
        () => true,
        20
      ),
      pastPaperAttempts: examAnswers(8, "completing-the-square", 1),
      topicLabels: { "topic:cts": { label: "Completing the square", source: "student-topic" } },
      topicRelations: [
        {
          topicId: "cts",
          relation: { type: "exact", conceptId: "completing-the-square", confirmedByOwner: true },
        },
      ],
    });

    expect(state(CTS)?.signal?.trend).not.toBe("declining");
    expect(state(CTS)?.memory).not.toContain("decaying");
  });
});

describe("a weakness is never lost on the way to the page", () => {
  it("puts a well-evidenced exam weakness on Today, with a way to act on it", () => {
    // Twelve real exam answers at a quarter of the marks: the strongest signal
    // the engine can have. It used to reach "teach", which has no page for a
    // specification concept, and vanish.
    const { mission, on } = studentSees({ pastPaperAttempts: examAnswers(12, "completing-the-square", 1) });

    expect(on(CTS)?.destination).toBeDefined();
    expect(mission.action?.target).toMatchObject({ kind: "topic", topicKey: CTS });
    expect(mission.headline).toBe("Build something to revise completing the square from");
    expect(mission.generate).toEqual({ kind: "create_flashcards", conceptId: "completing-the-square" });
  });

  it("says a thin weakness is uncertain, never that nothing was recorded", () => {
    const { on, plan } = studentSees({ pastPaperAttempts: examAnswers(3, "completing-the-square", 1) });

    expect(on(CTS)?.intervention?.because).toBe("suspected_gap");
    const item = plan.studyActions.find((entry) => entry.target.kind === "topic" && entry.target.topicKey === CTS);
    expect(item?.description).toContain("not enough evidence yet");
  });

  it("calls slipping slipping, and sends the student back to their cards", () => {
    const cards = QUADRATIC_CARDS.map((entry) => ({ ...entry, dueDate: NOW - DAY }));
    // Older reviews right, the latest ones wrong.
    const { mission } = studentSees({
      cards,
      flashcardReviewEvents: reviews(cards, 4, (age) => age >= 12),
      topicLabels: { "topic:quadratics": { label: "Quadratics", source: "student-topic" } },
    });

    expect(mission.headline).toBe("Get quadratics back on track");
    expect(mission.summary).toBe("Your recent answers on this are not as good as your earlier ones.");
    expect(mission.href.startsWith("/dashboard/study?")).toBe(true);
  });
});

describe("the button does what it says", () => {
  const HISTORIES: Partial<LearnerEvidence>[] = [
    { pastPaperAttempts: examAnswers(12, "completing-the-square", 1) },
    { pastPaperAttempts: examAnswers(3, "completing-the-square", 1) },
    {
      cards: QUADRATIC_CARDS,
      flashcardReviewEvents: ALL_RIGHT,
      pastPaperAttempts: examAnswers(3, "completing-the-square", 1),
      topicLabels: { "topic:quadratics": { label: "Quadratics", source: "student-topic" } },
      topicRelations: COVERS,
    },
    {
      cards: QUADRATIC_CARDS.map((entry) => ({ ...entry, lapses: 4, difficulty: 8, dueDate: NOW - DAY })),
      flashcardReviewEvents: reviews(QUADRATIC_CARDS, 3, (age) => age % 3 === 0),
      topicLabels: { "topic:quadratics": { label: "Quadratics", source: "student-topic" } },
    },
  ];

  const expectedPlace = (action: StudyAction) => {
    switch (action.intervention?.type) {
      case "retrieve":
        return "/dashboard/study?";
      case "past_paper":
      case "create_practice":
      case "create_flashcards":
      case "fill_specification_gap":
        return "/dashboard/practice/questions/new?";
      case "teach":
      case "review_material":
        return "/dashboard/topics/";
      default:
        return undefined;
    }
  };

  it("links every offered action to the place that action happens", () => {
    let checked = 0;
    for (const history of HISTORIES) {
      for (const action of studentSees(history).actions) {
        const place = expectedPlace(action);
        if (!place) continue;
        expect(action.destination?.href.startsWith(place), action.id).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });
});

/**
 * Every sentence, against every state that can reach it.
 *
 * The decisions come from the engine's own `decideTopic`, over a grid of
 * signals wide enough to reach each of its branches, so a sentence is checked
 * against what the engine can actually produce rather than what a test author
 * imagined it might.
 */
describe("every sentence is true for every student who sees it", () => {
  const claimOptions: (LearningClaimEstimate | undefined)[] = [
    undefined,
    { evidenceMastery: 0.3, confidence: 0.35, attempts: 3 },
    { evidenceMastery: 0.3, confidence: 0.7, attempts: 10 },
    { evidenceMastery: 0.9, confidence: 0.6, attempts: 12 },
  ];
  const trends: (LearningTrend | undefined)[] = [undefined, "improving", "stable", "declining"];

  /** What each sentence claims, as a check on the state that produced it. */
  const CLAIMS: Record<InterventionReason, (state: LearningTopicState) => boolean> = {
    declared_but_unevidenced: (state) => !state.signal,
    material_never_tested: (state) => !state.signal,
    no_material_for_specification_concept: (state) => !state.signal,
    suspected_gap: (state) =>
      Boolean(state.signal) &&
      (state.signal?.evidenceMastery ?? 1) < WEAKNESS_MASTERY_BELOW &&
      (state.signal?.confidence ?? 1) < TOPIC_FOCUS_CONFIDENCE,
    evidenced_knowledge_gap: (state) =>
      (state.signal?.evidenceMastery ?? 1) < WEAKNESS_MASTERY_BELOW &&
      (state.signal?.confidence ?? 0) >= TOPIC_FOCUS_CONFIDENCE,
    weak_without_flashcards: (state) =>
      (state.signal?.evidenceMastery ?? 1) < WEAKNESS_MASTERY_BELOW &&
      (state.signal?.confidence ?? 0) >= TOPIC_FOCUS_CONFIDENCE,
    recall_strong_application_weak: (state) => {
      const recall = state.signal?.claims?.recall;
      const application = state.signal?.claims?.application;
      return (
        recall !== undefined &&
        application !== undefined &&
        recall.evidenceMastery >= STRENGTH_MASTERY_FROM &&
        recall.confidence >= MIN_STRENGTH_CONFIDENCE &&
        application.evidenceMastery < WEAKNESS_MASTERY_BELOW &&
        application.confidence >= MIN_SIGNAL_CONFIDENCE
      );
    },
    slipping: (state) => state.signal?.trend === "declining",
    due_for_retrieval: (state) => (state.signal?.dueCards ?? 0) > 0,
    recent_gain: (state) => state.signal?.trend === "improving",
  };

  const AVAILABILITIES: InterventionAvailability[] = [
    {
      hasFlashcards: true,
      flashcardCount: 12,
      hasMaterial: true,
      canCreateFlashcards: true,
      canCreatePractice: true,
    },
    {
      hasFlashcards: false,
      flashcardCount: 0,
      hasMaterial: false,
      hasPastPaper: false,
      hasPractice: false,
      canCreateFlashcards: true,
      canCreatePractice: true,
    },
  ];

  function statesOnTheGrid(): LearningTopicState[] {
    const states: LearningTopicState[] = [];
    const sources: LearningTopicSource[] = ["specification", "student-topic", "deck"];
    for (const source of sources)
    for (const recall of claimOptions)
    for (const application of claimOptions)
    for (const notebook of [false, true])
    for (const evidenceMastery of [0.2, 0.5, 0.7, 0.9])
    for (const confidence of [0.1, 0.4, 0.8])
    for (const trend of trends)
    for (const previousAccuracy of [undefined, 0.3, 0.95])
    for (const dueCards of [0, 3]) {
      const evidence: LearningEvidenceKind[] = [
        ...(recall ? (["flashcards"] as const) : []),
        ...(application ? (["past-paper"] as const) : []),
        ...(notebook ? (["notebook"] as const) : []),
      ];
      const signal: LearningSignal | undefined =
        evidence.length === 0
          ? undefined
          : {
              topicKey: "k",
              topic: "Concept",
              topicSource: source,
              mastery: evidenceMastery,
              evidenceMastery,
              confidence,
              attempts: 10,
              uniqueItems: 10,
              accuracy: evidenceMastery,
              ...(trend ? { trend, recentAccuracy: 0.5 } : {}),
              ...(previousAccuracy !== undefined ? { previousAccuracy } : {}),
              dueCards: recall ? dueCards : 0,
              lastSeenAt: NOW,
              evidence,
              ...(recall || application
                ? { claims: { ...(recall ? { recall } : {}), ...(application ? { application } : {}) } }
                : {}),
            };
      for (const exposed of [false, true]) {
        const exposure = { notebooks: exposed ? 1 : 0, sources: 0, cards: recall ? 6 : 0 };
        const demonstration = demonstrationOf(signal);
        const memory = memoryOf(signal);
        const gap = applicationGapOf(signal, undefined, { topicKey: "k", label: "Concept" });
        const decision = decideTopic({
          ...(signal ? { signal } : {}),
          demonstration,
          memory,
          exposure,
          source,
          declared: source === "specification",
          applicationGap: Boolean(gap),
        });
        states.push({
          topicKey: "k",
          label: "Concept",
          source,
          provenance: "verified_specification",
          declared: source === "specification",
          exposure,
          demonstration,
          memory,
          ...(signal ? { signal } : {}),
          ...(gap ? { applicationGap: gap } : {}),
          ...(decision ? { decision } : {}),
        });
      }
    }
    return states;
  }

  it("holds each sentence to the state that chose it", () => {
    const reached = new Set<InterventionReason>();
    for (const state of statesOnTheGrid()) {
      for (const availability of AVAILABILITIES) {
        const choice = selectIntervention(state, availability);
        if (!choice) continue;
        reached.add(choice.because);
        expect(
          CLAIMS[choice.because](state),
          `${choice.because} for ${state.decision?.action}/${state.decision?.reason} on ${state.source}`
        ).toBe(true);
      }
    }
    // And the grid is wide enough to mean something: every sentence is reached.
    expect([...reached].sort()).toEqual(Object.keys(CLAIMS).sort());
  });
});
