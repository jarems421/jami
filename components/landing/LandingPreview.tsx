"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { REDUCED_MOTION_QUERY } from "@/lib/ui/reduced-motion";

/*
 * The questions, answers and marks below are written for this page. They are
 * not taken from any exam board's paper or mark scheme, so nothing here needs
 * a permission record -- and nothing licensed should ever be pasted in to make
 * the demo look more real.
 */

/**
 * What Jami decides to do next, one of each kind the Learning Engine can ask
 * for: teach it (a revision session), find out more (a practice set), or keep
 * it from slipping (a flashcard review).
 */
type Plan = {
  kind: "revision" | "practice" | "review";
  label: string;
  title: string;
  why: string;
  parts: readonly { name: string; detail: string }[];
  action: string;
  length: string;
};

export type LandingExample = {
  subject: string;
  question: string;
  marks: number;
  answer: string;
  points: readonly { text: string; earned: boolean }[];
  flashcard: { front: string; back: string };
  /** The topic as Jami saw it before this answer, and after marking it. */
  topic: { name: string; before: string; after: string; tone: "warning" | "info" };
  plan: Plan;
};

export const LANDING_EXAMPLES: readonly LandingExample[] = [
  {
    subject: "Biology",
    question: "Explain why an enzyme works more slowly above its optimum temperature.",
    marks: 4,
    answer:
      "The enzyme denatures, so its active site changes shape and the substrate no longer fits.",
    points: [
      { text: "Enzyme denatures", earned: true },
      { text: "Active site changes shape", earned: true },
      { text: "Substrate no longer fits", earned: true },
      { text: "Fewer enzyme–substrate complexes", earned: false },
    ],
    flashcard: {
      front: "What forms less often once an enzyme denatures?",
      back: "Enzyme–substrate complexes",
    },
    topic: {
      name: "Enzymes",
      before: "Last practiced 9 days ago",
      after: "Lost the mark on complexes",
      tone: "warning",
    },
    plan: {
      kind: "revision",
      label: "Revision session",
      title: "Enzymes and temperature",
      why: "Jami teaches the mark you missed, then checks that it stuck.",
      parts: [
        { name: "Explain", detail: "Why shape decides the fit" },
        { name: "Your turn", detail: "Three quick checks" },
        { name: "Exam question", detail: "4 marks, marked like this one" },
      ],
      action: "Start session",
      length: "~12 min",
    },
  },
  {
    subject: "Chemistry",
    question: "Explain why raising the temperature increases the rate of a reaction.",
    marks: 3,
    answer: "The particles gain energy and move faster, so they collide more often.",
    points: [
      { text: "Particles gain kinetic energy", earned: true },
      { text: "Collisions are more frequent", earned: true },
      { text: "More collisions exceed the activation energy", earned: false },
    ],
    flashcard: {
      front: "Why are more collisions successful at a higher temperature?",
      back: "More particles have at least the activation energy",
    },
    topic: {
      name: "Rates of reaction",
      before: "Not tested yet",
      after: "First answer · 2 of 3 marks",
      tone: "info",
    },
    plan: {
      kind: "practice",
      label: "Practice set",
      title: "Rates of reaction",
      why: "One answer is too little to judge, so a short set to see where you stand.",
      parts: [
        { name: "Collision theory", detail: "2 marks" },
        { name: "Catalysts", detail: "3 marks" },
        { name: "Concentration graphs", detail: "4 marks" },
      ],
      action: "Start practice",
      length: "3 questions",
    },
  },
  {
    subject: "History",
    question: "Describe two ways the Treaty of Versailles affected Germany.",
    marks: 4,
    answer:
      "Germany lost land, including Alsace-Lorraine, and it had to pay reparations to the Allies.",
    points: [
      { text: "Loss of territory identified", earned: true },
      { text: "Supported with an example", earned: true },
      { text: "Reparations identified", earned: true },
      { text: "Reparations developed with detail", earned: false },
    ],
    flashcard: {
      front: "What were German reparations set at in 1921?",
      back: "£6.6 billion",
    },
    topic: {
      name: "Treaty of Versailles",
      before: "4 cards due",
      after: "Slipping · 5 cards due",
      tone: "warning",
    },
    plan: {
      kind: "review",
      label: "Flashcard review",
      title: "Treaty of Versailles",
      why: "It is slipping, so the cards that are due come first, with the one you just made.",
      parts: [
        { name: "New", detail: "Reparations set in 1921" },
        { name: "Due", detail: "Land lost in the west" },
        { name: "Due", detail: "The War Guilt Clause" },
      ],
      action: "Review 5 cards",
      length: "~4 min",
    },
  },
];

/** How often the demo's clock advances. Coarse on purpose: nothing here needs 60fps. */
const TICK_MS = 50;
const TYPE_MS_PER_CHAR = 28;
const MARK_MS_PER_POINT = 520;
const PLAN_MS_PER_PART = 560;

/**
 * Where each moment of an example falls on its clock. Derived rather than
 * stored, so jumping to a step is only setting the clock.
 */
export function landingTimelineFor(example: LandingExample) {
  const typed = example.answer.length * TYPE_MS_PER_CHAR;
  const markStart = typed + 450;
  // The last point lands, and the topic Jami is tracking takes the result.
  const markedAt = markStart + (example.points.length - 1) * MARK_MS_PER_POINT + 350;
  const keepStart = markStart + example.points.length * MARK_MS_PER_POINT + 700;
  const flipAt = keepStart + 1_700;
  const planStart = keepStart + 3_600;
  const partsStart = planStart + 900;
  const pressAt = partsStart + example.plan.parts.length * PLAN_MS_PER_PART + 1_800;
  const end = pressAt + 1_100;
  return { typed, markStart, markedAt, keepStart, flipAt, planStart, partsStart, pressAt, end };
}

type Timeline = ReturnType<typeof landingTimelineFor>;

const STEPS = [
  {
    label: "Practice",
    detail: "Answer past-paper questions, typed or handwritten, in your own notebook.",
  },
  {
    label: "Get marked",
    detail: "Marked point by point against the scheme, so you see which marks you lost and why.",
  },
  {
    label: "Remember",
    detail: "The mark you missed becomes a flashcard you approve, reviewed before you forget.",
  },
  {
    label: "Plan next",
    detail:
      "Jami turns that into your next step: a revision session, a practice set or a review. Then round again.",
  },
] as const;

/** Where each step begins on an example's clock, with the end as a fifth entry. */
function stepStartsFor(timeline: Timeline) {
  return [0, timeline.markStart, timeline.keepStart, timeline.planStart, timeline.end];
}

/** Circumference of the score ring's r=15.5 circle. */
const RING = 2 * Math.PI * 15.5;

function Tick() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3"
    >
      <path d="m3.5 8.5 3 3 6-6.5" />
    </svg>
  );
}

function Cross() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3 w-3"
    >
      <path d="m5 5 6 6M11 5l-6 6" />
    </svg>
  );
}

/** Round again: the last step leads back to the first. */
function LoopArrow({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M13 8a5 5 0 1 1-1.6-3.67" />
      <path d="M13.25 2.5v2.25H11" />
    </svg>
  );
}

function PlanIcon({ kind }: { kind: Plan["kind"] }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[1.125rem] w-[1.125rem]"
    >
      {kind === "revision" ? (
        // An open book: being taught.
        <>
          <path d="M10 5.5C8.5 4.3 6.4 3.75 3.5 3.75v11c2.9 0 5 .55 6.5 1.75 1.5-1.2 3.6-1.75 6.5-1.75v-11c-2.9 0-5 .55-6.5 1.75Z" />
          <path d="M10 5.5v11" />
        </>
      ) : kind === "practice" ? (
        // A paper with a pencil across it: answering questions.
        <>
          <path d="M12.5 3.5H5.25A1.25 1.25 0 0 0 4 4.75v10.5c0 .69.56 1.25 1.25 1.25h9.5c.69 0 1.25-.56 1.25-1.25V9" />
          <path d="M7 8h3.5M7 11h5M7 14h2.5" />
          <path d="m11.5 7.75 4.6-4.6a1.06 1.06 0 0 1 1.5 1.5L13 9.25l-2 .5.5-2Z" />
        </>
      ) : (
        // Two cards, one behind the other.
        <>
          <rect x="3.5" y="6" width="10" height="10.5" rx="1.5" />
          <path d="M6.5 6V4.75c0-.69.56-1.25 1.25-1.25h7c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25H13.5" />
        </>
      )}
    </svg>
  );
}

/**
 * Jami's next step, built in front of the student: the kind of session, why
 * it was chosen, and what will be in it, arriving one part at a time. Then it
 * is started, and the loop begins again with the next question.
 */
function PlanSheet({ plan, clock, timeline }: { plan: Plan; clock: number; timeline: Timeline }) {
  const visible = clock >= timeline.planStart;
  const partsShown = Math.max(
    0,
    Math.min(
      plan.parts.length,
      Math.floor((clock - timeline.partsStart) / PLAN_MS_PER_PART) + 1
    )
  );
  const planning = partsShown < plan.parts.length;
  const pressed = clock >= timeline.pressAt;

  return (
    <div
      className={`absolute inset-0 transition duration-slow ${
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      <div className="signed-out-panel signed-out-panel-opaque flex h-full flex-col rounded-xl px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] ring-4 ring-[var(--color-accent-muted)] ${
                planning ? "animate-pulse" : ""
              }`}
            />
            {planning ? "Jami is planning…" : "Your next step"}
          </span>
          <span className="text-2xs tabular-nums text-text-muted">{plan.length}</span>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-muted)] text-accent">
            <PlanIcon kind={plan.kind} />
          </span>
          <div className="min-w-0">
            <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-accent">
              {plan.label}
            </div>
            <div className="truncate text-base font-semibold leading-6 text-text-primary">
              {plan.title}
            </div>
          </div>
        </div>

        <p className="mt-2 text-xs leading-5 text-text-secondary">{plan.why}</p>

        <ol className="mt-3 grid gap-1.5">
          {plan.parts.map((part, index) => {
            const shown = index < partsShown;
            return (
              <li
                key={`${part.name}-${part.detail}`}
                className="flex h-7 items-center gap-2.5 rounded-md bg-[var(--color-glass-subtle)] px-2.5 text-xs"
              >
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular-nums transition duration-fast ${
                    shown
                      ? "bg-[var(--color-accent-muted)] text-accent"
                      : "border border-[var(--color-border-strong)] text-text-muted"
                  }`}
                >
                  {index + 1}
                </span>
                {shown ? (
                  <span className="flex min-w-0 animate-fade-in items-baseline gap-2">
                    <span className="shrink-0 font-semibold text-text-primary">{part.name}</span>
                    <span className="truncate text-text-muted">{part.detail}</span>
                  </span>
                ) : (
                  <span className="h-1.5 w-2/5 animate-pulse rounded-full bg-[var(--color-glass-medium)]" />
                )}
              </li>
            );
          })}
        </ol>

        <div className="mt-auto flex items-center justify-between gap-3 pt-3">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-2xs leading-4 text-text-muted">
            <LoopArrow className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Then round again</span>
          </span>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-on transition duration-fast ${
              planning ? "opacity-40" : "opacity-100"
            } ${pressed ? "scale-95 ring-4 ring-[var(--color-accent-muted)] brightness-110" : ""}`}
          >
            {plan.action}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3 w-3"
            >
              <path d="M3.5 8h9M8.5 4l4 4-4 4" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One moment of the demo, drawn from an example and a point on its clock and
 * nothing else, so any moment can be shown -- including the finished one, for
 * reduced motion -- without playing up to it.
 */
export function LandingDemoScene({ example, clock }: { example: LandingExample; clock: number }) {
  const timeline = landingTimelineFor(example);
  const typedChars = Math.min(example.answer.length, Math.floor(clock / TYPE_MS_PER_CHAR));
  const typing = typedChars < example.answer.length;
  const pointsShown = Math.max(
    0,
    Math.min(
      example.points.length,
      Math.floor((clock - timeline.markStart) / MARK_MS_PER_POINT) + 1
    )
  );
  const earnedShown = example.points
    .slice(0, pointsShown)
    .filter((point) => point.earned).length;
  const keeping = clock >= timeline.keepStart;
  const flipped = clock >= timeline.flipAt;
  const marked = clock >= timeline.markedAt;
  // The tracked topic glows for a moment as the marks reach it.
  const topicChanging = marked && clock < timeline.markedAt + 2_400;

  return (
    <>
      <div className="landing-lean">
        <div className="signed-out-panel landing-spotlight rounded-xl p-4 sm:rounded-2xl sm:p-6">
          <div className="flex items-center gap-2 pr-36 sm:pr-40">
            <span className="app-chip rounded-full px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.14em]">
              {example.subject}
            </span>
            <span className="text-xs text-text-muted">{example.marks} marks</span>
          </div>

          <p className="mt-3 min-h-[3rem] text-sm font-medium leading-6 text-text-primary">
            {example.question}
          </p>

          <p className="landing-ruled mt-2 rounded-md px-1 text-text-secondary">
            {example.answer.slice(0, typedChars)}
            {typing ? <span className="landing-caret" /> : null}
          </p>

          {/*
            * Tall enough for the plan that is built over it at the end, so
            * the card keeps one size from the first letter to the last step.
            */}
          <div className="relative mt-4 min-h-[18.75rem]">
            <div className="border-t border-[var(--color-border)] pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                  {pointsShown > 0 ? "Marked against the scheme" : "Waiting to mark"}
                </span>
                <span className="flex items-center gap-2">
                  <svg viewBox="0 0 36 36" className="h-8 w-8 -rotate-90">
                    <circle
                      cx="18"
                      cy="18"
                      r="15.5"
                      fill="none"
                      stroke="var(--color-border-strong)"
                      strokeWidth="3"
                    />
                    <circle
                      cx="18"
                      cy="18"
                      r="15.5"
                      fill="none"
                      stroke="var(--color-success-mark)"
                      strokeWidth="3"
                      strokeLinecap="round"
                      className="landing-ring"
                      strokeDasharray={`${(RING * earnedShown) / example.points.length} ${RING}`}
                    />
                  </svg>
                  <span className="text-base font-semibold tabular-nums text-text-primary">
                    {earnedShown}
                    <span className="text-text-muted">/{example.points.length}</span>
                  </span>
                </span>
              </div>

              <ul className="mt-3 grid gap-2">
                {example.points.map((point, index) => {
                  const shown = index < pointsShown;
                  return (
                    <li
                      key={point.text}
                      className={`flex items-center gap-2.5 text-xs transition duration-normal sm:text-sm ${
                        shown ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"
                      }`}
                    >
                      <span
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                          point.earned
                            ? "bg-success-muted text-[var(--color-success-mark)]"
                            : "border border-dashed border-[var(--color-error-mark)] text-[var(--color-error-mark)]"
                        }`}
                      >
                        {point.earned ? <Tick /> : <Cross />}
                      </span>
                      <span className={point.earned ? "text-text-secondary" : "text-text-primary"}>
                        {point.text}
                      </span>
                      {point.earned ? null : (
                        <span className="ml-auto shrink-0 rounded-full bg-error-muted px-2 py-0.5 text-2xs font-semibold text-[var(--color-error-text)]">
                          Missed
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div
              className={`landing-flip mt-4 h-[5.25rem] transition duration-slow ${
                keeping ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
              }`}
              data-flipped={flipped ? "true" : "false"}
            >
              <div className="landing-flip-inner">
                <div className="landing-flip-face rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-glass-subtle)] px-3.5 py-3">
                  <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                    New flashcard · from the missed mark
                  </div>
                  <p className="mt-1.5 text-sm font-medium leading-5 text-text-primary">
                    {example.flashcard.front}
                  </p>
                </div>
                <div className="landing-flip-face landing-flip-back rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-glass-medium)] px-3.5 py-3">
                  <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                    Answer
                  </div>
                  <p className="mt-1.5 text-sm font-semibold leading-5 text-text-primary">
                    {example.flashcard.back}
                  </p>
                </div>
              </div>
            </div>

            <PlanSheet plan={example.plan} clock={clock} timeline={timeline} />
          </div>
        </div>
      </div>

      {/* The topic Jami is keeping track of, which the marks feed into. */}
      <div className="absolute right-0 top-0 sm:-right-3">
        <div
          className={`signed-out-panel signed-out-panel-opaque landing-tilted w-44 rounded-lg px-4 py-3 [--landing-tilt:3deg] sm:w-52 ${
            topicChanging ? "landing-next-live" : ""
          }`}
        >
          <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
            Jami is tracking
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full transition duration-normal ${
                !marked
                  ? "bg-[var(--color-border-strong)]"
                  : example.topic.tone === "warning"
                    ? "bg-[var(--color-warning-mark)] ring-4 ring-warning-muted"
                    : "bg-[var(--color-accent)] ring-4 ring-[var(--color-accent-muted)]"
              }`}
            />
            <span className="truncate text-sm font-semibold text-text-primary">
              {example.topic.name}
            </span>
          </div>
          <p
            key={marked ? "after" : "before"}
            className="mt-0.5 animate-fade-in truncate text-xs leading-5 text-text-muted"
          >
            {marked ? example.topic.after : example.topic.before}
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * The landing page's picture of Jami, played rather than posed, as the loop it
 * is: an answer is written and marked point by point, the missed mark becomes
 * a flashcard, the topic Jami tracks takes the result, and Jami builds the
 * next step from it -- a revision session, a practice set or a review. Then
 * the next subject begins, and the loop goes round again.
 *
 * The subjects and the four steps under the card are real controls -- choosing
 * one jumps the demo there -- so the page answers "how does it work" by showing
 * it. With reduced motion nothing plays by itself: each step is shown finished,
 * the last one first.
 *
 * The animated card is hidden from assistive technology; each example is
 * described in one sentence instead, since the made-up question is not content.
 */
export default function LandingPreview() {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  // One piece of state, so the clock can roll over into the next example in
  // the same update that advances it. `step` is only used with reduced motion,
  // where a chosen step is shown finished rather than played.
  const [demo, setDemo] = useState<{ index: number; elapsed: number; step: number | null }>({
    index: 0,
    elapsed: 0,
    step: null,
  });
  const stageRef = useRef<HTMLDivElement>(null);

  const exampleIndex = demo.index;
  const example = LANDING_EXAMPLES[exampleIndex];
  const timeline = landingTimelineFor(example);
  const stepStarts = stepStartsFor(timeline);
  const clock = reducedMotion
    ? // The last moment of the chosen step, before anything of the next.
      // The plan is shown built but not yet started.
      Math.min(stepStarts[(demo.step ?? STEPS.length - 1) + 1], timeline.pressAt) - 1
    : demo.elapsed;

  useEffect(() => {
    if (reducedMotion) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      setDemo((current) => {
        const next = current.elapsed + TICK_MS;
        if (next < landingTimelineFor(LANDING_EXAMPLES[current.index]).end) {
          return { ...current, elapsed: next };
        }
        return { index: (current.index + 1) % LANDING_EXAMPLES.length, elapsed: 0, step: null };
      });
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [reducedMotion]);

  const chooseExample = useCallback((index: number) => {
    setDemo({ index, elapsed: 0, step: null });
  }, []);

  const activeStep =
    clock >= timeline.planStart ? 3 : clock >= timeline.keepStart ? 2 : clock >= timeline.markStart ? 1 : 0;

  const chooseStep = (step: number) => {
    // Land just inside the step, so its first moment has already happened.
    setDemo({ index: exampleIndex, elapsed: step === 0 ? 0 : stepStarts[step] + 1, step });
  };

  // A slight lean toward the pointer, and light that follows it. Written to CSS
  // variables directly: re-rendering on every pointer move would be wasteful.
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage || event.pointerType !== "mouse" || reducedMotion) return;
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    // The light is drawn inside the card, not the whole stage (which also
    // holds the steps below it), so it is placed from the card's own corner.
    const card = stage.querySelector<HTMLElement>(".landing-spotlight");
    if (card) {
      const cardRect = card.getBoundingClientRect();
      card.style.setProperty("--landing-spot-x", `${(event.clientX - cardRect.left).toFixed(0)}px`);
      card.style.setProperty("--landing-spot-y", `${(event.clientY - cardRect.top).toFixed(0)}px`);
    }
    stage.style.setProperty("--landing-lean-x", `${((0.5 - y) * 5).toFixed(2)}deg`);
    stage.style.setProperty("--landing-lean-y", `${((x - 0.5) * 7).toFixed(2)}deg`);
  };

  const handlePointerLeave = () => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.setProperty("--landing-lean-x", "0deg");
    stage.style.setProperty("--landing-lean-y", "0deg");
  };

  const earnedTotal = example.points.filter((point) => point.earned).length;

  return (
    <div className="relative mx-auto w-full max-w-lg">
      <div
        role="tablist"
        aria-label="Example subject"
        className="relative z-10 mb-4 flex flex-wrap gap-2"
      >
        {LANDING_EXAMPLES.map((item, index) => {
          const selected = index === exampleIndex;
          return (
            <button
              key={item.subject}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => chooseExample(index)}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition duration-fast ${
                selected
                  ? "border-[var(--color-border-strong)] bg-[var(--color-glass-medium)] text-text-primary shadow-e1"
                  : "border-transparent text-text-muted hover:bg-[var(--button-ghost-bg-hover)] hover:text-text-primary"
              }`}
            >
              {item.subject}
            </button>
          );
        })}
      </div>

      <p className="sr-only" aria-live="polite">
        {`${example.subject} example: an answer marked ${earnedTotal} out of ${example.points.length} against the mark scheme, a flashcard made from the missed mark, and a ${example.plan.label.toLowerCase()} on ${example.plan.title} planned by Jami as the next step.`}
      </p>

      <div
        ref={stageRef}
        aria-hidden="true"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className="landing-stage relative pt-14 sm:pt-12"
      >
        <LandingDemoScene example={example} clock={clock} />
      </div>

      <ol className="relative z-10 mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-1.5">
        {STEPS.map((step, index) => {
          const active = index === activeStep;
          const last = index === STEPS.length - 1;
          const span = stepStarts[index + 1] - stepStarts[index];
          // Only the step playing shows its progress, so the row reads as
          // "where the demo is", not as a checklist being completed.
          const progress =
            active && !reducedMotion
              ? Math.min(1, Math.max(0, (clock - stepStarts[index]) / span))
              : 0;
          return (
            <li key={step.label}>
              <button
                type="button"
                onClick={() => chooseStep(index)}
                aria-current={active ? "step" : undefined}
                className={`group relative flex w-full items-center gap-1.5 overflow-hidden rounded-lg border px-2.5 pb-3 pt-2.5 text-left transition duration-fast ${
                  active
                    ? "border-[var(--color-border-strong)] bg-[var(--color-glass-medium)]"
                    : "border-transparent hover:bg-[var(--button-ghost-bg-hover)]"
                }`}
              >
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular-nums transition duration-fast ${
                    active
                      ? "bg-[var(--color-text-primary)] text-[var(--app-background)]"
                      : "border border-[var(--color-border-strong)] text-text-muted"
                  }`}
                >
                  {index + 1}
                </span>
                <span
                  className={`whitespace-nowrap text-xs font-semibold ${
                    active ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary"
                  }`}
                >
                  {step.label}
                </span>
                {last ? (
                  <span
                    className={`shrink-0 ${active ? "text-accent" : "text-text-muted"}`}
                    title="Then round again"
                  >
                    <LoopArrow className="h-3 w-3" />
                  </span>
                ) : null}
                <span
                  className="landing-step-progress absolute inset-x-0 bottom-0 h-0.5 origin-left"
                  style={{ transform: `scaleX(${progress})` }}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 min-h-[3rem] px-1 text-sm leading-6 text-text-muted">
        {STEPS[activeStep].detail}
      </p>
    </div>
  );
}
