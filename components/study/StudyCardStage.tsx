"use client";

import { useCallback, type ReactNode } from "react";
import JamiAssistantDrawer from "@/components/ai/JamiAssistantDrawer";
import InlineStudyFeedback from "@/components/study/InlineStudyFeedback";
import StudyRatingControls from "@/components/study/StudyRatingControls";
import { Button, JamiTutorIcon, ProgressBar } from "@/components/ui";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import { getCardListTitle, type Card } from "@/lib/study/cards";
import type { CardRating } from "@/lib/study/scheduler";
import type { StudySessionKind } from "@/lib/study/session";
import { getSessionLabel, type AnswerFeedback } from "@/lib/study/study-feedback";

/** Before the flip Jami nudges towards the answer; it cannot see it yet. */
const QUESTION_ACTIONS = [
  { label: "Give me a hint", prompt: "Give me one hint towards this without telling me the answer." },
  { label: "I don't know", prompt: "I'm stuck on this. Walk me through how to work it out, step by step." },
  { label: "Break it down", prompt: "What is this question actually asking? Break it down for me." },
];

const ANSWER_ACTIONS = [
  { label: "Explain simply", prompt: "Explain this card simply." },
  { label: "Give an example", prompt: "Give me a clear example of this idea." },
  {
    label: "What might I mix up?",
    prompt: "What is this commonly confused with, and how can I tell the difference?",
  },
];

/**
 * One card of a session in progress: where the session is, a way to ask Jami
 * about the card, the card itself, and how to rate it once it is turned over.
 */
export default function StudyCardStage({
  userId,
  card,
  sessionKind,
  index,
  totalCards,
  answerFeedback,
  flipped,
  assistantOpen,
  onAssistantOpenChange,
  settingsFolderIds,
  recoveryNotice,
  showRatingControls,
  savingRating,
  onRate,
  onEnd,
  children,
}: {
  userId: string;
  card: Card;
  sessionKind: StudySessionKind;
  /** How far through the session this card is. */
  index: number;
  totalCards: number;
  answerFeedback: AnswerFeedback | null;
  flipped: boolean;
  assistantOpen: boolean;
  onAssistantOpenChange: (open: boolean) => void;
  /** The folders whose Tutor instructions apply to this card. */
  settingsFolderIds: readonly string[];
  /** Why a saved exercise is being shown as the original card instead. */
  recoveryNotice: string | null;
  /** The card is a flipped flashcard, which is rated here rather than by its exercise. */
  showRatingControls: boolean;
  savingRating: CardRating | null;
  onRate: (rating: CardRating) => void;
  onEnd: () => void;
  /** The card as it is being asked. */
  children: ReactNode;
}) {
  const remainingCards = totalCards - index;
  const progressPercent = totalCards > 0 ? Math.round((index / totalCards) * 100) : 0;
  const ratingScale = sessionKind === "simple" ? "two-point" : "four-point";

  const getAssistantContext = useCallback(
    (): JamiAssistantContext => ({
      surface: "learn",
      cardId: card.id,
      phase: flipped ? "answer" : "question",
    }),
    [card.id, flipped]
  );

  return (
    <div className="animate-slide-up space-y-4 sm:space-y-5">
      <InlineStudyFeedback feedback={answerFeedback} />
      <section className="study-session-stage space-y-5 px-1 py-2 sm:px-2 sm:py-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="min-w-0">
            <div className="text-2xs font-semibold uppercase tracking-[0.2em] text-text-muted">
              {getSessionLabel(sessionKind)}
            </div>
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-3 py-1.5 text-sm leading-none text-text-secondary">
              <span className="font-semibold tabular-nums text-text-primary">{remainingCards}</span>
              <span className="text-text-muted">/</span>
              <span className="tabular-nums">{totalCards}</span>
              <span>cards remaining</span>
            </div>
          </div>
          <div className="flex items-end gap-2.5">
            <div className="min-w-[10rem] flex-1 lg:min-w-[12rem] lg:flex-none">
              <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-text-muted">
                <span>Progress</span>
                <span className="tabular-nums">{progressPercent}%</span>
              </div>
              <ProgressBar progress={progressPercent} />
            </div>
            <button
              type="button"
              title="Ask Jami about this card"
              aria-label="Ask Jami about this card"
              aria-haspopup="dialog"
              aria-expanded={assistantOpen}
              onClick={() => onAssistantOpenChange(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-3 py-1.5 text-xs font-semibold text-text-secondary transition duration-fast hover:border-border-strong hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              <JamiTutorIcon className="h-4 w-4" />
              Jami
            </button>
          </div>
        </div>

        <JamiAssistantDrawer
          userId={userId}
          open={assistantOpen}
          onOpenChange={onAssistantOpenChange}
          resetKey={card.id}
          contextKey={`learn:${card.id}`}
          contextLabel="Current flashcard"
          historyContextLabel={`Flashcard · ${getCardListTitle(card).slice(0, 72)}`}
          getContext={getAssistantContext}
          quickActions={flipped ? ANSWER_ACTIONS : QUESTION_ACTIONS}
          settingsFolderIds={settingsFolderIds}
          emptyStateNote={
            flipped
              ? undefined
              : "Jami cannot see this card's answer until you flip it, so it can nudge you towards it but never hand it over."
          }
        />
        {recoveryNotice ? (
          <p role="status" className="mx-auto max-w-xl text-center text-sm text-text-secondary">
            {recoveryNotice}
          </p>
        ) : null}
        {children}
      </section>
      {showRatingControls ? (
        <StudyRatingControls scale={ratingScale} savingRating={savingRating} onRate={onRate} />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={onEnd} variant="secondary">
          End session
        </Button>
      </div>
    </div>
  );
}

/** The card a locked mode is waiting on, while Jami writes its question. */
export function StudyQuestionWriting({
  cardId,
  onShowAsFlashcard,
}: {
  cardId: string;
  onShowAsFlashcard: () => void;
}) {
  return (
    <div
      data-study-current-card-id={cardId}
      className="study-flashcard-face mx-auto flex min-h-[16rem] w-full max-w-[62rem] flex-col items-center justify-center gap-5 rounded-2xl p-6 text-center sm:p-10"
    >
      <div aria-hidden className="flex items-center gap-2">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent"
            style={{ animationDelay: `${dot * 160}ms` }}
          />
        ))}
      </div>
      <div className="max-w-lg space-y-2">
        <h2 className="text-xl font-semibold text-text-primary">Writing this question</h2>
        <p role="status" className="text-sm leading-relaxed text-text-secondary">
          Jami is preparing the answer choices for this card.
        </p>
      </div>
      <Button type="button" variant="secondary" onClick={onShowAsFlashcard}>
        Show it as a flashcard
      </Button>
    </div>
  );
}
