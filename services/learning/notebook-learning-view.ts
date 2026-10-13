import type {
  MaterialAction,
  MaterialActionKind,
  MaterialConcept,
} from "@/lib/learning/actions/material-action";
import type {
  NotebookLearningView,
  NotebookLinkedQuestion,
} from "@/lib/learning/notebook-page-context";
import { auth } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";

/**
 * One notebook's place in the Learning Engine, for its Tutor.
 *
 * Asked for once per notebook while Tutor is open, and kept for a few minutes:
 * every page is then placed from it in the browser, so turning a page costs
 * nothing, and the engine's view does not change while the student reads.
 */

const CACHE_MS = 3 * 60_000;
const LOAD_MS = 6_000;

const cache = new Map<string, { storedAt: number; value: NotebookLearningView }>();

const ACTION_KINDS: readonly MaterialActionKind[] = [
  "quick-check",
  "teach",
  "exam-question",
  "recall",
  "harder",
];

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readAction(value: unknown): MaterialAction | undefined {
  const action = record(value);
  const kind = ACTION_KINDS.find((candidate) => candidate === action?.kind);
  if (!kind || typeof action?.topicKey !== "string" || typeof action.label !== "string") return undefined;
  return { kind, topicKey: action.topicKey, label: action.label };
}

function readLinkedQuestion(value: unknown): NotebookLinkedQuestion | undefined {
  const question = record(value);
  if (typeof question?.questionId !== "string") return undefined;
  const specificationIds = readStrings(question.specificationIds);
  if (question.kind === "practice-paper" && typeof question.paperId === "string") {
    return { kind: "practice-paper", paperId: question.paperId, questionId: question.questionId, specificationIds };
  }
  if (question.kind === "past-paper") {
    return { kind: "past-paper", questionId: question.questionId, specificationIds };
  }
  return undefined;
}

function readView(body: unknown): NotebookLearningView | null {
  const view = record(body);
  if (!view) return null;
  const linkedQuestions: NotebookLearningView["linkedQuestions"] = {};
  for (const [pageId, value] of Object.entries(record(view.linkedQuestions) ?? {})) {
    const question = readLinkedQuestion(value);
    if (question) linkedQuestions[pageId] = question;
  }
  const concepts: NotebookLearningView["concepts"] = {};
  for (const [key, value] of Object.entries(record(view.concepts) ?? {})) {
    const concept = record(value);
    if (typeof concept?.label !== "string") continue;
    const action = readAction(concept.action);
    const entry: MaterialConcept = {
      label: concept.label,
      ...(action ? { action } : {}),
      ...(typeof concept.rank === "number" && Number.isFinite(concept.rank) ? { rank: concept.rank } : {}),
    };
    concepts[key] = entry;
  }
  return { notebookTopicIds: readStrings(view.notebookTopicIds), linkedQuestions, concepts };
}

/** The notebook's view, or null when it cannot be had; the notebook works the same without it. */
export async function loadNotebookLearningView(notebookId: string): Promise<NotebookLearningView | null> {
  const user = auth.currentUser;
  if (!user) return null;
  const key = `${user.uid}:${notebookId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.storedAt < CACHE_MS) return cached.value;
  try {
    const search = new URLSearchParams({ notebookId });
    const response = await withTimeout(
      fetch(`/api/learning/notebook-learning?${search.toString()}`, {
        headers: { Authorization: `Bearer ${await user.getIdToken()}` },
      }),
      LOAD_MS,
      "Load notebook learning view"
    );
    if (!response.ok) return null;
    const value = readView(await response.json().catch(() => null));
    if (value) cache.set(key, { storedAt: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}
