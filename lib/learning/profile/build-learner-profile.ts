import { selectRecentResults } from "@/lib/learning/profile/recent-results";
import {
  buildConceptRegistry,
  conceptShares,
  expandConceptKeys,
  resolveConceptKey,
  type ConceptRegistry,
} from "@/lib/learning/concepts/registry";
import type { FlashcardReviewEvent } from "@/lib/learning/events/flashcard-review-event";
import {
  buildExposureByTopic,
  type LearnerExposureItem,
} from "@/lib/learning/profile/exposure";
import {
  flashcardObservations,
  flashcardTopicKeys,
  type FlashcardEvidenceCard,
} from "@/lib/learning/profile/flashcard-signals";
import {
  canonicalizeObservations,
  groupObservationsByTopic,
} from "@/lib/learning/profile/observations";
import {
  notebookObservations,
  type NotebookMarkedWorking,
} from "@/lib/learning/profile/notebook-signals";
import {
  revisionObservations,
  type RevisionSessionEvidence,
} from "@/lib/learning/profile/revision-signals";
import { tutorCheckObservations } from "@/lib/learning/profile/tutor-check-signals";
import type { TutorCheck } from "@/lib/learning/events/tutor-check";
import {
  applyTopicRelations,
  resolveTopicRelations,
  type TopicRelationInput,
} from "@/lib/learning/concepts/topic-relations";
import {
  pastPaperObservations,
  type PastPaperEvidenceAttempt,
} from "@/lib/learning/profile/past-paper-signals";
import {
  practicePaperObservations,
  type PracticePaperEvidenceAttempt,
} from "@/lib/learning/profile/practice-signals";
import { buildCommandWordSignals } from "@/lib/learning/profile/command-words";
import { buildRecurringErrors } from "@/lib/learning/profile/recurring-errors";
import {
  DECLINING_ATTENTION_BELOW,
  MIN_SIGNAL_CONFIDENCE,
  MIN_STRENGTH_CONFIDENCE,
  STRENGTH_MASTERY_FROM,
  WEAKNESS_MASTERY_BELOW,
} from "@/lib/learning/profile/thresholds";
import { buildTopicStates } from "@/lib/learning/profile/topic-states";
import { recommendFocus } from "@/lib/learning/recommendations/recommend-focus";
import { evidenceConfidence } from "@/lib/learning/scoring/confidence-score";
import { countUniqueItems } from "@/lib/learning/scoring/item-weights";
import { tuningWithLearnerPrior } from "@/lib/learning/scoring/learner-prior";
import { masteryScore, weightedAccuracy } from "@/lib/learning/scoring/mastery-score";
import { DEFAULT_LEARNING_TUNING, type LearningTuning } from "@/lib/learning/scoring/tuning";
import { measureTrend, measureTrendWithinKinds } from "@/lib/learning/scoring/trend-score";
import {
  LEARNER_PROFILE_ALGORITHM_VERSION,
  type ConceptProvenance,
  type LearnerEvidenceLimit,
  type LearnerEvidenceSource,
  type LearnerProfile,
  type LearnerProfileScope,
  type LearningClaimEstimate,
  type LearningClaims,
  type LearningConcept,
  type LearningDemonstration,
  type LearningEvidenceKind,
  type LearningObservation,
  type LearningSignal,
  type LearningSpecificationCoverage,
  type LearningTopicLabel,
  type LearningTopicSource,
  type LearningTopicState,
} from "@/lib/learning/types";

export {
  DECLINING_ATTENTION_BELOW,
  MIN_SIGNAL_CONFIDENCE,
  MIN_STRENGTH_CONFIDENCE,
  STRENGTH_MASTERY_FROM,
  WEAKNESS_MASTERY_BELOW,
} from "@/lib/learning/profile/thresholds";

/** The exam specification a folder is studying for, with its servable topics. */
export type LearnerSpecification = {
  id: string;
  title: string;
  topics: readonly { id: string; label: string }[];
};

/**
 * Everything the engine needs, already loaded and scoped.
 *
 * Loading lives in `services/learning`; this module never touches Firestore,
 * so the whole calculation is a pure function of its input and can be tested
 * and re-run exactly.
 */
export type LearnerEvidence = {
  cards: readonly FlashcardEvidenceCard[];
  flashcardReviewEvents: readonly FlashcardReviewEvent[];
  pastPaperAttempts: readonly PastPaperEvidenceAttempt[];
  practicePaperAttempts: readonly PracticePaperEvidenceAttempt[];
  /**
   * Notebook working Tutor has marked. Weaker than the three above and
   * weighted accordingly; see `notebook-signals.ts` for why.
   */
  notebookMarkings?: readonly NotebookMarkedWorking[];
  /**
   * Finished Revision Sessions on concepts in scope. Model-marked like notebook
   * working and weighted the same; see `revision-signals.ts`.
   */
  revisionSessions?: readonly RevisionSessionEvidence[];
  /**
   * Tutor's marked quick checks in scope. The weakest evidence read here; see
   * `tutor-check-signals.ts`.
   */
  tutorChecks?: readonly TutorCheck[];
  /**
   * Plain display names by key, for concepts with no hierarchy. A key with no
   * label or concept -- deleted, merged away, or from a catalogue that is not
   * servable -- is left out of the profile rather than shown as "Unknown".
   */
  topicLabels: Readonly<Record<string, LearningTopicLabel>>;
  /** Concepts with provenance and parents, laid over `topicLabels` where keys match. */
  concepts?: readonly LearningConcept[];
  /** Keys that now mean another concept, such as a merged Topic. */
  conceptRedirects?: Readonly<Record<string, string>>;
  /**
   * How the student's own Topics relate to the specification, where anyone has
   * said. Empty unless `enableConceptRelations` is on; see
   * `lib/learning/concepts/topic-relations.ts`.
   */
  topicRelations?: readonly TopicRelationInput[];
  /** Topic-linked notebooks and sources in scope: exposure, never evidence. */
  exposureItems?: readonly LearnerExposureItem[];
  /** Concepts the folder itself lists, which exist for it whatever the evidence. */
  declaredTopicKeys?: readonly string[];
  /**
   * Topics the student has told Tutor they find hard, and when. Neither
   * evidence nor exposure: see `LearningTopicState.studentConcernAt`.
   */
  studentConcerns?: readonly { topicKey: string; at: number }[];
  specification?: LearnerSpecification;
  limitsReached?: readonly LearnerEvidenceLimit[];
  unavailableSources?: readonly LearnerEvidenceSource[];
};

export const LEARNER_PROFILE_LIMITS = {
  weaknesses: 5,
  strengths: 4,
  uncertain: 4,
  improving: 3,
  recurringErrors: 4,
  recommendations: 5,
} as const;

const EVIDENCE_ORDER: readonly LearningEvidenceKind[] = [
  "flashcards",
  "practice",
  "past-paper",
  "notebook",
  "revision",
  "tutor-check",
];

const PROVENANCE_FOR_SOURCE: Readonly<Record<LearningTopicSource, ConceptProvenance>> = {
  specification: "verified_specification",
  "student-topic": "student_defined",
  deck: "fallback",
};

const EMPTY_DEMONSTRATION_COUNTS: Record<LearningDemonstration, number> = {
  none: 0,
  insufficient: 0,
  weak: 0,
  developing: 0,
  strong: 0,
};

/**
 * The concepts this evidence can be reasoned over with.
 *
 * Specification topics first, then plain labels, then detailed concepts, so a
 * concept carrying a parent and provenance replaces a plain label for the same
 * key. Drafts and unchecked catalogue entries never enter.
 */
export function buildEvidenceConceptRegistry(evidence: LearnerEvidence): ConceptRegistry {
  const declared: LearningConcept[] = [
      ...(evidence.specification?.topics ?? []).map(
        (topic): LearningConcept => ({
          key: `spec:${topic.id}`,
          label: topic.label,
          source: "specification",
          provenance: "verified_specification",
          verified: true,
        })
      ),
      ...Object.entries(evidence.topicLabels).map(
        ([key, label]): LearningConcept => ({
          key,
          label: label.label,
          source: label.source,
          provenance: PROVENANCE_FOR_SOURCE[label.source],
          verified: true,
        })
      ),
    ...(evidence.concepts ?? []),
  ];

  /*
   * Relations are laid over the concepts rather than mixed in with them,
   * because they change how existing concepts hang rather than adding new
   * ones: a covered specification concept gets the student's Topic as its
   * parent, and that Topic takes the parent the concept used to have.
   *
   * Nothing downstream changes. Evidence still expands upward only, so a
   * flashcard on the broad Topic stays broad while an exam answer on one
   * covered concept counts there and rolls up to meet it.
   */
  const resolution = resolveTopicRelations(
    evidence.topicRelations ?? [],
    declared.filter((concept) => concept.key.startsWith("spec:"))
  );

  return buildConceptRegistry({
    concepts: applyTopicRelations(declared, resolution),
    redirects: { ...(evidence.conceptRedirects ?? {}), ...resolution.redirects },
  });
}


/**
 * Every observation the evidence supports, validated, deduplicated and in
 * canonical order, with each topic key resolved to the concepts it counts
 * towards -- including every broader concept above it. Shared by the profile
 * and by evaluation, so both see exactly the same evidence.
 *
 * An answer that tests several distinct concepts is weaker evidence about each
 * of them than one that tests a single concept, so it carries each concept's
 * share of it rather than counting in full for every one.
 */
export function collectLearnerObservations(
  evidence: LearnerEvidence,
  now: number,
  registry: ConceptRegistry = buildEvidenceConceptRegistry(evidence)
) {
  const { observations, dropped } = canonicalizeObservations(
    [
      ...flashcardObservations(evidence.cards, evidence.flashcardReviewEvents, now),
      ...pastPaperObservations(evidence.pastPaperAttempts),
      ...practicePaperObservations(evidence.practicePaperAttempts),
      ...notebookObservations(evidence.notebookMarkings ?? []),
      ...revisionObservations(evidence.revisionSessions ?? []),
      ...tutorCheckObservations(evidence.tutorChecks ?? []),
    ],
    now
  );
  return {
    observations: observations.map((observation) => {
      const topicShares = conceptShares(registry, observation.topicKeys);
      return {
        ...observation,
        topicKeys: expandConceptKeys(registry, observation.topicKeys).sort(),
        ...(topicShares ? { topicShares } : {}),
      };
    }),
    dropped,
    registry,
  };
}

function dueCardsByTopic(
  cards: readonly FlashcardEvidenceCard[],
  registry: ConceptRegistry,
  now: number
) {
  const due = new Map<string, number>();
  for (const card of cards) {
    if (!((card.reps ?? 0) > 0) || typeof card.dueDate !== "number" || !Number.isFinite(card.dueDate)) {
      continue;
    }
    if (card.dueDate > now) continue;
    for (const topicKey of expandConceptKeys(registry, flashcardTopicKeys(card))) {
      due.set(topicKey, (due.get(topicKey) ?? 0) + 1);
    }
  }
  return due;
}

/** What each kind of evidence claims; see `LearningSignal.claims`. */
const RECALL_EVIDENCE: ReadonlySet<LearningEvidenceKind> = new Set(["flashcards"]);
const APPLICATION_EVIDENCE: ReadonlySet<LearningEvidenceKind> = new Set([
  "past-paper",
  "practice",
  "notebook",
]);

function claimEstimate(
  observations: readonly LearningObservation[],
  kinds: ReadonlySet<LearningEvidenceKind>,
  now: number,
  tuning: LearningTuning,
  scoped: LearningTuning
): LearningClaimEstimate | undefined {
  const own = observations.filter((observation) => kinds.has(observation.kind));
  if (own.length === 0) return undefined;
  return {
    // Unpooled, like `evidenceMastery`: the split exists to find a gap the
    // student's average would hide.
    evidenceMastery: masteryScore(own, now, tuning),
    confidence: evidenceConfidence(own, now, scoped),
    attempts: own.reduce((total, observation) => total + observation.count, 0),
  };
}

function claimsFor(
  observations: readonly LearningObservation[],
  now: number,
  tuning: LearningTuning,
  scoped: LearningTuning
): LearningClaims | undefined {
  const recall = claimEstimate(observations, RECALL_EVIDENCE, now, tuning, scoped);
  const application = claimEstimate(observations, APPLICATION_EVIDENCE, now, tuning, scoped);
  if (!recall && !application) return undefined;
  return { ...(recall ? { recall } : {}), ...(application ? { application } : {}) };
}

export function buildLearningSignals(
  observations: readonly LearningObservation[],
  registry: ConceptRegistry,
  cards: readonly FlashcardEvidenceCard[],
  now: number,
  tuning: LearningTuning = DEFAULT_LEARNING_TUNING
): LearningSignal[] {
  const byTopic = groupObservationsByTopic(observations);
  const due = dueCardsByTopic(cards, registry, now);
  // Decided once across the scope, so every topic is judged against the same
  // picture of the student rather than each re-deriving one from its own few answers.
  const scoped = tuningWithLearnerPrior(observations, now, tuning);

  const signals: LearningSignal[] = [];
  for (const [topicKey, topicObservations] of byTopic) {
    const concept = registry.concepts.get(topicKey);
    if (!concept) continue;
    const trend = measureTrendWithinKinds(topicObservations, scoped);
    const kinds = new Set(topicObservations.map((observation) => observation.kind));
    const claims = claimsFor(topicObservations, now, tuning, scoped);
    signals.push({
      topicKey,
      topic: concept.label,
      topicSource: concept.source,
      mastery: masteryScore(topicObservations, now, scoped),
      evidenceMastery: masteryScore(topicObservations, now, tuning),
      confidence: evidenceConfidence(topicObservations, now, scoped),
      attempts: topicObservations.reduce((total, observation) => total + observation.count, 0),
      uniqueItems: countUniqueItems(topicObservations),
      accuracy: weightedAccuracy(topicObservations, scoped),
      ...(trend
        ? {
            trend: trend.trend,
            recentAccuracy: trend.recentAccuracy,
            previousAccuracy: trend.previousAccuracy,
          }
        : {}),
      dueCards: due.get(topicKey) ?? 0,
      lastSeenAt: topicObservations.reduce(
        (latest, observation) => Math.max(latest, observation.at),
        0
      ),
      evidence: EVIDENCE_ORDER.filter((kind) => kinds.has(kind)),
      ...(claims ? { claims } : {}),
    });
  }
  return signals.sort((left, right) => left.topicKey.localeCompare(right.topicKey));
}

function byRankThenRecency(rank: (signal: LearningSignal) => number) {
  return (left: LearningSignal, right: LearningSignal) =>
    rank(right) - rank(left) ||
    right.lastSeenAt - left.lastSeenAt ||
    left.topicKey.localeCompare(right.topicKey);
}

function buildCoverage(
  specification: LearnerSpecification | undefined,
  observations: readonly LearningObservation[],
  topics: readonly LearningTopicState[]
): LearningSpecificationCoverage | undefined {
  if (!specification || specification.topics.length === 0) return undefined;
  const assessed = new Set(
    observations
      .filter((observation) => observation.kind === "past-paper")
      .flatMap((observation) => observation.topicKeys)
  );
  const statesByKey = new Map(topics.map((state) => [state.topicKey, state]));
  const byDemonstration = { ...EMPTY_DEMONSTRATION_COUNTS };
  const notYetAssessed: LearningSpecificationCoverage["notYetAssessed"] = [];
  for (const topic of specification.topics) {
    const topicKey = `spec:${topic.id}`;
    byDemonstration[statesByKey.get(topicKey)?.demonstration ?? "none"] += 1;
    if (!assessed.has(topicKey)) notYetAssessed.push({ topicKey, label: topic.label });
  }
  return {
    specificationId: specification.id,
    specificationTitle: specification.title,
    totalTopics: specification.topics.length,
    assessedTopics: specification.topics.length - notYetAssessed.length,
    notYetAssessed,
    byDemonstration,
  };
}

export function buildLearnerProfile(input: {
  scope: LearnerProfileScope;
  evidence: LearnerEvidence;
  now?: number;
}): LearnerProfile {
  const now = input.now ?? Date.now();
  const { evidence } = input;
  const registry = buildEvidenceConceptRegistry(evidence);
  const { observations, dropped } = collectLearnerObservations(evidence, now, registry);
  const signals = buildLearningSignals(observations, registry, evidence.cards, now);

  const specificationTopicKeys = (evidence.specification?.topics ?? []).map((topic) => `spec:${topic.id}`);
  const concernAt = new Map<string, number>();
  for (const concern of evidence.studentConcerns ?? []) {
    const key = resolveConceptKey(registry, concern.topicKey);
    if (key && Number.isFinite(concern.at)) {
      concernAt.set(key, Math.max(concernAt.get(key) ?? 0, concern.at));
    }
  }
  const topics = buildTopicStates({
    signals,
    exposure: buildExposureByTopic({
      items: evidence.exposureItems ?? [],
      cards: evidence.cards,
      expandKeys: (keys) => expandConceptKeys(registry, keys),
    }),
    registry,
    declaredTopicKeys: [
      ...(evidence.declaredTopicKeys ?? []).flatMap((key) => {
        const resolved = resolveConceptKey(registry, key);
        return resolved ? [resolved] : [];
      }),
      ...specificationTopicKeys,
    ],
  }).map((topic) => {
    const at = concernAt.get(topic.topicKey);
    return at ? { ...topic, studentConcernAt: at } : topic;
  });
  const deferred = new Set(topics.filter((topic) => topic.deferredTo).map((topic) => topic.topicKey));

  const weaknesses = signals
    .filter(
      (signal) =>
        signal.confidence >= MIN_SIGNAL_CONFIDENCE &&
        (signal.evidenceMastery < WEAKNESS_MASTERY_BELOW ||
          (signal.trend === "declining" && signal.evidenceMastery < DECLINING_ATTENTION_BELOW))
    )
    .sort(byRankThenRecency((signal) => (1 - signal.mastery) * signal.confidence))
    .slice(0, LEARNER_PROFILE_LIMITS.weaknesses);
  const weakKeys = new Set(weaknesses.map((signal) => signal.topicKey));

  const strengths = signals
    .filter(
      (signal) =>
        !weakKeys.has(signal.topicKey) &&
        signal.trend !== "declining" &&
        // Calling a topic a strength tells the tutor to skip it, so it has to
        // be earned by this topic's own evidence and not by the student's average.
        signal.evidenceMastery >= STRENGTH_MASTERY_FROM &&
        signal.confidence >= MIN_STRENGTH_CONFIDENCE
    )
    .sort(byRankThenRecency((signal) => signal.mastery * signal.confidence))
    .slice(0, LEARNER_PROFILE_LIMITS.strengths);

  // A thin concept whose decision belongs to a broader one is not "worth checking" on its own.
  const uncertain = signals
    .filter(
      (signal) =>
        !weakKeys.has(signal.topicKey) &&
        !deferred.has(signal.topicKey) &&
        signal.confidence < MIN_SIGNAL_CONFIDENCE &&
        signal.evidenceMastery < WEAKNESS_MASTERY_BELOW
    )
    .sort(byRankThenRecency((signal) => 1 - signal.mastery))
    .slice(0, LEARNER_PROFILE_LIMITS.uncertain);

  const improving = signals
    .filter((signal) => !weakKeys.has(signal.topicKey) && signal.trend === "improving")
    .sort(
      byRankThenRecency(
        (signal) => (signal.recentAccuracy ?? 0) - (signal.previousAccuracy ?? 0)
      )
    )
    .slice(0, LEARNER_PROFILE_LIMITS.improving);

  const recurringErrors = buildRecurringErrors(observations).slice(
    0,
    LEARNER_PROFILE_LIMITS.recurringErrors
  );
  const coverage = buildCoverage(evidence.specification, observations, topics);

  const count = (kind: LearningEvidenceKind, eventsOnly = false) =>
    observations.filter(
      (observation) => observation.kind === kind && (!eventsOnly || observation.trendEligible)
    ).length;

  return {
    algorithmVersion: LEARNER_PROFILE_ALGORITHM_VERSION,
    generatedAt: now,
    scope: input.scope,
    strengths,
    weaknesses,
    uncertain,
    improving,
    topics,
    recurringErrors,
    commandWords: buildCommandWordSignals(observations, now),
    recentTrend: measureTrend(observations)?.trend ?? "unknown",
    recommendedFocus: recommendFocus(
      { topics, recurringErrors },
      LEARNER_PROFILE_LIMITS.recommendations
    ),
    recentResults: selectRecentResults({ observations, topics, now }),
    ...(coverage ? { coverage } : {}),
    evidenceSummary: {
      flashcardReviews: evidence.cards.reduce(
        (total, card) =>
          total + (Number.isFinite(card.reps) ? Math.max(0, Math.floor(card.reps ?? 0)) : 0),
        0
      ),
      flashcardReviewEvents: count("flashcards", true),
      practiceAttempts: count("practice"),
      pastPaperAttempts: count("past-paper"),
      notebookMarkings: count("notebook"),
      revisionAnswers: count("revision"),
      tutorChecks: count("tutor-check"),
      ...(observations.length > 0
        ? { lastEvidenceAt: observations[observations.length - 1]?.at }
        : {}),
    },
    diagnostics: {
      observations: observations.length,
      droppedObservations: dropped,
      topicSignals: signals.length,
      limitsReached: Array.from(new Set(evidence.limitsReached ?? [])).sort(),
      unavailableSources: Array.from(new Set(evidence.unavailableSources ?? [])).sort(),
    },
  };
}
