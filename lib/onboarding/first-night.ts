import type { OnboardingActionId } from "@/lib/onboarding/tutorial";
import type { ExamCourseSelection } from "@/lib/practice/exam-questions";
import type { StudyLevel } from "@/lib/profile/study-level";
import { PLANNER_PATH } from "@/lib/app/plan-views";

/**
 * "First night": the sign-up walkthrough.
 *
 * A short welcome on a night sky that turns the student's subjects into
 * folders, a tour of the real sidebar, then a first constellation on Today.
 * Each star is something the student actually does -- writes in a notebook,
 * makes a flashcard and reviews it, asks Jami, answers a real exam question,
 * sets a goal -- and it lights when the app hears it happen, not when a note
 * is dismissed. Finishing earns the account's real first star, and the
 * walkthrough ends by taking the student to see it in their sky.
 *
 * Progress is kept on the account and mirrored on the device.
 * `?first-night=preview` starts it afresh and `?first-night=off` ends it, for
 * anyone checking it by hand.
 */

export const FIRST_NIGHT_QUERY_PARAM = "first-night";
const STORAGE_PREFIX = "jami:first-night:";

export type FirstNightDiscoveryId = "notebook" | "cards" | "learn" | "tutor" | "exam" | "goal";
/** `sky` is the last step: the star is earned, and the student is shown where it lives. */
export type FirstNightStage = "welcome" | "tour" | "exploring" | "sky" | "finished";
export type FirstNightRewardState = "not-earned" | "pending" | "awarded";

export type FirstNightDiscovery = {
  id: FirstNightDiscoveryId;
  title: string;
  /** Where it happens, as the row under the title says it. */
  where: string;
  /** The sidebar entry that leads there, exactly as the sidebar labels it. */
  navLabel: string;
  /** The page it starts on, for "Take me there". */
  href: string;
  /** Roughly how long it takes, said before asking, so a step never looks bigger than it is. */
  minutes: number;
  /** What it is, in one line, before it is done. */
  promise: string;
  /** What doing it gave the student, said the moment its star lights. */
  unlocked: string;
  /** Where its star sits in the Today panel's sky, in percentages. */
  x: number;
  y: number;
};

/**
 * In the order they are offered, which is also the order they build on each
 * other: a card before reviewing it, a notebook before asking about it.
 *
 * A real exam question comes first. It is the one thing here no other study
 * app does, and setup has just asked for the board and course it needs, so it
 * is the quickest way for a new student to see what Jami is for. A student
 * whose course has no questions yet is never offered it (`firstNightDiscoveries`)
 * and starts at the flashcard instead. The positions are the constellation's
 * shape and stay in their slots whatever fills them.
 */
export const FIRST_NIGHT_DISCOVERIES: readonly FirstNightDiscovery[] = [
  {
    id: "exam",
    title: "Get a real exam question marked",
    where: "Practice",
    navLabel: "Practice",
    href: "/dashboard/practice",
    minutes: 3,
    promise: "Answer one real question from your course and see which marks you would get.",
    unlocked: "Jami has its first real evidence about you, and Today will use it to suggest what to revise.",
    x: 10,
    y: 66,
  },
  {
    id: "cards",
    title: "Make a flashcard",
    where: "Flashcards",
    navLabel: "Flashcards",
    href: "/dashboard/decks",
    minutes: 1,
    promise: "One card about something you want to remember.",
    unlocked: "Your card is saved. Jami will bring it back on a schedule that fits your memory.",
    x: 26,
    y: 34,
  },
  {
    id: "learn",
    title: "Review your flashcard",
    where: "Learn",
    navLabel: "Learn",
    href: "/dashboard/study",
    minutes: 1,
    promise: "See it once and say how well you knew it.",
    unlocked: "Reviewed. It comes back just before you would forget it, not before.",
    x: 43,
    y: 60,
  },
  {
    id: "notebook",
    title: "Write in a notebook",
    where: "Practice",
    navLabel: "Practice",
    href: "/dashboard/practice",
    minutes: 1,
    promise: "Write or type anything in one of your subject folders. It saves as you go.",
    unlocked: "Saved in your folder. Jami can read it whenever you ask about it.",
    x: 58,
    y: 26,
  },
  {
    id: "tutor",
    title: "Ask Jami about your notes",
    where: "your notebook",
    navLabel: "Practice",
    href: "/dashboard/practice",
    minutes: 1,
    promise: "Ask about the page you just wrote. Jami reads it before it answers.",
    unlocked: "That is Jami. You can ask from any notebook or source, whenever you are stuck.",
    x: 74,
    y: 54,
  },
  {
    id: "goal",
    title: "Set your first goal",
    // Goals are the second tab of Plan, which opens on the revision plan.
    where: "Plan",
    navLabel: "Plan",
    href: "/dashboard/goals",
    minutes: 1,
    promise: "A small target, like ten cards by Friday.",
    unlocked: "Goal set. Finish it and a new star joins your sky.",
    x: 90,
    y: 30,
  },
];

/**
 * The second night: what the first six stars do not reach.
 *
 * Offered on Today once the first constellation is finished, never before and
 * never required. Each one is a part of Jami a student would otherwise only
 * find by wandering, and lighting them earns nothing but the lit star -- the
 * sky's real stars still come only from finished goals.
 */
export type SecondNightStarId = "source" | "plan" | "progress";

export type SecondNightStar = {
  id: SecondNightStarId;
  title: string;
  navLabel: string;
  href: string;
  minutes: number;
  promise: string;
  unlocked: string;
  x: number;
  y: number;
};

export const SECOND_NIGHT_STARS: readonly SecondNightStar[] = [
  {
    id: "source",
    title: "Give Jami something to read",
    navLabel: "Jami",
    href: "/dashboard/library",
    minutes: 1,
    promise: "Add notes, a PDF or a link. Jami can then answer from your own material.",
    unlocked: "Jami can read it now. Ask about it from Jami or any notebook in that folder.",
    x: 18,
    y: 58,
  },
  {
    id: "plan",
    title: "Plan your week with Jami",
    navLabel: "Plan",
    href: PLANNER_PATH,
    minutes: 2,
    promise: "Say when you can study, and Jami fills each day with what matters most.",
    unlocked: "Your week has a plan. Today shows each day's part of it.",
    x: 50,
    y: 30,
  },
  {
    id: "progress",
    title: "See where you stand",
    navLabel: "Progress",
    href: "/dashboard/progress",
    minutes: 1,
    promise: "Weak topics, what is due, and how your answers are trending.",
    unlocked: "That is your progress. It fills in as you study, and Jami reads it to choose what comes next.",
    x: 82,
    y: 62,
  },
];

export const SECOND_NIGHT_ACTIONS: Partial<Record<OnboardingActionId, SecondNightStarId>> = {
  "add-source": "source",
  "plan-week": "plan",
  "view-progress": "progress",
};

const SECOND_NIGHT_IDS = new Set<string>(SECOND_NIGHT_STARS.map((star) => star.id));

/** Whether Today should offer the second night: the first is done, and it is neither finished nor put away. */
export function secondNightOpen(state: FirstNightState | null) {
  if (!state || state.stage !== "finished" || state.bonusHidden) return false;
  return SECOND_NIGHT_STARS.some((star) => !state.bonus.includes(star.id));
}

/**
 * The star to offer next: the one asked for from Today if it is still unlit,
 * else the first unlit one in order. Nothing once every star is lit.
 */
export function nextFirstNightDiscovery(state: FirstNightState): FirstNightDiscovery | null {
  const open = firstNightDiscoveries(state).filter((discovery) => !state.lit.includes(discovery.id));
  return open.find((discovery) => discovery.id === state.intent) ?? open[0] ?? null;
}

/** Which thing the app reports doing lights which star. */
export const FIRST_NIGHT_ACTIONS: Partial<Record<OnboardingActionId, FirstNightDiscoveryId>> = {
  "save-work": "notebook",
  "ask-tutor": "tutor",
  "create-card": "cards",
  "complete-review": "learn",
  "mark-exam-answer": "exam",
  "create-goal": "goal",
};

export type FirstNightState = {
  version: 1;
  stage: FirstNightStage;
  tourStep: number;
  lit: FirstNightDiscoveryId[];
  /** The discovery last asked for from Today, when several share a page. */
  intent: FirstNightDiscoveryId | null;
  /**
   * Whether a folder was set up with a course that has exam questions.
   * Without one there is no question to answer, so that star is not asked for.
   */
  examReady: boolean;
  /** The finishing star: not yet earned, waiting for room in the sky, or given. */
  rewardState: FirstNightRewardState;
  /** Second-night stars lit. Absent on records from before the second night, which read as none. */
  bonus: SecondNightStarId[];
  /** The student put the second night away. */
  bonusHidden: boolean;
  /** When this copy last changed, so the device's and the account's can be merged. */
  updatedAt: number;
};

/** The real controls the walkthrough points at, marked where they are rendered. */
export const FIRST_NIGHT_TARGETS = {
  navShell: '[data-nav="sidebar"], [data-nav="bar"]',
  loopGroup: '[data-first-night-group="loop"]',
  supportGroup: '[data-first-night-group="support"]',
  panel: '[data-tutorial-target="first-night"]',
  firstFolder: '[data-tutorial-target="first-folder"]',
  createFolder: '[data-tutorial-target="create-folder"]',
  firstNotebook: '[data-tutorial-target="first-notebook"]',
  createNotebook: '[data-tutorial-target="create-notebook"]',
  pen: '[data-tutorial-target="pen"]',
  askTutor: '[data-tutorial-target="ask-tutor"]',
  createDeck: '[data-tutorial-target="create-deck"]',
  deckAddCard: '[data-tutorial-target="deck-add-card"]',
  createCard: '[data-tutorial-target="create-card"]',
  startReview: '[data-tutorial-target="start-review"]',
  flashcard: '[data-tutorial-target="flashcard"]',
  examQuestions: '[data-tutorial-target="exam-questions"]',
  startExam: '[data-tutorial-target="start-exam"]',
  markAnswer: '[data-tutorial-target="mark-answer"]',
  newGoal: '[data-tutorial-target="new-goal"]',
  createGoal: '[data-tutorial-target="create-goal"]',
  goalsTab: '[data-view-tab="Goals"]',
} as const;

/** The page controls whose presence decides which note applies. */
export const FIRST_NIGHT_PAGE_TARGETS: readonly string[] = [
  FIRST_NIGHT_TARGETS.firstFolder,
  FIRST_NIGHT_TARGETS.createFolder,
  FIRST_NIGHT_TARGETS.firstNotebook,
  FIRST_NIGHT_TARGETS.createNotebook,
  FIRST_NIGHT_TARGETS.pen,
  FIRST_NIGHT_TARGETS.askTutor,
  FIRST_NIGHT_TARGETS.createDeck,
  FIRST_NIGHT_TARGETS.deckAddCard,
  FIRST_NIGHT_TARGETS.createCard,
  FIRST_NIGHT_TARGETS.startReview,
  FIRST_NIGHT_TARGETS.flashcard,
  FIRST_NIGHT_TARGETS.examQuestions,
  FIRST_NIGHT_TARGETS.startExam,
  FIRST_NIGHT_TARGETS.markAnswer,
  FIRST_NIGHT_TARGETS.newGoal,
  FIRST_NIGHT_TARGETS.createGoal,
  FIRST_NIGHT_TARGETS.goalsTab,
];

export function navTarget(label: string) {
  return `[data-agent-nav="${label}"]`;
}

const DISCOVERY_IDS = new Set<string>(FIRST_NIGHT_DISCOVERIES.map((discovery) => discovery.id));
const STAGES = new Set<string>(["welcome", "tour", "exploring", "sky", "finished"]);
const REWARD_STATES = new Set<string>(["not-earned", "pending", "awarded"]);

export function getFirstNightDiscovery(id: FirstNightDiscoveryId) {
  return FIRST_NIGHT_DISCOVERIES.find((discovery) => discovery.id === id) ?? FIRST_NIGHT_DISCOVERIES[0];
}

/** The stars this student is asked to light. */
export function firstNightDiscoveries(state: Pick<FirstNightState, "examReady">) {
  return FIRST_NIGHT_DISCOVERIES.filter((discovery) => discovery.id !== "exam" || state.examReady);
}

export function allFirstNightLit(state: FirstNightState) {
  return firstNightDiscoveries(state).every((discovery) => state.lit.includes(discovery.id));
}

export function createFirstNightState(now = Date.now()): FirstNightState {
  return {
    version: 1,
    stage: "welcome",
    tourStep: 0,
    lit: [],
    intent: null,
    examReady: false,
    rewardState: "not-earned",
    bonus: [],
    bonusHidden: false,
    updatedAt: now,
  };
}

export function readFirstNightState(value: unknown): FirstNightState | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, stage, tourStep, lit, intent, examReady, rewardState, bonus, bonusHidden, updatedAt } =
    value as Record<string, unknown>;
  if (version !== 1 || typeof stage !== "string" || !STAGES.has(stage)) return null;
  const litIds = Array.isArray(lit)
    ? Array.from(new Set(lit.filter((id): id is FirstNightDiscoveryId => typeof id === "string" && DISCOVERY_IDS.has(id))))
    : [];
  return {
    version: 1,
    stage: stage as FirstNightStage,
    tourStep: typeof tourStep === "number" && Number.isInteger(tourStep) && tourStep >= 0 ? tourStep : 0,
    lit: litIds,
    intent: typeof intent === "string" && DISCOVERY_IDS.has(intent) ? (intent as FirstNightDiscoveryId) : null,
    examReady: examReady === true,
    rewardState:
      typeof rewardState === "string" && REWARD_STATES.has(rewardState) ? (rewardState as FirstNightRewardState) : "not-earned",
    bonus: Array.isArray(bonus)
      ? Array.from(new Set(bonus.filter((id): id is SecondNightStarId => typeof id === "string" && SECOND_NIGHT_IDS.has(id))))
      : [],
    bonusHidden: bonusHidden === true,
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
  };
}

export function readFirstNightQuery(search: string): "preview" | "off" | null {
  const value = new URLSearchParams(search).get(FIRST_NIGHT_QUERY_PARAM);
  return value === "preview" || value === "off" ? value : null;
}

/**
 * The device's copy, keyed per student so a shared device never shows one
 * student another's progress. It lets a reload or a failed account read carry
 * on from where the student was instead of starting again.
 */
export function loadLocalFirstNight(userId: string): FirstNightState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    return raw ? readFirstNightState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveLocalFirstNight(userId: string, state: FirstNightState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(state));
  } catch {
    // The account copy is what matters; this one is a convenience.
  }
}

/** Whichever copy changed last. The account's wins a tie, so a second device follows it. */
export function mergeFirstNight(local: FirstNightState | null, remote: FirstNightState | null) {
  if (!local) return remote;
  if (!remote) return local;
  return local.updatedAt > remote.updatedAt ? local : remote;
}

export type FirstNightSubjectAnswer = {
  name: string;
  /** Set only when the level, board, course and any tier were all answered. */
  examCourse: ExamCourseSelection | null;
};

export type FirstNightAnswers = {
  subjects: readonly FirstNightSubjectAnswer[];
  studyLevel: StudyLevel | null;
};

export const MAX_FIRST_NIGHT_SUBJECTS = 12;

type ExistingFolder = { id: string; name: string; studyLevel?: StudyLevel; examCourse?: ExamCourseSelection };

/**
 * The folders the welcome's answers become: one per subject, carrying its
 * level and, where one was settled, its exam course.
 *
 * No notebooks. A notebook made on the student's behalf arrived with no pages
 * and nothing in it, and making their own is the first thing the walkthrough
 * shows them how to do. A subject that already has a folder is not duplicated;
 * it is given the course the student has just told Jami, if it had none.
 */
export function planFirstNightSetup(
  answers: FirstNightAnswers,
  existingFolders: readonly ExistingFolder[],
  /** Folders the student's plan has room for (Free keeps three); undefined for no limit. */
  room?: number
) {
  const maxCreate = Math.min(MAX_FIRST_NIGHT_SUBJECTS, room ?? Infinity);
  let overPlan = 0;
  const byName = new Map(existingFolders.map((folder) => [folder.name.trim().toLowerCase(), folder]));
  const seen = new Set<string>();
  const create: Array<{ name: string; studyLevel: StudyLevel | null; examCourse: ExamCourseSelection | null }> = [];
  const update: Array<{ id: string; studyLevel?: StudyLevel; examCourse: ExamCourseSelection }> = [];

  for (const subject of answers.subjects) {
    const name = subject.name.trim().replace(/\s+/g, " ").slice(0, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const existing = byName.get(key);
    if (existing) {
      if (subject.examCourse && !existing.examCourse) {
        update.push({
          id: existing.id,
          examCourse: subject.examCourse,
          ...(existing.studyLevel || !answers.studyLevel ? {} : { studyLevel: answers.studyLevel }),
        });
      }
    } else if (create.length < maxCreate) {
      create.push({ name, studyLevel: answers.studyLevel, examCourse: subject.examCourse });
    } else if (create.length < MAX_FIRST_NIGHT_SUBJECTS) {
      overPlan += 1;
    }
  }

  return {
    create,
    update,
    overPlan,
    examReady: answers.subjects.some((subject) => Boolean(subject.examCourse)),
  };
}

export function isOnDiscoveryRoute(pathname: string, discovery: FirstNightDiscovery) {
  const practiceNotQuestions =
    pathname.startsWith("/dashboard/practice") && !pathname.startsWith("/dashboard/practice/questions");
  switch (discovery.id) {
    case "notebook":
    case "tutor":
      return practiceNotQuestions || pathname.startsWith("/dashboard/folders") || pathname.startsWith("/dashboard/notebooks");
    case "cards":
      return pathname.startsWith("/dashboard/decks");
    case "learn":
      return pathname.startsWith("/dashboard/study");
    case "exam":
      return pathname.startsWith("/dashboard/practice");
    case "goal":
      // The Plan entry opens on the revision plan; the guide points on to Goals from there.
      return pathname.startsWith("/dashboard/goals") || pathname.startsWith(PLANNER_PATH);
  }
}

/** Sidebar entries that still lead to an unlit star, so they can say so. */
export function pendingNavLabels(state: FirstNightState | null): string[] {
  if (!state) return [];
  if (state.stage === "sky") return ["Stars"];
  if (state.stage !== "tour" && state.stage !== "exploring") return [];
  return Array.from(
    new Set(firstNightDiscoveries(state).filter((discovery) => !state.lit.includes(discovery.id)).map((discovery) => discovery.navLabel))
  );
}

export type FirstNightGuideDone = "next-tour" | "finish-tour" | "clear-point" | "dismiss" | "finish";

export type FirstNightGuidePlan = {
  /** Stable per note, so a dismissed note stays dismissed. */
  key: string;
  /** The small line above the note, when it is more than "Jami". */
  eyebrow?: string;
  /** The control to spotlight, or null for a note with nothing to point at. */
  target: string | null;
  /** Sit beside this rather than over the page, when there is room. */
  near?: string;
  text: string;
  doneLabel: string;
  done: FirstNightGuideDone;
  skippable?: boolean;
};

type GuideInput = {
  state: FirstNightState;
  pathname: string;
  isPhone: boolean;
  pointing: FirstNightDiscoveryId | null;
  present: (selector: string) => boolean;
};

/**
 * The tour: two notes, then doing.
 *
 * It used to be four -- the map, the top group, the bottom group, then the
 * panel -- and three of them asked a student to read about places before they
 * had a reason to go to any. The sidebar entries that lead to a star carry a
 * small star of their own, and every page explains itself when a student
 * arrives, so the map is said once and the rest is learned by going.
 */
function tourSteps(isPhone: boolean, state?: Pick<FirstNightState, "examReady">): Omit<FirstNightGuidePlan, "key">[] {
  const T = FIRST_NIGHT_TARGETS;
  const first = state?.examReady ? "a real exam question from your course" : "your first flashcard";
  return [
    {
      target: T.navShell,
      near: isPhone ? undefined : T.navShell,
      text: isPhone
        ? "This bar is your map to all of Jami. Swipe it sideways to see everything. The places with a small star are where tonight's stars are."
        : "This is your map to all of Jami. The places with a small star are where tonight's stars are.",
      doneLabel: "Next",
      done: "next-tour",
      skippable: true,
      eyebrow: "Jami · 1 of 2",
    },
    {
      target: T.panel,
      near: isPhone ? undefined : T.panel,
      text: `Six stars, each one a real thing you will do in Jami, most in about a minute. We will start with ${first}.`,
      doneLabel: "Let's go",
      done: "finish-tour",
      eyebrow: "Jami · 2 of 2",
    },
  ];
}

export const FIRST_NIGHT_TOUR_LENGTH = tourSteps(false).length;

function note(key: string, target: string | null, text: string): FirstNightGuidePlan {
  return { key, target, text, doneLabel: "Got it", done: "dismiss" };
}

/**
 * The one note that applies right now, if any.
 *
 * Decided from where the student is and what is actually on the page, so a
 * note only ever points at something they can see and press. No note lights a
 * star: every one waits for the thing itself to happen.
 */
export function planFirstNightGuide({ state, pathname, isPhone, pointing, present }: GuideInput): FirstNightGuidePlan | null {
  const T = FIRST_NIGHT_TARGETS;
  const where = isPhone ? "in the bar at the bottom" : "in the sidebar";

  if (state.stage === "tour") {
    const steps = tourSteps(isPhone, state);
    const index = Math.min(state.tourStep, steps.length - 1);
    return { ...steps[index], key: `tour-${index}` };
  }

  if (state.stage === "sky") {
    if (pathname.startsWith("/dashboard/constellation")) {
      return {
        key: "sky-here",
        target: null,
        text: "This is your sky, and that's your first star. Every goal you finish adds another. Drag them wherever you like, and once you have a few, ask Jami to draw them into a picture.",
        doneLabel: "Finish",
        done: "finish",
      };
    }
    const stars = navTarget("Stars");
    return {
      key: "sky-go",
      target: stars,
      near: isPhone ? undefined : stars,
      text: `Your first star is waiting in your sky. Tap Stars ${where} to see it.`,
      doneLabel: "Later",
      done: "finish",
    };
  }

  if (state.stage !== "exploring") return null;

  const lit = new Set(state.lit);
  const wanted = firstNightDiscoveries(state).filter((discovery) => !lit.has(discovery.id));
  const needs = (id: FirstNightDiscoveryId) => wanted.some((discovery) => discovery.id === id);

  if (pointing && needs(pointing)) {
    const discovery = getFirstNightDiscovery(pointing);
    if (!isOnDiscoveryRoute(pathname, discovery)) {
      const nav = navTarget(discovery.navLabel);
      return {
        key: `point-${discovery.id}`,
        target: nav,
        near: isPhone ? undefined : nav,
        text:
          discovery.id === "tutor"
            ? `You ask Jami from inside your notebook. Tap Practice ${where}, then open your notebook.`
            : `That's in ${discovery.navLabel}. Tap ${discovery.navLabel} ${where} to go there.`,
        doneLabel: "Maybe later",
        done: "clear-point",
      };
    }
  }

  // Of the stars a page could lead to, the one asked for from Today, else the first still unlit.
  const focus = (...ids: FirstNightDiscoveryId[]) => {
    const open = ids.filter(needs);
    if (state.intent && open.includes(state.intent)) return state.intent;
    return FIRST_NIGHT_DISCOVERIES.find((discovery) => open.includes(discovery.id))?.id ?? null;
  };

  if (pathname.startsWith("/dashboard/notebooks/")) {
    const next = focus("notebook", "tutor");
    if (next === "notebook") {
      return present(T.pen)
        ? note("notebook-write", T.pen, "This is your notebook. Pick the pen and write anything, or tap the page to type. It saves by itself, and your star lights when it does.")
        : note("notebook-type", null, "This is your notebook. Tap the page and type anything, like today's topic. It saves by itself, and your star lights when it does.");
    }
    if (next === "tutor" && present(T.askTutor)) {
      return note("tutor-ask", T.askTutor, "Now ask Jami about it. Tap Ask Jami and ask a question about this page, like \"test me on this\".");
    }
    return null;
  }

  if (pathname.startsWith("/dashboard/folders/")) {
    const next = focus("notebook", "tutor");
    if (!next) return null;
    if (present(T.firstNotebook)) {
      return note(
        `${next}-open-notebook`,
        T.firstNotebook,
        next === "tutor" ? "Open your notebook. Ask Jami is at the top of it." : "Open your notebook to start writing."
      );
    }
    if (present(T.createNotebook)) {
      return note("notebook-create", T.createNotebook, "This folder is empty for now. Make your first notebook here. Call it anything, like \"Class notes\".");
    }
    return null;
  }

  if (pathname.startsWith("/dashboard/practice/questions/new")) {
    if (!needs("exam")) return null;
    return present(T.startExam)
      ? note("exam-start", T.startExam, "One or two questions is plenty for now. Set the mix, then press Start practice.")
      : null;
  }

  if (pathname.startsWith("/dashboard/practice/questions/")) {
    if (!needs("exam")) return null;
    return present(T.markAnswer)
      ? note("exam-mark", T.markAnswer, "Write your answer, then press Mark answer. Jami marks it against the real mark scheme and your star lights.")
      : null;
  }

  if (pathname === "/dashboard/practice") {
    const next = focus("notebook", "tutor", "exam");
    if (next === "exam" && present(T.examQuestions)) {
      return note("exam-open", T.examQuestions, "Real exam questions for your course live here. Open them to answer one.");
    }
    if (next === "notebook" || next === "tutor") {
      if (present(T.firstFolder)) {
        return note(`${next}-folder`, T.firstFolder, "Your subjects are here, one folder each. Open one to find its notebooks.");
      }
      if (present(T.createFolder)) {
        return note("notebook-new-folder", T.createFolder, "Make a folder for one of your subjects. Its notebooks will live inside.");
      }
    }
    return null;
  }

  if (pathname.startsWith("/dashboard/decks/")) {
    return needs("cards") && present(T.createCard)
      ? note("cards-add", T.createCard, "Write a question on the front and its answer on the back, then press Add card.")
      : null;
  }

  if (pathname.startsWith("/dashboard/decks")) {
    if (!needs("cards")) return null;
    if (present(T.deckAddCard)) return note("cards-open-deck", T.deckAddCard, "Your deck is ready. Press Add card to write your first flashcard.");
    if (present(T.createDeck)) return note("cards-deck", T.createDeck, "Flashcards live in decks. Give your first deck a name, like one of your subjects, and create it.");
    return null;
  }

  if (pathname.startsWith("/dashboard/study")) {
    if (!needs("learn")) return null;
    if (present(T.flashcard)) {
      return note("learn-flip", T.flashcard, "Think of the answer, then tap the card to flip it and say how well you knew it.");
    }
    if (present(T.startReview)) {
      return note("learn-start", T.startReview, "Your flashcard is ready to review. Start your review.");
    }
    if (needs("cards")) {
      const flashcards = navTarget("Flashcards");
      return {
        key: "learn-needs-card",
        target: flashcards,
        near: isPhone ? undefined : flashcards,
        text: `There's nothing to review until you've made a flashcard. Tap Flashcards ${where} to make one.`,
        doneLabel: "Got it",
        done: "dismiss",
      };
    }
    return null;
  }

  // Plan opens on the revision plan; goals are its second tab.
  if (pathname.startsWith(PLANNER_PATH)) {
    if (!needs("goal") || !present(T.goalsTab)) return null;
    return note("goal-tab", T.goalsTab, "Goals live here in Plan, beside your revision plan. Tap Goals to set your first one.");
  }

  if (pathname.startsWith("/dashboard/goals")) {
    if (!needs("goal")) return null;
    if (present(T.createGoal)) {
      return note("goal-create", T.createGoal, "Pick what to aim at, adjust it if you like, then press Create goal. Finish it and it earns a star.");
    }
    if (present(T.newGoal)) {
      return note("goal-new", T.newGoal, "Goals give your studying a target, and every goal you finish adds a star to your sky. Make your first one.");
    }
    return null;
  }

  if (pathname.startsWith("/dashboard/tutor") && needs("tutor")) {
    return note("tutor-page", null, "Jami reads only what you hand it. The quickest way to try it is from your notebook: open it and tap Ask Jami at the top.");
  }

  return null;
}
