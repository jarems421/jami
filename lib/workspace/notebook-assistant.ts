import { pageHasSavedInk } from "@/lib/workspace/notebook-page-ink-split";
import type { MaterialActionKind } from "@/lib/learning/actions/material-action";
import { isRevisionMistake } from "@/lib/revision/types";
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

/**
 * Asked for in words `invitesNotebookMarking` reads as a request to be marked
 * ("mark my work"), so the marking it produces can be kept as evidence.
 */
const MARK_MY_WORK_ACTION = {
  label: "Mark my work",
  prompt:
    "Mark my work on this page. Give clear indicative feedback on what is correct, what needs fixing, and the most useful next step. Only give a formal mark when this page includes a defensible mark allocation or mark scheme; otherwise label it as feedback, not an official grade.",
} as const;

/**
 * The first step that goes wrong, against Jami's own working of the problem.
 * Help, never a mark: see `requestsWorkingCheck`, which this prompt must keep
 * matching ("check my working").
 */
const CHECK_WORKING_ACTION = {
  label: "Check my working",
  prompt:
    "Check my working on this page. Find the first step that goes wrong, show me what that step should be, and stop there so I can fix the rest myself.",
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

/** After "Check my working": the corrected page, marked, which is what counts. */
export const MARK_UPDATED_WORK_FOLLOW_UP = {
  label: "Mark my updated work",
  prompt: MARK_MY_WORK_ACTION.prompt,
} as const;

const SHOW_METHOD_FOLLOW_UP = {
  label: "Show me the method",
  prompt:
    "Show me the method for this question step by step using different numbers, so I can redo mine myself.",
} as const;

/**
 * What to offer after a marking that lost marks, by what kind of mistake the
 * marker said it was: the idea taught, the method shown, or -- for a slip in
 * sound working -- the corrected page marked again.
 *
 * Tutoring only. The kind is read from this answer and chooses one button; it
 * is never stored and never reaches the Learning Engine.
 */
export function notebookMarkingFollowUp(marking: unknown): NotebookPromptAction | undefined {
  if (!marking || typeof marking !== "object") return undefined;
  const record = marking as Record<string, unknown>;
  if (record.canMark === false) return undefined;
  const lostMarks =
    typeof record.awardedMarks === "number" &&
    typeof record.maxMarks === "number" &&
    record.awardedMarks < record.maxMarks;
  if (!lostMarks || !isRevisionMistake(record.mistakeKind)) return undefined;
  switch (record.mistakeKind) {
    case "concept":
      return ENGINE_ACTIONS.teach;
    case "method":
      return SHOW_METHOD_FOLLOW_UP;
    case "slip":
      return MARK_UPDATED_WORK_FOLLOW_UP;
  }
}

/**
 * The engine's starting point for the concept on the page, as something to ask.
 *
 * Each says what to do and stops there, so the student answers before Tutor
 * says more. A quick check is asked as Tutor's own quick check, which is how
 * an answer to it can count.
 */
const ENGINE_ACTIONS: Record<MaterialActionKind, NotebookPromptAction> = {
  "quick-check": {
    label: "Quick check",
    prompt:
      "Give me a quick check on what this page is about: one short question, and wait for my answer before telling me anything.",
  },
  teach: {
    label: "Teach me this",
    prompt:
      "Teach me the idea this page is about from the start, step by step, then ask me one short question to check I followed.",
  },
  "exam-question": {
    label: "Try an exam question",
    prompt:
      "Give me one exam-style question on what this page is about. Let me answer it before you say anything else.",
  },
  recall: {
    label: "Test me from memory",
    prompt:
      "Test me from memory on what this page is about: ask me to recall the key idea without looking, one question at a time, and do not reveal the answer yet.",
  },
  harder: {
    label: "Give me a harder one",
    prompt:
      "Give me a harder question on what this page is about, one step beyond what I have done here. Do not give the answer yet.",
  },
};

/**
 * The three ways into a fresh notebook chat.
 *
 * Three, always: a wall of chips over an empty conversation reads as a menu to
 * study rather than a nudge to start. Once the page has work on it, checking
 * that work is the most useful thing Jami can do, so it takes the quiz's place.
 * Past Paper Practice and Revision Sessions used to sit here too; they open
 * somewhere else entirely rather than start a chat, and the folder page offers
 * both. With work on the page, checking it two ways -- marked, or the first
 * slip found -- leads; "explain this page" is one question in the chat away.
 *
 * The third is the Learning Engine's, when it has a decision on what the page
 * is about: never Tutor's guess, always the engine's own action for that
 * concept (`materialActionFor`). Without one it is a hint once there is work,
 * and a quiz before.
 */
export function getNotebookAssistantQuickActions(input: {
  hasWork: boolean;
  engineAction?: MaterialActionKind;
}): NotebookPromptAction[] {
  const engine = input.engineAction ? ENGINE_ACTIONS[input.engineAction] : undefined;
  return input.hasWork
    ? [CHECK_WORKING_ACTION, MARK_MY_WORK_ACTION, engine ?? HINT_ACTION]
    : [HINT_ACTION, EXPLAIN_ACTION, engine ?? QUIZ_ACTION];
}
