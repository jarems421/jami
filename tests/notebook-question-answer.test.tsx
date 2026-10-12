// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NotebookQuestionOverlay from "@/components/workspace/NotebookQuestionOverlay";
import { mapNotebookPageData } from "@/lib/workspace/notebooks";

/**
 * A practice question page keeps its answer folded away: the student meets the
 * question, and opens the answer themselves.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const page = mapNotebookPageData("page-1", {
  notebookId: "notebook-1",
  pageType: "question",
  questionPrompt: "Explain why the rate levels off. [3 marks]",
  questionAnswer: "Expected answer:\nAnother factor becomes limiting.",
});

describe("a practice question's answer", () => {
  it("is not shown until the student asks for it", () => {
    act(() => root.render(<NotebookQuestionOverlay page={page} />));
    expect(container.textContent).toContain("Explain why the rate levels off.");
    expect(container.textContent).not.toContain("Another factor becomes limiting.");

    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Show answer"
    );
    act(() => button?.click());
    expect(container.textContent).toContain("Another factor becomes limiting.");
  });

  it("is never written onto the page as typed text", () => {
    expect(page.typedContent).toBeUndefined();
    expect(page.textBlocks).toEqual([]);
  });
});
