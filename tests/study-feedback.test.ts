import { describe, expect, it } from "vitest";
import type { CardRating } from "@/lib/study/scheduler";
import {
  formatResetCountdown,
  getAnswerFeedback,
  getSessionLabel,
  getSimpleStudyFeedback,
  RATING_LABELS,
  RATING_STYLES,
  withGoalReward,
} from "@/lib/study/study-feedback";

const RATINGS: CardRating[] = ["again", "hard", "good", "easy"];

describe("getSessionLabel", () => {
  it("names each session kind the way the product does", () => {
    expect(getSessionLabel("simple")).toBe("Simple Study");
    expect(getSessionLabel("custom")).toBe("Focused Review");
    expect(getSessionLabel("daily-optional")).toBe("Easy Extras");
    expect(getSessionLabel("daily-required")).toBe("Daily Review");
  });

  it("falls back to Daily Review before a session starts", () => {
    expect(getSessionLabel(null)).toBe("Daily Review");
  });
});

describe("getAnswerFeedback", () => {
  it("tells a required-review student the card is coming back today", () => {
    const feedback = getAnswerFeedback("again", "daily-required", false);
    expect(feedback.tone).toBe("error");
    expect(feedback.message).toContain("queue");
  });

  it("says tomorrow instead when the session is not the required queue", () => {
    // Promising "back in the queue" outside Daily Review would be a lie: the
    // card will not reappear in this session.
    const feedback = getAnswerFeedback("again", "custom", false);
    expect(feedback.message).toContain("tomorrow");
  });

  it("says the card is back in the queue when an answer-first miss is requeued outside Daily Review", () => {
    expect(getAnswerFeedback("again", "custom", false, true).message).toContain("queue");
    expect(getAnswerFeedback("hard", "daily-optional", false, true).message).toContain("queue");
  });

  it("explains a parked card rather than looking like a demotion", () => {
    expect(getAnswerFeedback("again", "daily-required", true).message).toContain(
      "so you do not get stuck"
    );
    expect(getAnswerFeedback("hard", "daily-required", true).message).toContain(
      "Parked"
    );
  });

  it("stays positive for a recalled card", () => {
    expect(getAnswerFeedback("good", "daily-required", false).tone).toBe("good");
    expect(getAnswerFeedback("easy", "daily-required", false).tone).toBe("good");
  });

  it("returns a message for every rating and session combination", () => {
    for (const rating of RATINGS) {
      for (const kind of [
        "daily-required",
        "daily-optional",
        "custom",
        "simple",
      ] as const) {
        for (const parked of [true, false]) {
          const feedback = getAnswerFeedback(rating, kind, parked);
          expect(feedback.message.trim()).not.toBe("");
        }
      }
    }
  });
});

describe("withGoalReward", () => {
  const base = { tone: "good" as const, message: "Nice recall." };

  it("leaves feedback alone when no goal completed", () => {
    expect(withGoalReward(base, { completedGoals: 0, starsEarned: 0 })).toBe(
      base
    );
  });

  it("stays quiet when a star was earned, since the overlay says it", () => {
    expect(withGoalReward(base, { completedGoals: 1, starsEarned: 1 })).toBe(
      base
    );
  });

  it("acknowledges a goal that finished without a star", () => {
    const result = withGoalReward(base, { completedGoals: 1, starsEarned: 0 });
    expect(result.message).toBe("Nice recall. Goal complete.");
    // Held longer so a silent completion is actually read.
    expect(result.holdMs).toBe(5_000);
  });

  it("pluralises more than one goal", () => {
    const result = withGoalReward(base, { completedGoals: 3, starsEarned: 0 });
    expect(result.message).toContain("3 goals complete.");
  });
});

describe("getSimpleStudyFeedback", () => {
  it("clears a correct card", () => {
    expect(getSimpleStudyFeedback("correct")).toMatchObject({ tone: "good" });
  });

  it("sends a wrong card to the back rather than away", () => {
    const feedback = getSimpleStudyFeedback("wrong");
    expect(feedback.tone).toBe("warm");
    expect(feedback.message).toContain("back");
  });
});

describe("formatResetCountdown", () => {
  it("says now once the boundary has passed", () => {
    expect(formatResetCountdown(0)).toBe("now");
    expect(formatResetCountdown(-5_000)).toBe("now");
  });

  it("rounds a part-minute up so it never reads 0m", () => {
    expect(formatResetCountdown(1)).toBe("1m");
    expect(formatResetCountdown(59_000)).toBe("1m");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatResetCountdown(2 * 60 * 60_000)).toBe("2h");
  });

  it("shows hours and minutes together", () => {
    expect(formatResetCountdown(2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("keeps minutes alone under an hour", () => {
    expect(formatResetCountdown(45 * 60_000)).toBe("45m");
  });
});

describe("rating presentation", () => {
  it("labels and styles every rating", () => {
    for (const rating of RATINGS) {
      expect(RATING_LABELS[rating]).toBeTruthy();
      expect(RATING_STYLES[rating].hint).toBeTruthy();
      expect(RATING_STYLES[rating].classes).toBeTruthy();
    }
  });

  it("keeps the keyboard shortcuts 1-4 in rating order", () => {
    // The shortcut is positional; swapping two would rate the wrong button.
    expect(RATINGS.map((rating) => RATING_STYLES[rating].shortcut)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });
});
