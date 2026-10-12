import { pageHasSavedInk } from "@/lib/workspace/notebook-page-ink-split";
import type { NotebookPage, NotebookTextBlock } from "@/lib/workspace/notebooks";

type NotebookPromptAction = { label: string; prompt: string };

/**
 * Whether the open page has anything on it to check: typed notes, text
 * boxes with words in them, ink (on the editor now or saved before), images
 * or graphs.
 */
export function notebookPageHasWork(input: {
  page: NotebookPage | null;
  /** The page's text boxes as they are being edited, ahead of the saved page. */
  textBlocks: readonly NotebookTextBlock[];
  /** The ink editor's own answer, which knows about strokes not yet saved. */
  inkHasContent: boolean;
}) {
  const { page } = input;
  return Boolean(
    page?.typedContent?.trim() ||
      input.textBlocks.some((block) => block.text.trim()) ||
      input.inkHasContent ||
      (page && pageHasSavedInk(page)) ||
      (page?.imageRefs.length ?? 0) > 0 ||
      (page?.graphBlocks.length ?? 0) > 0
  );
}

const MARK_MY_WORK_ACTION = {
  label: "Mark my work",
  prompt:
    "Mark the work on this page. Give clear indicative feedback on what is correct, what needs fixing, and the most useful next step. Only give a formal mark when this page includes a defensible mark allocation or mark scheme; otherwise label it as feedback, not an official grade.",
} as const;

const HINT_ACTION = {
  label: "Give me a hint",
  prompt:
    "Give me one useful hint for the work on this page without revealing the full answer.",
} as const;

const EXPLAIN_ACTION = {
  label: "Explain this page",
  prompt:
    "Explain the ideas and working on this page clearly, including anything important I may have missed.",
} as const;

const QUIZ_ACTION = {
  label: "Quiz me",
  prompt:
    "Quiz me on the main idea from this page. Ask one question at a time and do not reveal the answer yet.",
} as const;

/**
 * The three ways into a fresh notebook chat.
 *
 * Three, always: a wall of chips over an empty conversation reads as a menu to
 * study rather than a nudge to start. Once the page has work on it, checking
 * that work is the most useful thing Jami can do, so it takes the quiz's place.
 * Past Paper Practice and Revision Sessions used to sit here too; they open
 * somewhere else entirely rather than start a chat, and the folder page offers
 * both.
 */
export function getNotebookAssistantQuickActions(input: {
  hasWork: boolean;
}): NotebookPromptAction[] {
  return input.hasWork
    ? [MARK_MY_WORK_ACTION, HINT_ACTION, EXPLAIN_ACTION]
    : [HINT_ACTION, EXPLAIN_ACTION, QUIZ_ACTION];
}
