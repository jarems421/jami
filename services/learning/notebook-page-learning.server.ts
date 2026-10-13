import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { parseStudyActionId } from "@/lib/learning/events/study-action-event";
import {
  resolveNotebookPageLearningContext,
  type NotebookLinkedQuestion,
  type NotebookPageLearningContext,
} from "@/lib/learning/notebook-page-context";
import { createLogger } from "@/lib/observability/logger";
import { filterCanonicalConceptIds } from "@/lib/practice/exam-specification-concepts";
import { servableExamSpecificationTopics } from "@/lib/practice/exam-specification-topics";
import { mapPracticePaperData } from "@/lib/practice/practice-papers";
import { mapStudyFolderData } from "@/lib/workspace/study-folders";
import type { Notebook, NotebookPage } from "@/lib/workspace/notebooks";

const log = createLogger({ module: "learning.notebook_page" });

/**
 * Where a notebook page sits in the Learning Engine, read on the server.
 *
 * The page's link to a question is the student's own field and is not taken
 * on trust: the question is looked up in the paper or Past Paper Practice
 * session it names, both of which only the server writes, and its concepts
 * are checked against the catalogue that paper or session is from. A link
 * that does not check out is ignored, and the page falls back to its Topics.
 *
 * A followed study action is kept only when it is one of this folder's.
 */
export async function loadNotebookPageLearningContext(input: {
  db: Firestore;
  uid: string;
  notebook: Pick<Notebook, "id" | "folderId" | "topicIds">;
  page: Pick<
    NotebookPage,
    "id" | "topicIds" | "linkedQuestionId" | "linkedPastPaperId" | "linkedExamSessionId"
  >;
  actionId?: string;
}): Promise<NotebookPageLearningContext> {
  const linkedQuestion = await loadLinkedQuestion(input).catch((error: unknown) => {
    log.warn("linked_question.unavailable", { error });
    return null;
  });
  const action = input.actionId ? parseStudyActionId(input.actionId) : null;
  const interventionId =
    action && action.folderId && action.folderId === input.notebook.folderId ? action.actionId : undefined;
  return resolveNotebookPageLearningContext({
    notebook: input.notebook,
    page: input.page,
    linkedQuestion,
    ...(interventionId ? { interventionId } : {}),
  });
}

async function loadLinkedQuestion(input: {
  db: Firestore;
  uid: string;
  notebook: Pick<Notebook, "folderId">;
  page: Pick<NotebookPage, "linkedQuestionId" | "linkedPastPaperId" | "linkedExamSessionId">;
}): Promise<NotebookLinkedQuestion | null> {
  const questionId = input.page.linkedQuestionId;
  if (!questionId) return null;
  const userRef = input.db.collection("users").doc(input.uid);

  if (input.page.linkedPastPaperId) {
    const paperId = input.page.linkedPastPaperId;
    const [paperSnapshot, folderSnapshot] = await Promise.all([
      userRef.collection("pastPapers").doc(paperId).get(),
      input.notebook.folderId
        ? userRef.collection("studyFolders").doc(input.notebook.folderId).get()
        : Promise.resolve(null),
    ]);
    if (!paperSnapshot.exists) return null;
    // A paper's concept ids are checked against its folder's course; without one none are kept.
    const specificationId = folderSnapshot?.exists
      ? mapStudyFolderData(folderSnapshot.id, folderSnapshot.data() as Record<string, unknown>)
          .examCourse?.specificationId
      : undefined;
    const paper = mapPracticePaperData(
      paperSnapshot.id,
      paperSnapshot.data() as Record<string, unknown>,
      specificationId
    );
    const question = paper.questions.find((candidate) => candidate.id === questionId);
    if (!question) return null;
    return {
      kind: "practice-paper",
      paperId,
      questionId,
      specificationIds: question.conceptIds ?? [],
    };
  }

  if (input.page.linkedExamSessionId) {
    const sessionSnapshot = await userRef
      .collection("examSessions")
      .doc(input.page.linkedExamSessionId)
      .get();
    const session = sessionSnapshot.data();
    if (!sessionSnapshot.exists || !session) return null;
    const questions = Array.isArray(session.questions)
      ? (session.questions as Array<Record<string, unknown>>)
      : [];
    const question = questions.find((candidate) => candidate.id === questionId);
    if (!question) return null;
    const course = session.course as Record<string, unknown> | undefined;
    const specificationId =
      typeof course?.specificationId === "string" ? course.specificationId : "";
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    // The same ids the past-paper evidence itself is placed on, checked the same way.
    const servableTopics = new Set(
      specificationId
        ? (servableExamSpecificationTopics(specificationId)?.topics ?? []).map((topic) => topic.id)
        : []
    );
    const topicIds = strings(question.topicIds).filter((id) => servableTopics.has(id));
    const conceptIds = specificationId
      ? filterCanonicalConceptIds(specificationId, strings(question.conceptIds)).conceptIds
      : [];
    return {
      kind: "past-paper",
      questionId,
      specificationIds: [...topicIds, ...conceptIds],
    };
  }

  return null;
}
