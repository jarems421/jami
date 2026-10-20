import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TodayGoals from "@/components/today/TodayGoals";
import type { TodayGoalSummary } from "@/lib/dashboard/today-plan";

const summary: TodayGoalSummary = {
  goalId: "g1",
  title: "Review 50 cards",
  measure: "cards",
  headline: "34 of 50 cards",
  detail: "On track · about 6 a day",
  progressPercent: 68,
  tone: "on_track",
  isAtRisk: false,
  href: "/dashboard/goals",
};

describe("Today's goals", () => {
  it("shows each goal with where it stands and its pace, and the way to all of them", () => {
    const html = renderToStaticMarkup(
      <TodayGoals goals={[summary, { ...summary, goalId: "g2", title: "20 cards a day", tone: "done_today", detail: "Done for today · 3 of 5 days" }]} />
    );
    expect(html).toContain("Goals");
    expect(html).toContain("Review 50 cards");
    expect(html).toContain("34 of 50 cards");
    expect(html).toContain("On track · about 6 a day");
    expect(html).toContain("Done for today · 3 of 5 days");
    expect(html).toContain('href="/dashboard/goals"');
  });

  it("says nothing when no goal is running", () => {
    expect(renderToStaticMarkup(<TodayGoals goals={[]} />)).toBe("");
  });
});
