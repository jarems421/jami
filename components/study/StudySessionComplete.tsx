"use client";

import type { DailyRequiredSessionScope } from "@/components/study/StudyDailyReviewCard";
import { Button, ButtonLink, Card as SurfaceCard } from "@/components/ui";
import { listModeResults } from "@/lib/study/mode-results";
import type { CardRating } from "@/lib/study/scheduler";
import type { StudyModeResults, StudySessionKind, StudySessionStats } from "@/lib/study/session";
import type { StudyNextStep, StudyNextStepAction, StudyNextStepMessage } from "@/lib/study/session-next-step";
import { RATING_LABELS } from "@/lib/study/study-feedback";
import { STUDY_MODE_LABELS } from "@/lib/study/study-modes";

const RATINGS: CardRating[] = ["again", "hard", "good", "easy"];

const NEXT_STEP_COPY: Record<StudyNextStepMessage, { title: string; description: string }> = {
  "fresh-required-ready": {
    title: "Today's priority cards are ready",
    description:
      "The unfinished carryover is clear. Move into the fresh cards selected for this Daily Review when you are ready.",
  },
  "simple-clear": {
    title: "Simple Study is clear",
    description:
      "You can switch to Daily Review, build a focused session, or come back when more cards need a simple pass.",
  },
  "optional-ready": {
    title: "Easy extras are ready",
    description: "These are lighter extra reps. Do them only if you want a little more practice today.",
  },
  "focused-ready": {
    title: "Focused Review is ready",
    description: "Build a session from any deck or Topic whenever you want targeted practice.",
  },
  "new-star": {
    title: "Check your new star",
    description: "Goal rewards become stars in your constellation.",
  },
  "tidy-cards": {
    title: "Tidy your cards",
    description: "Review is done for now. Add, fix, or tidy cards whenever something feels off.",
  },
};

const NEXT_DUE_FORMAT = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

type StartSession = (kind: StudySessionKind, scope?: DailyRequiredSessionScope) => void;

/** The summary at the end of a session that reviewed something. */
export default function StudySessionComplete({
  sessionKind,
  stats,
  totalCards,
  modeResults,
  daysRunning,
  nextStep,
  nextDueAt,
  canRepeat,
  onStart,
  onExit,
}: {
  sessionKind: StudySessionKind;
  stats: StudySessionStats;
  totalCards: number;
  modeResults: StudyModeResults;
  /** The study streak this session extended, once it has been read. */
  daysRunning: number | null;
  nextStep: StudyNextStep;
  nextDueAt: number | null;
  /** Whether the same kind of session has anything left to run again. */
  canRepeat: boolean;
  onStart: StartSession;
  onExit: () => void;
}) {
  const accuracyPercentage =
    stats.reviewedCards > 0 ? Math.round((stats.correctAnswers / stats.reviewedCards) * 100) : 0;
  const modes = listModeResults(modeResults);
  const copy = NEXT_STEP_COPY[nextStep.message];

  return (
    <SurfaceCard tone="warm" padding="lg">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-text-muted">Session complete</div>
          <h2 className="mt-3 text-xl font-medium leading-tight tracking-tight text-text-primary sm:text-2xl">Good work.</h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">
            {sessionKind === "simple"
              ? `You cleared Simple Study after ${stats.reviewedCards} answer${stats.reviewedCards === 1 ? "" : "s"}. Your next best step is ready below.`
              : `You reviewed ${stats.reviewedCards} of ${totalCards} card${totalCards === 1 ? "" : "s"}. Your next best step is ready below.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3 text-sm text-text-secondary">
            <span className="text-sm font-semibold text-text-primary">{accuracyPercentage}%</span> accuracy
          </div>
          {daysRunning !== null && daysRunning > 0 ? (
            <div className="rounded-xl border border-warm-border bg-warm-glow px-4 py-3 text-sm text-text-secondary">
              <span className="text-sm font-semibold text-text-primary">{daysRunning}</span>{" "}
              day{daysRunning === 1 ? "" : "s"} running
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label="Reviewed" value={stats.reviewedCards} />
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 text-sm">
          <div className="text-center text-xs text-text-muted">Ratings</div>
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs text-text-secondary">
            {RATINGS.map((rating) => (
              <SummaryPill key={rating} label={RATING_LABELS[rating]} value={stats.ratings[rating]} />
            ))}
          </div>
        </div>
        {modes.length > 0 ? (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 text-sm">
            <div className="text-center text-xs text-text-muted">By mode</div>
            <div className="mt-2 grid gap-1.5 text-xs text-text-secondary">
              {modes.map(({ mode, answered, correct }) => (
                <SummaryPill key={mode} label={STUDY_MODE_LABELS[mode]} value={`${correct}/${answered}`} />
              ))}
            </div>
          </div>
        ) : null}
        <SummaryTile label="Goals completed" value={stats.completedGoals} />
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 text-center text-sm">
          <div className="text-xs text-text-muted">Rewards</div>
          <div className="mt-2 text-sm text-text-secondary">
            <span className="font-semibold tabular-nums text-text-primary">{stats.starsEarned}</span> star
            {stats.starsEarned === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">Next best step</div>
        <div className="mt-2 text-base font-semibold text-text-primary sm:text-lg">{copy.title}</div>
        <p className="mt-1 text-sm leading-6 text-text-secondary">{copy.description}</p>
        {nextDueAt ? (
          <p className="mt-3 text-xs font-medium text-text-muted">
            Next due card: {NEXT_DUE_FORMAT.format(nextDueAt)}
          </p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <NextStepAction action={nextStep.action} onStart={onStart} />
        {canRepeat ? (
          <Button type="button" onClick={() => onStart(sessionKind)} size="lg" variant="secondary">
            Run this session again
          </Button>
        ) : null}
        <Button type="button" onClick={onExit} variant="secondary" size="lg">
          Back to study home
        </Button>
      </div>
    </SurfaceCard>
  );
}

function NextStepAction({ action, onStart }: { action: StudyNextStepAction; onStart: StartSession }) {
  switch (action) {
    case "start-fresh-required":
      return (
        <Button type="button" onClick={() => onStart("daily-required", "fresh")} size="lg" variant="warm">
          Start today&apos;s priority cards
        </Button>
      );
    case "start-optional":
      return (
        <Button type="button" onClick={() => onStart("daily-optional")} size="lg" variant="warm">
          Review easy extras
        </Button>
      );
    case "start-focused":
      return (
        <Button type="button" onClick={() => onStart("custom")} size="lg" variant="warm">
          Start Focused Review
        </Button>
      );
    case "view-constellation":
      return (
        <ButtonLink href="/dashboard/constellation" size="lg" variant="warm">
          View constellation
        </ButtonLink>
      );
    case "edit-cards":
      return (
        <ButtonLink href="/dashboard/cards" size="lg" variant="warm">
          Edit cards
        </ButtonLink>
      );
  }
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 text-center text-sm">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-2 flex min-h-7 items-center justify-center text-lg font-semibold leading-none tabular-nums text-text-primary">
        {value}
      </div>
    </div>
  );
}

function SummaryPill({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="inline-flex items-center justify-between gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-2.5 py-1">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-text-primary">{value}</span>
    </span>
  );
}
