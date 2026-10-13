import { describe, expect, it } from "vitest";
import { invitesNotebookMarking } from "@/lib/ai/jami-assistant";
import { requestsWorkingCheck } from "@/lib/ai/tutor-turn-plan";
import {
  getNotebookAssistantQuickActions,
  notebookPageHasWork,
} from "@/lib/workspace/notebook-assistant";
import type { NotebookPage, NotebookTextBlock } from "@/lib/workspace/notebooks";

function makePage(overrides: Partial<NotebookPage> = {}): NotebookPage {
  return {
    id: "page-1",
    notebookId: "notebook-1",
    folderId: "folder-1",
    pageNumber: 1,
    pageType: "blank",
    textBlocks: [],
    imageRefs: [],
    graphBlocks: [],
    pageColor: "white",
    pageStyle: "plain",
    status: "blank",
    contentRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTextBlock(text: string): NotebookTextBlock {
  return { id: "block-1", x: 0, y: 0, width: 200, height: 60, text, outlineVisible: false };
}

describe("notebook Tutor actions", () => {
  it("shows the checks only after the page contains work", () => {
    const empty = getNotebookAssistantQuickActions({ hasWork: false }).map((action) => action.label);
    expect(empty).not.toContain("Mark my work");
    expect(empty).not.toContain("Check my working");
    const actions = getNotebookAssistantQuickActions({ hasWork: true });
    const mark = actions.find((action) => action.label === "Mark my work");
    expect(mark?.prompt).toMatch(/indicative feedback/i);
    expect(mark?.prompt).toMatch(/formal mark.*mark allocation|mark scheme/i);
  });

  it("asks a working check in words the plan reads as one, and never as a request to be marked", () => {
    const check = getNotebookAssistantQuickActions({ hasWork: true }).find((action) => action.label === "Check my working");
    const context = { surface: "notebook" as const, notebookId: "notebook-1", pageId: "page-1" };
    expect(requestsWorkingCheck({ message: check?.prompt ?? "", context })).toBe(true);
    expect(invitesNotebookMarking({ message: check?.prompt ?? "", context })).toBe(false);
    // Only on a notebook page.
    expect(requestsWorkingCheck({ message: check?.prompt ?? "", context: { surface: "learn" as const, cardId: "card-1", phase: "answer" as const } })).toBe(false);
  });

  it("offers exactly three ways into a fresh chat", () => {
    expect(
      getNotebookAssistantQuickActions({ hasWork: false }).map((action) => action.label)
    ).toEqual(["Give me a hint", "Explain this page", "Quiz me"]);
    expect(
      getNotebookAssistantQuickActions({ hasWork: true }).map((action) => action.label)
    ).toEqual(["Check my working", "Mark my work", "Give me a hint"]);
  });
});

describe("whether a notebook page has work on it", () => {
  const blank = { page: makePage(), textBlocks: [], inkHasContent: false };

  it("is false for a blank page, and for no page at all", () => {
    expect(notebookPageHasWork(blank)).toBe(false);
    expect(notebookPageHasWork({ ...blank, page: null })).toBe(false);
  });

  it("counts ink the editor holds before it has been saved", () => {
    expect(notebookPageHasWork({ ...blank, inkHasContent: true })).toBe(true);
  });

  it("counts text boxes with words in them, not empty ones", () => {
    expect(notebookPageHasWork({ ...blank, textBlocks: [makeTextBlock("   ")] })).toBe(false);
    expect(notebookPageHasWork({ ...blank, textBlocks: [makeTextBlock("x = 2")] })).toBe(true);
  });

  it("counts what the saved page already holds", () => {
    const withWork = (overrides: Partial<NotebookPage>) =>
      notebookPageHasWork({ ...blank, page: makePage(overrides) });
    expect(withWork({ typedContent: "   " })).toBe(false);
    expect(withWork({ typedContent: "notes" })).toBe(true);
    expect(withWork({ inkData: { version: 2, format: "js-draw-svg", svg: "<svg/>" } })).toBe(true);
    expect(
      withWork({
        strokeData: {
          version: 1,
          strokes: [{ points: [], color: "black", width: 2, tool: "pen" }],
        },
      })
    ).toBe(true);
    expect(withWork({ imageRefs: [{ id: "image-1" }] })).toBe(true);
  });
});
