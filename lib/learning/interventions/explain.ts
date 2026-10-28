import type {
  InterventionChoice,
  InterventionReason,
  InterventionType,
} from "@/lib/learning/interventions/catalogue";
import type { LearningEvidenceKind, LearningRecommendationEvidence } from "@/lib/learning/types";
import { PLAN_MINUTES_PER_ITEM } from "@/lib/planning/types";

/**
 * The engine's decision, said to the student.
 *
 * Every sentence here is looked up from the decision, never written by a model
 * and never assembled from a score. That is the whole design: a student asking
 * "why this?" is asking Jami to account for itself, and an answer that varied
 * between two identical situations would not be an account of anything.
 *
 * Two rules hold it together.
 *
 * **Nothing internal escapes.** `recall_strong_application_weak` is how the
 * catalogue names a situation; "Your recall is strong, but application is
 * weaker" is that situation in the student's own words. No reason code, action
 * type, intervention id, mastery value, confidence or evidence weight appears
 * in anything this module returns.
 *
 * **Nothing is claimed that was not counted.** The evidence line says how many
 * answers there are and where they came from, and when there are none it says
 * that instead. It would be easy, and wrong, to let an unevidenced concept
 * borrow the phrasing of a weak one: the engine reaches those two states by
 * opposite routes, and a student told "this has been going badly" about
 * something they have never answered has been misled about themselves.
 */

/** Diagnosis and action are separate: the headline is what changes, the label is what happens. */
const HEADLINE: Record<InterventionReason, (label: string) => string> = {
  recall_strong_application_weak: (label) => `Make ${label} exam-ready`,
  weak_without_flashcards: (label) => `Build something to revise ${label} from`,
  suspected_gap: (label) => `Check ${label}`,
  slipping: (label) => `Get ${label} back on track`,
  material_never_tested: (label) => `Test yourself on ${label}`,
  declared_but_unevidenced: (label) => `Find out where you stand on ${label}`,
  no_material_for_specification_concept: (label) => `${label} is not covered yet`,
  due_for_retrieval: (label) => `Bring ${label} back`,
  recent_gain: (label) => `Lock in ${label}`,
  evidenced_knowledge_gap: (label) => `Work through ${label}`,
};

/** One line under the headline: what Jami noticed, not what it intends to do about it. */
const SUMMARY: Record<InterventionReason, string> = {
  recall_strong_application_weak: "Your recall is strong, but application is weaker.",
  weak_without_flashcards:
    "This is proving difficult, and there are not enough cards on it to revise from.",
  suspected_gap: "A few answers on this have gone wrong, but not enough yet to be sure.",
  slipping: "Your recent answers on this are not as good as your earlier ones.",
  material_never_tested: "You have material on this and have not been tested on it yet.",
  declared_but_unevidenced:
    "It is part of your course and nothing has been recorded against it yet.",
  no_material_for_specification_concept:
    "Your course asks for this and there is nothing here to work from yet.",
  due_for_retrieval: "Cards on this are due. A quick look now stops them fading.",
  recent_gain: "This has been going well lately. A short session will keep it.",
  evidenced_knowledge_gap: "Enough answers have gone wrong that it is worth going back over.",
};

/** The verb on the button. Says what pressing it does, and nothing more. */
const ACTION_LABEL: Record<InterventionType, string> = {
  create_flashcards: "Make cards",
  create_practice: "Create practice",
  fill_specification_gap: "Create material",
  past_paper: "Start practicing",
  retrieve: "Start review",
  teach: "Open material",
  reinforce: "Start practicing",
  review_material: "Open material",
};

/**
 * Why this action and not another one.
 *
 * The sentence a student needs in order to trust a recommendation is rarely
 * "you are weak at this" -- they usually know. It is "so why cards rather than
 * questions", and that is a statement about the material, which is exactly
 * what the catalogue decided on.
 */
const CHOICE: Record<InterventionType, string> = {
  create_flashcards:
    "So Jami is offering to write a few cards to revise from first, rather than testing you straight away.",
  create_practice:
    "So Jami is offering to write exam-style questions, rather than more cards to remember.",
  fill_specification_gap:
    "So the first thing to do is get some material for it, rather than test you on nothing.",
  past_paper: "So this is real exam questions rather than more flashcards.",
  retrieve: "So this is a short review of cards you already have, rather than anything new.",
  teach: "So this starts with the material rather than with a test.",
  reinforce: "So this is a light session to hold on to it, rather than a full pass.",
  review_material: "So this opens what you already have rather than generating something new.",
};

const SOURCE_PHRASE: Record<LearningEvidenceKind, string> = {
  flashcards: "flashcards",
  practice: "practice questions",
  "past-paper": "exam questions",
  notebook: "your notes",
  revision: "revision sessions",
  "tutor-check": "quick checks in Tutor",
};

function listPhrase(parts: readonly string[]) {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function lowerFirst(value: string) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

/**
 * What has actually been recorded, as a sentence.
 *
 * Counts and sources only. Deliberately says nothing about how well the
 * answers went: that judgement belongs to the engine, and a second version of
 * it written here would eventually disagree with the first.
 */
export function evidenceSentence(
  evidence: Pick<LearningRecommendationEvidence, "count" | "sources">
) {
  if (evidence.count <= 0) return "Nothing has been recorded against this yet.";
  const answers = `${evidence.count} ${evidence.count === 1 ? "answer" : "answers"}`;
  const sources = evidence.sources.map((source) => SOURCE_PHRASE[source]).filter(Boolean);
  return sources.length > 0
    ? `Jami has ${answers} from you on this, across ${listPhrase(sources)}.`
    : `Jami has ${answers} from you on this.`;
}

export type MissionCopy = {
  /** The largest words on the page. */
  headline: string;
  /** One line beneath it. */
  summary: string;
  /** The button. */
  actionLabel: string;
  /** Behind "Why this?", in order: what exists, what it says, what follows. */
  explanation: string[];
};

/**
 * The noticing sentence for one choice.
 *
 * Recall read from the student's own broader Topic is named as that Topic.
 * "Your recall is strong" about completing the square would claim they had
 * drilled completing the square; what they drilled was Quadratics, and the
 * sentence says so. The name is the student's own, rendered as text.
 */
function summaryFor(choice: InterventionChoice) {
  const topic = choice.recallFrom?.label.trim();
  if (choice.because === "recall_strong_application_weak" && topic) {
    return `Your cards on ${lowerFirst(topic)} are going well, but exam-style answers on this are not.`;
  }
  return SUMMARY[choice.because];
}

/**
 * One recommendation, worded for a student.
 *
 * Takes the intervention rather than the engine's reason, because the
 * intervention is the thing with an action attached: the engine says a concept
 * needs practice, and only the catalogue knows whether that means real exam
 * questions or writing some first.
 */
export function missionCopy(input: {
  conceptLabel: string;
  choice: InterventionChoice;
  evidence: Pick<LearningRecommendationEvidence, "count" | "sources">;
}): MissionCopy {
  const label = lowerFirst(input.conceptLabel.trim()) || "this";
  const { because, type } = input.choice;
  const summary = summaryFor(input.choice);
  return {
    headline: HEADLINE[because](label),
    summary,
    actionLabel: ACTION_LABEL[type],
    explanation: [evidenceSentence(input.evidence), summary, CHOICE[type]],
  };
}

/**
 * How much work this is, in the student's terms.
 *
 * Minutes come from the planner's own per-item estimate rather than a second
 * one invented here, so a mission and the plan slot covering the same work can
 * never quote different numbers to the same student on the same page.
 *
 * Returns nothing when the engine did not size the work. An estimate is
 * useful; a made-up one, on a surface whose whole promise is that Jami knows
 * what you need, is not.
 */
export function missionEffort(input: { targetItems?: number; type: InterventionType }) {
  if (!input.targetItems || input.targetItems <= 0) return undefined;
  const noun =
    input.type === "create_flashcards" || input.type === "retrieve" ? "card" : "question";
  return {
    items: `${input.targetItems} ${input.targetItems === 1 ? noun : `${noun}s`}`,
    minutes: `about ${PLAN_MINUTES_PER_ITEM} min`,
  };
}
