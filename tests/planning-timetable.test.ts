import { describe, expect, it } from "vitest";
import {
  freeSessionActivityId,
  planFreeSessionsOn,
  resolveTimetableDay,
  resolveTimetableDays,
  storedPlanDay,
  timetableUpNext,
} from "@/lib/planning/timetable";
import { planDayKeysBetween } from "@/lib/planning/plan-schedule";
import { planAutoFills } from "@/lib/planning/types";
import {
  FRIDAY,
  MONDAY,
  SUNDAY,
  TUESDAY,
  WEDNESDAY,
  planActivity,
  revisionPlan,
} from "./support/plan-fixtures";

/**
 * Reading a day of the plan. The rule the redesign turns on: a day with a
 * timetable of its own shows exactly that, and a day without one shows the
 * usual week as free sessions -- time set aside, never a promise that a task
 * will appear on its own.
 */

describe("a week nobody has planned yet", () => {
  it("shows the usual week's sittings as free sessions, taking turns between subjects by weight", () => {
    const plan = revisionPlan();
    const subjects = [MONDAY, WEDNESDAY, FRIDAY].map((dayKey) => planFreeSessionsOn(plan, dayKey)[0]?.scopeKey);
    // Biology is weighted 2 and Chemistry 1: Biology, Chemistry, Biology -- spread, not blocked.
    expect(subjects).toEqual(["folder:biology", "folder:chemistry", "folder:biology"]);

    const day = resolveTimetableDay({ plan, dayKey: MONDAY, todayDayKey: TUESDAY });
    expect(day.kind).toBe("flexible");
    expect(day.activities).toEqual([
      expect.objectContaining({
        id: freeSessionActivityId("mon"),
        open: true,
        computed: true,
        startTime: "17:00",
        minutes: 45,
        scopeKey: "folder:biology",
      }),
    ]);
    // A free session is time, not a task: nothing to tick, nothing to count as done.
    expect(day.taskCount).toBe(0);
    expect(day.openCount).toBe(1);
  });

  it("keeps a sitting pinned to a subject on that subject, outside the rotation", () => {
    const plan = revisionPlan({
      sessions: [
        { id: "mon", weekday: 1, minutes: 45, scopeKey: "folder:chemistry" },
        { id: "wed", weekday: 3, minutes: 30 },
      ],
    });
    expect(planFreeSessionsOn(plan, MONDAY)[0]?.scopeKey).toBe("folder:chemistry");
    // Monday being Chemistry does not mean Chemistry now gets less of Wednesday.
    expect(planFreeSessionsOn(plan, WEDNESDAY)[0]?.scopeKey).toBe("folder:biology");
  });

  it("stops timetabling a subject once its last exam has gone", () => {
    const plan = revisionPlan({
      exams: [{ id: "bio", label: "Biology Paper 1", dayKey: TUESDAY, scopeKey: "folder:biology" }],
    });
    expect(planFreeSessionsOn(plan, MONDAY)[0]?.scopeKey).toBe("folder:biology");
    expect(planFreeSessionsOn(plan, WEDNESDAY)[0]?.scopeKey).toBe("folder:chemistry");
    expect(planFreeSessionsOn(plan, FRIDAY)[0]?.scopeKey).toBe("folder:chemistry");
  });

  it("asks nothing outside the plan's dates, or of a plan that has finished", () => {
    expect(planFreeSessionsOn(revisionPlan({ startDayKey: WEDNESDAY }), MONDAY)).toEqual([]);
    expect(planFreeSessionsOn(revisionPlan({ status: "archived" }), MONDAY)).toEqual([]);
    expect(resolveTimetableDay({ plan: revisionPlan(), dayKey: TUESDAY, todayDayKey: TUESDAY }).kind).toBe("rest");
  });
});

describe("a day with a timetable of its own", () => {
  const plan = revisionPlan();

  it("shows exactly what was put there, in the order the day runs", () => {
    const day = resolveTimetableDay({
      plan,
      dayKey: MONDAY,
      todayDayKey: TUESDAY,
      entry: {
        dayKey: MONDAY,
        activities: [
          planActivity({ id: "late", title: "Past paper", startTime: "00:30" }),
          planActivity({ id: "whenever", title: "Read notes", method: "notes" }),
          planActivity({ id: "first", title: "Homeostasis", startTime: "17:00" }),
        ],
      },
    });
    expect(day.kind).toBe("planned");
    // Half past midnight belongs to the end of Monday's evening, not the top of it.
    expect(day.activities.map((activity) => activity.id)).toEqual(["first", "late", "whenever"]);
    expect(day.activities.every((activity) => !activity.computed)).toBe(true);
    expect(day.taskCount).toBe(3);
  });

  it("is a rest day when it was cleared, whatever the usual week says", () => {
    const day = resolveTimetableDay({ plan, dayKey: MONDAY, todayDayKey: TUESDAY, entry: { dayKey: MONDAY, activities: [] } });
    expect(day.kind).toBe("rest");
    expect(day.activities).toEqual([]);
  });

  it("marks what the student ticked", () => {
    const day = resolveTimetableDay({
      plan,
      dayKey: MONDAY,
      todayDayKey: TUESDAY,
      entry: {
        dayKey: MONDAY,
        activities: [planActivity({ id: "a", startTime: "17:00" }), planActivity({ id: "b", startTime: "17:30" })],
        done: { a: { by: "manual", at: 5 } },
      },
    });
    expect(day.activities.map((activity) => activity.completion?.by)).toEqual(["manual", undefined]);
    expect(day.doneCount).toBe(1);
    expect(timetableUpNext(day)?.id).toBe("b");
  });

  it("says which exams fall on it", () => {
    const withExam = revisionPlan({ exams: [{ id: "e", label: "Chemistry Paper 1", dayKey: FRIDAY }] });
    expect(resolveTimetableDay({ plan: withExam, dayKey: FRIDAY, todayDayKey: TUESDAY }).exams.map((exam) => exam.label)).toEqual([
      "Chemistry Paper 1",
    ]);
  });
});

describe("a plan made before dated activities", () => {
  const legacy = revisionPlan({ schemaVersion: 2, autoFill: undefined });

  it("still has Jami fill its days, as it always did", () => {
    expect(planAutoFills(legacy)).toBe(true);
    expect(planAutoFills(revisionPlan({ autoFill: undefined }))).toBe(false);
  });

  it("reads a day with pinned tasks into activities, keeping the student's ticks", () => {
    const stored = storedPlanDay(legacy, {
      dayKey: MONDAY,
      pinned: [
        { actionId: "own:abc", label: "Redo question 3", sessionId: "mon" },
        { actionId: "folder:biology|x", label: "Review enzymes", href: "/dashboard/study?mode=custom", sessionId: "mon" },
      ],
      completedSlotIds: ["pin:own:abc", "plan-1:2026-10-19:0"],
      updatedAt: 7,
    });
    expect(stored?.activities.map((activity) => [activity.title, activity.method, activity.mode, activity.origin])).toEqual([
      // What is left of the sitting stays free time; the tasks take the rest.
      ["", "other", "adaptive", "student"],
      ["Redo question 3", "other", "fixed", "student"],
      ["Review enzymes", "flashcards", "fixed", "jami"],
    ]);
    expect(stored?.activities[0]?.minutes).toBe(15);
    expect(Object.keys(stored?.done ?? {})).toEqual(["legacy-0"]);
  });

  it("reads a day off as a rest day, and an untouched day as the usual week", () => {
    expect(storedPlanDay(legacy, { dayKey: MONDAY, skipped: true })).toEqual({ activities: [], done: {} });
    expect(storedPlanDay(legacy, { dayKey: MONDAY, completedSlotIds: ["plan-1:2026-10-19:0"] })).toBeNull();
  });
});

describe("a range of days", () => {
  it("resolves every day the same way, today and the past marked", () => {
    const days = resolveTimetableDays({
      plan: revisionPlan(),
      dayKeys: planDayKeysBetween(MONDAY, SUNDAY),
      entries: [{ dayKey: WEDNESDAY, activities: [planActivity({ id: "x" })] }],
      todayDayKey: TUESDAY,
    });
    expect(days.map((day) => day.kind)).toEqual(["flexible", "rest", "planned", "rest", "flexible", "rest", "rest"]);
    expect(days.filter((day) => day.isPast).map((day) => day.dayKey)).toEqual([MONDAY]);
    expect(days.find((day) => day.isToday)?.dayKey).toBe(TUESDAY);
  });
});
