"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, ElapsedTime, FeedbackBanner, ProgressBar } from "@/components/ui";
import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/Dialog";
import PracticePaperDetailsDialog from "@/components/practice/PracticePaperDetailsDialog";
import PracticePaperResultsDialog from "@/components/practice/PracticePaperResultsDialog";
import { useFeedback } from "@/hooks/useFeedback";
import { practiceMissionCompletion } from "@/lib/learning/interventions/practice-completion";
import { noteMissionFinished } from "@/lib/learning/mission-handoff";
import { getStudyDayKey } from "@/lib/study/day";
import { noteStudyActionOutcomeById } from "@/services/learning/study-action-events";
import { PRACTICE_PAPER_MARKING_STAGE_LABELS } from "@/lib/practice/practice-paper-marking-jobs";
import type { PracticePaper, PracticePaperMarkingJob, PracticePaperStatus, PracticePaperTimingMode } from "@/lib/practice/practice-papers";
import {
  cancelPracticePaperMarkingJob,
  getPracticePaperMarkingJob,
  getRecentPracticePaperMarkingJobs,
  markPracticePaper,
  prepareUploadedPracticePaper,
} from "@/services/ai/practice-papers";
import {
  capturePracticePaperDeadlineSnapshot,
  continuePracticePaperInOvertime,
  getPracticePaperByNotebookId,
  pausePracticePaperAttempt,
  resumePracticePaperAttempt,
  startPracticePaperAttempt,
  submitPracticePaperAttempt,
} from "@/services/study/practice-papers";

/**
 * A paper Jami wrote has just been marked: tell the loop it was done.
 *
 * Two records, for two readers, both fire-and-forget. The event is what stops
 * the engine recommending work the student has already carried out; the note
 * is what lets Today acknowledge it when they go back. Neither may delay or
 * fail the marking report the student is waiting for, and losing either costs
 * only itself.
 *
 * Nothing happens for a paper the student made themselves, or for a sitting
 * that produced no countable answer -- see `practiceMissionCompletion`.
 */
function noteFinishedMission(userId: string, paper: PracticePaper) {
  const finished = practiceMissionCompletion(paper);
  if (!finished) return;
  noteMissionFinished(
    {
      actionId: finished.interventionId,
      headline: `Practice ${finished.conceptLabel}`,
      conceptLabel: finished.conceptLabel,
      targetItems: finished.targetItems,
    },
    finished.answered
  );
  noteStudyActionOutcomeById(userId, finished.interventionId, "completed", getStudyDayKey());
}

function formatRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function PracticePaperAttemptBar({
  userId,
  notebookId,
  onStatusChange,
  onBeforeSubmit,
  onRetake,
  onEditingLockChange,
  onTutorLockChange,
}: {
  userId: string;
  notebookId: string;
  onStatusChange: (status: PracticePaperStatus | null) => void;
  onBeforeSubmit: () => Promise<boolean>;
  onRetake: () => void;
  onEditingLockChange: (locked: boolean) => void;
  onTutorLockChange: (locked: boolean) => void;
}) {
  const [paper, setPaper] = useState<PracticePaper | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"prepare" | "start" | "mark" | "retake" | "pause" | "resume" | "snapshot" | "overtime" | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [confirmRetake, setConfirmRetake] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [markingJob, setMarkingJob] = useState<PracticePaperMarkingJob | null>(null);
  const [clock, setClock] = useState(Date.now());
  /** How the next attempt is sat; the paper's own choice until the student changes it here. */
  const [timingChoice, setTimingChoice] = useState<PracticePaperTimingMode | null>(null);
  const captureVersionRef = useRef<string | null>(null);
  const { feedback, showThrownError, showError, clear } = useFeedback();
  const replacePaper = useCallback((next: PracticePaper) => {
    setPaper(next);
    onStatusChange(next.status);
  }, [onStatusChange]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getPracticePaperByNotebookId(userId, notebookId)
      .then((next) => {
        if (!active) return;
        setPaper(next);
        onStatusChange(next?.status ?? null);
      })
      .catch((error) => {
        if (active) showThrownError(error, "Could not load this paper's attempt state.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [notebookId, onStatusChange, showThrownError, userId]);

  useEffect(() => {
    if (!paper || (paper.status !== "submitted" && paper.status !== "marked")) return;
    let active = true;
    void getRecentPracticePaperMarkingJobs()
      .then((jobs) => {
        if (!active) return;
        const matching = jobs.find((job) =>
          job.paperId === paper.id &&
          job.kind === "full" &&
          !["failed", "cancelled"].includes(job.status)
        );
        if (matching) setMarkingJob(matching);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [paper]);

  const markingJobId = markingJob?.id;
  const markingJobStatus = markingJob?.status;
  useEffect(() => {
    if (!markingJobId || !markingJobStatus || !["queued", "running"].includes(markingJobStatus)) return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await getPracticePaperMarkingJob(markingJobId);
        if (!active) return;
        setMarkingJob(next);
        if (next.status === "ready") {
          const marked = await getPracticePaperByNotebookId(userId, notebookId);
          if (!active || !marked) return;
          replacePaper(marked);
          setReportOpen(true);
          noteFinishedMission(userId, marked);
        }
      } catch (error) {
        if (active) showThrownError(error, "Could not refresh marking progress.");
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_500);
    void refresh();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [markingJobId, markingJobStatus, notebookId, replacePaper, showThrownError, userId]);

  useEffect(() => {
    if (
      paper?.timingMode !== "timed" ||
      paper.status !== "in_progress" ||
      (paper.timingState !== "running" && paper.timingState !== "overtime")
    ) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [paper?.status, paper?.timingMode, paper?.timingState]);

  useEffect(() => {
    const editingLocked = Boolean(
      paper &&
      (paper.status === "submitted" ||
        paper.status === "marked" ||
        (paper.status === "in_progress" &&
          (paper.timingState === "paused" ||
            paper.timingState === "awaiting_overtime")))
    );
    const tutorLocked = Boolean(
      paper?.status === "submitted" ||
      (paper?.status === "in_progress" &&
        (!paper.tutorEnabled ||
          paper.timingState === "paused" ||
          paper.timingState === "awaiting_overtime"))
    );
    onEditingLockChange(editingLocked);
    onTutorLockChange(tutorLocked);
  }, [onEditingLockChange, onTutorLockChange, paper]);

  const remaining = useMemo(() => {
    if (!paper?.deadlineAt || paper.timingMode !== "timed") return null;
    return paper.deadlineAt - clock;
  }, [clock, paper?.deadlineAt, paper?.timingMode]);

  const overtime = useMemo(() => {
    if (!paper?.overtimeStartedAt || paper.timingState !== "overtime") return null;
    return Math.max(0, clock - paper.overtimeStartedAt);
  }, [clock, paper?.overtimeStartedAt, paper?.timingState]);

  useEffect(() => {
    if (
      !paper ||
      paper.status !== "in_progress" ||
      paper.timingState !== "running" ||
      remaining === null ||
      remaining > 0 ||
      busy !== null
    ) return;
    const captureKey = `${paper.activeAttemptId}:${paper.deadlineVersion}`;
    if (captureVersionRef.current === captureKey) return;
    captureVersionRef.current = captureKey;
    setBusy("snapshot");
    void onBeforeSubmit()
      .then(async (saved) => {
        if (!saved) throw new Error("Save the current page before time is recorded.");
        replacePaper(await capturePracticePaperDeadlineSnapshot(userId, paper));
      })
      .catch((error) => {
        captureVersionRef.current = null;
        showThrownError(error, "Jami could not record the deadline snapshot.");
      })
      .finally(() => setBusy(null));
  }, [busy, onBeforeSubmit, paper, remaining, replacePaper, showThrownError, userId]);

  const canTime = Boolean(paper && paper.durationMinutes > 0);
  const nextTiming: PracticePaperTimingMode = canTime ? (timingChoice ?? paper?.timingMode ?? "timed") : "untimed";

  const start = async () => {
    if (!paper) return;
    setBusy(paper.origin === "uploaded" && paper.questions.length === 0 ? "prepare" : "start");
    clear();
    try {
      if (paper.origin === "uploaded" && paper.questions.length === 0) {
        const prepared = await prepareUploadedPracticePaper(notebookId);
        replacePaper(prepared);
        setDetailsOpen(true);
        return;
      }
      const started = await startPracticePaperAttempt(userId, paper, { timingMode: nextTiming });
      replacePaper(started);
      setClock(started.startedAt ?? Date.now());
    } catch (error) {
      showThrownError(error, "Could not start this attempt.");
    } finally {
      setBusy(null);
    }
  };

  const submitAndMark = async () => {
    if (!paper) return;
    setBusy("mark");
    clear();
    try {
      const saved = await onBeforeSubmit();
      if (!saved) {
        showError("Save the current page before submitting the paper.");
        return;
      }
      let submitted = paper;
      if (paper.status !== "submitted") {
        const submittedAt = await submitPracticePaperAttempt(userId, paper);
        submitted = { ...paper, status: "submitted", submittedAt };
        replacePaper(submitted);
      }
      setConfirmSubmit(false);
      const job = await markPracticePaper(notebookId, markingJob?.id);
      setMarkingJob(job);
    } catch (error) {
      showThrownError(error, "Jami could not mark this paper.");
    } finally {
      setBusy(null);
    }
  };

  const cancelMarking = async () => {
    if (!markingJob) return;
    clear();
    try {
      setMarkingJob(await cancelPracticePaperMarkingJob(markingJob.id));
    } catch (error) {
      showThrownError(error, "Could not cancel marking.");
    }
  };

  const pause = async () => {
    if (!paper) return;
    setBusy("pause");
    clear();
    try {
      const saved = await onBeforeSubmit();
      if (!saved) throw new Error("Save the current page before pausing.");
      replacePaper(await pausePracticePaperAttempt(userId, paper));
    } catch (error) {
      showThrownError(error, "Could not pause this attempt.");
    } finally {
      setBusy(null);
    }
  };

  const resume = async () => {
    if (!paper) return;
    setBusy("resume");
    clear();
    try {
      replacePaper(await resumePracticePaperAttempt(userId, paper));
      setClock(Date.now());
    } catch (error) {
      showThrownError(error, "Could not resume this attempt.");
    } finally {
      setBusy(null);
    }
  };

  const continueOvertime = async () => {
    if (!paper) return;
    setBusy("overtime");
    clear();
    try {
      replacePaper(await continuePracticePaperInOvertime(userId, paper));
      setClock(Date.now());
    } catch (error) {
      showThrownError(error, "Could not continue in overtime.");
    } finally {
      setBusy(null);
    }
  };

  const retake = async () => {
    if (!paper) return;
    setBusy("retake");
    clear();
    try {
      const started = await startPracticePaperAttempt(userId, paper, { clearPreviousWork: true, timingMode: nextTiming });
      onRetake();
      replacePaper(started);
      setClock(started.startedAt ?? Date.now());
      setConfirmRetake(false);
      setReportOpen(false);
    } catch (error) {
      showThrownError(error, "Could not start a new attempt.");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="mt-2 h-14 animate-pulse rounded-xl bg-[var(--color-glass-subtle)]" />;
  if (!paper) return null;
  const result = paper.result;

  /*
   * The state, said once, in three separate places rather than one run-on
   * string.
   *
   * It used to read "18/40 complete · 45% · Grade 5" in a single truncated
   * line of `text-xs` -- so the result of an entire paper was both the
   * smallest text in the bar and the first thing cut off on a narrow screen.
   * A pill carries the state, a headline carries the fact, and the numbers
   * get their own space below.
   */
  const statusPill = (() => {
    if (paper.status === "ready") {
      return {
        label: "Ready",
        className: "bg-accent/12 text-accent",
        headline: paper.totalMarks
          ? `${paper.totalMarks} marks`
          : "Practice paper",
        detail: paper.markScheme.notice,
      };
    }
    if (paper.status === "in_progress") {
      return {
        label: paper.timingState === "paused" ? "Paused" : "Sitting",
        className:
          paper.timingState === "paused"
            ? "bg-[var(--color-glass-medium)] text-text-secondary"
            : "bg-warm-accent/15 text-warm-accent",
        headline: `Attempt ${paper.attemptCount}`,
        detail:
          paper.timingState === "paused"
            ? "Writing and Jami are locked while paused"
            : paper.tutorEnabled
              ? "Jami assisted"
              : "Exam conditions",
      };
    }
    if (paper.status === "submitted" && markingJob && ["queued", "running", "paused"].includes(markingJob.status)) {
      return {
        label: markingJob.status === "paused" ? "Paused" : "Marking",
        className: "bg-accent/12 text-accent",
        headline: PRACTICE_PAPER_MARKING_STAGE_LABELS[markingJob.stage],
        detail: markingJob.failureMessage ?? "You can leave this page. Your work is safely saved.",
      };
    }
    if (paper.status === "submitted") {
      return {
        label: "Submitted",
        className: "bg-accent/12 text-accent",
        headline: "Ready to mark",
        detail: paper.markScheme.notice,
      };
    }
    if (paper.status === "marked" && result) {
      return {
        label: "Marked",
        className: "bg-success/15 text-success",
        headline: `Attempt ${paper.attemptCount}`,
        detail: paper.markScheme.notice,
      };
    }
    return {
      label: "Setup",
      className: "bg-[var(--color-glass-medium)] text-text-secondary",
      headline: "Practice paper setup",
      detail: paper.markScheme.notice,
    };
  })();

  const timed = paper.status === "in_progress" && paper.timingMode === "timed";
  const showClock = timed;
  /** Under five minutes is when the clock stops being background information. */
  const runningLow =
    remaining !== null && remaining > 0 && remaining <= 5 * 60 * 1000;
  const clockTone: "normal" | "low" | "overtime" =
    timed && paper.timingState === "overtime"
      ? "overtime"
      : timed && paper.timingState === "running" && runningLow
        ? "low"
        : "normal";
  const clockValue =
    paper.timingState === "paused"
      ? remaining !== null
        ? formatRemaining(remaining)
        : "--:--"
      : paper.timingState === "awaiting_overtime"
        ? "0:00"
        : overtime !== null
          ? `+${formatRemaining(overtime)}`
          : remaining !== null
            ? formatRemaining(remaining)
            : "--:--";
  const clockCaption =
    paper.timingState === "paused"
      ? "Paused"
      : paper.timingState === "awaiting_overtime"
        ? "Time reached"
        : overtime !== null
          ? "Overtime"
          : "Remaining";

  return (
    <>
      <div
        className={`mt-2 rounded-xl border px-3 py-2.5 transition duration-fast ${
          clockTone === "overtime"
            ? "border-warm/45 bg-warm-muted"
            : clockTone === "low"
              ? "border-warning/40 bg-warning-muted"
              : "border-[var(--color-border)] bg-[var(--color-glass-subtle)]"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-2xs font-semibold uppercase tracking-[0.12em] ${statusPill.className}`}
            >
              {statusPill.label}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-text-primary">
                {statusPill.headline}
              </p>
              <p className="mt-0.5 truncate text-2xs text-text-muted">
                {statusPill.detail}
              </p>
            </div>
          </div>

          {/*
            * The clock, at the size the only number that matters should be.
            *
            * It was a line of grey `text-xs` under the title -- smaller than
            * the status text beside it -- which is the wrong way round for
            * somebody sitting a timed paper, where the time left is the whole
            * reason to look at this bar at all. It also now colours the bar,
            * so the last few minutes and overtime are seen without reading.
            */}
          {showClock ? (
            <div className="shrink-0 text-right">
              <div
                className={`text-xl font-semibold leading-none tabular-nums sm:text-2xl ${
                  clockTone === "overtime"
                    ? "text-warm"
                    : clockTone === "low"
                      ? "text-[var(--color-warning-text)]"
                      : "text-text-primary"
                }`}
                role="timer"
                aria-live={clockTone === "normal" ? "off" : "polite"}
              >
                {clockValue}
              </div>
              <div className="mt-1 text-2xs font-medium uppercase tracking-[0.12em] text-text-muted">
                {clockCaption}
              </div>
            </div>
          ) : null}

          {result && paper.status === "marked" ? (
            <div className="flex shrink-0 items-center gap-4">
              {paper.withinTimeResult ? (
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums text-text-secondary">
                    {paper.withinTimeResult.awardedMarks}/
                    {paper.withinTimeResult.totalMarks}
                  </div>
                  <div className="mt-0.5 text-2xs uppercase tracking-[0.12em] text-text-muted">
                    In time
                  </div>
                </div>
              ) : null}
              <div className="text-right">
                <div className="text-xl font-semibold leading-none tabular-nums text-text-primary sm:text-2xl">
                  {result.percentage}%
                </div>
                <div className="mt-1 text-2xs font-medium uppercase tracking-[0.12em] text-text-muted">
                  {result.awardedMarks}/{result.totalMarks}
                  {result.gradeLabel ? ` · ${result.gradeLabel}` : ""}
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {paper.questions.length > 0 && paper.status !== "in_progress" ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setDetailsOpen(true)}>
                Paper details
              </Button>
            ) : null}
            {(paper.status === "ready" || paper.status === "marked") && paper.questions.length > 0 && canTime ? (
              /*
               * Timed or not is decided as the attempt starts. It was fixed when
               * the paper was made, and the choice there was locked until the
               * sources were confirmed -- so it read as "always timed".
               */
              <div role="radiogroup" aria-label="How to sit it" className="flex rounded-full border border-[var(--color-border)] p-0.5 text-xs font-semibold">
                {([
                  ["timed", `Timed · ${paper.durationMinutes} min`],
                  ["untimed", "Untimed"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={nextTiming === value}
                    disabled={busy !== null}
                    onClick={() => setTimingChoice(value)}
                    className={`rounded-full px-3 py-1.5 transition ${
                      nextTiming === value
                        ? "bg-[var(--color-selected-bg)] text-text-primary shadow-e1"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {paper.status === "ready" ? (
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void start()}>
                {busy === "prepare" ? "Preparing..." : busy === "start" ? "Starting..." : paper.origin === "uploaded" && paper.questions.length === 0 ? "Prepare paper" : "Start attempt"}
              </Button>
            ) : null}
            {paper.status === "in_progress" && paper.timingState === "running" ? (
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void pause()}>
                {busy === "pause" ? "Pausing..." : "Pause"}
              </Button>
            ) : null}
            {paper.status === "in_progress" && paper.timingState === "paused" ? (
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void resume()}>
                {busy === "resume" ? "Resuming..." : "Resume"}
              </Button>
            ) : null}
            {paper.status === "in_progress" ? <Button type="button" size="sm" variant="warm" disabled={busy !== null || paper.timingState === "awaiting_overtime"} onClick={() => setConfirmSubmit(true)}>Submit paper</Button> : null}
            {paper.status === "submitted" && (!markingJob || ["failed", "cancelled", "paused"].includes(markingJob.status)) ? <Button type="button" size="sm" disabled={busy !== null} onClick={() => void submitAndMark()}>{busy === "mark" ? "Queuing..." : markingJob ? "Retry marking" : "Mark paper"}</Button> : null}
            {paper.status === "submitted" && markingJob && ["queued", "running"].includes(markingJob.status) ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void cancelMarking()}>Cancel marking</Button>
            ) : null}
            {paper.status === "marked" && result ? (
              <>
                <Button type="button" size="sm" onClick={() => setReportOpen(true)}>View results</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRetake(true)}>Retake</Button>
              </>
            ) : null}
          </div>
        </div>
        {paper.status === "submitted" && markingJob && ["queued", "running", "paused"].includes(markingJob.status) ? (
          <div className="mt-3 border-t border-[var(--color-border)] pt-3">
            <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
              <span>{PRACTICE_PAPER_MARKING_STAGE_LABELS[markingJob.stage]}</span>
              <span className="flex gap-2 tabular-nums">
                <ElapsedTime startedAt={markingJob.createdAt} label="Marking for" />
                <span>{markingJob.progress}%</span>
              </span>
            </div>
            <ProgressBar progress={markingJob.progress} className="mt-2" />
            {markingJob.status === "paused" ? (
              <p className="mt-2 text-xs leading-5 text-text-secondary">
                {markingJob.failureMessage} Retry when you are ready; it will not use another daily mark.
              </p>
            ) : null}
          </div>
        ) : null}
        {feedback ? <div className="mt-2.5"><FeedbackBanner type={feedback.type} message={feedback.message} onDismiss={clear} /></div> : null}
      </div>

      <ConfirmDialog open={confirmSubmit} title="Submit this paper for marking?" description="Your current page will be saved first. Jami stays unavailable until marking finishes." confirmLabel="Submit and mark" busy={busy === "mark"} onConfirm={() => void submitAndMark()} onClose={() => setConfirmSubmit(false)} />
      <ConfirmDialog open={confirmRetake} title="Start a new attempt?" description="Your previous result remains in attempt history. The notebook answer pages will be cleared for the new attempt." confirmLabel="Clear pages and retake" busy={busy === "retake"} onConfirm={() => void retake()} onClose={() => setConfirmRetake(false)} />
      <Dialog
        open={paper.timingState === "awaiting_overtime"}
        dismissible={false}
        className="fixed inset-0 flex items-end justify-center p-4 sm:items-center"
        onDismiss={() => undefined}
      >
        <DialogBackdrop className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
        <DialogPanel role="alertdialog" className="app-panel relative w-full max-w-md rounded-2xl p-6 shadow-e3">
          <DialogTitle className="text-xl font-semibold text-text-primary">Time reached</DialogTitle>
          <DialogDescription className="mt-3 text-sm leading-6 text-text-secondary">
            Your within-time work is saved. Submit it now, or keep writing in clearly logged overtime.
          </DialogDescription>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void submitAndMark()}>
              {busy === "mark" ? "Submitting..." : "Submit now"}
            </Button>
            <Button type="button" disabled={busy !== null} onClick={() => void continueOvertime()}>
              {busy === "overtime" ? "Starting..." : "Continue in overtime"}
            </Button>
          </div>
        </DialogPanel>
      </Dialog>
      <PracticePaperDetailsDialog open={detailsOpen} userId={userId} paper={paper} onClose={() => setDetailsOpen(false)} onChange={replacePaper} />
      <PracticePaperResultsDialog open={reportOpen} userId={userId} paper={paper} onClose={() => setReportOpen(false)} onChange={replacePaper} />
    </>
  );
}
