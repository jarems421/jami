import type {
  LearnerProfile,
  LearningTopicDecision,
  LearningTopicState,
} from "@/lib/learning/types";

/**
 * The one thing the engine would have a student do with the material open in
 * front of them, as a starting point Tutor can be asked for.
 *
 * Tutor's starting points on a notebook page used to know one fact: whether
 * the page had work on it. The engine knows far more -- that the concept has
 * never been tested, that recall holds and exam answers do not, that it was
 * strong and is fading -- and the most useful next question follows from
 * that. This reads the engine's own decision for the page's concepts and names
 * the matching starting point. It decides nothing: a concept the engine would
 * leave alone, or has no decision on, gets no engine starting point, and the
 * page keeps its ordinary ones.
 */

export type MaterialActionKind =
  /** Nothing tested yet, or too little to say: one short question finds out. */
  | "quick-check"
  /** Well evidenced as weak: teach it properly. */
  | "teach"
  /** Recall is fine and using it is not, or marked answers slipped: an exam question. */
  | "exam-question"
  /** Known before and fading: retrieve it from memory rather than re-learn it. */
  | "recall"
  /** Improving: stretch it while it is fresh. */
  | "harder";

export type MaterialAction = {
  kind: MaterialActionKind;
  /** The concept the decision is about, which may be broader than the page's own. */
  topicKey: string;
  /** Its name, as the profile has it; student-written, so shown as text only. */
  label: string;
};

function kindFor(decision: LearningTopicDecision): MaterialActionKind | undefined {
  if (decision.action === "leave_alone") return undefined;
  if (decision.action === "practice") return "exam-question";
  if (decision.action === "teach") return "teach";
  switch (decision.reason) {
    case "untested_exposure":
    case "not_yet_assessed":
    case "low_confidence":
      return "quick-check";
    case "knowledge_decay":
    case "declining_mastery":
    case "due_for_retrieval":
      return "recall";
    case "recent_improvement_needs_reinforcement":
      return "harder";
    case "low_mastery":
      return "teach";
    default:
      return undefined;
  }
}

/** The state holding a concept's decision: its own, or the broader concept it defers to. */
function decidingState(
  byKey: ReadonlyMap<string, LearningTopicState>,
  topicKey: string
): LearningTopicState | undefined {
  const state = byKey.get(topicKey);
  if (state?.decision) return state;
  return state?.deferredTo ? byKey.get(state.deferredTo) : undefined;
}

/** One concept as the notebook needs it: its name, and the engine's starting point for it. */
export type MaterialConcept = {
  label: string;
  /** From this concept's own decision, or the broader concept's it defers to. */
  action?: MaterialAction;
  /** Where the engine ranks that decision among its recommendations, lowest first. */
  rank?: number;
};

/**
 * The profile's concepts, reduced to what material in front of the student
 * needs: a name, and the engine's starting point with its rank. Computed once
 * for a whole notebook, so each page is placed without asking again.
 */
export function materialConcepts(
  profile: Pick<LearnerProfile, "topics" | "recommendedFocus">,
  /** Only these concepts; all of them when absent. */
  include?: (topicKey: string) => boolean
): Record<string, MaterialConcept> {
  const byKey = new Map(profile.topics.map((topic) => [topic.topicKey, topic]));
  const ranks = new Map<string, number>();
  profile.recommendedFocus.forEach((recommendation, index) => {
    const target = recommendation.target;
    if (target.kind === "topic" && !ranks.has(target.topicKey)) ranks.set(target.topicKey, index);
  });
  const concepts: Record<string, MaterialConcept> = {};
  for (const topic of profile.topics) {
    if (include && !include(topic.topicKey)) continue;
    const deciding = decidingState(byKey, topic.topicKey);
    const kind = deciding?.decision ? kindFor(deciding.decision) : undefined;
    const rank = deciding ? ranks.get(deciding.topicKey) : undefined;
    concepts[topic.topicKey] = {
      label: topic.label,
      ...(deciding && kind ? { action: { kind, topicKey: deciding.topicKey, label: deciding.label } } : {}),
      ...(kind && rank !== undefined ? { rank } : {}),
    };
  }
  return concepts;
}

/**
 * The engine's starting point for material on these concepts, or nothing.
 *
 * Where it sits on several, the one the engine ranks highest among its
 * recommendations wins; failing that, the first with a decision.
 */
export function pickMaterialAction(
  concepts: Readonly<Record<string, MaterialConcept>>,
  conceptKeys: readonly string[]
): MaterialAction | undefined {
  let best: { action: MaterialAction; rank: number } | undefined;
  for (const key of conceptKeys) {
    const concept = concepts[key];
    if (!concept?.action) continue;
    const rank = concept.rank ?? Number.POSITIVE_INFINITY;
    if (!best || rank < best.rank) best = { action: concept.action, rank };
  }
  return best?.action;
}
