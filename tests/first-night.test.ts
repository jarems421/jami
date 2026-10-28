import { describe, expect, it } from "vitest";
import {
  allFirstNightLit,
  createFirstNightState,
  FIRST_NIGHT_ACTIONS,
  FIRST_NIGHT_DISCOVERIES,
  FIRST_NIGHT_TARGETS,
  FIRST_NIGHT_TOUR_LENGTH,
  firstNightDiscoveries,
  getFirstNightDiscovery,
  isOnDiscoveryRoute,
  mergeFirstNight,
  navTarget,
  pendingNavLabels,
  planFirstNightGuide,
  planFirstNightSetup,
  nextFirstNightDiscovery,
  readFirstNightQuery,
  readFirstNightState,
  SECOND_NIGHT_ACTIONS,
  SECOND_NIGHT_STARS,
  secondNightOpen,
  type FirstNightState,
} from "@/lib/onboarding/first-night";
import type { ExamCourseSelection } from "@/lib/practice/exam-questions";

const exploring = (overrides: Partial<FirstNightState> = {}): FirstNightState => ({
  ...createFirstNightState(),
  stage: "exploring",
  ...overrides,
});

const presentOnly = (...selectors: string[]) => (selector: string) => selectors.includes(selector);

const T = FIRST_NIGHT_TARGETS;

const MATHS_HIGHER: ExamCourseSelection = {
  board: "aqa",
  qualification: "gcse",
  specificationId: "8300",
  specificationTitle: "GCSE Mathematics (8300)",
  tier: "Higher",
  componentIds: ["8300/1H", "8300/2H", "8300/3H"],
};

describe("starting and remembering it", () => {
  it("starts from the link and ends from it", () => {
    expect(readFirstNightQuery("?first-night=preview")).toBe("preview");
    expect(readFirstNightQuery("?first-night=off")).toBe("off");
    expect(readFirstNightQuery("?other=1")).toBeNull();
  });

  it("reads back a stored state defensively, dropping stars that no longer exist", () => {
    expect(
      readFirstNightState({ version: 1, stage: "sky", tourStep: 2, lit: ["learn", "stars", "learn"], intent: "exam", examReady: true })
    ).toEqual({
      version: 1,
      stage: "sky",
      tourStep: 2,
      lit: ["learn"],
      intent: "exam",
      examReady: true,
      rewardState: "not-earned",
      bonus: [],
      bonusHidden: false,
      updatedAt: 0,
    });
    // Records from before the second night, and junk in its fields, read as none of it.
    expect(
      readFirstNightState({ version: 1, stage: "finished", bonus: ["plan", "moon", "plan"], bonusHidden: "yes" })
    ).toMatchObject({ bonus: ["plan"], bonusHidden: false });
    expect(readFirstNightState({ version: 1, stage: "tour" })?.examReady).toBe(false);
    expect(readFirstNightState({ version: 2, stage: "tour" })).toBeNull();
    expect(readFirstNightState("tour")).toBeNull();
  });

  it("carries on from whichever copy changed last, preferring the account on a tie", () => {
    const local = { ...createFirstNightState(10), stage: "exploring" as const, lit: ["learn" as const] };
    const remote = { ...createFirstNightState(20), stage: "tour" as const };
    expect(mergeFirstNight(local, remote)).toBe(remote);
    expect(mergeFirstNight({ ...local, updatedAt: 30 }, remote)?.lit).toEqual(["learn"]);
    expect(mergeFirstNight({ ...local, updatedAt: 20 }, remote)).toBe(remote);
    expect(mergeFirstNight(null, remote)).toBe(remote);
  });
});

describe("setting up the subjects", () => {
  it("makes a folder per subject with its level and course, and no notebooks", () => {
    const plan = planFirstNightSetup(
      {
        studyLevel: "gcse-equivalent",
        subjects: [
          { name: "Maths", examCourse: MATHS_HIGHER },
          { name: " History ", examCourse: null },
          { name: "maths", examCourse: null },
        ],
      },
      []
    );
    expect(plan.create).toEqual([
      { name: "Maths", studyLevel: "gcse-equivalent", examCourse: MATHS_HIGHER },
      { name: "History", studyLevel: "gcse-equivalent", examCourse: null },
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.examReady).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("notebook");
  });

  it("gives an existing folder the course it lacked, without duplicating it", () => {
    const plan = planFirstNightSetup(
      { studyLevel: "gcse-equivalent", subjects: [{ name: "Maths", examCourse: MATHS_HIGHER }] },
      [{ id: "f1", name: "maths" }]
    );
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([{ id: "f1", examCourse: MATHS_HIGHER, studyLevel: "gcse-equivalent" }]);

    const alreadySet = planFirstNightSetup(
      { studyLevel: "gcse-equivalent", subjects: [{ name: "Maths", examCourse: MATHS_HIGHER }] },
      [{ id: "f1", name: "Maths", studyLevel: "gcse-equivalent", examCourse: { ...MATHS_HIGHER, tier: "Foundation" } }]
    );
    expect(alreadySet.update).toEqual([]);
  });

  it("is not ready for exam questions when no course was settled", () => {
    expect(planFirstNightSetup({ studyLevel: null, subjects: [{ name: "Law", examCourse: null }] }, []).examReady).toBe(false);
  });
});

describe("which stars there are", () => {
  it("asks for the exam star only when a course with questions was set up", () => {
    expect(firstNightDiscoveries({ examReady: false }).map((discovery) => discovery.id)).toEqual(["cards", "learn", "notebook", "tutor", "goal"]);
    // First when there is one: it is what a new student should see Jami do.
    expect(firstNightDiscoveries({ examReady: true }).map((discovery) => discovery.id)[0]).toBe("exam");
    expect(allFirstNightLit(exploring({ lit: ["notebook", "tutor", "cards", "learn", "goal"] }))).toBe(true);
    expect(allFirstNightLit(exploring({ examReady: true, lit: ["notebook", "tutor", "cards", "learn", "goal"] }))).toBe(false);
  });

  it("lights each star from something the app actually did", () => {
    expect(FIRST_NIGHT_ACTIONS).toEqual({
      "save-work": "notebook",
      "ask-tutor": "tutor",
      "create-card": "cards",
      "complete-review": "learn",
      "mark-exam-answer": "exam",
      "create-goal": "goal",
    });
  });

  it("knows where each one happens", () => {
    expect(isOnDiscoveryRoute("/dashboard/folders/abc", getFirstNightDiscovery("notebook"))).toBe(true);
    expect(isOnDiscoveryRoute("/dashboard/notebooks/n1", getFirstNightDiscovery("tutor"))).toBe(true);
    expect(isOnDiscoveryRoute("/dashboard/practice/questions/new", getFirstNightDiscovery("notebook"))).toBe(false);
    expect(isOnDiscoveryRoute("/dashboard/practice/questions/new", getFirstNightDiscovery("exam"))).toBe(true);
    expect(isOnDiscoveryRoute("/dashboard/decks/d1", getFirstNightDiscovery("cards"))).toBe(true);
    expect(isOnDiscoveryRoute("/dashboard/goals", getFirstNightDiscovery("goal"))).toBe(true);
  });

  it("marks the sidebar entries that still lead to a star, then Stars at the end", () => {
    expect(pendingNavLabels(exploring({ lit: ["notebook", "tutor"] }))).toEqual(["Flashcards", "Learn", "Plan"]);
    expect(pendingNavLabels(exploring({ examReady: true, lit: ["notebook", "tutor"] }))).toEqual(["Practice", "Flashcards", "Learn", "Plan"]);
    expect(pendingNavLabels(exploring({ stage: "sky" }))).toEqual(["Stars"]);
    expect(pendingNavLabels(exploring({ stage: "finished" }))).toEqual([]);
  });
});

describe("which note shows", () => {
  const run = (state: FirstNightState, pathname: string, ...present: string[]) =>
    planFirstNightGuide({ state, pathname, isPhone: false, pointing: null, present: presentOnly(...present) });

  it("says where the map is once, then points at the stars and goes", () => {
    const plan = (state: FirstNightState, isPhone = false) =>
      planFirstNightGuide({ state, pathname: "/dashboard", isPhone, pointing: null, present: () => false });
    expect(FIRST_NIGHT_TOUR_LENGTH).toBe(2);

    const map = plan(exploring({ stage: "tour", tourStep: 0 }));
    expect(map).toMatchObject({ target: T.navShell, eyebrow: "Jami · 1 of 2", done: "next-tour" });
    expect(plan(exploring({ stage: "tour", tourStep: 0 }), true)?.text).toContain("Swipe");

    const stars = plan(exploring({ stage: "tour", tourStep: 1, examReady: true }));
    expect(stars).toMatchObject({ target: T.panel, done: "finish-tour", doneLabel: "Let's go" });
    expect(stars?.text).toContain("real exam question");
    expect(plan(exploring({ stage: "tour", tourStep: 1 }))?.text).toContain("first flashcard");
  });

  it("points at the sidebar entry until the student gets there", () => {
    const state = exploring();
    expect(planFirstNightGuide({ state, pathname: "/dashboard", isPhone: false, pointing: "cards", present: () => true })).toMatchObject({
      target: navTarget("Flashcards"),
      done: "clear-point",
    });
    // Asking Jami happens in the notebook, which is reached through Practice.
    expect(planFirstNightGuide({ state, pathname: "/dashboard", isPhone: false, pointing: "tutor", present: () => true })?.target).toBe(navTarget("Practice"));
  });

  it("leads from a folder to making a notebook, writing in it, then asking Jami", () => {
    const state = exploring();
    expect(run(state, "/dashboard/practice", T.firstFolder)?.target).toBe(T.firstFolder);
    expect(run(state, "/dashboard/practice", T.createFolder)?.target).toBe(T.createFolder);
    // The folder the welcome made is empty: the student makes the notebook.
    expect(run(state, "/dashboard/folders/f1", T.createNotebook)?.target).toBe(T.createNotebook);
    expect(run(state, "/dashboard/folders/f1", T.firstNotebook, T.createNotebook)?.target).toBe(T.firstNotebook);
    expect(run(state, "/dashboard/notebooks/n1", T.pen, T.askTutor)?.target).toBe(T.pen);
    expect(run(state, "/dashboard/notebooks/n1")).toMatchObject({ target: null });
    expect(run(exploring({ lit: ["notebook"] }), "/dashboard/notebooks/n1", T.pen, T.askTutor)?.target).toBe(T.askTutor);
    expect(run(exploring({ lit: ["notebook", "tutor"] }), "/dashboard/notebooks/n1", T.pen, T.askTutor)).toBeNull();
  });

  it("takes the student through making a deck and a card before reviewing it", () => {
    const state = exploring({ lit: ["notebook", "tutor"] });
    expect(run(state, "/dashboard/decks", T.createDeck)?.target).toBe(T.createDeck);
    expect(run(state, "/dashboard/decks", T.createDeck, T.deckAddCard)?.target).toBe(T.deckAddCard);
    expect(run(state, "/dashboard/decks/d1", T.createCard)?.target).toBe(T.createCard);

    // Learn with nothing to review sends them to make a card, rather than lighting anything.
    expect(run(state, "/dashboard/study")).toMatchObject({ target: navTarget("Flashcards") });
    const withCard = exploring({ lit: ["notebook", "tutor", "cards"] });
    expect(run(withCard, "/dashboard/study", T.startReview)?.target).toBe(T.startReview);
    expect(run(withCard, "/dashboard/study", T.flashcard)?.target).toBe(T.flashcard);
  });

  it("walks a real exam question from Practice to Mark answer, only when there is a course", () => {
    const ready = exploring({ examReady: true, lit: ["notebook", "tutor"] });
    expect(run(ready, "/dashboard/practice", T.firstFolder, T.examQuestions)?.target).toBe(T.examQuestions);
    expect(run(ready, "/dashboard/practice/questions/new", T.startExam)?.target).toBe(T.startExam);
    expect(run(ready, "/dashboard/practice/questions/s1", T.markAnswer)?.target).toBe(T.markAnswer);
    expect(run(exploring({ lit: ["notebook", "tutor"] }), "/dashboard/practice/questions/s1", T.markAnswer)).toBeNull();
    // Asked for from Today, the exam note comes first even with notebooks still to do.
    expect(run(exploring({ examReady: true, intent: "exam" }), "/dashboard/practice", T.firstFolder, T.examQuestions)?.target).toBe(T.examQuestions);
  });

  it("opens the goal composer, then points at Create goal", () => {
    const state = exploring();
    expect(run(state, "/dashboard/goals", T.newGoal)?.target).toBe(T.newGoal);
    expect(run(state, "/dashboard/goals", T.createGoal)?.target).toBe(T.createGoal);
  });

  it("finds goals through Plan, which opens on the revision plan", () => {
    const state = exploring();
    // From anywhere else the guide points at the Plan entry...
    expect(planFirstNightGuide({ state, pathname: "/dashboard", isPhone: false, pointing: "goal", present: () => true })?.target).toBe(navTarget("Plan"));
    // ...which lands on the revision plan, so it stops pointing there and shows the Goals tab instead.
    expect(isOnDiscoveryRoute("/dashboard/planner", getFirstNightDiscovery("goal"))).toBe(true);
    expect(run(state, "/dashboard/planner", T.goalsTab)).toMatchObject({ key: "goal-tab", target: T.goalsTab });
    // Nothing to say on the plan once the goal star is lit.
    expect(run(exploring({ lit: ["goal"] }), "/dashboard/planner", T.goalsTab)).toBeNull();
  });

  it("never lights a star from a note", () => {
    const pages: Array<[string, string[]]> = [
      ["/dashboard/notebooks/n1", [T.pen, T.askTutor]],
      ["/dashboard/decks/d1", [T.createCard]],
      ["/dashboard/study", [T.flashcard]],
      ["/dashboard/goals", [T.createGoal]],
      ["/dashboard/practice/questions/s1", [T.markAnswer]],
      ["/dashboard/tutor", []],
    ];
    for (const [pathname, present] of pages) {
      const plan = run(exploring({ examReady: true }), pathname, ...present);
      expect(plan, pathname).not.toBeNull();
      expect(plan?.done, pathname).toBe("dismiss");
    }
  });

  it("ends by taking the student to see their star in the sky", () => {
    const sky = exploring({ stage: "sky" });
    expect(run(sky, "/dashboard")).toMatchObject({ target: navTarget("Stars"), done: "finish" });
    expect(run(sky, "/dashboard/constellation")).toMatchObject({ target: null, done: "finish", doneLabel: "Finish" });
    expect(run(exploring({ stage: "finished" }), "/dashboard/constellation")).toBeNull();
  });
});

describe("the next star", () => {
  it("offers the first unlit star, or the one asked for from Today", () => {
    expect(nextFirstNightDiscovery(exploring({ examReady: true }))?.id).toBe("exam");
    expect(nextFirstNightDiscovery(exploring({ examReady: false }))?.id).toBe("cards");
    expect(nextFirstNightDiscovery(exploring({ examReady: true, lit: ["exam"] }))?.id).toBe("cards");
    expect(nextFirstNightDiscovery(exploring({ examReady: true, intent: "goal" }))?.id).toBe("goal");
    // A lit star asked for is not offered again.
    expect(nextFirstNightDiscovery(exploring({ lit: ["goal"], intent: "goal" }))?.id).toBe("cards");
    expect(
      nextFirstNightDiscovery(exploring({ examReady: true, lit: FIRST_NIGHT_DISCOVERIES.map((discovery) => discovery.id) }))
    ).toBeNull();
  });

  it("says how long each one takes, what it is, and what it gave", () => {
    for (const discovery of FIRST_NIGHT_DISCOVERIES) {
      expect(discovery.minutes, discovery.id).toBeGreaterThan(0);
      expect(discovery.promise.length, discovery.id).toBeGreaterThan(10);
      expect(discovery.unlocked.length, discovery.id).toBeGreaterThan(10);
      // "Take me there" lands on a page where that star's note can take over.
      expect(isOnDiscoveryRoute(discovery.href, discovery), discovery.id).toBe(true);
    }
  });
});

describe("the second night", () => {
  it("is offered only once the first night is over, until it is done or put away", () => {
    expect(secondNightOpen(exploring())).toBe(false);
    expect(secondNightOpen(exploring({ stage: "finished" }))).toBe(true);
    expect(secondNightOpen(exploring({ stage: "finished", bonusHidden: true }))).toBe(false);
    expect(
      secondNightOpen(exploring({ stage: "finished", bonus: SECOND_NIGHT_STARS.map((star) => star.id) }))
    ).toBe(false);
    expect(secondNightOpen(null)).toBe(false);
  });

  it("lights each star from something the app actually did", () => {
    expect(SECOND_NIGHT_ACTIONS).toEqual({ "add-source": "source", "plan-week": "plan", "view-progress": "progress" });
    // Never the same actions as the first night, so one thing cannot light two stars.
    for (const action of Object.keys(SECOND_NIGHT_ACTIONS)) {
      expect(FIRST_NIGHT_ACTIONS).not.toHaveProperty(action);
    }
  });
});
