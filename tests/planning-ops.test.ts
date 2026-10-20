import { describe, expect, it } from "vitest";
import { applyTimetableOps, timetableOpDays, type TimetableOpContext } from "@/lib/planning/timetable-ops";
import { openActivityFromFreeSession, planFreeSessionsOn } from "@/lib/planning/timetable";
import type { PlanActivity } from "@/lib/planning/types";
import { FRIDAY, MONDAY, WEDNESDAY, planActivity, revisionPlan } from "./support/plan-fixtures";

/**
 * Every change to the timetable is one of these ops, whoever asked for it --
 * so a tap and a chat instruction make exactly the same edit.
 */

const plan = revisionPlan();
const context: TimetableOpContext = {
  freeSessionsFor: (dayKey) => planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession),
};

function apply(days: Record<string, PlanActivity[]>, ops: Parameters<typeof applyTimetableOps>[1]) {
  return applyTimetableOps(new Map(Object.entries(days)), ops, context);
}

const jamiPick = planActivity({
  id: "pick",
  title: "Homeostasis",
  method: "practice",
  startTime: "17:00",
  mode: "adaptive",
  origin: "jami",
  actionId: "folder:biology|low_mastery|topic:homeostasis",
  href: "/dashboard/practice/questions/new?folderId=biology",
  targetItems: 6,
});

describe("adding", () => {
  it("keeps a day's free sessions when something is first added to it", () => {
    const { touched } = apply({}, [
      { type: "add", dayKey: MONDAY, activity: planActivity({ id: "new", title: "Finish my homework", method: "other", startTime: "16:00" }) },
    ]);
    // The 17:00 free session the student could see does not vanish because they added something at 16:00.
    expect(touched.get(MONDAY)?.map((activity) => [activity.id, activity.open ?? false])).toEqual([
      ["new", false],
      ["routine-mon", true],
    ]);
  });

  it("refuses an activity that cannot be one", () => {
    const { touched } = apply({}, [{ type: "add", dayKey: MONDAY, activity: { ...planActivity({ id: "x" }), title: "  " } }]);
    expect(touched.size).toBe(0);
  });
});

describe("editing", () => {
  it("makes an activity the student's own fixed task when they change what it is", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "update", dayKey: MONDAY, activityId: "pick", patch: { title: "Homeostasis exam questions", method: "practice" } },
    ]);
    const edited = touched.get(MONDAY)?.[0];
    expect(edited).toMatchObject({ title: "Homeostasis exam questions", mode: "fixed", origin: "student" });
    // Jami's link and action belonged to Jami's task, not this one.
    expect(edited?.actionId).toBeUndefined();
    expect(edited?.href).toBeUndefined();
  });

  it("keeps an adaptive task adaptive when only its time or length changes", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "update", dayKey: MONDAY, activityId: "pick", patch: { startTime: "18:15", minutes: 40 } },
    ]);
    expect(touched.get(MONDAY)?.[0]).toMatchObject({ startTime: "18:15", minutes: 40, mode: "adaptive", actionId: jamiPick.actionId });
  });

  it("takes Jami's suggestion as Jami's, still adaptive", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      {
        type: "update",
        dayKey: MONDAY,
        activityId: "pick",
        patch: { task: { title: "Enzymes", method: "flashcards", actionId: "folder:biology|x|topic:enzymes", origin: "jami" } },
      },
    ]);
    expect(touched.get(MONDAY)?.[0]).toMatchObject({ title: "Enzymes", method: "flashcards", mode: "adaptive", origin: "jami" });
    expect(touched.get(MONDAY)?.[0]?.targetItems).toBeUndefined();
  });

  it("fixes and frees a task", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "update", dayKey: MONDAY, activityId: "pick", patch: { mode: "fixed" } },
    ]);
    expect(touched.get(MONDAY)?.[0]).toMatchObject({ mode: "fixed", actionId: jamiPick.actionId });
  });

  it("changes nothing when the activity is not there", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [{ type: "remove", dayKey: MONDAY, activityId: "nope" }]);
    expect(touched.size).toBe(0);
  });
});

describe("moving and copying", () => {
  it("moves an activity to another day as it is, keeping that day's free sessions", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "move", fromDayKey: MONDAY, toDayKey: WEDNESDAY, activityId: "pick", fallbackId: "pick-2" },
    ]);
    expect(touched.get(MONDAY)).toEqual([]);
    expect(touched.get(WEDNESDAY)?.map((activity) => activity.id)).toEqual(["pick", "routine-wed"]);
    expect(touched.get(WEDNESDAY)?.[0]).toMatchObject({ title: "Homeostasis", mode: "adaptive", minutes: 30 });
  });

  it("gives a moved activity a new id only when the day already has its own", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick], [FRIDAY]: [{ ...jamiPick, startTime: "09:00" }] }, [
      { type: "move", fromDayKey: MONDAY, toDayKey: FRIDAY, activityId: "pick", startTime: "19:00", fallbackId: "pick-2" },
    ]);
    expect(touched.get(FRIDAY)?.map((activity) => [activity.id, activity.startTime])).toEqual([
      ["pick", "09:00"],
      ["pick-2", "19:00"],
    ]);
  });

  it("re-times an activity on its own day", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "move", fromDayKey: MONDAY, toDayKey: MONDAY, activityId: "pick", startTime: "20:00", fallbackId: "x" },
    ]);
    expect(touched.get(MONDAY)?.[0]?.startTime).toBe("20:00");
  });

  it("copies an activity to another day under a new id", () => {
    const { touched } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "duplicate", fromDayKey: MONDAY, toDayKey: MONDAY, activityId: "pick", newId: "copy", startTime: "19:00" },
    ]);
    expect(touched.get(MONDAY)?.map((activity) => activity.id)).toEqual(["pick", "copy"]);
  });
});

describe("whole days", () => {
  it("clears a day into a rest day the usual week does not refill", () => {
    const { touched } = apply({}, [{ type: "clearDay", dayKey: MONDAY }]);
    expect(touched.get(MONDAY)).toEqual([]);
  });

  it("hands a day back to the usual week, or sets it whole", () => {
    const { touched, days } = apply({ [MONDAY]: [jamiPick] }, [
      { type: "setDay", dayKey: MONDAY, activities: null },
      { type: "setDay", dayKey: WEDNESDAY, activities: [jamiPick, { ...jamiPick, title: "" }] },
    ]);
    expect(touched.get(MONDAY)).toBeNull();
    expect(days.get(MONDAY)).toBeNull();
    // Normalised on the way in: an activity with no title and no free time is not one.
    expect(touched.get(WEDNESDAY)?.map((activity) => activity.id)).toEqual(["pick"]);
  });

  it("drops a fill worked out from a day that has changed since", () => {
    // Another device planned Monday a moment ago: this device's fill of the free session must not overwrite it.
    const fill = { type: "setDay" as const, dayKey: MONDAY, activities: [jamiPick], ifIds: ["routine-mon"] };
    expect(apply({ [MONDAY]: [planActivity({ id: "theirs" })] }, [fill]).touched.size).toBe(0);
    expect(apply({}, [fill]).touched.get(MONDAY)?.map((activity) => activity.id)).toEqual(["pick"]);
  });

  it("says which days an op reads and writes", () => {
    expect(timetableOpDays({ type: "move", fromDayKey: MONDAY, toDayKey: FRIDAY, activityId: "a", fallbackId: "b" })).toEqual([
      MONDAY,
      FRIDAY,
    ]);
    expect(timetableOpDays({ type: "clearDay", dayKey: MONDAY })).toEqual([MONDAY]);
  });
});
