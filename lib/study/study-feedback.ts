import type { CardRating } from "@/lib/study/scheduler";
import type { StudySessionKind } from "@/lib/study/session";
import type { SimpleStudyResult } from "@/lib/study/simple-study";

/** The one-line acknowledgement shown after a card is rated. */
export type AnswerFeedback = {
  tone: "error" | "warm" | "good" | "calm";
  message: string;
  /** Overrides the usual dismiss delay, so a reward is not gone before it is read. */
  holdMs?: number;
};

export const RATING_LABELS: Record<CardRating, string> = {
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
};

export const RATING_STYLES: Record<
  CardRating,
  { hint: string; shortcut: string; classes: string }
> = {
  again: {
    hint: "Missed it",
    shortcut: "1",
    classes: "app-danger hover:border-border-strong",
  },
  hard: {
    hint: "Barely recalled",
    shortcut: "2",
    classes: "app-warning hover:border-border-strong",
  },
  good: {
    hint: "Recalled",
    shortcut: "3",
    classes:
      "app-chip hover:border-border-strong hover:bg-[var(--color-glass-medium)]",
  },
  easy: {
    hint: "Instant",
    shortcut: "4",
    classes: "app-success hover:border-border-strong",
  },
};

export function getSessionLabel(kind: StudySessionKind | null) {
  if (kind === "simple") return "Simple Study";
  if (kind === "custom") return "Focused Review";
  if (kind === "daily-optional") return "Easy Extras";
  return "Daily Review";
}

/**
 * `requeued` says whether the card went to the back of this session's queue.
 * Outside Daily Review that depends on the mode: an answer-first miss comes
 * back, so its count stays put, and the message has to say so.
 */
export function getAnswerFeedback(
  rating: CardRating,
  sessionKind: StudySessionKind,
  parked: boolean,
  requeued = sessionKind === "daily-required" && !parked,
): AnswerFeedback {
  if (rating === "again") {
    return {
      tone: "error",
      message: parked
        ? "Moved to tomorrow so you do not get stuck."
        : requeued
          ? "Back in the queue for another try."
          : "We will bring this back tomorrow.",
    };
  }

  if (rating === "hard") {
    return {
      tone: "warm",
      message: parked
        ? "Parked for tomorrow after a rough stretch."
        : requeued
          ? "Back in the queue for one steadier pass."
          : "Worth another look tomorrow.",
    };
  }

  if (rating === "good") {
    return { tone: "good", message: "Nice recall." };
  }

  return { tone: "good", message: "That one felt easy." };
}

/**
 * Says so when a review finished a goal without earning a star.
 *
 * A star gets the overlay instead, which shows the star itself. This covers the
 * quieter case, where a goal completes but the constellation is already full,
 * so the completion is still acknowledged rather than passing in silence.
 */
export function withGoalReward(
  feedback: AnswerFeedback,
  progress: { completedGoals: number; starsEarned: number }
): AnswerFeedback {
  if (progress.completedGoals <= 0 || progress.starsEarned > 0) return feedback;

  const goals =
    progress.completedGoals === 1
      ? "Goal complete."
      : `${progress.completedGoals} goals complete.`;

  return {
    tone: "good",
    message: `${feedback.message} ${goals}`,
    holdMs: 5_000,
  };
}

export function getSimpleStudyFeedback(
  result: SimpleStudyResult
): AnswerFeedback {
  return result === "correct"
    ? { tone: "good", message: "Cleared from Simple Study." }
    : { tone: "warm", message: "Moved to the back for another pass." };
}

/** How long until the daily queue refills, as a short "2h 15m" style label. */
export function formatResetCountdown(ms: number) {
  if (ms <= 0) return "now";
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
