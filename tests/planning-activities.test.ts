import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_SESSION_MINUTES,
  defaultPlanActivityTitle,
  methodForDestination,
  normalizePlanActivities,
  normalizePlanActivity,
  normalizePlanActivityDone,
  planActivitiesClash,
  planActivityEndTime,
  planActivityTaskFromAction,
} from "@/lib/planning/plan-activities";
import { planActivity, studyAction } from "./support/plan-fixtures";

/** One activity on the timetable, through the gate every one goes through. */

describe("an activity, as stored", () => {
  it("keeps what an activity is and drops what it cannot be", () => {
    expect(normalizePlanActivity({ id: "a", title: "  Finish   my homework ", minutes: 45, startTime: "25:00" })).toEqual({
      id: "a",
      title: "Finish my homework",
      method: "other",
      minutes: 45,
      mode: "fixed",
      origin: "student",
    });
    expect(normalizePlanActivity({ id: "", title: "x" })).toBeNull();
    expect(normalizePlanActivity({ id: "a", title: "" })).toBeNull();
    expect(normalizePlanActivity("nonsense")).toBeNull();
  });

  it("keeps a free session honestly empty", () => {
    expect(
      normalizePlanActivity({ id: "f", open: true, title: "ignored", minutes: 30, scopeKey: "folder:biology", mode: "adaptive", href: "/dashboard/x" })
    ).toEqual({ id: "f", title: "", method: "other", minutes: 30, scopeKey: "folder:biology", mode: "adaptive", origin: "student", open: true });
  });

  it("never follows a link off the app, and only adapts within a subject", () => {
    const activity = normalizePlanActivity({ id: "a", title: "x", href: "https://evil.example", mode: "adaptive" });
    expect(activity?.href).toBeUndefined();
    expect(activity?.mode).toBe("fixed");
    expect(normalizePlanActivity({ id: "b", title: "x", href: "/dashboard/study?mode=daily" })?.href).toBe("/dashboard/study?mode=daily");
  });

  it("bounds a day: clean, one of each id, at most twelve, in the order it runs", () => {
    const many = Array.from({ length: 20 }, (_, index) => planActivity({ id: `a${index % 15}`, startTime: `1${index % 10}:00` }));
    const day = normalizePlanActivities(many);
    expect(day).toHaveLength(12);
    expect(new Set(day.map((activity) => activity.id)).size).toBe(12);
    expect(day[0]?.startTime).toBe("10:00");
  });

  it("reads a day's record of what was done", () => {
    expect(normalizePlanActivityDone({ a: { by: "activity", at: 5 }, b: { by: "who knows" }, c: "x" })).toEqual({
      a: { by: "activity", at: 5 },
      b: { by: "manual", at: 0 },
    });
  });

  it("keeps how long a timed session ran, within what a sitting could be", () => {
    expect(
      normalizePlanActivityDone({
        timed: { by: "activity", at: 5, minutes: 28.4 },
        overnight: { by: "activity", at: 5, minutes: 900 },
        nonsense: { by: "manual", at: 5, minutes: -3 },
      })
    ).toEqual({
      timed: { by: "activity", at: 5, minutes: 28 },
      overnight: { by: "activity", at: 5, minutes: MAX_PLAN_SESSION_MINUTES },
      nonsense: { by: "manual", at: 5 },
    });
  });

  it("keeps the notebook notebook work is done in, and only there", () => {
    expect(normalizePlanActivity({ id: "n", title: "Enzymes", method: "notebook", notebookId: " nb-1 " })?.notebookId).toBe("nb-1");
    // Nothing else names a notebook, and nothing that is not an id gets through as one.
    expect(normalizePlanActivity({ id: "p", title: "Enzymes", method: "practice", notebookId: "nb-1" })?.notebookId).toBeUndefined();
    expect(normalizePlanActivity({ id: "x", title: "Enzymes", method: "notebook", notebookId: "../../users" })?.notebookId).toBeUndefined();
    expect(normalizePlanActivity({ id: "f", open: true, method: "notebook", notebookId: "nb-1" })?.notebookId).toBeUndefined();
  });
});

describe("an activity the student did not name", () => {
  it("is called after its notebook, its topic, or how it is done", () => {
    expect(defaultPlanActivityTitle({ method: "notebook", notebookTitle: "  Cell biology  " })).toBe("Cell biology");
    expect(defaultPlanActivityTitle({ method: "practice", topic: { label: "Homeostasis" } })).toBe("Homeostasis");
    expect(defaultPlanActivityTitle({ method: "notebook" })).toBe("Notebook work");
    expect(defaultPlanActivityTitle({ method: "other" })).toBe("Study session");
    // A name it is given is still a valid title: it passes the same gate as a typed one.
    expect(normalizePlanActivity({ id: "a", title: defaultPlanActivityTitle({ method: "flashcards" }), method: "flashcards" })?.title).toBe("Flashcards");
  });
});

describe("timing", () => {
  it("knows when an activity ends and whether two clash", () => {
    expect(planActivityEndTime({ startTime: "17:00", minutes: 45 })).toBe("17:45");
    expect(planActivityEndTime({ minutes: 45 })).toBeUndefined();
    expect(planActivitiesClash({ startTime: "17:00", minutes: 30 }, { startTime: "17:15", minutes: 30 })).toBe(true);
    expect(planActivitiesClash({ startTime: "17:00", minutes: 30 }, { startTime: "17:30", minutes: 30 })).toBe(false);
    expect(planActivitiesClash({ minutes: 30 }, { startTime: "17:00", minutes: 30 })).toBe(false);
  });
});

describe("one of the engine's actions, as a task", () => {
  it("is named by its topic, done the way its destination does it, and knows where it came from", () => {
    const task = planActivityTaskFromAction(studyAction("cell division"));
    expect(task).toEqual({
      title: "Cell division",
      method: "practice",
      topic: { kind: "topic", id: "cell division", label: "cell division" },
      href: "/dashboard/practice/questions/new?folderId=biology&topics=cell division",
      actionId: "folder:biology|low_mastery|topic:cell division",
      targetItems: 6,
    });
  });

  it("reads every destination as a method", () => {
    expect(methodForDestination("flashcards")).toBe("flashcards");
    expect(methodForDestination("practice-papers")).toBe("practice");
    expect(methodForDestination("revision-session")).toBe("revision");
    expect(methodForDestination("notebook")).toBe("notebook");
    expect(methodForDestination("topic")).toBe("notes");
    expect(methodForDestination(undefined)).toBe("other");
  });

  it("does not count items in a session that is not measured in them", () => {
    const lesson = studyAction("osmosis", {
      destination: { kind: "revision-session", href: "/dashboard/revision/new?action=x", selection: {} },
    });
    expect(planActivityTaskFromAction(lesson).targetItems).toBeUndefined();
  });
});
