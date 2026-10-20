import { describe, expect, it } from "vitest";
import {
  describeGoalDeadline,
  endOfStudyDay,
  examDeadline,
  goalDayLabel,
  goalDeadlineDayKey,
  studyDaysLeft,
  thisWeekDeadline,
} from "@/lib/goals/deadlines";
import { getStudyDayKey, getStudyDayStartFromKey, shiftStudyDayKey, studyDaysBetween } from "@/lib/study/day";

// A Tuesday, mid-morning in London.
const TUESDAY = "2026-10-20";
const NOW = getStudyDayStartFromKey(TUESDAY) + 6 * 60 * 60 * 1000;

describe("goal deadlines", () => {
  it("end at the last moment of a study day, not at midnight", () => {
    const end = endOfStudyDay(TUESDAY);
    expect(getStudyDayKey(end)).toBe(TUESDAY);
    expect(getStudyDayKey(end + 1)).toBe(shiftStudyDayKey(TUESDAY, 1));
    expect(goalDeadlineDayKey(end)).toBe(TUESDAY);
  });

  it("take this week to mean the coming Sunday", () => {
    expect(goalDeadlineDayKey(thisWeekDeadline(NOW))).toBe("2026-10-25");
    const sunday = getStudyDayStartFromKey("2026-10-25") + 60 * 60 * 1000;
    expect(goalDeadlineDayKey(thisWeekDeadline(sunday))).toBe("2026-10-25");
  });

  it("fall the evening before an exam", () => {
    expect(goalDeadlineDayKey(examDeadline("2026-11-12"))).toBe("2026-11-11");
  });

  it("count study days left including today", () => {
    expect(studyDaysLeft(endOfStudyDay(TUESDAY), NOW)).toBe(1);
    expect(studyDaysLeft(endOfStudyDay("2026-10-25"), NOW)).toBe(6);
    expect(studyDaysLeft(NOW - 1, NOW)).toBe(0);
    expect(studyDaysLeft(0, NOW)).toBe(0);
  });

  it("say how pressing they are", () => {
    expect(describeGoalDeadline(0, NOW)).toEqual({ label: "No deadline", tone: "none" });
    expect(describeGoalDeadline(NOW - 1, NOW)).toEqual({ label: "Time's up", tone: "passed" });
    expect(describeGoalDeadline(endOfStudyDay(TUESDAY), NOW)).toEqual({ label: "Due today", tone: "today" });
    expect(describeGoalDeadline(endOfStudyDay("2026-10-21"), NOW)).toEqual({ label: "Due tomorrow", tone: "soon" });
    expect(describeGoalDeadline(endOfStudyDay("2026-10-23"), NOW).tone).toBe("soon");
    expect(describeGoalDeadline(endOfStudyDay("2026-11-02"), NOW)).toEqual({ label: "Due Mon 2 Nov", tone: "calm" });
  });

  it("print a study day the way the rest of the app does", () => {
    expect(goalDayLabel("2026-11-12")).toBe("Thu 12 Nov");
  });

  it("count days the same way plans do, across a clock change", () => {
    // The clocks go back in the UK on 25 October 2026.
    expect(studyDaysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });
});
