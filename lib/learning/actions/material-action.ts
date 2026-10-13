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

/**
 * The engine's starting point for this material, or nothing.
 *
 * Where the page sits on several concepts, the one the engine ranks highest
 * among its recommendations wins; failing that, the first with a decision.
 */
export function materialActionFor(
  profile: Pick<LearnerProfile, "topics" | "recommendedFocus">,
  conceptKeys: readonly string[]
): MaterialAction | undefined {
  if (conceptKeys.length === 0) return undefined;
  const byKey = new Map(profile.topics.map((topic) => [topic.topicKey, topic]));
  const states = conceptKeys.flatMap((key) => {
    const state = decidingState(byKey, key);
    return state ? [state] : [];
  });
  const ranked = profile.recommendedFocus.flatMap((recommendation) => {
    const target = recommendation.target;
    if (target.kind !== "topic") return [];
    const state = states.find((candidate) => candidate.topicKey === target.topicKey);
    return state ? [state] : [];
  });
  for (const state of [...ranked, ...states]) {
    const kind = state.decision ? kindFor(state.decision) : undefined;
    if (kind) return { kind, topicKey: state.topicKey, label: state.label };
  }
  return undefined;
}
