import type {
  AiGenerationRole,
  AiReasoningEffort,
  AiRouteDecision,
  AiRouteReason,
} from "@/lib/ai/provider-policy";
import type { ReasoningEffortPreference } from "@/lib/profile/reasoning-effort";

/**
 * How a Tutor answer is thought about: quickly, with more thought, or deeply.
 *
 * Measured on Tutor-sized questions (October 2026), the fast model answered in
 * one to five seconds and the thinking model in fifteen to a hundred, a third of
 * the time breaking before it finished. On hard competition problems the fast
 * model was right nine times in ten at low effort and at high alike. So more
 * thought is cheap on the fast model, and the thinking role is kept for what
 * earns its place: a disputed answer, an idea that keeps coming back, a request
 * too long or too widely sourced to take in quickly.
 *
 * - quick: the fast model, little thought. Definitions, recall, hints.
 * - think: the fast model, thinking hard. Problems, proofs, marking, "why".
 * - deep: the thinking role, its fastest model first (Kimi K3, then Qwen).
 */
export type TutorThinkingTier = "quick" | "think" | "deep";

export type TutorThinkingChoice = {
  tier: TutorThinkingTier;
  reason: AiRouteReason;
  /**
   * Whether the request settled it. When it did not, a one-line routing call
   * may still move a question up a tier (`tutor-routing-preflight.ts`).
   */
  settled: boolean;
};

/** A recall question: short, and asking what something is, not working it out. */
const QUICK_PATTERN =
  /^(?:what (?:is|are|was|were|does|do)|what's|define|definition of|meaning of|name|list|give me (?:one|a|an) (?:hint|example|word)|translate|spell|when (?:is|was|did)|who (?:is|was|discovered|invented)|where (?:is|was)|yes or no|is it|true or false|remind me)\b/i;

/** Thanks and the like, which need no thought at all. */
const CHAT_PATTERN =
  /^(?:thanks|thank you|thx|cheers|ok(?:ay)?|cool|great|nice|got it|perfect|hi|hello|hey)\b[\s!.,]*$/i;

/** Working something out: a problem to solve, a claim to show, a reason to give. */
const PROBLEM_PATTERN =
  /\b(?:solve|calculate|work out|compute|find|show that|prove|derive|evaluate|simplify|factori[sz]e|expand|differentiate|integrate|rearrange|how many|how much|how long|how far|why|explain why|explain how|compare|justify|mark (?:my|this)|check my|where did i go wrong|step[- ]by[- ]step|full solution)\b/i;

/** The marks of maths in a message: an equation, a power, a fraction, LaTeX. */
const MATHS_PATTERN = /\d\s*[-+*/^=<>]\s*[\d(a-z]|[a-z]\s*\^|\\[a-z]{2,}|\$[^$\n]+\$|\b\d+\s*\/\s*\d+\b|[=≤≥≠√∫∑π]/i;

/** "(a)", "(ii)", "part b": a question in parts. */
const PARTS_PATTERN = /\((?:[a-h]|i{1,3}|iv|v)\)|\bpart\s+[a-h]\b/i;

/** The reasons the request itself gives for the thinking role. */
const DEEP_REASONS: readonly AiRouteReason[] = ["repeated_concept", "many_sources", "long_request"];

/**
 * The tier for one question, from the student's level and what the question
 * asks. Auto reads the question; Low, Medium and High choose a tier outright.
 * A challenged answer keeps its stronger route at every level, the juror
 * included: a preference cannot make a dispute cheaper to settle.
 */
export function chooseTutorThinking(input: {
  preference: ReasoningEffortPreference | undefined;
  /** What the deterministic rules made of the request (`decideTutorRoute`). */
  decision: AiRouteDecision;
  message: string;
  /** A notebook page the student asked to have marked, read the routine way. */
  routineNotebookMarking: boolean;
  /** "Check my working" on a notebook page (`requestsWorkingCheck`). */
  workingCheck?: boolean;
  /** Whether the student sent a picture or file with the question. */
  hasAttachments?: boolean;
}): TutorThinkingChoice {
  const { decision } = input;
  if (decision.role === "juror" || decision.reason === "student_correction") {
    return { tier: "deep", reason: decision.reason, settled: true };
  }
  const preference = input.preference ?? "auto";
  if (preference === "low") return { tier: "quick", reason: "student_preference", settled: true };
  if (preference === "medium") return { tier: "think", reason: "student_preference", settled: true };
  if (preference === "high") return { tier: "deep", reason: "student_preference", settled: true };

  if (DEEP_REASONS.includes(decision.reason)) return { tier: "deep", reason: decision.reason, settled: true };
  // A working check is worth its independent working, which only Think and Deep turns look up.
  if (input.workingCheck) return { tier: "think", reason: "complex_request", settled: true };
  if (input.routineNotebookMarking) return { tier: "think", reason: "routine", settled: true };
  if (decision.reason === "complex_request") return { tier: "think", reason: "complex_request", settled: true };

  const message = input.message.trim();
  if (CHAT_PATTERN.test(message)) return { tier: "quick", reason: "routine", settled: true };
  const working = PROBLEM_PATTERN.test(message) || MATHS_PATTERN.test(message) || PARTS_PATTERN.test(message);
  if (working) return { tier: "think", reason: "complex_request", settled: true };
  // A picture of a question is usually a question to work, whatever the words say.
  if (input.hasAttachments) return { tier: "think", reason: "routine", settled: true };
  if (message.length <= 220 && QUICK_PATTERN.test(message)) return { tier: "quick", reason: "routine", settled: true };
  // Neither plainly recall nor plainly a problem: answered with thought, unless the preflight says more.
  return { tier: "think", reason: "routine", settled: false };
}

/** How each tier is answered: which role, how hard it thinks, and whether its fastest model goes first. */
export function tutorThinkingRoute(
  tier: TutorThinkingTier,
  reason: AiRouteReason
): { role: AiGenerationRole; reasoningEffort: AiReasoningEffort; preferStandby: boolean } {
  if (tier === "quick") return { role: "worker", reasoningEffort: "low", preferStandby: false };
  if (tier === "think") return { role: "worker", reasoningEffort: "high", preferStandby: false };
  /*
   * The thinking role, with its standby (Kimi K3) first: correct with its
   * working shown, first words in about a second, where Qwen took fifteen to a
   * hundred. Not after a juror's review, which is Kimi too: the answer that
   * reconciles it stays on the other family.
   */
  return { role: "supervisor", reasoningEffort: "high", preferStandby: reason !== "second_correction" };
}
