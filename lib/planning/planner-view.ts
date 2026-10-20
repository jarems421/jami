import { longPlanDate, planMonthLabel, planRangeLabel } from "@/lib/planning/plan-format";
import {
  planMonthStartDayKey,
  planNextMonthStartDayKey,
  planWeekStartDayKey,
} from "@/lib/planning/plan-schedule";
import { shiftStudyDayKey } from "@/lib/study/day";

/**
 * Which days the planner shows, and how it moves between them.
 *
 * Three views of one timetable: the week, which is where a plan is mostly
 * read and changed; a day, for working through one in detail; and a month, for
 * seeing the exams coming. The day on screen is the "anchor" -- every view is
 * worked out from it, so switching view never loses the student's place.
 */

export type PlannerView = "week" | "day" | "month";

export const PLANNER_VIEWS: readonly { value: PlannerView; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "day", label: "Day" },
  { value: "month", label: "Month" },
];

export type PlannerRange = {
  /** The days read and resolved for this view. */
  fromDayKey: string;
  toDayKey: string;
  /** The days Jami is shown: the week in view, or the first fortnight of a month's place. */
  focusFromDayKey: string;
  focusToDayKey: string;
};

export function plannerRange(view: PlannerView, anchor: string): PlannerRange {
  if (view === "month") {
    const gridStart = planWeekStartDayKey(planMonthStartDayKey(anchor));
    const lastDay = shiftStudyDayKey(planNextMonthStartDayKey(anchor), -1);
    const focus = planWeekStartDayKey(anchor);
    return {
      fromDayKey: gridStart,
      toDayKey: shiftStudyDayKey(planWeekStartDayKey(lastDay), 6),
      focusFromDayKey: focus,
      focusToDayKey: shiftStudyDayKey(focus, 13),
    };
  }
  const weekStart = planWeekStartDayKey(anchor);
  const weekEnd = shiftStudyDayKey(weekStart, 6);
  return { fromDayKey: weekStart, toDayKey: weekEnd, focusFromDayKey: weekStart, focusToDayKey: weekEnd };
}

/** The anchor one step on or back: a day, a week, or the first of a month. */
export function plannerStep(view: PlannerView, anchor: string, direction: 1 | -1) {
  if (view === "day") return shiftStudyDayKey(anchor, direction);
  if (view === "week") return shiftStudyDayKey(anchor, 7 * direction);
  return direction > 0
    ? planNextMonthStartDayKey(anchor)
    : planMonthStartDayKey(shiftStudyDayKey(planMonthStartDayKey(anchor), -1));
}

/** What the planner's heading says for the days in view. */
export function plannerTitle(view: PlannerView, anchor: string) {
  if (view === "day") return longPlanDate(anchor);
  if (view === "month") return planMonthLabel(anchor);
  const range = plannerRange("week", anchor);
  return planRangeLabel(range.fromDayKey, range.toDayKey);
}
