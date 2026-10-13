import "server-only";

import { buildNotebookPayload } from "@/lib/workspace/notebooks";
import { buildNotebookPagePayload } from "@/lib/workspace/notebook-page-writes";
import { buildPracticePaperPayload } from "@/lib/practice/practice-papers";
import { practiceToStore } from "@/lib/learning/interventions/practice-store";
import type { PracticeQuestionDraft } from "@/lib/learning/interventions/practice-request";
import { practicePaperSecretRef } from "@/services/ai/practice-paper-secrets.server";
import { getAdminDb } from "@/services/firebase/admin";

/**
 * Storing questions Jami wrote, once the student has agreed to them.
 *
 * On the server, and it has to be. A practice paper is not an ordinary
 * document the owner may write: the rules let a browser create only an
 * *uploaded* paper with no questions and no marks, because "no assessment
 * definition, answer-bearing guide, result or timing transition" may originate
 * there. A first attempt at this wrote the paper straight from the browser and
 * would have been refused for every student, on four counts at once.
 *
 * The answer-bearing half is split off for the same reason. `pastPapers` is
 * the public projection -- readable by the student, and readable *only* while
 * its mark scheme carries no items -- so the real scheme lives in
 * `practicePaperSecrets`, which no client can read at all. Writing the paper
 * without that split does not fail loudly: `buildPracticePaperPayload` strips
 * the scheme on its way out, so the questions would simply arrive unmarkable.
 *
 * This is the same shape the ordinary paper-generation workflow writes, on
 * purpose. A question from a recommendation is then sat, marked and turned
 * into evidence by exactly the same code as any other.
 */

export type StoredInterventionPractice = { notebookId: string };

export async function storeInterventionPractice(input: {
  uid: string;
  folderId: string;
  conceptId: string;
  conceptLabel: string;
  interventionId: string;
  questions: readonly PracticeQuestionDraft[];
}): Promise<StoredInterventionPractice> {
  const { questions, markScheme } = practiceToStore(input.questions, {
    conceptId: input.conceptId,
    interventionId: input.interventionId,
  });

  const db = getAdminDb();
  const userRef = db.collection("users").doc(input.uid);
  // One id for the notebook, the paper and the secret: the paper is the
  // notebook, everywhere else in the app.
  const paperId = userRef.collection("pastPapers").doc().id;
  const now = Date.now();
  const title = input.conceptLabel;

  const batch = db.batch();

  batch.set(
    userRef.collection("notebooks").doc(paperId),
    buildNotebookPayload({
      folderId: input.folderId,
      title,
      type: "practice_paper",
      /*
       * No Topics. The concept is a specification concept, not one of the
       * student's Topics, and filed here it read as a Topic nobody had made.
       * Each page links to its question, which carries the concept, and that
       * is how the page is placed (`resolveNotebookPageLearningContext`).
       */
      topicIds: [],
      sourceIds: [],
      pastPaperId: paperId,
      color: "violet",
      icon: "notebook",
      pageColor: "white",
      pageStyle: "plain",
      now,
    })
  );

  // A page per question, which is what the student actually writes on.
  questions.forEach((question, index) => {
    const safeQuestionId = question.id.replace(/[^A-Za-z0-9_-]/g, "-");
    batch.set(
      userRef.collection("notebookPages").doc(`${paperId}_${safeQuestionId}`.slice(0, 1_400)),
      buildNotebookPagePayload({
        notebookId: paperId,
        folderId: input.folderId,
        pageNumber: index + 1,
        title: question.label,
        pageType: "question",
        pageColor: "white",
        pageStyle: "plain",
        status: "blank",
        questionPrompt: `${question.prompt}\n\n[${question.marks} ${
          question.marks === 1 ? "mark" : "marks"
        }]`,
        questionAssets: question.assets,
        linkedQuestionId: question.id,
        linkedPastPaperId: paperId,
        now,
      })
    );
  });

  batch.set(
    userRef.collection("pastPapers").doc(paperId),
    buildPracticePaperPayload({
      notebookId: paperId,
      folderId: input.folderId,
      title,
      origin: "generated",
      status: "ready",
      sourceIds: [],
      sourceLabels: [],
      request: `Targeted practice on ${title}`,
      coverage: title,
      length: "full",
      focus: "weak_areas",
      /*
       * Untimed, because this is targeted revision on one concept rather than
       * a mock: a clock on five questions about completing the square would be
       * theatre.
       */
      durationMinutes: 0,
      timingMode: "untimed",
      timingState: "not_started",
      totalPausedMs: 0,
      deadlineVersion: 0,
      tutorEnabled: true,
      tutorUsed: false,
      timerEnabled: false,
      instructions: [],
      /*
       * What this paper honestly is, rather than an inferred exam profile.
       * Confidence is low on purpose: these were written for one concept on a
       * published specification, which is not the same as knowing the format
       * of the paper the student will actually sit.
       */
      assessmentProfile: {
        studyLevel: "",
        qualificationOrModule: "",
        awardingBodyOrInstitution: "",
        specificationOrCourse: "",
        tierOrComponent: "",
        formatSummary: `Targeted practice on ${title}`,
        confidence: "low",
      },
      questions,
      choiceGroups: [],
      totalMarks: questions.reduce((sum, question) => sum + question.marks, 0),
      // Stripped to its public projection on the way in; the real one is below.
      markScheme: {
        kind: "generated",
        label: "Jami-written marking guide",
        notice:
          "Jami wrote these questions and their marking guide. Check anything that looks wrong before you rely on a mark.",
        items: markScheme,
      },
      preparedAt: now,
      gradeGuidance: {
        kind: "none",
        label: "No grade guidance",
        notice: "Grade boundaries do not apply to a few questions on one concept.",
        boundaries: [],
      },
      examinerInsights: [],
      attemptCount: 0,
      createdByInterventionId: input.interventionId,
      now,
    })
  );

  batch.set(practicePaperSecretRef(input.uid, paperId), {
    paperId,
    markScheme: {
      kind: "generated",
      label: "Jami-written marking guide",
      notice:
        "Jami wrote these questions and their marking guide. Check anything that looks wrong before you rely on a mark.",
      items: markScheme,
    },
    createdAt: now,
    updatedAt: now,
  });

  await batch.commit();
  return { notebookId: paperId };
}
