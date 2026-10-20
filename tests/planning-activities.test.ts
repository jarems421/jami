import { describe, expect, it } from "vitest";
import {
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
