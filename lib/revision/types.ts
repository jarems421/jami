import type { LearningErrorCategory, LearningTopicSource } from "@/lib/learning/types";

/**
 * A Revision Session: Jami teaching the thing the Learning Engine says needs
 * teaching. See `docs/revision-sessions.md`.
 *
 * The shapes here are the whole contract between the three parties. The state
 * machine in `session-machine.ts` owns the order of steps; the model fills in a
 * `RevisionLesson` and marks answers; the store keeps a `RevisionSessionRecord`
 * holding nothing the student typed.
 */

export const REVISION_SESSION_SCHEMA_VERSION = 1;
export const REVISION_SESSIONS_COLLECTION = "revisionSessions";

/**
 * Which path through the framework a session takes.
 *
 * Only `teach` exists in Stage 1. `diagnose` and `reinforce` are the same
 * machine with different paths, and arrive with the engine decisions they
 * answer.
 */
export type RevisionPolicy = "teach";

/**
 * One kind of step. Internal names: the student never sees these words.
 *
 * `retry` is not on any policy's path. It is inserted after a guided attempt
 * that went wrong, once.
 */
export type RevisionStepKind =
  | "orient"
  | "explain"
  | "guided"
  | "retry"
  | "independent"
  | "apply"
  | "retrieve";

export type RevisionAnswerStepKind = Extract<
  RevisionStepKind,
  "guided" | "retry" | "independent" | "apply" | "retrieve"
>;

export type RevisionVerdict = "correct" | "partial" | "incorrect";

/**
 * What kind of mistake a wrong or partial answer was. A fixed list, named by
 * the marker, used only to choose what to offer next -- never to judge what
 * the student knows. See `next-steps.ts`.
 */
export const REVISION_MISTAKES = ["concept", "method", "slip"] as const;
export type RevisionMistake = (typeof REVISION_MISTAKES)[number];

/**
 * Whether a value, typically one a model returned, is one of the three kinds
 * of mistake. Tutor's notebook marking uses the same three to choose what to
 * offer next.
 */
export function isRevisionMistake(value: unknown): value is RevisionMistake {
  return REVISION_MISTAKES.some((mistake) => mistake === value);
}

export type RevisionSessionStatus =
  | "preparing"
  | "active"
  | "completed"
  | "abandoned"
  | "failed";

/** One question the student answers, with everything needed to mark it. */
export type RevisionTask = {
  prompt: string;
  /** One nudge, never the answer. */
  hint: string;
  /** The answer in its shortest correct form. */
  answer: string;
  /** What a correct answer must contain, one point per line. */
  markScheme: string[];
  /** The answer worked through, shown once the step is over. */
  solution: string;
};

/**
 * Everything the model writes for one session, generated once at the start.
 *
 * Teaching material, not learner data: it describes the concept, not the
 * student. It is still deleted when the session ends, because nothing reads it
 * afterwards and it holds the answers.
 */
export type RevisionLesson = {
  /** Three short things the session will cover, in the student's terms. */
  goals: string[];
  /** One or two sentences that set up why this idea matters. */
  orientation: string;
  explanation: {
    body: string;
    example: { problem: string; steps: string[] };
  };
  guided: RevisionTask;
  independent: RevisionTask;
  apply: RevisionTask;
  retrieve: RevisionTask;
  /** Written only if the guided attempt goes wrong. */
  retry?: { explanation: string; task: RevisionTask };
};

/**
 * What happened at one step, and nothing the student wrote.
 *
 * `score` is 0 to 1. A skipped step scores 0. A self-graded step keeps the
 * student's own call for the flow but is never evidence.
 */
export type RevisionStepRecord = {
  kind: RevisionStepKind;
  attempts: number;
  verdict?: RevisionVerdict;
  score?: number;
  errorCategory?: LearningErrorCategory;
  mistake?: RevisionMistake;
  hintUsed: boolean;
  skipped: boolean;
  selfGraded: boolean;
  /** When the step was resolved -- answered, skipped or self-graded. */
  resolvedAt?: number;
};

export type RevisionTarget = {
  topicKey: string;
  source: LearningTopicSource;
  /** Resolved on the server from the engine, never taken from a request. */
  conceptLabel: string;
  folderId?: string;
  deckId?: string;
};

export type RevisionSessionRecord = {
  id: string;
  schemaVersion: typeof REVISION_SESSION_SCHEMA_VERSION;
  policy: RevisionPolicy;
  status: RevisionSessionStatus;
  target: RevisionTarget;
  /**
   * The engine's recommendation on this concept, when there is one. A session
   * the student started themselves on a concept the engine had nothing to say
   * about has none -- and still counts, because its concept is real.
   */
  actionId?: string;
  /** The engine's reasons, in student language, for "Why this?". */
  why: string[];
  lesson?: RevisionLesson;
  steps: RevisionStepRecord[];
  /** Index into `steps` of the step on screen. Equal to its length once finished. */
  position: number;
  /** When a model call for this session started, so two cannot run at once. */
  workingSince?: number;
  createdAt: number;
  updatedAt: number;
  /** Set only on completion, which is what the evidence query orders by. */
  completedAt?: number;
  /** When an unfinished session was closed off -- abandoned or failed. */
  endedAt?: number;
  /** Chosen by rule when the session finishes. See `next-steps.ts`. */
  nextSteps?: RevisionNextStep[];
};

/**
 * Something to do after a session, chosen from what happened in it.
 *
 * Holds a kind and a concept, never content: the flashcards or questions are
 * written, or found, only when the student asks for them.
 */
export type RevisionNextStepKind = "flashcards" | "review-cards" | "practice" | "exam-questions" | "session";

export type RevisionNextStep = {
  kind: RevisionNextStepKind;
  /** Why this, in the student's terms. Chosen by rule, never by the model. */
  reason: string;
  topicKey: string;
  conceptLabel: string;
  folderId: string;
  /** The specification concept id, where Jami can write material for it. */
  conceptId?: string;
  /** Where "Do it now" goes, for the kinds that are a link. */
  href?: string;
};
