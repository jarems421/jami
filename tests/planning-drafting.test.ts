import { describe, expect, it } from "vitest";
import {
  buildPlanSubjectSupport,
  fallbackPlanTask,
  fillFreeSessions,
  isUntouchedDraftDay,
  planFill,
  planFillNotice,
  planRefreshSuggestions,
  splitSessionMinutes,
  studentTaskHref,
  type PlanDraftingContext,
} from "@/lib/planning/plan-drafting";
import { resolveTimetableDays, planFreeSessionsOn, openActivityFromFreeSession } from "@/lib/planning/timetable";
import { planDayKeysBetween } from "@/lib/planning/plan-schedule";
import { FRIDAY, MONDAY, SUNDAY, TUESDAY, WEDNESDAY, planActivity, revisionPlan, studyAction } from "./support/plan-fixtures";

/**
 * Jami filling free sessions, when asked. Every task it writes is the Learning
 * Engine's, in its order, or a fallback the subject certainly has -- and a
 * subject with neither keeps honest free time rather than a pretend task.
 */

function counter() {
  let next = 0;
  return () => {
    next += 1;
    return next / 1000;
  };
}

function context(overrides: Partial<PlanDraftingContext> = {}): PlanDraftingContext {
  return {
    actionsByScope: new Map([
      ["folder:biology", [studyAction("homeostasis"), studyAction("enzymes"), studyAction("cell division")]],
      ["folder:chemistry", [studyAction("bonding", { folderId: "chemistry" })]],
    ]),
    support: new Map([
      ["folder:biology", { deckIds: ["bio-deck"], cardCount: 40, questionPracticeFolderId: "biology" }],
      ["folder:chemistry", { deckIds: [], cardCount: 0 }],
    ]),
    random: counter(),
    ...overrides,
  };
}

function freeDays(plan = revisionPlan()) {
  return planDayKeysBetween(MONDAY, SUNDAY).map((dayKey) => ({
    dayKey,
    activities: planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession),
  }));
}

describe("sharing out a session's time", () => {
  it("keeps a short session whole, splits an hour into a main piece and a shorter one, and caps the pieces", () => {
    expect(splitSessionMinutes(20)).toEqual([20]);
    expect(splitSessionMinutes(30)).toEqual([30]);
    expect(splitSessionMinutes(45)).toEqual([30, 15]);
    expect(splitSessionMinutes(60)).toEqual([40, 20]);
    expect(splitSessionMinutes(90)).toEqual([30, 30, 30]);
    expect(splitSessionMinutes(240)).toEqual([60, 60, 60, 60]);
    for (const minutes of [35, 50, 75, 100, 150, 200]) {
      const parts = splitSessionMinutes(minutes);
      expect(parts.reduce((total, part) => total + part, 0)).toBe(minutes);
      expect(parts.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("filling a week", () => {
  it("gives each free session real tasks from the engine, in its order, never the same one twice", () => {
    const filled = fillFreeSessions({ days: freeDays(), context: context() });
    const monday = filled.get(MONDAY) ?? [];
    expect(monday.map((activity) => [activity.startTime, activity.minutes, activity.title, activity.mode, activity.origin])).toEqual([
      ["17:00", 30, "Homeostasis", "adaptive", "jami"],
      ["17:30", 15, "Enzymes", "adaptive", "jami"],
    ]);
    expect(monday[0]).toMatchObject({ method: "practice", actionId: "folder:biology|low_mastery|topic:homeostasis", targetItems: 6 });
    expect(monday[0]?.href).toContain("topics=homeostasis");
    // Friday's Biology picks up where Monday left off, then falls back to what Biology always has.
    expect((filled.get(FRIDAY) ?? []).map((activity) => activity.title)).toEqual(["Cell division", "Review your cards"]);
  });

  it("keeps honest free time where a subject has nothing Jami can set", () => {
    const filled = fillFreeSessions({
      days: freeDays(),
      context: context({ actionsByScope: new Map(), support: new Map() }),
    });
    expect(filled.size).toBe(0);
  });

  it("fills what it can and leaves the rest of the session free", () => {
    const chemistryEvening = revisionPlan({
      sessions: [{ id: "wed", weekday: 3, minutes: 45, startTime: "18:00", scopeKey: "folder:chemistry" }],
    });
    const filled = fillFreeSessions({ days: [freeDays(chemistryEvening)[2]!], context: context() });
    // Chemistry has one action, no cards and no question bank: the second piece stays free time.
    expect(
      (filled.get(WEDNESDAY) ?? []).map((activity) => [activity.title, activity.open ?? false, activity.minutes, activity.startTime])
    ).toEqual([
      ["Bonding", false, 30, "18:00"],
      ["", true, 15, "18:30"],
    ]);
  });

  it("leaves anything with a task in it exactly where it is", () => {
    const own = planActivity({ id: "mine", title: "Finish my homework", method: "other", startTime: "16:00" });
    const filled = fillFreeSessions({
      days: [{ dayKey: MONDAY, activities: [own, ...freeDays()[0]!.activities] }],
      context: context(),
    });
    expect(filled.get(MONDAY)?.[0]).toEqual(own);
  });

  it("does not repeat work already on the timetable nearby", () => {
    const filled = fillFreeSessions({
      days: [freeDays()[0]!],
      context: context(),
      alreadyPlanned: new Set(["folder:biology|low_mastery|topic:homeostasis"]),
    });
    expect((filled.get(MONDAY) ?? []).map((activity) => activity.title)).toEqual(["Enzymes", "Cell division"]);
  });

  it("says when Jami will write the material as the student starts", () => {
    const writes = studyAction("osmosis", { intervention: { type: "create_practice", because: "no_application", alternatives: [] } as never });
    const filled = fillFreeSessions({
      days: [freeDays()[0]!],
      context: context({ actionsByScope: new Map([["folder:biology", [writes]]]) }),
    });
    expect(filled.get(MONDAY)?.[0]).toMatchObject({ title: "Osmosis", writtenOnStart: true });
  });
});

describe("what a subject falls back on", () => {
  it("takes due cards and exam questions in turn, and nothing it does not have", () => {
    const support = buildPlanSubjectSupport({
      scopes: [{ folderId: "biology" }, { folderId: "history" }],
      decks: [{ id: "bio-deck", folderIds: ["biology"] }, { id: "empty", folderIds: ["biology"] }],
      cards: [{ deckId: "bio-deck" }, { deckId: "bio-deck" }],
      questionPracticeFolderIds: new Set(["biology"]),
    });
    expect(support.get("folder:biology")).toEqual({ deckIds: ["bio-deck"], cardCount: 2, questionPracticeFolderId: "biology" });
    expect(fallbackPlanTask(support.get("folder:biology"), 0)?.method).toBe("flashcards");
    expect(fallbackPlanTask(support.get("folder:biology"), 1)?.method).toBe("practice");
    expect(fallbackPlanTask(support.get("folder:history"), 0)).toBeNull();
  });

  it("links a student's own task to somewhere real, or nowhere", () => {
    const support = new Map([["folder:biology", { deckIds: ["bio-deck"], cardCount: 4, questionPracticeFolderId: "biology" }]]);
    expect(studentTaskHref({ method: "flashcards", scopeKey: "folder:biology", support })).toContain("decks=bio-deck");
    expect(studentTaskHref({ method: "practice", scopeKey: "folder:biology", support })).toContain("folderId=biology");
    expect(
      studentTaskHref({ method: "flashcards", scopeKey: "folder:biology", topic: { kind: "topic", id: "t1", label: "Osmosis" }, support })
    ).toContain("topics=t1");
    expect(studentTaskHref({ method: "other", scopeKey: "folder:biology", support })).toBeUndefined();
    // Notebook work opens its notebook when it has one, the subject's folder when it does not.
    expect(studentTaskHref({ method: "notebook", scopeKey: "folder:biology", notebookId: "nb-1", support })).toBe("/dashboard/notebooks/nb-1");
    expect(studentTaskHref({ method: "notebook", scopeKey: "folder:biology", support })).toBe("/dashboard/folders/biology");
  });
});

describe("what a fill did, said", () => {
  it("fills only the free sessions it was asked to, and counts what it put in", () => {
    const monday = {
      dayKey: MONDAY,
      activities: [
        planActivity({ id: "early", title: "", open: true, minutes: 30, startTime: "16:00", mode: "adaptive" }),
        planActivity({ id: "late", title: "", open: true, minutes: 30, startTime: "19:00", mode: "adaptive" }),
      ],
    };
    const outcome = planFill([monday], context(), { only: new Set(["late"]) });
    expect(outcome.added).toBe(1);
    expect(outcome.unfilledScopeKeys).toEqual([]);
    const [op] = outcome.ops;
    expect(op).toMatchObject({ type: "setDay", dayKey: MONDAY, ifIds: ["early", "late"] });
    // The session it was not asked about is still free, where it was.
    expect(op?.type === "setDay" ? op.activities?.map((activity) => [activity.id === "early", activity.open ?? false]) : []).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it("names the subjects it had nothing for, so a fill is never a button that did nothing", () => {
    const chemistryOnly = revisionPlan({ sessions: [{ id: "wed", weekday: 3, minutes: 30, scopeKey: "folder:chemistry" }] });
    const outcome = planFill([freeDays(chemistryOnly)[2]!], context({ actionsByScope: new Map() }));
    expect(outcome).toEqual({ ops: [], added: 0, unfilledScopeKeys: ["folder:chemistry"] });

    const names = (scopeKey: string) => (scopeKey === "folder:chemistry" ? "Chemistry" : "Physics");
    expect(planFillNotice({ picked: 0, unfilledScopeKeys: ["folder:chemistry"] }, names)).toBe(
      "Jami has nothing to pick from in Chemistry yet: no cards, exam questions or marked work there. Choose the task yourself instead."
    );
    expect(planFillNotice({ picked: 3, unfilledScopeKeys: ["folder:chemistry", "folder:physics"] }, names)).toContain(
      "nothing more to pick from in Chemistry and Physics yet"
    );
    expect(planFillNotice({ picked: 3, unfilledScopeKeys: [] }, names)).toBeNull();
  });
});

describe("drafting a week again", () => {
  it("counts a day as Jami's own draft only while nothing in it is the student's", () => {
    const jami = planActivity({ id: "j", mode: "adaptive", origin: "jami" });
    expect(isUntouchedDraftDay([jami], {})).toBe(true);
    expect(isUntouchedDraftDay([jami], { j: { by: "manual", at: 1 } })).toBe(false);
    expect(isUntouchedDraftDay([jami, planActivity({ id: "s" })], {})).toBe(false);
    expect(isUntouchedDraftDay([{ ...jami, mode: "fixed" }], {})).toBe(false);
  });
});

describe("suggesting better work later", () => {
  const plan = revisionPlan({ sessions: [] });
  const week = (activities: ReturnType<typeof planActivity>[]) =>
    resolveTimetableDays({
      plan,
      dayKeys: [MONDAY, WEDNESDAY],
      entries: [{ dayKey: WEDNESDAY, activities }],
      todayDayKey: TUESDAY,
    });

  it("suggests, never swaps, when a planned task is no longer recommended", () => {
    const stale = planActivity({ id: "s", mode: "adaptive", origin: "jami", actionId: "folder:biology|low_mastery|topic:mitosis" });
    const suggestions = planRefreshSuggestions({
      days: week([stale]),
      actionsByScope: context().actionsByScope,
      answeredScopes: new Set(["folder:biology"]),
    });
    expect(suggestions).toEqual([
      expect.objectContaining({ dayKey: WEDNESDAY, activityId: "s", task: expect.objectContaining({ title: "Homeostasis" }) }),
    ]);
  });

  it("leaves alone what is still recommended, fixed, done, or in a subject the engine did not answer for", () => {
    const current = planActivity({ id: "c", mode: "adaptive", origin: "jami", actionId: "folder:biology|low_mastery|topic:enzymes" });
    const fixed = planActivity({ id: "f", mode: "fixed", origin: "jami", actionId: "gone" });
    const unanswered = planActivity({ id: "u", mode: "adaptive", origin: "jami", actionId: "gone", scopeKey: "folder:chemistry" });
    expect(
      planRefreshSuggestions({
        days: week([current, fixed, unanswered]),
        actionsByScope: context().actionsByScope,
        answeredScopes: new Set(["folder:biology"]),
      })
    ).toEqual([]);
  });

  it("offers something specific in place of a fallback once the engine has it", () => {
    const fallback = planActivity({ id: "fb", title: "Review your cards", method: "flashcards", mode: "adaptive", origin: "jami" });
    const [suggestion] = planRefreshSuggestions({
      days: week([fallback]),
      actionsByScope: context().actionsByScope,
      answeredScopes: new Set(["folder:biology"]),
    });
    expect(suggestion?.task.title).toBe("Homeostasis");
  });
});
