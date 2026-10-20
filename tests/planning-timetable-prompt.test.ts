import { describe, expect, it } from "vitest";
import { describePlanTimetable, planCalendarLines, readPlanTimetableDays } from "@/lib/planning/plan-timetable-prompt";
import { plannerRange, plannerStep, plannerTitle } from "@/lib/planning/planner-view";
import { MONDAY, TUESDAY, WEDNESDAY, planActivity } from "./support/plan-fixtures";

/** What the model is shown of the timetable, and how the planner moves through it. */

const SUBJECTS = [{ ref: "S1", label: "Biology", folderId: "biology" }];

describe("the timetable, written for the model", () => {
  it("hands out refs in date and time order and resolves each back to its activity", () => {
    const { text, refs } = describePlanTimetable(
      [
        {
          dayKey: MONDAY,
          activities: [
            planActivity({ id: "late", title: "Past paper", startTime: "19:00" }),
            planActivity({ id: "early", title: 'Homeostasis "notes"', startTime: "17:00", mode: "adaptive", origin: "jami" }),
          ],
          doneIds: ["late"],
        },
        { dayKey: TUESDAY, activities: [], doneIds: [] },
        {
          dayKey: WEDNESDAY,
          activities: [{ ...planActivity({ id: "free", scopeKey: "folder:chemistry" }), title: "", open: true }],
          doneIds: [],
        },
      ],
      SUBJECTS
    );
    expect([...refs]).toEqual([
      ["A1", { dayKey: MONDAY, activityId: "late", done: true }],
      ["A2", { dayKey: MONDAY, activityId: "early", done: false }],
      ["A3", { dayKey: WEDNESDAY, activityId: "free", done: false }],
    ]);
    // Titles are the student's, so they go in quoted.
    expect(text).toContain('"Homeostasis \\"notes\\""');
    expect(text).toContain("Jami's pick (adaptive)");
    expect(text).toContain("· done");
    expect(text).toContain("Tue 20 Oct (2026-10-20): nothing planned");
    expect(text).toContain("another subject · free session, nothing chosen yet");
  });

  it("reads only well-formed days, each once, and only its own done ids", () => {
    const days = readPlanTimetableDays([
      { dayKey: TUESDAY, activities: [planActivity({ id: "a" })], doneIds: ["a", "not-here"] },
      { dayKey: TUESDAY, activities: [] },
      { dayKey: "next tuesday", activities: [] },
      "junk",
      { dayKey: MONDAY, activities: [{ id: "x", title: "" }] },
    ]);
    expect(days.map((day) => [day.dayKey, day.activities.length, day.doneIds])).toEqual([
      [MONDAY, 0, []],
      [TUESDAY, 1, ["a"]],
    ]);
  });

  it("gives at least four weeks of dates", () => {
    expect(planCalendarLines(TUESDAY)).toHaveLength(4);
    expect(planCalendarLines(TUESDAY)[0]).toBe(
      "This week: Mon 2026-10-19, Tue 2026-10-20, Wed 2026-10-21, Thu 2026-10-22, Fri 2026-10-23, Sat 2026-10-24, Sun 2026-10-25"
    );
  });
});

describe("moving through the planner", () => {
  it("shows a week Monday to Sunday, a day within its week, and a month in whole weeks", () => {
    expect(plannerRange("week", WEDNESDAY)).toMatchObject({ fromDayKey: MONDAY, toDayKey: "2026-10-25" });
    expect(plannerRange("day", WEDNESDAY)).toMatchObject({ fromDayKey: MONDAY, toDayKey: "2026-10-25" });
    // October 2026 starts on a Thursday and ends on a Saturday.
    expect(plannerRange("month", WEDNESDAY)).toMatchObject({ fromDayKey: "2026-09-28", toDayKey: "2026-11-01" });
  });

  it("steps a day, a week or a month at a time", () => {
    expect(plannerStep("day", WEDNESDAY, 1)).toBe("2026-10-22");
    expect(plannerStep("week", WEDNESDAY, -1)).toBe("2026-10-14");
    expect(plannerStep("month", WEDNESDAY, 1)).toBe("2026-11-01");
    expect(plannerStep("month", WEDNESDAY, -1)).toBe("2026-09-01");
  });

  it("titles what is in view", () => {
    expect(plannerTitle("week", WEDNESDAY)).toBe("19–25 October");
    expect(plannerTitle("day", WEDNESDAY)).toBe("Wednesday 21 October");
    expect(plannerTitle("month", WEDNESDAY)).toBe("October 2026");
  });
});
