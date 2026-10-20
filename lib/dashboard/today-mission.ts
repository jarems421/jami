import { missionCopy, missionEffort } from "@/lib/learning/interventions/explain";
import type {
  TodayNextAction,
  TodayNextActionType,
  TodayStudyAction,
} from "@/lib/dashboard/today-plan";

/**
 * The one thing Today leads with, assembled for the screen.
 *
 * Nothing here decides anything. The ladder that picks the next action lives
 * in `buildTodayPlan` and the choice of what to do about a concept lives in
 * the intervention catalogue; this only puts the two together and words the
 * result. Any ranking written here would be a second recommendation system
 * disagreeing with the first, which is the failure this layer exists to avoid.
 *
 * The mission is the engine's advice whenever the ladder chose it, and an
 * ordinary next step otherwise -- a due review, a session to resume, a first
 * folder to make. Both are real answers to "what should I do now"; only one of
 * them has reasoning behind it, and only that one gets to show any.
 */

export type TodayMission = {
  eyebrow: string;
  headline: string;
  summary: string;
  actionLabel: string;
  href: string;
  /**
   * Behind "Why this?". Empty where Jami has nothing to account for, and the
   * disclosure is then not offered at all: an explanation invented for a step
   * that had no reasoning behind it is worse than no explanation.
   */
  explanation: string[];
  effort?: { items?: string; minutes: string };
  folderName?: string;
  /** The recommendation this is, so what became of it can be recorded. */
  action?: TodayStudyAction;
  /** Present when the action is for Jami to write the material. */
  generate?: { kind: "create_flashcards" | "create_practice"; conceptId: string };
  secondary?: { label: string; href: string };
};

/**
 * Why an ordinary next step is the next step.
 *
 * Only for the ones that have an answer. "Continue your notebook" is a
 * sensible thing to offer and Jami has no reasoning behind it beyond noticing
 * it was open most recently, so it says nothing rather than dressing that up.
 */
const PLAIN_EXPLANATION: Partial<Record<TodayNextActionType, string[]>> = {
  review_due_cards: [
    "Each of these came up today because of how your last review of it went.",
    "Reviewing on the day a card is due is what keeps the rest of the schedule honest -- leave them and everything behind them shifts too.",
  ],
  resume_study_session: [
    "You left a session part-way through.",
    "Finishing it means the cards you already answered are not scheduled a second time.",
  ],
  continue_goal: [
    "This is the goal that most needs you today: due soonest, or slipping behind the pace it needs.",
    "Jami counts only work it can see towards it: cards you review, answers it marks, and what your results say about a topic.",
  ],
};

const DEFAULT_EYEBROW = "Your next move";

/**
 * A teach recommendation, offered as a Revision Session.
 *
 * Its own wording rather than the intervention's, because what the student is
 * being offered is different: not "open your material" but a sitting with
 * Jami. The reasons behind "Why this?" are still the engine's own.
 */
const REVISION_SESSION_MISSION = {
  eyebrow: "Revision session",
  summary: "Let's get this properly understood.",
  actionLabel: "Start session",
  minutes: "About 15 min",
} as const;

/**
 * The mission, from the plan's own next action and the engine's list.
 *
 * The action is found by id rather than by matching wording: the ladder
 * already knows which recommendation it chose, and asking the copy to identify
 * it again would mean two places had to agree about a sentence.
 */
export function buildTodayMission(input: {
  nextAction: TodayNextAction;
  studyActions: readonly TodayStudyAction[];
}): TodayMission {
  const { nextAction } = input;
  const action = nextAction.actionId
    ? input.studyActions.find((candidate) => candidate.id === nextAction.actionId)
    : undefined;
  const secondary =
    nextAction.secondaryHref && nextAction.secondaryLabel
      ? { label: nextAction.secondaryLabel, href: nextAction.secondaryHref }
      : undefined;

  if (action?.intervention && action.destinationKind === "revision-session") {
    const copy = missionCopy({
      conceptLabel: action.target.label,
      choice: action.intervention,
      evidence: action.evidence,
    });
    return {
      eyebrow: REVISION_SESSION_MISSION.eyebrow,
      headline: action.target.label,
      summary: REVISION_SESSION_MISSION.summary,
      actionLabel: REVISION_SESSION_MISSION.actionLabel,
      href: nextAction.href,
      explanation: copy.explanation,
      effort: { minutes: REVISION_SESSION_MISSION.minutes },
      ...(action.folderName ? { folderName: action.folderName } : {}),
      action,
      ...(secondary ? { secondary } : {}),
    };
  }

  if (action?.intervention) {
    const copy = missionCopy({
      conceptLabel: action.target.label,
      choice: action.intervention,
      evidence: action.evidence,
    });
    const effort = missionEffort({
      type: action.intervention.type,
      ...(action.targetItems !== undefined ? { targetItems: action.targetItems } : {}),
    });
    return {
      eyebrow: DEFAULT_EYEBROW,
      headline: copy.headline,
      summary: copy.summary,
      actionLabel: copy.actionLabel,
      href: nextAction.href,
      explanation: copy.explanation,
      ...(effort ? { effort } : {}),
      ...(action.folderName ? { folderName: action.folderName } : {}),
      action,
      ...(action.generate ? { generate: action.generate } : {}),
      ...(secondary ? { secondary } : {}),
    };
  }

  /*
   * The engine chose this, but the catalogue had no action it could offer for
   * it -- no material to work from, nothing this deployment can write. The
   * engine's own wording still holds, and there is still somewhere to go.
   */
  return {
    eyebrow: DEFAULT_EYEBROW,
    headline: nextAction.title,
    summary: nextAction.description,
    actionLabel: nextAction.label,
    href: nextAction.href,
    explanation: PLAIN_EXPLANATION[nextAction.type] ?? [],
    ...(action?.folderName ? { folderName: action.folderName } : {}),
    ...(action ? { action } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

export type MissionCompletionCopy = {
  headline: string;
  /** What was done, as the student would name it. */
  detail: string;
  /** One line about what Jami did with it. Never a promise about what changes. */
  note: string;
  /** Whether all of the work asked for was actually done. */
  complete: boolean;
};

/**
 * What to say to somebody who has just come back from doing the work.
 *
 * Three rules, and they are all about not overstating.
 *
 * **Say what happened, not what it means.** Answers are evidence; whether they
 * move mastery is the engine's call, made from all the evidence rather than
 * from one session, and it may well decide nothing has changed. So the note
 * says Jami has the answers -- which is certainly true -- and never that the
 * student has improved.
 *
 * **Two of five is two.** Partial work gets its own wording rather than the
 * finished wording with a smaller number in it. The moment Jami rounds a
 * student's effort up is the moment its other claims stop being worth reading.
 *
 * **Never name the mechanism.** No evidence weights, no intervention, no
 * profile. "Jami has your answers" is the whole of it.
 */
export function missionCompletionCopy(input: {
  conceptLabel: string;
  answered: number;
  targetItems?: number;
}): MissionCompletionCopy {
  const { answered, targetItems } = input;
  const complete = targetItems === undefined ? answered > 0 : answered >= targetItems;
  const counted =
    targetItems !== undefined
      ? `${answered} / ${targetItems}`
      : `${answered} ${answered === 1 ? "answer" : "answers"}`;

  return {
    headline: complete ? "Nice. That's done." : "Good — that counts.",
    detail: `${input.conceptLabel} · ${counted}`,
    note: complete
      ? "You've tested this properly. Jami has your answers."
      : `Jami has the ${answered} you answered, and the rest is still there when you want it.`,
    complete,
  };
}

/**
 * The line under the greeting.
 *
 * Says how much there is, not what it is -- the mission underneath is about to
 * say what it is at four times the size, and a subtitle that previewed it
 * would just be the same sentence twice.
 */
export function hubSubline(input: {
  hasMission: boolean;
  /** Recommendations beyond the one leading the page. */
  extraActions: number;
}) {
  if (!input.hasMission) return "Pick up wherever you feel like starting.";
  if (input.extraActions <= 0) return "One thing worth focusing on.";
  return `One thing worth focusing on, and ${input.extraActions} more when you want them.`;
}

/**
 * A greeting that is true at the time it is read.
 *
 * Local hours, because "good evening" is about where the student is sitting.
 */
export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
