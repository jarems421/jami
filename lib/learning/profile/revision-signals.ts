import { markedAnswerWeight } from "@/lib/learning/profile/marked-answer";
import { isValidEvidenceTime } from "@/lib/learning/evidence-time";
import { isLearningErrorCategory, type LearningObservation } from "@/lib/learning/types";

/**
 * A finished Revision Session, as the Learning Engine reads it.
 *
 * Ids, scores and times: nothing the student wrote and nothing the model said.
 * See `docs/revision-sessions.md`.
 */
export type RevisionSessionEvidence = {
  id: string;
  /** The recommendation the session answered, when it answered one. */
  actionId?: string;
  topicKey: string;
  completedAt: number;
  steps: readonly RevisionEvidenceStep[];
};

export type RevisionEvidenceStep = {
  kind: string;
  score?: number;
  skipped: boolean;
  selfGraded: boolean;
  errorCategory?: string;
  resolvedAt?: number;
};

/**
 * The steps that say what a student can do alone.
 *
 * The guided step and its retry are left out on purpose. They are answered
 * straight after a worked example, often with a hint, and getting one right
 * says the explanation was followed -- not that the idea can be used. Counting
 * them would let a session inflate the evidence for the very topic it was
 * opened because the evidence was weak.
 */
const COUNTED_STEPS: ReadonlySet<string> = new Set(["independent", "apply", "retrieve"]);

/** Each step is one short question, marked as a whole. */
const STEP_MARKS = 1;

const TOPIC_KEY_PATTERN = /^(topic|deck|spec):.+/;

/**
 * One observation per counted step.
 *
 * Model-marked, so these are `revision` evidence and weighted exactly as
 * notebook marking is (`evidenceSourceWeight`): real, and never enough to
 * decide a topic alone. A skipped step is a 0 -- "I'm not sure" is an honest
 * answer about what is known. A self-graded step, where the marker failed and
 * the student judged themselves, is not evidence at all: a self-report about
 * one's own answer is the one thing the engine refuses to count.
 */
export function revisionObservations(
  sessions: readonly RevisionSessionEvidence[]
): LearningObservation[] {
  const observations: LearningObservation[] = [];
  const seen = new Set<string>();

  for (const session of sessions) {
    if (!session.id || !TOPIC_KEY_PATTERN.test(session.topicKey)) continue;
    if (!isValidEvidenceTime(session.completedAt)) continue;

    for (const step of session.steps) {
      if (!COUNTED_STEPS.has(step.kind) || step.selfGraded) continue;
      const at = step.resolvedAt ?? session.completedAt;
      if (!isValidEvidenceTime(at)) continue;
      const score = step.skipped
        ? 0
        : typeof step.score === "number" && Number.isFinite(step.score)
          ? Math.min(1, Math.max(0, step.score))
          : null;
      if (score === null) continue;

      const itemId = `revision:${session.id}:${step.kind}`;
      if (seen.has(itemId)) continue;
      seen.add(itemId);

      observations.push({
        kind: "revision",
        evidenceId: itemId,
        itemId,
        topicKeys: [session.topicKey],
        score,
        weight: markedAnswerWeight(STEP_MARKS),
        count: 1,
        at,
        trendEligible: true,
        ...(session.actionId ? { interventionId: session.actionId } : {}),
        errorChecks: isLearningErrorCategory(step.errorCategory)
          ? [{ category: step.errorCategory, missed: true, detection: "marker-note" }]
          : [],
      });
    }
  }

  return observations;
}
