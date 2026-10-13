export type FeatureFlagKey =
  | "enableFolders"
  | "enableMasteryProgress"
  | "enableFlashcardAi"
  | "enableStudyModes"
  | "enablePastPaperPractice"
  | "enableTutorPersonalisation"
  | "enableLearnerProfile"
  | "enableFlashcardReviewEvents"
  | "enableStudyActions"
  | "enableRevisionPlans"
  | "enableRevisionSessions"
  | "enableConceptRelations"
  | "enableTutorMemory"
  | "enableTutorChatRecall"
  | "enableTutorAgent"
  | "enableBilling"
  | "enableTutorChecks"
  | "enableJamiInk"
  | "enableNotebookNativeScroll";

const DEFAULT_FLAGS: Record<FeatureFlagKey, boolean> = {
  enableFolders: true,
  enableMasteryProgress: true,
  enableFlashcardAi: true,
  // Both features landed with their complete UI, persistence and prompt paths.
  // A direct public environment override can still remove either surface.
  enableStudyModes: true,
  /*
   * On. The surface is complete independently of the licensed corpus, and the
   * owner runs this deployment as its only user.
   *
   * The fail-closed default this replaces was protecting students from a
   * half-ingested corpus, which is not the situation: the per-board switches
   * and the per-question review and spot-check gates all still apply, so
   * turning the surface on exposes exactly the questions that have passed
   * them and nothing else. A public override still removes the surface.
   */
  enablePastPaperPractice: true,
  enableTutorPersonalisation: true,
  /*
   * The Learning Engine's profile in Tutor's prompt. On, because it adds nothing
   * for a student with no recorded work; the switch exists to take a new prompt
   * input out quickly if it misbehaves.
   */
  enableLearnerProfile: true,
  /*
   * Recording each flashcard answer as a compact learning event. Separate from
   * the profile so recording can stop without losing what is already stored,
   * and the profile keeps reading existing history either way.
   */
  enableFlashcardReviewEvents: true,
  /*
   * Learning Engine study actions on Today. Separate from the profile so the
   * recommendations can be taken off the home page without touching Tutor.
   */
  enableStudyActions: true,
  /*
   * Revision plans: the student's own timetable, filled by the Learning
   * Engine. On, with the plan living inside Tutor and shown at the top of
   * Today once a student has made one -- so nothing appears for anybody who
   * has not asked for it. A public override still removes the surface.
   */
  enableRevisionPlans: true,
  /*
   * Revision Sessions: Jami teaching what the engine says needs teaching. See
   * `docs/revision-sessions.md`. On for this deployment, whose owner is its only
   * user; off, Today's teach recommendations go back to opening the Topic page,
   * and the engine stops reading session evidence.
   */
  enableRevisionSessions: true,
  /*
   * On, by the owner's decision on 28 September 2026.
   *
   * Joining a student's own Topics to the specification changes numbers a
   * student has already been shown: evidence that was split across two
   * unrelated concepts starts meeting, and a topic's mastery moves as a
   * result. That is correct rather than a fault, but it is visible. It was held
   * off for a before/after diff on real evidence, which no account could yet
   * supply; it is on because without it the engine can never see that a
   * student recalls a topic from their own cards and still loses marks on it
   * in exam questions. `scripts/eval/concept-relation-diff.ts` still reads the
   * difference for any folder. Only relations recorded on a Topic are used.
   */
  enableConceptRelations: true,
  /*
   * Tutor's memory across chats: what a student likes, finds hard, is aiming
   * for and said they would do next, plus their other recent chats. On by the
   * owner's decision on 30 September 2026, and on for every student until they
   * turn it off in Personalise Jami. Off here removes it from every prompt and
   * stops every write, without deleting what is stored.
   */
  enableTutorMemory: true,
  /*
   * Tutor searching back when a student refers to something said before:
   * earlier in a long chat, or in another chat while memory is on. Off, Tutor
   * reads only the recent part of the current chat, as before.
   */
  enableTutorChatRecall: true,
  /*
   * Tutor as an agent (docs/tutor-agent.md): before a Think or Deep answer it
   * chooses what to look up or work out first -- the student's material, the
   * web, earlier chats, an independent working -- and shows each step. On by
   * the owner's decision on 12 October 2026. Off, every answer is the single
   * call it was before.
   */
  enableTutorAgent: true,
  /*
   * Plans and monthly allowances (docs/plans-and-stardust.md). Off until
   * launch: off, every student keeps today's daily limits and nothing else,
   * exactly as before plans existed. On, new accounts get Free's monthly
   * allowances, and every account made before BILLING_LAUNCH_AT is Lifetime.
   */
  enableBilling: false,
  /*
   * Tutor's quick checks: one short question in chat, marked on the reply
   * against points fixed when it was asked, kept as weak evidence. Off stops
   * Tutor asking them and the engine reading them, without deleting any.
   */
  enableTutorChecks: true,
  /*
   * Jami Ink, the notebook's own ink engine (docs/notebook-ink.md), hosted by
   * the notebook editor and the exam working sheet. Off, both keep js-draw,
   * unchanged: this is the emergency fallback to it. On from stage 4 so the
   * owner can try each stage on the live iPad; pages still save as SVG, so
   * turning it off loses nothing.
   */
  enableJamiInk: true,
  /*
   * A zoomed notebook sheet pans with the browser's own scrolling, at the
   * screen's own rate and with momentum, even in Low Power Mode, where what a
   * page moves itself is held to 30 frames a second. Off, a finger drag moves
   * the sheet through the notebook's own pan, as before: the fallback if
   * scrolling misbehaves on a device.
   */
  enableNotebookNativeScroll: true,
};

/**
 * Public client variables must be referenced directly for Next to replace
 * them in the browser bundle. A computed `process.env[key]` lookup silently
 * falls back to the defaults on the client.
 */
const ENV_VALUES: Record<FeatureFlagKey, string | undefined> = {
  enableFolders: process.env.NEXT_PUBLIC_ENABLE_FOLDERS,
  enableMasteryProgress: process.env.NEXT_PUBLIC_ENABLE_MASTERY_PROGRESS,
  enableFlashcardAi: process.env.NEXT_PUBLIC_ENABLE_FLASHCARD_AI,
  enableStudyModes: process.env.NEXT_PUBLIC_ENABLE_STUDY_MODES,
  enablePastPaperPractice:
    process.env.NEXT_PUBLIC_ENABLE_PAST_PAPER_PRACTICE,
  enableTutorPersonalisation:
    process.env.NEXT_PUBLIC_ENABLE_TUTOR_PERSONALISATION,
  enableLearnerProfile: process.env.NEXT_PUBLIC_ENABLE_LEARNER_PROFILE,
  enableFlashcardReviewEvents: process.env.NEXT_PUBLIC_ENABLE_FLASHCARD_REVIEW_EVENTS,
  enableStudyActions: process.env.NEXT_PUBLIC_ENABLE_STUDY_ACTIONS,
  enableRevisionPlans: process.env.NEXT_PUBLIC_ENABLE_REVISION_PLANS,
  enableRevisionSessions: process.env.NEXT_PUBLIC_ENABLE_REVISION_SESSIONS,
  enableConceptRelations: process.env.NEXT_PUBLIC_ENABLE_CONCEPT_RELATIONS,
  enableTutorMemory: process.env.NEXT_PUBLIC_ENABLE_TUTOR_MEMORY,
  enableTutorChatRecall: process.env.NEXT_PUBLIC_ENABLE_TUTOR_CHAT_RECALL,
  enableTutorAgent: process.env.NEXT_PUBLIC_ENABLE_TUTOR_AGENT,
  enableBilling: process.env.NEXT_PUBLIC_ENABLE_BILLING,
  enableTutorChecks: process.env.NEXT_PUBLIC_ENABLE_TUTOR_CHECKS,
  enableJamiInk: process.env.NEXT_PUBLIC_ENABLE_JAMI_INK,
  enableNotebookNativeScroll: process.env.NEXT_PUBLIC_ENABLE_NOTEBOOK_NATIVE_SCROLL,
};

function parseFlagValue(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function isFeatureEnabled(key: FeatureFlagKey) {
  return parseFlagValue(ENV_VALUES[key], DEFAULT_FLAGS[key]);
}

export const featureFlags: Record<FeatureFlagKey, boolean> = {
  enableFolders: isFeatureEnabled("enableFolders"),
  enableMasteryProgress: isFeatureEnabled("enableMasteryProgress"),
  enableFlashcardAi: isFeatureEnabled("enableFlashcardAi"),
  enableStudyModes: isFeatureEnabled("enableStudyModes"),
  enablePastPaperPractice: isFeatureEnabled("enablePastPaperPractice"),
  enableTutorPersonalisation: isFeatureEnabled("enableTutorPersonalisation"),
  enableLearnerProfile: isFeatureEnabled("enableLearnerProfile"),
  enableFlashcardReviewEvents: isFeatureEnabled("enableFlashcardReviewEvents"),
  enableStudyActions: isFeatureEnabled("enableStudyActions"),
  enableRevisionPlans: isFeatureEnabled("enableRevisionPlans"),
  enableRevisionSessions: isFeatureEnabled("enableRevisionSessions"),
  enableConceptRelations: isFeatureEnabled("enableConceptRelations"),
  enableTutorMemory: isFeatureEnabled("enableTutorMemory"),
  enableTutorChatRecall: isFeatureEnabled("enableTutorChatRecall"),
  enableTutorAgent: isFeatureEnabled("enableTutorAgent"),
  enableBilling: isFeatureEnabled("enableBilling"),
  enableTutorChecks: isFeatureEnabled("enableTutorChecks"),
  enableJamiInk: isFeatureEnabled("enableJamiInk"),
  enableNotebookNativeScroll: isFeatureEnabled("enableNotebookNativeScroll"),
};
