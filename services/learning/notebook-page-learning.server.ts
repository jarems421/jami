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
  const linkedQuestions = await loadLinkedQuestions({
    db: input.db,
    uid: input.uid,
    notebook: input.notebook,
    pages: [input.page],
  }).catch((error: unknown) => {
    log.warn("linked_question.unavailable", { error });
    return {} as Record<string, NotebookLinkedQuestion>;
  });
  const action = input.actionId ? parseStudyActionId(input.actionId) : null;
  const interventionId =
    action && action.folderId && action.folderId === input.notebook.folderId ? action.actionId : undefined;
  return resolveNotebookPageLearningContext({
    notebook: input.notebook,
    page: input.page,
    linkedQuestion: linkedQuestions[input.page.id] ?? null,
    ...(interventionId ? { interventionId } : {}),
  });
}

type LinkablePage = Pick<
  NotebookPage,
  "id" | "linkedQuestionId" | "linkedPastPaperId" | "linkedExamSessionId"
>;

/**
 * More papers or sessions than one notebook credibly links to. A page linking
 * past this is placed by its Topics instead, as an unverifiable link would be.
 */
const MAX_LINKED_SOURCES = 12;

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The checked question behind each page that links to one, by page id.
 *
 * Each paper or session is read once however many of the pages link to it,
 * so placing a whole notebook costs a read per paper, not per page. Pages
 * whose link does not check out are left out.
 */
export async function loadLinkedQuestions(input: {
  db: Firestore;
  uid: string;
  notebook: Pick<Notebook, "folderId">;
  pages: readonly LinkablePage[];
}): Promise<Record<string, NotebookLinkedQuestion>> {
  const linked = input.pages.filter(
    (page) => page.linkedQuestionId && (page.linkedPastPaperId || page.linkedExamSessionId)
  );
  if (linked.length === 0) return {};
  const userRef = input.db.collection("users").doc(input.uid);
  const paperIds = Array.from(
    new Set(linked.flatMap((page) => (page.linkedPastPaperId ? [page.linkedPastPaperId] : [])))
  ).slice(0, MAX_LINKED_SOURCES);
  const sessionIds = Array.from(
    new Set(
      linked.flatMap((page) =>
        !page.linkedPastPaperId && page.linkedExamSessionId ? [page.linkedExamSessionId] : []
      )
    )
  ).slice(0, MAX_LINKED_SOURCES);

  const [folderSnapshot, paperSnapshots, sessionSnapshots] = await Promise.all([
    paperIds.length > 0 && input.notebook.folderId
      ? userRef.collection("studyFolders").doc(input.notebook.folderId).get()
      : Promise.resolve(null),
    Promise.all(paperIds.map((id) => userRef.collection("pastPapers").doc(id).get())),
    Promise.all(sessionIds.map((id) => userRef.collection("examSessions").doc(id).get())),
  ]);

  // A paper's concept ids are checked against its folder's course; without one none are kept.
  const folderSpecificationId = folderSnapshot?.exists
    ? mapStudyFolderData(folderSnapshot.id, folderSnapshot.data() as Record<string, unknown>)
        .examCourse?.specificationId
    : undefined;
  const paperQuestions = new Map<string, Map<string, readonly string[]>>();
  for (const snapshot of paperSnapshots) {
    if (!snapshot.exists) continue;
    const paper = mapPracticePaperData(
      snapshot.id,
      snapshot.data() as Record<string, unknown>,
      folderSpecificationId
    );
    paperQuestions.set(
      snapshot.id,
      new Map(paper.questions.map((question) => [question.id, question.conceptIds ?? []]))
    );
  }

  // The same ids the past-paper evidence itself is placed on, checked the same way.
  const sessionQuestions = new Map<string, Map<string, readonly string[]>>();
  for (const snapshot of sessionSnapshots) {
    const session = snapshot.data();
    if (!snapshot.exists || !session) continue;
    const course = session.course as Record<string, unknown> | undefined;
    const specificationId = typeof course?.specificationId === "string" ? course.specificationId : "";
    const servableTopics = new Set(
      specificationId
        ? (servableExamSpecificationTopics(specificationId)?.topics ?? []).map((topic) => topic.id)
        : []
    );
    const questions = Array.isArray(session.questions)
      ? (session.questions as Array<Record<string, unknown>>)
      : [];
    sessionQuestions.set(
      snapshot.id,
      new Map(
        questions.flatMap((question) => {
          if (typeof question.id !== "string") return [];
          const topicIds = strings(question.topicIds).filter((id) => servableTopics.has(id));
          const conceptIds = specificationId
            ? filterCanonicalConceptIds(specificationId, strings(question.conceptIds)).conceptIds
            : [];
          return [[question.id, [...topicIds, ...conceptIds]] as const];
        })
      )
    );
  }

  const placed: Record<string, NotebookLinkedQuestion> = {};
  for (const page of linked) {
    const questionId = page.linkedQuestionId as string;
    if (page.linkedPastPaperId) {
      const specificationIds = paperQuestions.get(page.linkedPastPaperId)?.get(questionId);
      if (specificationIds) {
        placed[page.id] = { kind: "practice-paper", paperId: page.linkedPastPaperId, questionId, specificationIds };
      }
    } else if (page.linkedExamSessionId) {
      const specificationIds = sessionQuestions.get(page.linkedExamSessionId)?.get(questionId);
      if (specificationIds) placed[page.id] = { kind: "past-paper", questionId, specificationIds };
    }
  }
  return placed;
}
