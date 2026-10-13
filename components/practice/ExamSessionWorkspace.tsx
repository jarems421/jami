"use client";

import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import JamiAssistantDrawer from "@/components/ai/JamiAssistantDrawer";
import AppPage from "@/components/layout/AppPage";
import ExamAnswerPanel from "@/components/practice/ExamAnswerPanel";
import { ExamMarkingFailed, ExamMarkingInProgress } from "@/components/practice/ExamMarkingNotice";
import ExamNotebookSaveCard from "@/components/practice/ExamNotebookSaveCard";
import ExamQuestionAssets from "@/components/practice/ExamQuestionAssets";
import ExamQuestionCard, { ExamSheetQuestionHeader } from "@/components/practice/ExamQuestionCard";
import ExamQuestionMarkReport from "@/components/practice/ExamQuestionMarkReport";
import ExamRetryBrief from "@/components/practice/ExamRetryBrief";
import ExamScratchpad, { type ExamScratchpadHandle } from "@/components/practice/ExamScratchpad";
import ExamSessionComplete from "@/components/practice/ExamSessionComplete";
import ExamSessionQuestionBar from "@/components/practice/ExamSessionQuestionBar";
import { useUser } from "@/components/providers/UserProvider";
import { Button, Card, ConfirmDialog, FeedbackBanner, Skeleton, StudyText } from "@/components/ui";
import { useExamAnswerDrafts } from "@/hooks/useExamAnswerDrafts";
import { useExamNotebookSave } from "@/hooks/useExamNotebookSave";
import { useExamPrintedPages } from "@/hooks/useExamPrintedPages";
import { useExamSession, useExamSessionWatch } from "@/hooks/useExamSession";
import { useExamWorkingDialog } from "@/hooks/useExamWorkingDialog";
import { reportTutorialAction } from "@/lib/onboarding/tutorial";
import {
  examQuestionPartLabel,
  examSessionQuestionRuns,
  examSessionRunAt,
} from "@/lib/practice/exam-question-groups";
import { EXAM_OPERATION_LEASE_MS } from "@/lib/practice/exam-questions";
import { countMarkedExamQuestions, examQuestionAttempts } from "@/lib/practice/exam-session-attempts";
import { requireExamWorkingSnapshot } from "@/lib/practice/exam-working";
import { PRACTICE_TUTOR_QUICK_ACTIONS } from "@/lib/practice/practice-tutor-actions";
import { notifyAllowanceSpent } from "@/services/billing/plan-summary-store";
import {
  deletePastPaperPracticeAnswers,
  finishPastPaperPracticeSession,
  reviewExamAnswer,
  saveExamAnswerDraft,
  submitExamAnswer,
} from "@/services/study/exam-practice";

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

export default function ExamSessionWorkspace({ sessionId }: { sessionId: string }) {
  const { user } = useUser();
  const { data, setData, error, setError, refresh } = useExamSession(sessionId);
  const [index, setIndex] = useState(0);
  const drafts = useExamAnswerDrafts({ sessionId });
  const { flushDrafts, readDraft, handleDraft, noteTyped } = drafts;
  const [submitting, setSubmitting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showWorking, setShowWorking] = useState(false);
  /**
   * What the sheet last reported, and for which attempt.
   *
   * Ink loads after the page mounts, and a question returned to already has
   * ink on it -- treating "not reported yet" as "nothing written" would grey
   * out the mark button on the way back. So an empty sheet is only called
   * empty once that attempt's sheet has said so.
   */
  const [inkReport, setInkReport] = useState<{ attemptId: string; hasInk: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const answerFieldId = useId();
  /** Attempt whose reopened-draft refusal the student has read and closed. */
  const [dismissedFailure, setDismissedFailure] = useState("");
  const scratchpad = useRef<ExamScratchpadHandle | null>(null);
  const workingSheet = useRef<HTMLDivElement | null>(null);
  /** Stable, so the memoised working sheet is not re-rendered for a new function. */
  const handleScratchpad = useCallback((handle: ExamScratchpadHandle | null) => {
    scratchpad.current = handle;
  }, []);
  /** Stable for the same reason, and the point at which the sheet is known. */
  const handleInkChange = useCallback((hasInk: boolean, attemptId: string) => {
    setInkReport((previous) =>
      previous?.attemptId === attemptId && previous.hasInk === hasInk ? previous : { attemptId, hasInk }
    );
  }, []);

  const session = data?.session;
  const questions = useMemo(() => session?.questions ?? [], [session]);
  const question = questions[index];
  const attempts = useMemo(() => data?.attempts ?? [], [data]);
  const { firstAttempt, retryId, retryAttempt, retryOpen, activeAttempt, markedAttempt } = examQuestionAttempts(
    question,
    attempts
  );
  const answering = session?.status === "active" && (!markedAttempt || retryOpen);

  const notebook = useExamNotebookSave({
    userId: user.uid,
    sessionId,
    folderId: session?.folderId,
    originNotebookId: session?.originNotebookId,
    markedAttemptId: markedAttempt?.id,
    onError: setError,
  });

  /**
   * The question's own pages of paper, if ingestion rendered any.
   *
   * This is what decides which of two layouts a question is answered in. With
   * pages, the paper is the page: the question is not a picture in a column
   * beside an empty pad, it is the thing being written on, and the typed
   * answer sits underneath it the way a printed answer line does.
   *
   * Without pages -- a question Jami wrote, or one ingested before the sheet
   * existed -- nothing changes. The old layout is still correct for a question
   * that has no paper, and it is what every session already running is using.
   */
  const printedPages = useExamPrintedPages(question);
  const hasPrintedPages = printedPages.length > 0;
  /**
   * Whether the question is answered on a sheet: its printed page with room to
   * write under it, or -- for a question Jami wrote -- its text at the top of a
   * blank page. Jami's questions used to keep the old column layout with a
   * typed box as the answer, which made them feel like a form next to real
   * papers; on a sheet they are written on the same way, typing optional.
   */
  const hasSheet = hasPrintedPages || question?.origin === "jami_generated";
  /**
   * The questions this session is made of, read back out of its parts.
   *
   * A student asks for two questions and the session stores fourteen parts, so
   * it used to count itself "Question 1 of 14" -- a number nobody chose. The
   * parts have not changed: each is still answered on its own and marked on
   * its own. Only the counting has, so the session says the same thing the
   * setup screen did.
   */
  const runs = useMemo(() => examSessionQuestionRuns(questions), [questions]);
  const { run, runIndex, partIndex } = examSessionRunAt(runs, index);
  /** "(b)" where the paper letters its parts, empty where the question is whole. */
  const partLabel = examQuestionPartLabel(question?.provenance?.questionNumber ?? "");
  const questionNumber = run?.number || String(runIndex + 1);
  /** "3(b)" on a question with parts, "3" on one without. */
  const questionCardLabel = `${questionNumber}${run && run.count > 1 ? partLabel : ""}`;

  const activeAttemptId = activeAttempt?.id ?? "";
  const storedAnswer = activeAttempt?.answerText ?? "";
  const inkKnown = inkReport?.attemptId === activeAttemptId;
  const hasInk = inkKnown && inkReport.hasInk;
  const hasTypedText = drafts.hasTypedText(activeAttemptId, storedAnswer);
  /** Nothing written anywhere. Only true once the sheet has actually been read. */
  const nothingToSend = inkKnown && !hasInk && !hasTypedText;
  const questionId = question?.id ?? "";
  const assetPath = useCallback(
    (assetId: string) =>
      `/api/practice/exam-sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(questionId)}/${encodeURIComponent(assetId)}`,
    [questionId, sessionId]
  );
  /**
   * Whether the working is covering the screen as its own dialog.
   *
   * Only ever for a question with no paper of its own. A sheet is the
   * question, so it is never something to open over the question.
   */
  const workingOpen = showWorking && !hasSheet;
  useExamWorkingDialog({ open: workingOpen, sheetRef: workingSheet });
  const isLast = index === questions.length - 1;

  /** Something is being worked on server-side, so the page keeps watching. */
  const pendingStatus =
    activeAttempt && (activeAttempt.status === "marking" || activeAttempt.reviewStatus === "reviewing")
      ? `${activeAttempt.id}:${activeAttempt.status}:${activeAttempt.reviewStatus ?? ""}`
      : null;
  const now = useExamSessionWatch({ pending: pendingStatus, refresh });
  /*
   * The lease is generous because the job's deadline is: each completed
   * marker report touches the attempt, so a marking still working through its
   * stages keeps showing progress rather than ageing towards being stranded.
   */
  const markingStale =
    activeAttempt?.status === "marking" && now - (activeAttempt.updatedAt ?? 0) > EXAM_OPERATION_LEASE_MS;

  const { forgetSaved } = notebook;
  const goTo = useCallback(
    (next: number) => {
      void flushDrafts();
      setShowWorking(false);
      forgetSaved();
      setError("");
      setIndex(next);
    },
    [flushDrafts, forgetSaved, setError]
  );

  const submit = async () => {
    if (!question || !activeAttempt) return;
    await flushDrafts();
    setSubmitting(true);
    setError("");
    try {
      const working = await requireExamWorkingSnapshot(activeAttempt, scratchpad.current);
      const response = await submitExamAnswer({
        sessionId,
        questionId: question.id,
        attemptNumber: activeAttempt.attemptNumber,
        // The latest draft if one was typed, else what is stored.
        answerText: readDraft(activeAttempt.id) ?? activeAttempt.answerText ?? "",
        workingSnapshot: working?.png,
      });
      setData((current) =>
        current
          ? {
              ...current,
              attempts: [response.attempt, ...current.attempts.filter((item) => item.id !== response.attempt.id)],
            }
          : current
      );
      if (response.attempt.status === "marked") reportTutorialAction("mark-exam-answer");
      notifyAllowanceSpent();
    } catch (reason) {
      setError(errorMessage(reason, "Jami couldn't mark this one — your answer is saved."));
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const review = async () => {
    if (!question) return;
    setReviewing(true);
    setError("");
    try {
      await reviewExamAnswer(sessionId, question.id);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, "Jami couldn't check this mark just now."));
    } finally {
      setReviewing(false);
    }
  };

  const beginRetry = async () => {
    if (!retryId) return;
    setError("");
    try {
      await saveExamAnswerDraft(sessionId, retryId, "");
      noteTyped(retryId, "");
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, "The retry could not be opened."));
    }
  };

  const finish = async () => {
    void flushDrafts();
    setFinishing(true);
    setError("");
    try {
      await finishPastPaperPracticeSession(sessionId);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, "This session could not be finished."));
    } finally {
      setFinishing(false);
    }
  };

  const removeAnswers = async () => {
    setDeleting(true);
    setError("");
    try {
      await deletePastPaperPracticeAnswers(sessionId);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, "Your stored answers could not be deleted."));
    } finally {
      setDeleting(false);
    }
  };

  if (!data || !session || !question) {
    return (
      <AppPage title="Past Paper Practice" backHref="/dashboard/practice" backLabel="Practice" width="study">
        {error ? (
          <FeedbackBanner type="error" message={error} onDismiss={() => setError("")} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-[34rem]" />
            <Skeleton className="h-[34rem]" />
          </div>
        )}
      </AppPage>
    );
  }

  /*
   * The report leads with the mark and carries the question inside it, so the
   * question card above is only drawn for the states that are still about
   * answering it.
   */
  const showReport = Boolean(markedAttempt) && !answering && !(activeAttempt?.status === "marking" && !submitting);

  return (
    <AppPage
      // A practice set is named for what it practises; a past-paper session for its subject.
      title={session.practiceSet?.title ?? session.subject}
      backHref="/dashboard/practice"
      backLabel="Practice"
      width="study"
    >
      <div className="space-y-4">
        {error ? <FeedbackBanner type="error" message={error} onDismiss={() => setError("")} /> : null}
        {/*
          * An answer the server refused to send, handed back for editing.
          *
          * This used to be a 413 on the submit request, which the page turned
          * into a banner. The submit request no longer knows: it returns while
          * the marking is still queued, and the refusal happens later against
          * an attempt that has been reopened as a draft. So the banner is
          * driven by the attempt instead of by a response.
          */}
        {!error &&
        activeAttempt?.status === "draft" &&
        activeAttempt.markingFailure &&
        dismissedFailure !== activeAttempt.id ? (
          <FeedbackBanner
            type="error"
            message={activeAttempt.markingFailure.message}
            onDismiss={() => setDismissedFailure(activeAttempt.id)}
          />
        ) : null}

        {session.status === "completed" ? <ExamSessionComplete session={session} /> : null}

        <ExamSessionQuestionBar
          runs={runs}
          parts={questions}
          attempts={attempts}
          index={index}
          markedCount={countMarkedExamQuestions(runs, questions, attempts)}
          canFinish={session.status === "active"}
          finishing={finishing}
          onGoTo={goTo}
          onFinish={() => void finish()}
        />

        {/*
          * Two columns only while there is a second thing to put in one.
          * After marking the working pane is gone, and the grid kept its
          * shape -- so the report was squeezed into nine-tenths of a column
          * with an empty half of the screen beside it.
          */}
        {showReport && markedAttempt ? (
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <ExamQuestionMarkReport
              attempt={markedAttempt}
              firstAttempt={firstAttempt}
              sessionId={sessionId}
              question={
                <ExamQuestionCard sessionId={sessionId} question={question} label={questionCardLabel} collapsible />
              }
              reviewing={reviewing}
              nextLabel={isLast ? "Finish session" : "Next question"}
              onNext={() => (isLast ? void finish() : goTo(index + 1))}
              onRetry={
                session.status === "active" && markedAttempt.attemptNumber === 1 && !retryAttempt
                  ? () => void beginRetry()
                  : undefined
              }
              /*
               * The independent check is of the official first-attempt
               * mark, and the route reads that attempt whichever one is on
               * screen. Tying the button to the displayed attempt meant a
               * retry silently consumed an unused check.
               */
              onReview={firstAttempt?.status === "marked" && !firstAttempt.reviewUsed ? () => void review() : undefined}
              onAsk={() => setAssistantOpen(true)}
            />
            {notebook.choices.length > 0 ? (
              <ExamNotebookSaveCard
                choices={notebook.choices}
                notebookId={notebook.notebookId}
                onPick={notebook.pickNotebook}
                saving={notebook.saving}
                saved={Boolean(notebook.savedNotebookId)}
                onSave={() => void notebook.save()}
              />
            ) : null}
          </div>
        ) : (
          /*
           * The question, in full, on the left; one answer sheet on the right,
           * the paper being written on with the optional typed answer folded
           * away beneath it. Everything that gets marked is in one place beside
           * the question it answers.
           *
           * Side by side only on a wide screen held landscape, with the sheet
           * given the larger share: an even split left an iPad a page of working
           * barely wider than a phone's. Held upright -- a portrait iPad, even a
           * 13-inch one at exactly `lg` -- the two stack and the sheet takes the
           * full width.
           */
          <div
            className={`grid items-start gap-4 lg:gap-6 ${
              answering && hasSheet
                ? "mx-auto w-full max-w-5xl"
                : answering
                  ? "lg:landscape:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] 2xl:landscape:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"
                  : "mx-auto w-full max-w-3xl"
            }`}
          >
            {answering && hasSheet ? null : (
              <div
                data-behind-working
                className={`min-w-0 ${
                  answering
                    ? "lg:landscape:sticky lg:landscape:top-[8.5rem] lg:landscape:max-h-[calc(100dvh-10rem)] lg:landscape:overflow-y-auto lg:landscape:rounded-2xl"
                    : ""
                }`}
              >
                <ExamQuestionCard sessionId={sessionId} question={question} label={questionCardLabel} />
              </div>
            )}

            <div className="min-w-0 space-y-4">
              <div data-behind-working className="space-y-4 empty:hidden">
                {session.status === "completed" && !markedAttempt ? (
                  <Card padding="md">
                    <h3 className="text-base font-semibold text-text-primary">Not answered</h3>
                    <p className="mt-2 text-sm text-text-muted">This question counted as zero when the session was finished.</p>
                  </Card>
                ) : activeAttempt?.status === "marking" && !submitting ? (
                  <ExamMarkingInProgress
                    attempt={activeAttempt}
                    sessionId={sessionId}
                    stale={markingStale}
                    submitting={submitting}
                    onMarkAgain={() => void submit()}
                  />
                ) : answering && activeAttempt?.status === "marking_failed" ? (
                  <ExamMarkingFailed
                    attempt={activeAttempt}
                    sessionId={sessionId}
                    submitting={submitting}
                    onRetry={() => void submit()}
                  />
                ) : answering && retryOpen && firstAttempt?.result ? (
                  <ExamRetryBrief
                    firstAttempt={firstAttempt}
                    result={firstAttempt.result}
                    sessionId={sessionId}
                    onAsk={() => setAssistantOpen(true)}
                  />
                ) : null}
              </div>

              {answering && activeAttempt ? (
                <section aria-label="Answer sheet" className={`app-panel min-w-0 ${hasSheet ? "" : "overflow-hidden"}`}>
                  {/*
                    * The panel is not clipped while there is paper in it: the
                    * working sheet pins its tool pill to the top as the page
                    * scrolls, and a clipped ancestor is a scrollport that never
                    * scrolls, so the pill would simply sit where it started. With
                    * no paper the panel opens on a filled header instead, which
                    * does need the rounded corner cut.
                    */}
                  {hasSheet ? (
                    <ExamSheetQuestionHeader
                      question={question}
                      questionNumber={questionNumber}
                      part={run && run.count > 1 ? { label: partLabel, index: partIndex, count: run.count } : null}
                    />
                  ) : null}
                  {hasSheet && !hasPrintedPages ? (
                    <div className="border-b border-[var(--color-border)] px-4 py-5 sm:px-6">
                      <StudyText
                        as="div"
                        text={question.prompt}
                        className="whitespace-pre-wrap text-base leading-8 text-text-primary sm:text-lg"
                      />
                      <ExamQuestionAssets sessionId={sessionId} questionId={question.id} assets={question.assets} />
                    </div>
                  ) : null}

                  {/*
                    * A dialog by hand, deliberately.
                    *
                    * The shared Dialog renders its children only while open, and the
                    * pad has to stay mounted whether or not the sheet is: it holds the
                    * handle submission asks for, so on a phone a student who never
                    * opened working could not submit at all. So the sheet keeps its
                    * one mount point and takes on the dialog's obligations instead --
                    * a labelled modal role, focus moved in and restored on close,
                    * Escape, and the rest of the page hidden from assistive
                    * technology while it covers the screen.
                    *
                    * None of that applies to a question with its own paper. There the
                    * sheet is the question, it is on the page at every width, and the
                    * way to write on it at full size is the control the sheet already
                    * carries.
                    */}
                  <div
                    ref={workingSheet}
                    {...(workingOpen
                      ? {
                          role: "dialog" as const,
                          "aria-modal": true,
                          "aria-label": "Your working",
                          onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
                            if (event.key !== "Escape") return;
                            event.stopPropagation();
                            setShowWorking(false);
                          },
                        }
                      : {})}
                    className={
                      hasSheet
                        ? "min-w-0"
                        : `${
                            workingOpen
                              ? "fixed inset-0 z-50 overflow-y-auto bg-[var(--app-background)] p-3 pb-[env(safe-area-inset-bottom)]"
                              : "hidden md:block"
                          } md:static md:block md:overflow-visible md:bg-transparent md:p-0`
                    }
                  >
                    <div className={workingOpen ? "app-panel" : ""}>
                      {hasSheet ? null : (
                        <div
                          className={`flex items-center justify-between gap-3 bg-[var(--color-glass-subtle)] px-4 py-2.5 sm:px-5 ${
                            activeAttempt.status === "draft" && !workingOpen ? "border-t border-[var(--color-border)]" : ""
                          }`}
                        >
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h2 className="text-sm font-semibold text-text-primary">Working</h2>
                            <p className="truncate text-xs text-text-muted">
                              {activeAttempt.status !== "draft"
                                ? "As it was sent"
                                : hasInk
                                  ? "Sent with your answer"
                                  : "Optional"}
                            </p>
                          </div>
                          <Button type="button" size="sm" variant="ghost" className="md:hidden" onClick={() => setShowWorking(false)}>
                            Done
                          </Button>
                        </div>
                      )}
                      <ExamScratchpad
                        key={activeAttempt.id}
                        embedded
                        userId={user.uid}
                        attemptId={activeAttempt.id}
                        printedPages={printedPages}
                        answerSpacePages={question.answerSpacePages}
                        questionLabel={question.label}
                        assetPath={assetPath}
                        // Read-only the moment the attempt stops being a draft: the
                        // sheet is then frozen evidence, and the rules refuse writes.
                        disabled={submitting || activeAttempt.status !== "draft"}
                        onHandle={handleScratchpad}
                        onInkChange={handleInkChange}
                      />
                    </div>
                  </div>

                  {activeAttempt.status === "draft" ? (
                    <ExamAnswerPanel
                      fieldId={answerFieldId}
                      attemptId={activeAttempt.id}
                      prompt={question.prompt}
                      storedText={activeAttempt.answerText ?? ""}
                      onSheet={hasSheet}
                      hasPrintedPages={hasPrintedPages}
                      retrying={retryOpen}
                      hasTypedText={hasTypedText}
                      hasInk={hasInk}
                      nothingToSend={nothingToSend}
                      submitting={submitting}
                      saveState={drafts.saveState}
                      readDraft={readDraft}
                      onDraft={handleDraft}
                      onShowWorking={() => setShowWorking(true)}
                      onSubmit={() => void submit()}
                    />
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>
        )}

        {session.status === "completed" ? (
          <div className="flex justify-center border-t border-[var(--color-border)] pt-4 sm:justify-end">
            <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmDelete(true)}>
              Delete my answers
            </Button>
          </div>
        ) : null}

        <ConfirmDialog
          open={confirmDelete}
          title="Delete answers and working?"
          description="This removes the typed answers and frozen working from this Practice session. Marks stay in your history, and notebook copies are unchanged."
          confirmLabel="Delete my answers"
          busy={deleting}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void removeAnswers().finally(() => setConfirmDelete(false))}
        />

        {markedAttempt ? (
          <JamiAssistantDrawer
            userId={user.uid}
            open={assistantOpen}
            onOpenChange={setAssistantOpen}
            resetKey={`practice:${session.id}:${markedAttempt.id}`}
            contextKey={`practice:${session.id}:${markedAttempt.id}`}
            contextLabel="Marked practice answer"
            historyContextLabel={`${session.subject} · ${question.label}`}
            getContext={() => ({
              surface: "practice" as const,
              sessionId: session.id,
              attemptId: markedAttempt.id,
            })}
            quickActions={PRACTICE_TUTOR_QUICK_ACTIONS}
            emptyStateNote="Jami can discuss this question only after it has been marked."
            settingsFolderIds={[session.folderId]}
          />
        ) : null}
      </div>
    </AppPage>
  );
}
