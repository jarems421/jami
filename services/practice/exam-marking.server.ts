import "server-only";
import { loadQuestionTypeRules } from "@/services/practice/question-type-rules.server";
import { failedMarkingExecution } from "@/lib/practice/marking-execution-audit";

import { FieldValue } from "firebase-admin/firestore";
import { start } from "workflow/api";
import { getAiInputTokenCap } from "@/lib/ai/budgets";
import { getAiTokenCap, refundAiBudget } from "@/services/ai/budgets";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import { getAdminDb, getAdminStorageBucket } from "@/services/firebase/admin";
import { featureFlags } from "@/lib/app/feature-flags";
import {
  examAnswerUnlocksModelAnswer,
  examDocument,
  examResultForAttempt,
  examSessionQualification,
  withCriterionTariffs,
  type ExamAttempt,
  type ExamSession,
} from "@/lib/practice/exam-questions";
import {
  examMarkingFailure,
  type ExamMarkingFailureCode,
} from "@/lib/practice/exam-marking-failure";
import {
  EXAM_MARKING_STAGES,
  markerStageBudgetMs,
  type PracticePaperMarkerStage,
  type PracticePaperMarkerStageResult,
} from "@/lib/practice/marker-stages";
import { schemeCriteria } from "@/lib/practice/mark-schemes";
import {
  buildSingleQuestionAnswerParts,
  buildSingleQuestionPaper,
} from "@/lib/practice/single-question-paper";
import { markSingleQuestionAdaptively } from "@/services/ai/practice-paper-marking.server";
import { recordExamDifficultyContribution } from "@/services/practice/exam-difficulty.server";
import { countMarkedAnswersTowardGoals } from "@/services/study/goal-progress.server";
import {
  examQuestionVisualParts,
  loadExamQuestionSecret,
  loadServableExamQuestion,
} from "@/services/practice/exam-evidence.server";
import { markExamQuestionWorkflow } from "@/workflows/exam-question-marking";

/**
 * Marking one exam question, off the request that asked for it.
 *
 * It used to run inside the submit route, which had 60 seconds to live and so
 * gave the marking 55. That is not a marking budget: a marking is up to three
 * sequential provider calls, and the measurements in the marker size a single
 * supervisor report at 408 seconds. The route squeezed it into 30 and the
 * stage that overran was always the adjudicator -- the one bought precisely
 * because two markers had disagreed, so the pipeline failed hardest on the
 * answers that most needed it, having already paid for both reports.
 *
 * So the request now freezes the evidence and returns, and a durable job does
 * the marking against a deadline chosen for marking rather than for a
 * serverless function. The student's page already polled a `marking` attempt
 * with backoff, so what they see is unchanged apart from taking as long as it
 * genuinely takes.
 */

type AttemptRefs = {
  attemptRef: FirebaseFirestore.DocumentReference;
  sessionRef: FirebaseFirestore.DocumentReference;
  attempt: ExamAttempt;
  session: ExamSession;
};

function refsFor(uid: string, attemptId: string) {
  const userRef = getAdminDb().collection("users").doc(uid);
  return {
    userRef,
    attemptRef: userRef.collection("examAttempts").doc(attemptId),
  };
}

async function loadAttempt(uid: string, attemptId: string): Promise<AttemptRefs | null> {
  const { userRef, attemptRef } = refsFor(uid, attemptId);
  const attempt = (await attemptRef.get()).data() as ExamAttempt | undefined;
  if (!attempt) return null;
  const sessionRef = userRef.collection("examSessions").doc(attempt.sessionId);
  const session = (await sessionRef.get()).data() as ExamSession | undefined;
  if (!session) return null;
  return { attemptRef, sessionRef, attempt, session };
}

/**
 * Whether this marking still has anything to deliver to.
 *
 * Checked before the provider calls and again before the write, because a
 * student can finish the session or delete their answers while a job is in
 * flight -- which is the whole point of the job not blocking them.
 *
 * The token is what makes it *this* marking rather than any marking. A student
 * whose mark failed can resubmit, and the attempt is back at `marking` within
 * seconds -- a different job, over different evidence, on the same document.
 * With no identity to check, the superseded job would mark the old answer and
 * write its result over the new one, and its checkpoints would be handed to a
 * marking of work it never saw.
 */
function markingIsSuperseded({ attempt, session }: Pick<AttemptRefs, "attempt" | "session">, token: string) {
  return (
    attempt.status !== "marking" ||
    attempt.marking?.token !== token ||
    Boolean(attempt.answerDeletedAt) ||
    Boolean(session.answersDeletedAt) ||
    session.status !== "active"
  );
}

/** Queued by the submit route once the evidence is frozen. */
export async function enqueueExamQuestionMarking(uid: string, attemptId: string, token: string) {
  const { attemptRef } = refsFor(uid, attemptId);
  try {
    const run = await start(markExamQuestionWorkflow, [uid, attemptId, token]);
    await getAdminDb().runTransaction(async (transaction) => {
      const attempt = (await transaction.get(attemptRef)).data() as ExamAttempt | undefined;
      if (attempt?.status !== "marking" || attempt.marking?.token !== token) return;
      transaction.update(attemptRef, { "marking.runId": run.runId, updatedAt: Date.now() });
    });
    return true;
  } catch {
    /*
     * A job that never started will never write its own failure, so the
     * attempt is settled here instead of being left reading `marking` until
     * its lease runs out.
     */
    await failExamQuestionMarking(uid, attemptId, "marking_failed", token);
    return false;
  }
}

/**
 * Stage checkpoints, written as each provider call comes back.
 *
 * Field-merged rather than written whole: the job is one of several things
 * touching this document, and a background job replacing it is how a student's
 * later edit disappears. Refused outright once the token has moved on, so a
 * superseded job cannot leave a report of the old answer where a marking of
 * the new one would pick it up.
 */
async function saveStage(
  uid: string,
  attemptId: string,
  token: string,
  stage: PracticePaperMarkerStage,
  result: PracticePaperMarkerStageResult
) {
  const db = getAdminDb();
  const { attemptRef } = refsFor(uid, attemptId);
  await db.runTransaction(async (transaction) => {
    const attempt = (await transaction.get(attemptRef)).data() as ExamAttempt | undefined;
    if (attempt?.marking?.token !== token || attempt.status !== "marking" || attempt.answerDeletedAt) return;
    transaction.update(attemptRef, {
    [`marking.stages.${stage}`]: examDocument(result),
      // Doubles as the job's heartbeat: an attempt whose stages are still
      // arriving is plainly not stranded.
      updatedAt: Date.now(),
    });
  });
}

function failureCodeFor(reason: string): ExamMarkingFailureCode {
  if (reason === "input_too_large") return "input_too_large";
  if (reason === "question_changed") return "question_changed";
  return "marking_failed";
}

/**
 * Settle an attempt that produced no mark.
 *
 * An oversized request is the one failure the student can act on, and the only
 * one that never reached a provider -- it is refused while assembling. So the
 * attempt goes back to being a draft rather than frozen evidence: retrying
 * identical evidence would fail identically for ever, and telling someone to
 * shorten an answer the server will not let them touch is worse than saying
 * nothing.
 */
export async function failExamQuestionMarking(
  uid: string,
  attemptId: string,
  code: ExamMarkingFailureCode,
  token: string,
  error?: unknown
) {
  const db = getAdminDb();
  const { attemptRef } = refsFor(uid, attemptId);
  const grant = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(attemptRef);
    const attempt = snapshot.data() as ExamAttempt | undefined;
    if (!attempt || attempt.status !== "marking") return undefined;
    // A superseded job does not get to fail the marking that replaced it.
    if (attempt.marking?.token !== token) return undefined;
    const budgetGrant = attempt.marking?.budgetGrant;
    transaction.update(attemptRef, {
      status: code === "input_too_large" ? "draft" : "marking_failed",
      markingFailure: examMarkingFailure(code, Date.now()),
      [`executionAudit.${token}`]: { ...failedMarkingExecution(error), recordedAt: Date.now() },
      // Keep paid stages for the same frozen evidence; discard only the refunded grant.
      ...(code === "input_too_large" ? { marking: FieldValue.delete() } : {
        "marking.budgetGrant": FieldValue.delete(),
      }),
      updatedAt: Date.now(),
    });
    return budgetGrant;
  });
  // The allowance, not the money: a call the provider answered was paid for
  // whatever this does.
  if (grant) await refundAiBudget(grant).catch(() => undefined);
}

export async function runExamQuestionMarking(uid: string, attemptId: string, token: string) {
  if (!featureFlags.enablePastPaperPractice) return "cancelled" as const;
  const db = getAdminDb();
  const loaded = await loadAttempt(uid, attemptId);
  if (!loaded) return "cancelled" as const;
  const { attemptRef, sessionRef, attempt, session } = loaded;
  // Judged on the documents just read, rather than by reading both again.
  if (markingIsSuperseded(loaded, token)) return "cancelled" as const;

  const question = session.questions.find((item) => item.id === attempt.questionId);
  if (!question) return "cancelled" as const;
  const job = attempt.marking;
  /*
   * A resumed job gets time for the work it has left, not the clock it was
   * given first.
   *
   * `deadlineAt` is an absolute timestamp, so inheriting it meant a retry of a
   * marking that died near its deadline began with no budget at all and could
   * never finish. Retries are now the expected path rather than the unlucky
   * one -- failure keeps the stages it paid for -- so the budget is recomputed
   * from the stages still missing, and the stored deadline is honoured only
   * while it still leaves room for them.
   */
  const remaining = markerStageBudgetMs(EXAM_MARKING_STAGES, job?.stages);
  const deadlineAt = Math.max(job?.deadlineAt ?? 0, Date.now() + remaining);

  enterAiSpendContext(aiSpendContextFor(uid, "examQuestionMarking"));
  try {
    const [bankQuestion, secret] = await Promise.all([
      // Both halves from the same ingest: the wording and images the session
      // started on, and the scheme written for exactly those.
      loadServableExamQuestion(attempt.questionId, uid, question.contentVersion),
      loadExamQuestionSecret(attempt.questionId, uid, question.contentVersion),
    ]);
    if (secret.markSchemeItem.maxMarks !== question.marks || secret.questionId !== attempt.questionId) {
      throw new Error("scheme_mismatch");
    }
    const paper = buildSingleQuestionPaper({
      id: `exam-${attemptId}`, folderId: session.folderId, title: `${session.subject} ${question.label}`,
      question: { id: question.id, label: question.label, prompt: question.prompt, marks: question.marks, assets: question.assets },
      markSchemeItem: secret.markSchemeItem, studyLevel: session.studyLevel, qualification: examSessionQualification(session),
      awardingBody: question.provenance.boardLabel, specification: question.provenance.specificationTitle,
      component: question.provenance.componentTitle, markSchemeKind: question.origin === "jami_generated" ? "generated" : "official",
    });
    // Independent reads, so the student waits for the slowest rather than the sum.
    const [originalPaperParts, bytes, examinerPracticeRules] = await Promise.all([
      examQuestionVisualParts(bankQuestion),
      attempt.workingSnapshotPath
        ? getAdminStorageBucket().file(attempt.workingSnapshotPath).download().then(([data]) => data)
        : Promise.resolve(undefined),
      loadQuestionTypeRules(paper.assessmentProfile, paper.title),
    ]);
    const answerParts = buildSingleQuestionAnswerParts({
      questionId: attempt.questionId, answerText: attempt.answerText,
      ...(bankQuestion.separateAwardMarks ? { separateAwardMarks: bankQuestion.separateAwardMarks } : {}),
      workingImage: bytes ? { inlineData: { mimeType: "image/png", data: bytes.toString("base64") } } : undefined,
    });
    const marked = await markSingleQuestionAdaptively({
      paper, answerParts, originalPaperParts, examinerPracticeRules,
      maxOutputTokens: getAiTokenCap("examQuestionMarking"),
      inputTokenCap: getAiInputTokenCap("examQuestionMarking"),
      deadlineAt,
      cachedStageResults: job?.stages,
      onStageResult: (stage, result) => saveStage(uid, attemptId, token, stage, result),
      /*
       * Every answer is marked and then checked. Not sometimes.
       *
       * This used to consult `examMarkingNeedsVerification`, which bought a
       * second marker only at six marks, on a judgement-based regime, or at
       * four marks with handwriting -- so a three-mark "solve for x" was one
       * model's unchecked opinion. That was never the product decision; it
       * arrived as an optimisation and the original plan had said to cut it.
       *
       * A 37-record benchmark then measured what it cost. Two thirds of marks
       * went unchecked, and the marker sat 2.7x further from the examiners'
       * consensus than the examiners sat from it themselves -- a variance
       * failure, which is exactly what a second opinion is for. Against that,
       * checking everything adds 12%: the verifier is the cheap model, at
       * $0.0013 a call against the primary's $0.0061.
       *
       * It is also faster. Forced verification runs the two markers in
       * parallel; the conditional post-check it replaces ran them in sequence,
       * so the path that skipped the check was slower whenever it changed its
       * mind.
       */
      forceVerification: true,
    });
    if (!marked.result.questionResults[0]) throw new Error("missing_question_result");
    // The scheme is in hand here and nowhere downstream, so each criterion
    // takes its tariff with it.
    const result = examResultForAttempt(
      withCriterionTariffs(marked.result.questionResults[0], schemeCriteria(secret.markSchemeItem))
    );
    const written = await db.runTransaction(async (transaction) => {
      const [current, currentSession] = await Promise.all([
        transaction.get(attemptRef), transaction.get(sessionRef),
      ]);
      const now = current.data() as ExamAttempt | undefined;
      if (
        now?.status !== "marking" ||
        now.marking?.token !== token ||
        currentSession.data()?.status !== "active" ||
        now.answerDeletedAt ||
        currentSession.data()?.answersDeletedAt
      ) {
        return false;
      }
      transaction.update(attemptRef, examDocument({
        status: "marked", result,
        officialMarkScheme: examAnswerUnlocksModelAnswer(result) ? secret.officialMarkScheme : null,
        audit: { ...marked.audit, studentReviewed: false },
        [`executionAudit.${token}`]: {
          status: "complete", costAccounting: marked.costAccounting,
          models: marked.models, recordedAt: Date.now(),
        },
        markedAt: Date.now(), updatedAt: Date.now(),
      }));
      transaction.update(attemptRef, { marking: FieldValue.delete(), markingFailure: FieldValue.delete() });
      if (attempt.attemptNumber === 1) transaction.update(sessionRef, {
        answeredCount: (currentSession.data()?.answeredCount ?? 0) + 1,
        awardedTotal: (currentSession.data()?.awardedTotal ?? 0) + result.awardedMarks,
        // What has actually been marked, so a session in progress is scored
        // against the questions answered rather than the whole paper.
        assessedTotal: (currentSession.data()?.assessedTotal ?? 0) + result.maxMarks,
        updatedAt: Date.now(),
      });
      return true;
    });
    /*
     * A mark nobody is waiting for is not written back. The student finished
     * the session, deleted their answers, or resubmitted while this ran, and
     * whichever it was is more recent than this result.
     */
    if (!written) return "cancelled" as const;
    if (attempt.attemptNumber === 1 && result.attempted) {
      await recordExamDifficultyContribution({
        uid, attemptId, questionId: attempt.questionId, studyLevel: session.studyLevel,
        fraction: result.awardedMarks / question.marks,
        durationMs: Math.max(0, (attempt.submittedAt ?? Date.now()) - attempt.startedAt),
      });
      // A first answer, marked and not blank: what a practice-question goal counts.
      await countMarkedAnswersTowardGoals({
        uid,
        receiptId: `exam:${attemptId}`,
        folderId: session.folderId,
        scores: [result.maxMarks > 0 ? result.awardedMarks / result.maxMarks : 0],
        at: Date.now(),
      });
    }
    return "marked" as const;
  } catch (error) {
    await failExamQuestionMarking(
      uid,
      attemptId,
      failureCodeFor(error instanceof Error ? error.message : ""),
      token,
      error
    );
    return "failed" as const;
  }
}
