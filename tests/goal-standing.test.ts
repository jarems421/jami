import { describe, expect, it } from "vitest";
import { endOfStudyDay } from "@/lib/goals/deadlines";
import { goalFromDraft, normalizeGoal, type Goal, type GoalDraft } from "@/lib/goals/model";
import { goalOutcomeLine, goalStanding, sortGoalsForDisplay } from "@/lib/goals/standing";
import { getStudyDayStartFromKey, shiftStudyDayKey } from "@/lib/study/day";

const START = "2026-10-20";
const at = (dayKey: string, hours = 6) => getStudyDayStartFromKey(dayKey) + hours * 60 * 60 * 1000;

function goal(overrides: Partial<GoalDraft> = {}, progress: Partial<Goal["progress"]> = {}, createdAt = at(START)): Goal {
  const made = goalFromDraft(
    "g",
    {
      name: "",
      measure: "cards",
      cadence: "total",
      target: 100,
      days: 0,
      scope: { type: "all" },
      // Ten study days, the start day included.
      deadline: endOfStudyDay(shiftStudyDayKey(START, 9)),
      ...overrides,
    },
    createdAt
  );
  return { ...made, progress: { ...made.progress, ...progress } };
}

describe("a total with a deadline", () => {
  it("is on track when it has what an even pace asks for by now", () => {
    // Day four: three days have passed, so thirty of a hundred is on pace.
    const standing = goalStanding(goal({}, { count: 30 }), at(shiftStudyDayKey(START, 3)));
    expect(standing).toMatchObject({ tone: "on_track", percent: 30, remaining: 70, perDay: 10, atRisk: false });
    expect(standing.headline).toBe("30 of 100 cards");
    expect(standing.pace).toBe("On track · about 10 a day");
  });

  it("is ahead once today's share is already done", () => {
    const standing = goalStanding(goal({}, { count: 45 }), at(shiftStudyDayKey(START, 3)));
    expect(standing.tone).toBe("ahead");
    expect(standing.pace).toBe("Ahead of pace · 55 to go");
  });

  it("is behind when it is short of the pace, and says what each day now needs", () => {
    const standing = goalStanding(goal({}, { count: 10 }), at(shiftStudyDayKey(START, 5)));
    expect(standing.tone).toBe("behind");
    // Ninety left over the five days that remain, today included.
    expect(standing.perDay).toBe(18);
    expect(standing.pace).toBe("18 a day to make it");
  });

  it("is at risk when it is due within two days and not ahead", () => {
    expect(goalStanding(goal({}, { count: 60 }), at(shiftStudyDayKey(START, 8))).atRisk).toBe(true);
  });

  it("asks for the rest today on its last day", () => {
    const standing = goalStanding(goal({}, { count: 92 }), at(shiftStudyDayKey(START, 9)));
    expect(standing).toMatchObject({ tone: "due_today", pace: "8 to go today", atRisk: true });
  });

  it("has no pace without a deadline", () => {
    const standing = goalStanding(goal({ deadline: 0 }, { count: 20 }), at(START));
    expect(standing).toMatchObject({ tone: "open", pace: "80 to go", atRisk: false });
  });
});

describe("an old goal that has its cards but not its accuracy", () => {
  it("says the accuracy is what is left", () => {
    const legacy = normalizeGoal("old", {
      targetCards: 10,
      targetAccuracy: 0.8,
      progress: { cardsCompleted: 10, correctAnswers: 7, totalAnswers: 10 },
      status: "active",
    });
    expect(goalStanding(legacy, at(START))).toMatchObject({ tone: "behind", pace: "Accuracy 70% · this goal needs 80%" });
  });
});

describe("a daily goal", () => {
  const daily = (progress: Partial<Goal["progress"]>, deadline = 0) =>
    goal({ cadence: "daily", target: 20, days: 5, deadline }, progress);

  it("shows today against the day's amount, and the days hit", () => {
    const standing = goalStanding(daily({ dayKey: START, dayCount: 12, daysHit: 2 }), at(START));
    expect(standing.headline).toBe("Today: 12 of 20 cards");
    expect(standing.pace).toBe("8 to go today · 2 of 5 days");
    expect(standing.days).toMatchObject({ hit: 2, of: 5, doneToday: false, todayCount: 12, todayPercent: 60 });
  });

  it("starts today from nothing when the last count was another day", () => {
    const standing = goalStanding(daily({ dayKey: START, dayCount: 20, daysHit: 1 }), at(shiftStudyDayKey(START, 1)));
    expect(standing.days?.todayCount).toBe(0);
  });

  it("says when today is done", () => {
    const standing = goalStanding(daily({ dayKey: START, dayCount: 21, daysHit: 3 }), at(START));
    expect(standing).toMatchObject({ tone: "done_today", pace: "Done for today · 3 of 5 days" });
  });

  it("says plainly when its days can no longer fit before the deadline", () => {
    const deadline = endOfStudyDay(shiftStudyDayKey(START, 1));
    const standing = goalStanding(daily({ daysHit: 1 }, deadline), at(START));
    expect(standing).toMatchObject({ tone: "out_of_reach", pace: "4 more days needed, 2 left" });
  });
});

describe("a topic goal", () => {
  const topic = (demonstration?: Goal["progress"]["demonstration"]) =>
    goal(
      { measure: "topic", scope: { type: "folder", id: "f" }, topic: { key: "topic:t", label: "Waves" }, deadline: 0 },
      demonstration ? { demonstration } : {}
    );

  it("climbs the engine's ladder rather than filling a bar", () => {
    expect(goalStanding(topic("developing"), at(START))).toMatchObject({
      headline: "Developing",
      percent: 75,
      ladder: { step: 3, label: "Developing" },
    });
    expect(goalStanding(topic("weak"), at(START)).ladder?.step).toBe(2);
  });

  it("waits honestly before the engine has been asked", () => {
    expect(goalStanding(topic(), at(START))).toMatchObject({ tone: "unchecked", headline: "Not checked yet", percent: 0 });
  });
});

describe("listing goals", () => {
  it("puts the soonest due first and open-ended ones last, newest first", () => {
    const soon = { ...goal({ deadline: endOfStudyDay(shiftStudyDayKey(START, 2)) }), id: "soon" };
    const later = { ...goal(), id: "later" };
    const openOld = { ...goal({ deadline: 0 }, {}, at(START, 1)), id: "open-old" };
    const openNew = { ...goal({ deadline: 0 }, {}, at(START, 3)), id: "open-new" };
    expect(sortGoalsForDisplay([openOld, later, openNew, soon]).map((item) => item.id)).toEqual([
      "soon",
      "later",
      "open-new",
      "open-old",
    ]);
  });

  it("sums up how a goal ended", () => {
    expect(goalOutcomeLine(goal({}, { count: 64 }))).toBe("64 of 100 cards");
    expect(goalOutcomeLine(goal({ cadence: "daily", target: 10, days: 5 }, { daysHit: 3 }))).toBe("3 of 5 days");
    const topic = goal({ measure: "topic", scope: { type: "folder", id: "f" }, topic: { key: "k", label: "Waves" } }, { demonstration: "weak" });
    expect(goalOutcomeLine(topic)).toBe("Got to weak");
    expect(goalOutcomeLine({ ...topic, status: "completed" })).toBe("Reached strong");
  });
});
