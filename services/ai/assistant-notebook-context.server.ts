import "server-only";

import type { AiContentPart } from "@/lib/ai/content-parts";
import {
  JamiAssistantContextError,
  assertSnapshotMime,
  type SourceRelations,
} from "@/lib/ai/assistant-context.server";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import {
  getNotebookContextPageTextLimit,
  selectNotebookContextWindow,
} from "@/lib/ai/notebook-context-window";
import { mapNotebookData, mapNotebookPageData } from "@/lib/workspace/notebooks";
import type { getAdminDb } from "@/services/firebase/admin";
import { notebookContextTopicIds } from "@/lib/learning/notebook-page-context";
import { loadNotebookNeighbourPageParts } from "@/services/ai/notebook-neighbour-pages.server";
import { loadNotebookPageLearningContext } from "@/services/learning/notebook-page-learning.server";

/**
 * The notebook page a student has open, as Tutor reads it: the page itself,
 * a map of the rest of the notebook, and the pictured pages beside it.
 */

const NOTEBOOK_CONTEXT_PAGE_LIMIT = 60;
const NOTEBOOK_CONTEXT_PAGE_TEXT_LIMIT = 700;
const NOTEBOOK_CONTEXT_TOTAL_TEXT_LIMIT = 12_000;

type AdminDb = ReturnType<typeof getAdminDb>;

function getNotebookPageText(
  page: ReturnType<typeof mapNotebookPageData>,
  limit: number = NOTEBOOK_CONTEXT_PAGE_TEXT_LIMIT
) {
  return [page.typedContent, ...page.textBlocks.map((block) => block.text)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildNotebookPageMap(
  pages: ReturnType<typeof mapNotebookPageData>[],
  currentPageId: string
) {
  if (pages.length <= 1) return "";

  const { nearby, distant } = selectNotebookContextWindow(pages, currentPageId);
  const nearbyIds = new Set(nearby.map((page) => page.id));

  const describe = (page: ReturnType<typeof mapNotebookPageData>) => {
    const isNearby = nearbyIds.has(page.id);
    const pageText = getNotebookPageText(
      page,
      getNotebookContextPageTextLimit(isNearby)
    );
    const details = [
      page.title && !/^Page \d+$/i.test(page.title) ? `title: ${page.title}` : "",
      page.questionPrompt ? `question: ${page.questionPrompt.slice(0, 500)}` : "",
      pageText ? `typed content: ${pageText}` : "no typed summary available",
    ].filter(Boolean);
    return `- Page ${page.pageNumber}${
      page.id === currentPageId ? " (current)" : ""
    }: ${details.join("; ")}`;
  };

  /*
   * Two bands, because a question that runs over a page break is the ordinary
   * case and the page it continues onto used to be described no better than one
   * at the other end of the notebook.
   */
  const sections: string[] = [];
  if (nearby.length > 0) {
    sections.push(
      `Pages around the one the student is on. A question may well be split across these, so read them as part of the same piece of work:
${nearby
        .map(describe)
        .join("\n")}`
    );
  }
  if (distant.length > 0) {
    sections.push(
      `The rest of the notebook, listed so you can find something the student refers to:
${distant
        .map(describe)
        .join("\n")}`
    );
  }

  return `Notebook page map (loaded when the student asked; handwriting and page imagery are available for the current page and for any page pictured below (the page either side, and any page the student names); treat any other page's typed text as an outline rather than its full contents. If the work they ask about is on a page that is not pictured, ask them which page number it is on rather than saying you cannot read it):
${sections
    .join("\n\n")
    .slice(0, NOTEBOOK_CONTEXT_TOTAL_TEXT_LIMIT)}`;
}

export async function resolveNotebookContext(input: {
  db: AdminDb;
  uid: string;
  context: Extract<JamiAssistantContext, { surface: "notebook" }>;
  /** What the student asked, which says which other pages to read. */
  message: string;
}) {
  const userRef = input.db.collection("users").doc(input.uid);
  const [notebookSnapshot, pageSnapshot, notebookPagesSnapshot] = await Promise.all([
    userRef.collection("notebooks").doc(input.context.notebookId).get(),
    userRef.collection("notebookPages").doc(input.context.pageId).get(),
    userRef
      .collection("notebookPages")
      .where("notebookId", "==", input.context.notebookId)
      .orderBy("pageNumber", "asc")
      .limit(NOTEBOOK_CONTEXT_PAGE_LIMIT)
      .get(),
  ]);
  if (!notebookSnapshot.exists || !pageSnapshot.exists) {
    throw new JamiAssistantContextError("This notebook page could not be found.");
  }

  const notebook = mapNotebookData(
    notebookSnapshot.id,
    notebookSnapshot.data() ?? {}
  );
  const page = mapNotebookPageData(pageSnapshot.id, pageSnapshot.data() ?? {});
  if (page.notebookId !== notebook.id) {
    throw new JamiAssistantContextError("This notebook page could not be found.");
  }

  const typedText =
    input.context.typedText ||
    [page.typedContent, ...page.textBlocks.map((block) => block.text)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12_000);
  const questionPrompt = input.context.questionPrompt || page.questionPrompt || "";
  const notebookPages = notebookPagesSnapshot.docs
    .map((snapshot) =>
      mapNotebookPageData(snapshot.id, snapshot.data() as Record<string, unknown>)
    )
    .filter((candidate) => candidate.notebookId === notebook.id);
  const notebookPageMap = buildNotebookPageMap(notebookPages, page.id);
  /*
   * A practice question's answer, which the page keeps folded away. Tutor
   * marks against it, and holds it back as a flashcard's withheld side is held
   * back: the student opens it themselves, or asks for it.
   */
  const answerKey = questionPrompt && page.questionAnswer ? page.questionAnswer.slice(0, 6_000) : "";
  const currentParts: AiContentPart[] = [
    {
      text: `Notebook: ${notebook.title}\nPage: ${page.pageNumber}${
        questionPrompt ? `\nQuestion prompt: ${questionPrompt}` : ""
      }${
        answerKey
          ? `\nAnswer key for this question (hidden on the page until the student opens it). Use it to mark and check their working. Do not reveal it unless they ask for the answer or ask to be marked:\n${answerKey}`
          : ""
      }${typedText ? `\nTyped page content:\n${typedText}` : ""}${
        notebookPageMap ? `\n\n${notebookPageMap}` : ""
      }`,
    },
  ];
  if (input.context.snapshot) {
    assertSnapshotMime(input.context.snapshot);
    currentParts.push({
      inlineData: {
        mimeType: input.context.snapshot.mimeType,
        data: input.context.snapshot.dataBase64,
      },
    });
  }
  /*
   * Started here, awaited alongside the sources: drawing two pages takes a
   * moment, and nothing else waits on it.
   */
  const neighbourParts = loadNotebookNeighbourPageParts({
    uid: input.uid,
    notebookId: notebook.id,
    pages: notebookPages,
    currentPageId: page.id,
    message: input.message,
  });
  // One read at most, and only for a page made for a question.
  const notebookLearning = await loadNotebookPageLearningContext({
    db: input.db,
    uid: input.uid,
    notebook,
    page,
  });
  const pageTopicIds = notebookContextTopicIds(notebookLearning);

  return {
    currentId: page.id,
    currentLabel: "Current page",
    currentParts,
    neighbourParts,
    relations: {
      currentSourceIds: [],
      directSourceIds: notebook.sourceIds,
      folderIds: notebook.folderId ? [notebook.folderId] : [],
      // The page's own Topics when it has them: they choose sources and scope memory.
      topicIds: pageTopicIds.length > 0 ? pageTopicIds : notebook.topicIds,
    } satisfies SourceRelations,
    notebookLearning,
  };
}
