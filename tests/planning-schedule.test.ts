import { describe, expect, it } from "vitest";
import { migrateStoredRevisionPlan } from "@/lib/planning/migrate-plan";
import { normalizeRevisionPlanDraft, unusedPlanExamId } from "@/lib/planning/normalize-plan";
import { planCountdown, planWeekOfPlan } from "@/lib/planning/plan-countdown";
import { formatPlanMinutes, longPlanDate, planRangeLabel, shortPlanDate } from "@/lib/planning/plan-format";
import {
  planDayKeysBetween,
  planDaysBetween,
  planMonthStartDayKey,
  planNextMonthStartDayKey,
  planScopeSequence,
  planSessionEndTime,
  planSessionsOn,
  planWeekStartDayKey,
  planWeekdayOf,
  studyDayMinutes,
} from "@/lib/planning/plan-schedule";
import { planScopeKey } from "@/lib/planning/types";
import { MONDAY, SUNDAY, THURSDAY, TUESDAY, WEDNESDAY, revisionPlan } from "./support/plan-fixtures";

describe("calendar arithmetic", () => {
  it("reads a day key as a calendar date, not a moment", () => {
    // Going through a timestamp would make a plan's Monday depend on where the
    // reader is, which is nothing to do with the plan.
    expect(planWeekdayOf(MONDAY)).toBe(1);
    expect(planWeekdayOf(SUNDAY)).toBe(0);
    expect(planDaysBetween(MONDAY, SUNDAY)).toBe(6);
    expect(planDaysBetween(SUNDAY, MONDAY)).toBe(-6);
  });

  it("counts across the October clock change without gaining or losing a day", () => {
    // Clocks go back in London on Sunday 25 October 2026.
    expect(planDayKeysBetween("2026-10-24", "2026-10-27")).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(planDaysBetween("2026-10-24", "2026-11-01")).toBe(8);
  });

  it("starts a week on Monday and a month on the first", () => {
    expect(planWeekStartDayKey(WEDNESDAY)).toBe(MONDAY);
    expect(planWeekStartDayKey(SUNDAY)).toBe(MONDAY);
    expect(planMonthStartDayKey(WEDNESDAY)).toBe("2026-10-01");
    expect(planNextMonthStartDayKey("2026-12-14")).toBe("2027-01-01");
  });
});

describe("the clock within a study day", () => {
  it("puts the small hours at the end of the evening, since the study day turns at 4am", () => {
    expect(studyDayMinutes("04:00")).toBe(0);
    expect(studyDayMinutes("23:00")).toBeLessThan(studyDayMinutes("00:30"));
    expect(studyDayMinutes("03:59")).toBe(1439);
  });

  it("works out when a sitting finishes, through midnight but not past the end of the study day", () => {
    expect(planSessionEndTime("16:30", 45)).toBe("17:15");
    expect(planSessionEndTime("23:30", 60)).toBe("00:30");
    expect(planSessionEndTime("03:30", 60)).toBe("03:59");
  });

  it("orders a day of the usual week by its clock, untimed sittings last", () => {
    const sessions = [
      { id: "whenever", weekday: 1 as const, minutes: 30 },
      { id: "late", weekday: 1 as const, minutes: 30, startTime: "00:15" },
      { id: "four-thirty", weekday: 1 as const, minutes: 30, startTime: "16:30" },
    ];
    expect(planSessionsOn(sessions, MONDAY).map((session) => session.id)).toEqual(["four-thirty", "late", "whenever"]);
  });

  it("spreads a heavier subject through the week rather than blocking it", () => {
    const scopes = [
      { folderId: "chemistry", weight: 2 },
      { folderId: "biology", weight: 1 },
    ];
    expect(planScopeSequence(scopes, 3, planScopeKey)).toEqual(["folder:chemistry", "folder:biology", "folder:chemistry"]);
  });
});

describe("writing dates and lengths", () => {
  it("reads every date the same on every device", () => {
    expect(shortPlanDate(MONDAY)).toBe("Mon 19 Oct");
    expect(longPlanDate(MONDAY)).toBe("Monday 19 October");
    expect(planRangeLabel(MONDAY, SUNDAY)).toBe("19–25 October");
    expect(planRangeLabel("2026-10-26", "2026-11-01")).toBe("26 October – 1 November");
    expect(formatPlanMinutes(45)).toBe("45m");
    expect(formatPlanMinutes(150)).toBe("2h 30m");
  });
});

describe("a plan written before sessions existed", () => {
  it("reads its cadence as the usual week", () => {
    const stored = {
      title: "Summer exams",
      status: "active",
      origin: "manual",
      startDayKey: MONDAY,
      endDayKey: SUNDAY,
      scopes: [{ folderId: "biology", weight: 1 }],
      cadence: [{ weekday: 1, minutes: 45 }],
      emphasis: [],
    };
    const migrated = normalizeRevisionPlanDraft(migrateStoredRevisionPlan(stored) as never).draft;
    expect(migrated.sessions).toEqual([{ id: "w1", weekday: 1, minutes: 45 }]);
  });

  it("leaves a plan that already has sessions alone", () => {
    const stored = { sessions: [{ id: "s0", weekday: 3, minutes: 30 }], cadence: [{ weekday: 1, minutes: 45 }] };
    expect(migrateStoredRevisionPlan(stored).sessions).toEqual(stored.sessions);
  });
});

describe("what a plan needs to start", () => {
  it("is either a usual week or something on the timetable", () => {
    const empty = { ...revisionPlan(), scopes: [], sessions: [] };
    expect(normalizeRevisionPlanDraft(empty).valid).toBe(false);
    // Three activities placed by hand are a plan, with no weekly pattern and no subjects.
    expect(normalizeRevisionPlanDraft(empty, Date.now(), { activityCount: 3 }).valid).toBe(true);
    // A usual week takes turns between subjects, so it needs some.
    expect(normalizeRevisionPlanDraft({ ...revisionPlan(), scopes: [] }, Date.now(), { activityCount: 3 }).valid).toBe(false);
  });

  it("keeps whether Jami fills free sessions", () => {
    expect(normalizeRevisionPlanDraft({ ...revisionPlan(), autoFill: true }).draft.autoFill).toBe(true);
    expect("autoFill" in normalizeRevisionPlanDraft({ ...revisionPlan(), autoFill: undefined }).draft).toBe(false);
  });
});

describe("counting down", () => {
  it("counts down to each exam, soonest first", () => {
    const countdown = planCountdown(
      revisionPlan({
        exams: [
          { id: "maths", label: "Maths Paper 1", dayKey: "2026-11-16" },
          { id: "chem", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chemistry" },
        ],
      }),
      THURSDAY
    );
    expect(countdown.map((item) => [item.label, item.daysLeft, item.scopeKey])).toEqual([
      ["Chemistry Paper 1", 21, "folder:chemistry"],
      ["Maths Paper 1", 25, undefined],
    ]);
  });

  it("counts down to the plan's end when it has no exams, and drops dates already past", () => {
    expect(planCountdown(revisionPlan(), THURSDAY).map((item) => [item.label, item.daysLeft])).toEqual([["Summer exams", 39]]);
    expect(planCountdown(revisionPlan({ exams: [{ id: "old", label: "Old", dayKey: "2026-09-01" }] }), THURSDAY)[0]?.label).toBe(
      "Summer exams"
    );
  });

  it("says which week of the plan it is", () => {
    expect(planWeekOfPlan(revisionPlan(), TUESDAY)).toEqual({ current: 1, total: 7 });
  });
});

describe("keeping exams on a plan", () => {
  it("keeps real exams in date order and drops what cannot be one", () => {
    const { draft } = normalizeRevisionPlanDraft({
      ...revisionPlan(),
      exams: [
        { id: "b", label: "History Paper 1", dayKey: "2026-11-20", scopeKey: "folder:history" },
        { id: "a", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chemistry" },
        { id: "c", label: "", dayKey: "2026-11-13" },
        { id: "d", label: "No date", dayKey: "13 November" },
      ],
    });
    expect(draft.exams).toEqual([
      { id: "a", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chemistry" },
      // A subject the plan does not cover is dropped from the exam, not the exam.
      { id: "b", label: "History Paper 1", dayKey: "2026-11-20" },
    ]);
  });

  it("never gives two exams the same id", () => {
    expect(unusedPlanExamId([{ id: "exam-2" }, { id: "exam-3" }])).toBe("exam-4");
    const { draft } = normalizeRevisionPlanDraft({
      ...revisionPlan(),
      exams: [
        { id: "exam-1", label: "Paper 1", dayKey: "2026-11-02" },
        { id: "exam-1", label: "Paper 2", dayKey: "2026-11-05" },
      ],
    });
    expect(new Set(draft.exams?.map((exam) => exam.id)).size).toBe(2);
  });
});
