"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ButtonLink, StudyText } from "@/components/ui";
import RevisionAsk from "@/components/revision/RevisionAsk";
import RevisionNextSteps from "@/components/revision/RevisionNextSteps";
import RevisionTaskStep from "@/components/revision/RevisionTaskStep";
import { useUser } from "@/components/providers/UserProvider";
import { useRevisionSession } from "@/hooks/useRevisionSession";
import { noteMissionCompleted } from "@/lib/learning/mission-handoff";
import type { RevisionSessionView, RevisionStepView } from "@/lib/revision/view";
import { getStudyDayKey } from "@/lib/study/day";
import { NOTEBOOK_EDITOR_LOCK_BODY_CLASS } from "@/lib/workspace/notebook-interaction-lock";
import { noteStudyActionOutcomeById } from "@/services/learning/study-action-events";

const TODAY_HREF = "/dashboard";

/** Where leaving goes, and what the way back is called. */
function backTo(returnHref: string | undefined) {
  return returnHref
    ? { href: returnHref, label: "Back to where you were" }
    : { href: TODAY_HREF, label: "Back to Today" };
}

/**
 * A Revision Session, full screen.
 *
 * Deliberately not a chat. There is one thing on the screen at a time -- the
 * idea, then a question, then the next -- and Jami's words sit above the
 * activity rather than in bubbles beside it. The navigation goes, the page
 * stops scrolling behind it, and what is left is the concept's name, a row of
 * dots and a way out.
 *
 * Everything shown is what the server sent. See `useRevisionSession`.
 */
export default function RevisionSessionScreen({
  sessionId,
  returnHref,
}: {
  sessionId: string;
  /** The page the session was started from, when it was not Today. */
  returnHref?: string;
}) {
  const { user } = useUser();
  const state = useRevisionSession(sessionId);
  const { session } = state;

  useEffect(() => {
    document.body.classList.add(NOTEBOOK_EDITOR_LOCK_BODY_CLASS);
    return () => document.body.classList.remove(NOTEBOOK_EDITOR_LOCK_BODY_CLASS);
  }, []);

  /*
   * Handing back to Today, once.
   *
   * The recommendation is recorded as carried out -- the same record a
   * flashcard session writes -- and Today's completion moment is told what was
   * done. Both are notes rather than requirements: finishing must never fail
   * because a note about it could not be written.
   */
  const handedBackRef = useRef(false);
  useEffect(() => {
    if (session?.status !== "completed" || !session.completion || handedBackRef.current) return;
    handedBackRef.current = true;
    // A session the student started on a concept Jami had no advice about has
    // no recommendation to report back on.
    if (!session.actionId) return;
    noteMissionCompleted(session.actionId, session.completion.answered);
    noteStudyActionOutcomeById(user.uid, session.actionId, "completed", getStudyDayKey());
  }, [session, user.uid]);

  return (
    <RevisionCanvas session={session} returnHref={returnHref}>
      {state.error ? (
        <Ended
          title="This session couldn't carry on."
          detail={state.error}
          returnHref={returnHref}
        />
      ) : !session ? (
        <Preparing label="Opening your session" />
      ) : session.status === "completed" && session.completion ? (
        <Completion session={session} returnHref={returnHref} />
      ) : session.status === "failed" ? (
        <Ended
          title="Jami couldn't prepare this session."
          detail="Nothing from it counts. You can start it again whenever you like."
          returnHref={returnHref}
        />
      ) : session.status === "abandoned" ? (
        <Ended
          title="This session has ended."
          detail="It was left for a while, so it's been put away. You can start a fresh one whenever you like."
          returnHref={returnHref}
        />
      ) : session.status === "preparing" || !session.step ? (
        <Opening session={session} />
      ) : (
        <Step key={stepKey(session)} session={session} step={session.step} state={state} />
      )}
    </RevisionCanvas>
  );
}

function stepKey(session: RevisionSessionView) {
  return `${session.progress.currentIndex}:${session.step?.kind ?? "none"}`;
}

function RevisionCanvas({
  session,
  returnHref,
  children,
}: {
  session: RevisionSessionView | null;
  returnHref?: string;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-[var(--app-background)] text-text-primary">
      <header className="relative flex items-center gap-4 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-8">
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-[0.2em] text-text-muted">
          {session?.conceptLabel ?? "Revision session"}
        </span>
        {session && session.status === "active" ? <ProgressDots session={session} /> : null}
        <ButtonLink
          href={backTo(returnHref).href}
          variant="ghost"
          size="icon"
          aria-label="Leave the session. It will be here if you come back soon."
          title="Leave — it'll be here if you come back soon"
        >
          <CloseGlyph />
        </ButtonLink>
      </header>

      <main
        aria-label={session ? `Revision session: ${session.conceptLabel}` : "Revision session"}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-6 sm:px-8 sm:pt-10">
          {children}
        </div>
      </main>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Where the student is. Five quiet dots, never a percentage. */
function ProgressDots({ session }: { session: RevisionSessionView }) {
  const { total, currentIndex } = session.progress;
  return (
    <div
      role="img"
      aria-label={
        currentIndex < 0 || currentIndex >= total
          ? "Getting started"
          : `Part ${currentIndex + 1} of ${total}`
      }
      className="flex items-center gap-1.5"
    >
      {Array.from({ length: total }, (_unused, index) => (
        <span
          key={index}
          className={`h-1.5 rounded-full transition-all duration-slow ${
            index === currentIndex
              ? "w-5 bg-accent"
              : index < currentIndex
                ? "w-1.5 bg-accent/60"
                : "w-1.5 bg-[var(--color-border)]"
          }`}
        />
      ))}
    </div>
  );
}

const RISE_IN = "motion-safe:animate-[app-rise-in_360ms_cubic-bezier(0.22,1,0.36,1)_both]";

function Preparing({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center" role="status">
      <span className="ai-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <p className="text-sm text-text-muted">{label}</p>
    </div>
  );
}

/**
 * The start: what this is, what it will cover, and why Jami chose it.
 *
 * Shown while the lesson is still being written, which is most of the reason
 * it exists -- a student reading why this topic, and what they will be able to
 * do, is not waiting. "Start" arrives when the lesson does.
 */
function Opening({ session }: { session: RevisionSessionView }) {
  const [showWhy, setShowWhy] = useState(false);
  const ready = session.status === "active";
  return (
    <div className={`flex flex-col gap-8 ${RISE_IN}`}>
      <div className="flex flex-col gap-4">
        <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-warm-accent">
          Revision session
        </span>
        <h1 className="text-balance text-3xl font-medium leading-[1.1] tracking-[-0.02em] sm:text-4xl">
          {session.conceptLabel}
        </h1>
        <p className="text-base leading-7 text-text-secondary">
          {ready ? "Let's get this properly understood." : "Jami is getting your session ready."}
        </p>
      </div>
      {!ready ? <Preparing label="This takes a few seconds" /> : null}
      {session.why.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setShowWhy((open) => !open)}
            aria-expanded={showWhy}
            className="rounded-full text-sm font-medium text-text-muted underline-offset-4 transition duration-fast hover:text-text-primary hover:underline"
          >
            {showWhy ? "Hide" : "Why this topic?"}
          </button>
          {showWhy ? (
            <div className="mt-3 grid gap-2 border-l border-[var(--color-border)] pl-4">
              {session.why.map((line) => (
                <p key={line} className="text-sm leading-6 text-text-secondary">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Step({
  session,
  step,
  state,
}: {
  session: RevisionSessionView;
  step: RevisionStepView;
  state: ReturnType<typeof useRevisionSession>;
}) {
  const { busy, act, stepError } = state;
  if (step.kind === "orient") {
    return (
      <div className={`flex flex-col gap-8 ${RISE_IN}`}>
        <div className="flex flex-col gap-4">
          <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-warm-accent">
            Revision session
          </span>
          <h1 className="text-balance text-3xl font-medium leading-[1.1] tracking-[-0.02em] sm:text-4xl">
            {session.conceptLabel}
          </h1>
          <StudyText as="p" text={step.orientation} className="text-base leading-7 text-text-secondary" />
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-muted">By the end, you&apos;ll be able to</p>
          <ul className="grid gap-2.5">
            {step.goals.map((goal) => (
              <li key={goal} className="flex items-start gap-3 text-base leading-7">
                <span aria-hidden="true" className="mt-[0.7rem] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <StudyText text={goal} />
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" className="min-w-36" disabled={busy !== null} onClick={() => void act({ type: "continue" })}>
            {busy === "continue" ? "One moment…" : "Start"}
          </Button>
          {stepError ? <p role="alert" className="text-sm text-text-secondary">{stepError}</p> : null}
        </div>
        <RevisionAsk sessionId={session.id} />
      </div>
    );
  }

  if (step.kind === "explain") {
    return (
      <div className={`flex flex-col gap-8 ${RISE_IN}`}>
        <div className="flex flex-col gap-4">
          <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-warm-accent">
            The idea
          </span>
          <StudyText
            as="p"
            text={step.body}
            className="whitespace-pre-line text-lg leading-8 text-text-primary sm:text-xl sm:leading-9"
          />
        </div>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-5 sm:p-6">
          <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">For example</span>
          <StudyText as="p" text={step.example.problem} className="mt-2 block text-lg leading-7 text-text-primary" />
          <ol className="mt-4 grid gap-2.5">
            {step.example.steps.map((line, index) => (
              <li key={`${index}:${line}`} className="flex gap-3 text-base leading-7 text-text-secondary">
                <span aria-hidden="true" className="w-5 shrink-0 text-right text-sm tabular-nums text-text-muted">
                  {index + 1}
                </span>
                <StudyText text={line} />
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" className="min-w-36" disabled={busy !== null} onClick={() => void act({ type: "continue" })}>
            {busy === "continue" ? "One moment…" : "Try one"}
          </Button>
          {stepError ? <p role="alert" className="text-sm text-text-secondary">{stepError}</p> : null}
        </div>
        <RevisionAsk sessionId={session.id} />
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-8 ${RISE_IN}`}>
      <RevisionTaskStep
        step={step}
        feedback={state.feedback}
        selfGrade={state.selfGrade}
        busy={busy}
        stepError={stepError}
        isLast={step.kind === "retrieve"}
        onAct={(input) => void act(input)}
      />
      <RevisionAsk sessionId={session.id} />
    </div>
  );
}

/**
 * The end: what was done well, and one honest line about the rest.
 *
 * No confetti, no score, and no claim that the topic is now known -- that is
 * the engine's call, made from everything rather than one sitting.
 */
function Completion({
  session,
  returnHref,
}: {
  session: RevisionSessionView;
  returnHref?: string;
}) {
  const completion = session.completion;
  if (!completion) return null;
  const back = backTo(returnHref);
  return (
    <div className={`flex flex-col gap-8 ${RISE_IN}`}>
      <div className="flex flex-col gap-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-warm-accent">
          {session.conceptLabel}
        </span>
        <h1 className="text-balance text-3xl font-medium leading-[1.1] tracking-[-0.02em] sm:text-4xl">
          That&apos;s enough for today.
        </h1>
      </div>
      {completion.earned.length > 0 ? (
        <ul className="grid gap-3">
          {completion.earned.map((line) => (
            <li key={line} className="flex items-center gap-3 text-base leading-7">
              <span
                aria-hidden="true"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success/15 text-[var(--color-success-mark)]"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5">
                  <path d="m5 12.5 4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <p className="text-base leading-7 text-text-secondary">{completion.note}</p>
        <p className="text-sm text-text-muted">Jami has your answers.</p>
      </div>
      <RevisionNextSteps
        items={completion.nextSteps.map((step) => ({ step }))}
        // Material written from here answers the recommendation, or this session.
        interventionId={session.actionId ?? `revision-session:${session.id}`}
      />
      <div>
        <ButtonLink href={back.href} size="lg" className="min-w-40">
          {back.label}
        </ButtonLink>
      </div>
    </div>
  );
}

function Ended({
  title,
  detail,
  returnHref,
}: {
  title: string;
  detail: string;
  returnHref?: string;
}) {
  const back = backTo(returnHref);
  return (
    <div className={`flex flex-col gap-6 ${RISE_IN}`}>
      <div className="flex flex-col gap-3">
        <h1 className="text-balance text-2xl font-medium leading-tight tracking-[-0.01em] sm:text-3xl">{title}</h1>
        <p className="text-base leading-7 text-text-secondary">{detail}</p>
      </div>
      <div>
        <ButtonLink href={back.href} size="lg">
          {back.label}
        </ButtonLink>
      </div>
    </div>
  );
}

export { Preparing as RevisionPreparing, RevisionCanvas, Ended as RevisionEnded };
