"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ButtonLink, Card, SectionHeader, Skeleton } from "@/components/ui";
import { featureFlags } from "@/lib/app/feature-flags";
import type { ExamSession } from "@/lib/practice/exam-questions";
import type { PracticePaperAttempt } from "@/lib/practice/practice-papers";
import {
  summarisePaperAttempts,
  summarisePastPaperSessions,
  summarisePracticeWeek,
  summariseSessionTrend,
  type PaperProgress,
  type PastPaperProgress,
  type PracticeWeek,
  type SessionTrend,
} from "@/lib/practice/practice-progress";
import { listPastPaperPracticeSessions } from "@/services/study/exam-practice";
import { getRecentPracticePaperAttempts } from "@/services/study/practice-papers";

export type Loadable<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

export type PastPaperView = { progress: PastPaperProgress; trend: SessionTrend };

/**
 * Progress's Practice view: how marked exam questions and practice papers are
 * going.
 *
 * Each half loads on its own, so one failing never hides the other.
 */
export default function PracticeProgress({ userId }: { userId: string }) {
  const pastPapersEnabled = featureFlags.enablePastPaperPractice;
  const [sessions, setSessions] = useState<Loadable<ExamSession[]>>(
    pastPapersEnabled ? { status: "loading" } : { status: "ready", value: [] }
  );
  const [attempts, setAttempts] = useState<Loadable<PracticePaperAttempt[]>>({ status: "loading" });

  useEffect(() => {
    let active = true;
    if (pastPapersEnabled) {
      listPastPaperPracticeSessions()
        .then((page) => active && setSessions({ status: "ready", value: page.sessions }))
        .catch((error) => {
          console.warn("Progress could not load past paper practice.", error);
          if (active) setSessions({ status: "error" });
        });
    }
    getRecentPracticePaperAttempts(userId, 20)
      .then((value) => active && setAttempts({ status: "ready", value }))
      .catch((error) => {
        console.warn("Progress could not load practice papers.", error);
        if (active) setAttempts({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [pastPapersEnabled, userId]);

  const pastPapers: Loadable<PastPaperView> =
    sessions.status === "ready"
      ? {
          status: "ready",
          value: {
            progress: summarisePastPaperSessions(sessions.value),
            trend: summariseSessionTrend(sessions.value),
          },
        }
      : sessions;
  const papers: Loadable<PaperProgress> =
    attempts.status === "ready" ? { status: "ready", value: summarisePaperAttempts(attempts.value) } : attempts;
  const week =
    sessions.status !== "loading" && attempts.status !== "loading"
      ? summarisePracticeWeek(
          sessions.status === "ready" ? sessions.value : [],
          attempts.status === "ready" ? attempts.value : []
        )
      : null;

  return (
    <PracticeProgressView
      week={week}
      trend={pastPapers.status === "ready" ? pastPapers.value.trend : null}
      pastPapers={pastPapersEnabled ? pastPapers : null}
      papers={papers}
    />
  );
}

/** A small figure in the chip Progress uses for every number. */
function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="app-chip min-w-0 rounded-lg px-3 py-2.5">
      <div className="truncate text-2xs font-semibold uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-lg font-semibold tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-text-muted">{children}</p>;
}

function shortDate(at: number) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(at));
}

/** "2/9": what fits under a chart bar a phone's width divides into eight. */
function tinyDate(at: number) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric" }).format(new Date(at));
}

/** One sentence on whether recent sessions went up, down or held. */
function trendSentence(trend: SessionTrend) {
  if (trend.recentAverage === null) return null;
  const sessions = `session${trend.recentCount === 1 ? "" : "s"}`;
  if (trend.earlierAverage === null) {
    return `Your ${trend.recentCount === 1 ? "session so far scored" : `${trend.recentCount} sessions so far average`} ${trend.recentAverage}%.`;
  }
  const difference = trend.recentAverage - trend.earlierAverage;
  const movement =
    difference >= 3
      ? `up from ${trend.earlierAverage}%`
      : difference <= -3
        ? `down from ${trend.earlierAverage}%`
        : `about the same as the ${trend.earlierAverage}% before`;
  return `Your last ${trend.recentCount} ${sessions} averaged ${trend.recentAverage}%, ${movement}.`;
}

function WeekCard({ week, trend }: { week: PracticeWeek | null; trend: SessionTrend | null }) {
  const sentence = trend ? trendSentence(trend) : null;
  return (
    <Card tone="warm" padding="md">
      <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-text-muted">Last 7 days</p>
      {week === null ? (
        <Skeleton className="mt-3 h-16 rounded-lg" />
      ) : (
        <>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
            {week.daysPractised === 0
              ? "No practice marked this week"
              : `Practiced on ${week.daysPractised} day${week.daysPractised === 1 ? "" : "s"}`}
          </h2>
          {/* Two zero tiles say less than one line about what fills them in. */}
          {week.daysPractised === 0 ? (
            <p className="mt-1.5 text-sm text-text-secondary">
              Mark some exam questions or finish a paper, and your week shows here.
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <MiniStat label="Sessions" value={week.sessions} />
              <MiniStat label="Papers marked" value={week.papersMarked} />
            </div>
          )}
          {sentence ? <p className="mt-3 text-sm text-text-secondary">{sentence}</p> : null}
        </>
      )}
    </Card>
  );
}

function TrendChart({ trend }: { trend: SessionTrend }) {
  return (
    <div
      className="app-subtle-panel rounded-lg px-3 pb-2 pt-3"
      role="img"
      aria-label={`Recent session scores: ${trend.points.map((point) => `${point.percent}%`).join(", ")}`}
    >
      <div className="flex h-28 items-end gap-2">
        {trend.points.map((point) => (
          <div key={point.id} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={point.courseName}>
            <span className="mb-1 text-2xs font-semibold tabular-nums text-text-secondary">{point.percent}%</span>
            <div
              className="w-full max-w-10 rounded-t-sm bg-[var(--color-accent)]"
              style={{ height: `${Math.max(4, point.percent * 0.72)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2">
        {trend.points.map((point) => (
          <span key={point.id} className="min-w-0 flex-1 truncate text-center text-2xs text-text-muted">
            <span className="sm:hidden">{tinyDate(point.at)}</span>
            <span className="hidden sm:inline">{shortDate(point.at)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PastPaperCard({ state }: { state: Loadable<PastPaperView> }) {
  return (
    <Card padding="md">
      <SectionHeader
        title="Past paper questions"
        description="Real exam questions, marked one at a time."
        action={
          <ButtonLink href="/dashboard/practice/history" size="sm" variant="ghost">
            History
          </ButtonLink>
        }
      />
      <div className="mt-4 space-y-4">
        {state.status === "loading" ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : state.status === "error" ? (
          <Quiet>Your question practice could not be loaded just now.</Quiet>
        ) : state.value.progress.percent === null ? (
          <Quiet>
            No questions marked yet.{" "}
            <Link href="/dashboard/practice/questions/new" className="font-semibold text-text-primary underline underline-offset-2">
              Try some exam questions
            </Link>{" "}
            and your scores build up here.
          </Quiet>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="Questions" value={state.value.progress.questionsMarked} />
              <MiniStat label="Score" value={`${state.value.progress.percent}%`} />
              <MiniStat label="Finished" value={state.value.progress.finishedSessions} />
            </div>

            {state.value.trend.points.length > 1 ? (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-text-primary">Recent sessions</h4>
                <TrendChart trend={state.value.trend} />
              </div>
            ) : null}

            {state.value.progress.courses.length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-text-primary">By course</h4>
                <ul className="space-y-2">
                  {state.value.progress.courses.map((course) => (
                    <li key={course.name} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-xs font-medium text-text-secondary sm:w-40" title={course.name}>
                        {course.name}
                      </span>
                      <div
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-glass-medium"
                        role="progressbar"
                        aria-label={`${course.name}: ${course.percent} per cent of marks`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={course.percent}
                      >
                        <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${course.percent}%` }} />
                      </div>
                      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-text-primary">
                        {course.percent}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Quiet>
              From your {state.value.progress.sessionCount} most recent session
              {state.value.progress.sessionCount === 1 ? "" : "s"}.
            </Quiet>
          </>
        )}
      </div>
    </Card>
  );
}

function FeedbackList({ title, items, tone }: { title: string; items: string[]; tone: "work" | "good" }) {
  if (items.length === 0) return null;
  return (
    <div className="app-subtle-panel rounded-lg px-3 py-2.5">
      <h5 className="text-xs font-semibold text-text-primary">{title}</h5>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-xs leading-5 text-text-secondary">
            <span
              aria-hidden="true"
              className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${tone === "good" ? "bg-success" : "bg-warning"}`}
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaperCard({ state }: { state: Loadable<PaperProgress> }) {
  return (
    <Card padding="md">
      <SectionHeader
        title="Practice papers"
        description="Full papers, marked as a whole."
        action={
          <ButtonLink href="/dashboard/practice/new" size="sm" variant="ghost">
            New paper
          </ButtonLink>
        }
      />
      <div className="mt-4 space-y-4">
        {state.status === "loading" ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : state.status === "error" ? (
          <Quiet>Your practice papers could not be loaded just now.</Quiet>
        ) : state.value.markedCount === 0 ? (
          <Quiet>No practice papers marked yet. Finish one and your marks, and what to work on, show here.</Quiet>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="Papers" value={state.value.markedCount} />
              <MiniStat label="Average" value={`${state.value.average}%`} />
              <MiniStat
                label={state.value.change === null ? "Best" : "Since last"}
                value={
                  state.value.change === null ? (
                    `${state.value.best}%`
                  ) : (
                    <span className={state.value.change > 0 ? "text-[var(--color-success-text)]" : ""}>
                      {state.value.change > 0 ? "+" : ""}
                      {state.value.change}%
                    </span>
                  )
                }
              />
            </div>

            {state.value.latestFeedback ? (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-text-primary">
                  From your latest paper
                  <span className="ml-1.5 font-normal text-text-muted">{state.value.latestFeedback.paperTitle}</span>
                </h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  <FeedbackList title="Work on next" items={state.value.latestFeedback.priorities} tone="work" />
                  <FeedbackList title="Went well" items={state.value.latestFeedback.strengths} tone="good" />
                </div>
              </div>
            ) : null}

            {state.value.extraTime ? (
              <p className="text-sm text-text-secondary">
                {state.value.extraTime.withExtraTime - state.value.extraTime.withinTime > 0
                  ? `Extra time is adding about ${state.value.extraTime.withExtraTime - state.value.extraTime.withinTime} points: you average ${state.value.extraTime.withinTime}% within the time and ${state.value.extraTime.withExtraTime}% with it.`
                  : `You finish inside the time: extra time is not changing your ${state.value.extraTime.withinTime}% average.`}
              </p>
            ) : null}

            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-text-primary">Recent papers</h4>
              <ul className="space-y-1.5">
                {state.value.recent.map((attempt) => (
                  <li key={attempt.id}>
                    <Link
                      href={`/dashboard/notebooks/${encodeURIComponent(attempt.notebookId)}`}
                      className="app-subtle-panel flex items-center gap-3 rounded-lg px-3 py-2 transition duration-fast hover:bg-[var(--color-glass-medium)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary">{attempt.paperTitle}</span>
                        <span className="block text-2xs text-text-muted">
                          Attempt {attempt.attemptNumber}
                          {attempt.markedAt ? ` · ${shortDate(attempt.markedAt)}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-semibold tabular-nums text-text-primary">
                          {attempt.result?.percentage}%
                        </span>
                        {attempt.result?.gradeLabel ? (
                          <span className="block text-2xs text-text-muted">{attempt.result.gradeLabel}</span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** The view itself, given already-loaded summaries. */
export function PracticeProgressView({
  week,
  trend,
  pastPapers,
  papers,
}: {
  /** Null while either half is still loading. */
  week: PracticeWeek | null;
  trend: SessionTrend | null;
  /** Null when Past Paper Practice is switched off. */
  pastPapers: Loadable<PastPaperView> | null;
  papers: Loadable<PaperProgress>;
}) {
  return (
    <div className="space-y-4">
      <WeekCard week={week} trend={trend} />
      {pastPapers ? <PastPaperCard state={pastPapers} /> : null}
      <PaperCard state={papers} />
    </div>
  );
}
