/**
 * The Jami Learning Engine's shared vocabulary.
 *
 * The engine answers one question for every surface that needs it: what does
 * Jami currently believe this student knows, struggles with, and should do
 * next? Everything here is calculated deterministically from work the student
 * has already done -- flashcard reviews, marked practice-paper answers, marked
 * past-paper answers -- and no model is asked to estimate any of it. A model
 * is handed the result to talk about, which keeps the numbers consistent,
 * testable, and improvable without touching a prompt.
 *
 * Two numbers travel with every claim and they mean different things:
 * `mastery` is how well Jami thinks the student knows something, and
 * `confidence` is how much evidence stands behind that estimate. 85% mastery at
 * 18% confidence means "looks strong, barely tested", and every consumer is
 * expected to treat it that way.
 *
 * A third distinction sits beside them: exposure. A student can have notes,
 * sources and cards on a topic without ever having answered anything about it.
 * That is "seen", not "known", and the engine keeps the two apart.
 */

export const LEARNER_PROFILE_ALGORITHM_VERSION = "learner-profile-v10-2026-10-01";

/**
 * Where a piece of evidence came from.
 *
 * `notebook` is the weakest of the four and is kept separate for that reason.
 * The others are answers to a question with a known right answer, marked
 * against a scheme. Notebook working is marked by Tutor against a question the
 * student was answering, which is real evidence -- it is the student's own
 * reasoning, graded -- but it is graded by a model rather than a scheme, on
 * work the student chose rather than work that was set. It counts, at a
 * fraction of the weight, and never on its own: see `NOTEBOOK_EVIDENCE_WEIGHT`.
 *
 * `revision` is the same kind of evidence from a different place: answers
 * given during a Revision Session, marked by a model against the question the
 * session set. Trusted exactly as far as notebook marking, and kept apart from
 * it only so the two can be told apart. See `revision-signals.ts`.
 *
 * `tutor-check` is the weakest: one short question Tutor asked in chat and
 * marked on the reply, often just after explaining the idea. See
 * `tutor-check-signals.ts`.
 */
export type LearningEvidenceKind =
  | "flashcards"
  | "practice"
  | "past-paper"
  | "notebook"
  | "revision"
  | "tutor-check";

export type LearningTrend = "improving" | "stable" | "declining";

/**
 * Recurring ways of losing marks the engine can name. Stable identifiers:
 * display wording lives beside the detection rules, never in these ids.
 *
 * A fixed vocabulary on purpose. Criterion wording is written per question
 * ("states the gradient", "Mark 2"), so grouping it any other way would mean
 * either a model deciding which slips are "the same" -- the inference the
 * engine exists to keep deterministic -- or passing marker prose into a prompt.
 */
export const LEARNING_ERROR_CATEGORIES = [
  "missing_units",
  "incorrect_precision",
  "insufficient_justification",
  "missing_working",
  "terminology_misuse",
  "graph_error",
  "comparison_error",
] as const;

export type LearningErrorCategory = (typeof LEARNING_ERROR_CATEGORIES)[number];

/** Whether a value, typically one a model returned, is on the fixed list. */
export function isLearningErrorCategory(value: unknown): value is LearningErrorCategory {
  return LEARNING_ERROR_CATEGORIES.some((category) => category === value);
}

/**
 * How a recurring-error chance was recognised, strongest first: the marker's
 * structured scheme and candidate values, then the criterion's wording, then
 * the marker's improvement note.
 */
export type LearningErrorDetection = "marking-values" | "criterion-wording" | "marker-note";

/** Whether one marked answer could show a category, and whether it lost credit on it. */
export type LearningErrorCheck = {
  category: LearningErrorCategory;
  missed: boolean;
  detection: LearningErrorDetection;
};

/** One piece of recorded work, reduced to what the engine scores. */
export type LearningObservation = {
  kind: LearningEvidenceKind;
  /** The stored record this came from, so the same record can never count twice. */
  evidenceId: string;
  /** What was answered: a card, a bank question, a practice-paper question. */
  itemId: string;
  /**
   * Namespaced topic keys -- `topic:<id>`, `deck:<id>` or `spec:<id>` -- or
   * none when the work carries no topic, as practice-paper questions do not.
   */
  topicKeys: string[];
  /**
   * How much of the answer is about each of `topicKeys`, when it tests more
   * than one distinct concept. A missing map, or a missing key, means the
   * whole answer.
   */
  topicShares?: Readonly<Record<string, number>>;
  /** The command word a marked question opened with, where it printed one. */
  commandWord?: string;
  /**
   * The recommendation whose session produced this answer, when one did.
   *
   * Provenance, not scoring: nothing weighs an observation differently for
   * having it. It exists so the engine can ask whether the work it asked for
   * was actually done, without inferring that from timestamps.
   */
  interventionId?: string;
  /** 0 to 1: the share of the available credit that was earned. */
  score: number;
  /** How much this observation counts towards mastery, before recency. */
  weight: number;
  /** How many answers it stands for: a card's review count, otherwise 1. */
  count: number;
  /** When it happened, epoch ms. */
  at: number;
  /**
   * Whether a time series over observations like this one is a real change
   * over time.
   *
   * False for a card read from its aggregate scheduling state, which says
   * nothing about when each review happened. True for a recorded review event.
   */
  trendEligible: boolean;
  /**
   * The score is an estimate of what is known *now*, not a measurement taken
   * at `at`.
   *
   * True for a card scored from the scheduler's fitted memory, which has
   * already accounted for the time since the last review. Recency weighting
   * must not be applied on top of such a score or the age is charged twice --
   * but the evidence behind it is still old, so confidence keeps fading it.
   */
  currentEstimate?: boolean;
  errorChecks: LearningErrorCheck[];
};

export type LearningTopicSource = "student-topic" | "deck" | "specification";

export type LearningTopicLabel = {
  label: string;
  source: LearningTopicSource;
};

/**
 * Where a concept came from, which decides whether it may be reasoned over.
 *
 * `verified_specification`: from an exam specification catalogue a person has
 * checked. `jami_curated`: a Jami-maintained concept list a person has checked.
 * `student_defined`: a Topic the student created -- true for them, with
 * boundaries that are theirs. `fallback`: a deck standing in for a concept
 * because its cards have none. `ai_suggested`: a draft nobody has checked; it
 * can be reviewed, never treated as truth.
 */
export const CONCEPT_PROVENANCES = [
  "verified_specification",
  "jami_curated",
  "student_defined",
  "fallback",
  "ai_suggested",
] as const;

export type ConceptProvenance = (typeof CONCEPT_PROVENANCES)[number];

/**
 * A concept the engine can reason about.
 *
 * Identified by its key, never by its label: labels change, and two concepts
 * can share one. The key is namespaced by where the concept lives -- `spec:`,
 * `topic:` or `deck:` -- and a parent makes finer concepts roll up into broader
 * ones, so evidence on "Quadratic equations" is also evidence on "Algebra".
 */
export type LearningConcept = {
  key: string;
  label: string;
  source: LearningTopicSource;
  provenance: ConceptProvenance;
  /** Checked by a person. Only meaningful for catalogue provenance; a student's own Topic is true for them. */
  verified: boolean;
  parentKey?: string;
  aliases?: string[];
  /** The board's own reference, such as "A13" -- metadata, never identity. */
  reference?: string;
};

export type LearningSignal = {
  topicKey: string;
  /** Display name. Student-written for topics and decks, so never trusted. */
  topic: string;
  topicSource: LearningTopicSource;
  /**
   * 0 to 1: how well Jami thinks the student knows this, pooled towards how
   * they do across the whole scope. The better estimate, and what to show.
   */
  mastery: number;
  /**
   * 0 to 1: what this topic's own evidence shows, before any pooling.
   *
   * Every threshold reads this rather than `mastery`, because the two answer
   * different questions. Pooling is right about the estimate -- one wrong
   * answer from a strong student probably is noise -- but a gap that is only
   * hidden by the student's own average is exactly the gap worth finding, and
   * judging "is this worth checking" on the pooled number would bury it.
   */
  evidenceMastery: number;
  /** 0 to 1: how much evidence stands behind `mastery`. */
  confidence: number;
  /** Answers behind the estimate: reviews for flashcards, marked answers otherwise. */
  attempts: number;
  /** Distinct cards and questions behind the estimate. */
  uniqueItems: number;
  /** Weighted accuracy over all of the evidence, with no recency and no prior. */
  accuracy: number;
  /** Present only when a trend could be measured. */
  trend?: LearningTrend;
  recentAccuracy?: number;
  previousAccuracy?: number;
  /** Reviewed flashcards on this topic that are due now. */
  dueCards: number;
  lastSeenAt: number;
  evidence: LearningEvidenceKind[];
  /**
   * The same evidence split by what it claims: recall from flashcards,
   * application from marked exam, practice and notebook answers.
   *
   * `mastery` above blends the two, which is right for "how well is this
   * known" and wrong for "what kind of work would help". A student can recall
   * a method every time and still lose marks using it, and only the split can
   * see that. Notebook working was once left out of both, as marked by a model
   * rather than a scheme. It counts as application since 28 September 2026,
   * by the owner's decision: without it a student's own Topic could never show
   * the gap, because only specification concepts have exam answers. It keeps
   * its lower weight, so it takes more marked pages than exam answers to make
   * the claim.
   */
  claims?: LearningClaims;
};

/** One kind of claim, estimated from its own evidence only. */
export type LearningClaimEstimate = {
  /** 0 to 1, with no pooling towards the student's average. */
  evidenceMastery: number;
  /** 0 to 1: how much evidence of this kind stands behind it. */
  confidence: number;
  attempts: number;
};

export type LearningClaims = {
  recall?: LearningClaimEstimate;
  application?: LearningClaimEstimate;
};

/**
 * Material the student has on a topic, as counts -- never its content.
 *
 * Having notes on something is a reason to check it, not evidence of knowing
 * it, so exposure never moves mastery or confidence.
 */
export type LearningExposure = {
  notebooks: number;
  sources: number;
  cards: number;
  lastExposedAt?: number;
};

/**
 * What the evidence says about a topic, and only that.
 *
 * `none`: nothing answered. `insufficient`: answered, but too little to call.
 * `weak`, `developing`, `strong`: enough evidence to say, in that order.
 */
export type LearningDemonstration = "none" | "insufficient" | "weak" | "developing" | "strong";

/**
 * Memory states the evidence can justify.
 *
 * `due`: the scheduler has cards on this topic due now -- its own judgement,
 * not a forecast of ours. `decaying`: dated evidence shows the topic was strong
 * in an earlier window and has fallen since. A topic with no dated history can
 * be due but never decaying.
 */
export type LearningMemoryState = "due" | "decaying";

/**
 * Recurring errors in their life.
 *
 * `emerging`: lost more than once, not yet well established. `active`:
 * established and still happening. `improving`: the latest chances earned the
 * mark. `likely_resolved`: a run of successes across more than one question --
 * never a single correct answer.
 */
export type LearningErrorStatus = "emerging" | "active" | "improving" | "likely_resolved";

export type LearningError = {
  category: LearningErrorCategory;
  label: string;
  /** Marked answers that lost credit on this. */
  occurrences: number;
  /** Marked answers where a criterion of this kind applied at all. */
  opportunities: number;
  /** Distinct questions the credit was lost on. */
  uniqueItems: number;
  confidence: number;
  status: LearningErrorStatus;
  lastSeenAt: number;
  lastOpportunityAt: number;
  evidence: LearningEvidenceKind[];
  detection: LearningErrorDetection[];
};

/** Why something is recommended. Ordered strongest first in `recommend-focus`. */
export type LearningRecommendationReason =
  | "persistent_error"
  | "declining_mastery"
  | "knowledge_decay"
  | "low_mastery"
  | "low_confidence"
  | "due_for_retrieval"
  | "recent_improvement_needs_reinforcement"
  | "untested_exposure"
  | "not_yet_assessed";

/**
 * What kind of activity would help.
 *
 * `leave_alone` is a real decision rather than an absence of one: the topic is
 * strong, well evidenced and not due, and study time is better spent elsewhere.
 * It is never offered as something to do.
 */
export type LearningAction =
  | "leave_alone"
  | "diagnose"
  | "teach"
  | "practice"
  | "retrieve"
  | "reinforce"
  | "review";

export type LearningTopicDecision = {
  action: LearningAction;
  reason: LearningRecommendationReason | "stable_strength";
};

/** Everything the engine believes about one topic in scope. */
export type LearningTopicState = {
  topicKey: string;
  label: string;
  source: LearningTopicSource;
  provenance: ConceptProvenance;
  parentKey?: string;
  /** On the folder's own topic list or its specification, whatever the evidence. */
  declared: boolean;
  /** Includes material on finer concepts beneath this one. */
  exposure: LearningExposure;
  demonstration: LearningDemonstration;
  memory: LearningMemoryState[];
  /** Includes evidence on finer concepts beneath this one. */
  signal?: LearningSignal;
  /**
   * Recall is holding up and application is not: flashcards on this concept,
   * or on the student's own Topic that covers it, read strong, while marked
   * exam and practice answers on this concept read weak.
   *
   * `recallFrom` is where the recall evidence sits, so a sentence about it can
   * name the Topic the student actually studied instead of implying they
   * drilled this exact concept. The broad Topic's cards never become evidence
   * about the concept; they only say what kind of work is missing.
   */
  applicationGap?: { recallFrom: string; recallLabel: string };
  /** Absent when nothing is warranted, or when the decision belongs to a broader concept. */
  decision?: LearningTopicDecision;
  /**
   * The broader concept that holds the decision instead: this one has too
   * little evidence of its own to be judged, and the ancestor has enough.
   */
  deferredTo?: string;
  /**
   * Finer concepts whose own well-evidenced decisions explain this one's, so
   * a recommendation goes to them rather than to this broader concept.
   */
  coveredBy?: string[];
  /**
   * When the student last told Tutor this feels hard, while it still counts.
   *
   * What the student says, not what they did: like exposure it never moves
   * mastery, confidence or a decision. It only moves a topic the engine
   * already recommends ahead of others recommended for the same reason, and
   * lets Tutor know the student raised it.
   */
  studentConcernAt?: number;
};

export type LearningRecommendationTarget =
  | { kind: "topic"; topicKey: string; label: string; source: LearningTopicSource }
  | { kind: "error"; category: LearningErrorCategory; label: string };

/** The evidence behind a recommendation, so any consumer can say why. */
export type LearningRecommendationEvidence = {
  count: number;
  uniqueItems: number;
  mastery?: number;
  confidence?: number;
  trend?: LearningTrend;
  recentAccuracy?: number;
  previousAccuracy?: number;
  dueCards?: number;
  exposure?: LearningExposure;
  lastEvidenceAt?: number;
  sources: LearningEvidenceKind[];
  /** The student has said they find this hard; see `LearningTopicState.studentConcernAt`. */
  studentConcernAt?: number;
};

export type LearningRecommendation = {
  reason: LearningRecommendationReason;
  action: Exclude<LearningAction, "leave_alone">;
  /** Higher first. The integer part is the reason's band, the fraction orders within it. */
  priority: number;
  target: LearningRecommendationTarget;
  evidence: LearningRecommendationEvidence;
};

export type LearnerProfileScope = {
  folderId?: string;
  deckId?: string;
  /** The decks whose cards were read, for a folder profile. */
  deckIds?: string[];
};

/** A read cap that was reached, so the profile saw only the most recent part of that evidence. */
export type LearnerEvidenceLimit =
  | "decks"
  | "cards"
  | "flashcard-events"
  | "exam-sessions"
  | "exam-attempts"
  | "practice-papers"
  | "practice-attempts"
  | "topic-labels"
  | "notebooks"
  | "sources";

/** Evidence that could not be read at all this time. */
export type LearnerEvidenceSource = "flashcard-events" | "exposure";

/**
 * What the folder's exam specification expects, against what has been tested.
 *
 * The point is the distinction it keeps: a topic with no marked past-paper
 * answers is not yet assessed, which is a different thing from weak.
 */
export type LearningSpecificationCoverage = {
  specificationId: string;
  specificationTitle: string;
  totalTopics: number;
  assessedTopics: number;
  notYetAssessed: { topicKey: string; label: string }[];
  /** Every specification topic, counted by what its evidence shows. */
  byDemonstration: Record<LearningDemonstration, number>;
};

export type LearnerEvidenceSummary = {
  /** Lifetime reviews across the cards in scope, from their scheduling totals. */
  flashcardReviews: number;
  /** Recorded review events used, counting a card once per study day. */
  flashcardReviewEvents: number;
  practiceAttempts: number;
  pastPaperAttempts: number;
  /** Notebook pages Tutor marked when the student asked, one per piece of work. */
  notebookMarkings: number;
  /** Counted steps of finished Revision Sessions. */
  revisionAnswers: number;
  /** Answered Tutor quick checks. */
  tutorChecks: number;
  lastEvidenceAt?: number;
};

export type LearnerProfileDiagnostics = {
  observations: number;
  /** Malformed or duplicate records left out. */
  droppedObservations: number;
  topicSignals: number;
  limitsReached: LearnerEvidenceLimit[];
  unavailableSources: LearnerEvidenceSource[];
};

/**
 * How a student does on questions that open with one command word, across
 * enough different questions for it to describe a pattern.
 */
export type LearningCommandWordSignal = {
  commandWord: string;
  attempts: number;
  uniqueItems: number;
  /** 0 to 1: the share of available credit earned on these questions. */
  accuracy: number;
  confidence: number;
  lastSeenAt: number;
};

/** How the latest attempt at one item went. See `profile/recent-results.ts`. */
export type LearningRecentOutcome = "missed" | "partial" | "correct";

export type LearningRecentResult = {
  kind: LearningEvidenceKind;
  /** `card:<id>`, `paper:<paperId>:<questionId>`, `exam:<questionId>`, and so on. */
  itemId: string;
  topicKey?: string;
  topicLabel?: string;
  outcome: LearningRecentOutcome;
  /** The latest attempt's share of the credit, 0 to 1. */
  score: number;
  at: number;
  /** Attempts in the window, and how many of them went wrong. */
  attempts: number;
  misses: number;
  /** Where the latest attempt lost marks, from the fixed vocabulary. */
  missedErrors: LearningErrorCategory[];
};

export type LearnerProfile = {
  algorithmVersion: string;
  generatedAt: number;
  scope: LearnerProfileScope;
  strengths: LearningSignal[];
  weaknesses: LearningSignal[];
  /** Looks weak, but on too little evidence to say so: things to check, not facts. */
  uncertain: LearningSignal[];
  /** Measurably improving and not currently weak. */
  improving: LearningSignal[];
  /** Every labelled topic in scope, with its state and decision. */
  topics: LearningTopicState[];
  recurringErrors: LearningError[];
  /**
   * Accuracy by command word, the instruction costing the most marks first.
   * Absent from profiles built before command words were read.
   */
  commandWords?: LearningCommandWordSignal[];
  /** "unknown" when there is not enough dated evidence to say either way. */
  recentTrend: LearningTrend | "unknown";
  recommendedFocus: LearningRecommendation[];
  /**
   * The latest attempts at individual items in the last three weeks, wrong
   * answers first. Absent from profiles built before this was kept.
   */
  recentResults?: LearningRecentResult[];
  coverage?: LearningSpecificationCoverage;
  evidenceSummary: LearnerEvidenceSummary;
  diagnostics: LearnerProfileDiagnostics;
};
