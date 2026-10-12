// @vitest-environment jsdom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import { useExamSheetDocument } from "@/hooks/useExamSheetDocument";
import type { ExamScratchpadHandle } from "@/lib/practice/exam-working";
import { svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";

vi.mock("@/services/study/exam-practice", () => ({
  ExamScratchpadTooLargeError: class ExamScratchpadTooLargeError extends Error {},
  loadExamScratchpad: vi.fn(async () => [] as string[]),
  saveExamScratchpad: vi.fn(async () => undefined),
}));

const { loadExamScratchpad, saveExamScratchpad } = await import("@/services/study/exam-practice");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INKED = '<svg><path d="M0 0 L10 10" /></svg>';

/** The editor as the sheet reads it: whatever was last written on the open page. */
function fakeEditor(): NotebookInkEditorHandle & { markup: string } {
  const editor = {
    markup: "",
    clear: () => undefined,
    getHistoryState: () => ({ undoDepth: 0, redoDepth: 0 }),
    hasInk: () => editor.markup !== "",
    isInteracting: () => false,
    redo: () => undefined,
    serialize: () => svgNotebookInkData(editor.markup),
    serializeAsync: async () => svgNotebookInkData(editor.markup),
    serializeWarm: () => svgNotebookInkData(editor.markup),
    setEraserMode: () => undefined,
    undo: () => undefined,
  };
  return editor;
}

type Sheet = ReturnType<typeof useExamSheetDocument>;

let container: HTMLDivElement;
let root: Root;
let sheet: Sheet;
let editor: ReturnType<typeof fakeEditor>;
let inking = false;

function Harness({ answerSpacePages }: { answerSpacePages?: number }) {
  const editorRef = useRef<NotebookInkEditorHandle | null>(editor);
  const value = useExamSheetDocument({
    userId: "student",
    attemptId: "attempt-1",
    disabled: false,
    printedPages: NO_PRINTED_PAGES,
    answerSpacePages,
    questionLabel: "1",
    paper: { pageColor: "white", pageStyle: "plain" },
    editorRef,
    isInking: () => inking,
    onHandle: noHandle,
  });
  useEffect(() => {
    sheet = value;
  });
  return null;
}

const NO_PRINTED_PAGES: never[] = [];
const noHandle = (handle: ExamScratchpadHandle | null) => void handle;

async function render(props: { answerSpacePages?: number } = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  editor = fakeEditor();
  inking = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useExamSheetDocument", () => {
  it("reopens the stored pages where they were written", async () => {
    vi.mocked(loadExamScratchpad).mockResolvedValueOnce(["", INKED]);
    await render();

    expect(sheet.pageCount).toBe(2);
    expect(sheet.pageSvgs).toEqual(["", INKED]);
  });

  it("writes the sheet once the pen has been still, and not while it is down", async () => {
    await render();
    editor.markup = INKED;
    inking = true;
    act(() => sheet.handleInkChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(vi.mocked(saveExamScratchpad)).not.toHaveBeenCalled();

    inking = false;
    act(() => sheet.resumeAfterStroke());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(vi.mocked(saveExamScratchpad)).toHaveBeenCalledWith("student", "attempt-1", [INKED]);
  });

  it("keeps the last stroke when the sheet is left before it was saved", async () => {
    await render();
    editor.markup = INKED;
    act(() => sheet.handleInkChange());
    act(() => root.unmount());
    root = createRoot(container);

    expect(vi.mocked(saveExamScratchpad)).toHaveBeenCalledWith("student", "attempt-1", [INKED]);
  });

  it("adds a sheet at the end and opens it, and removes it again", async () => {
    await render({ answerSpacePages: 0 });
    expect(sheet.pageCount).toBe(1);

    act(() => sheet.addPage());
    expect(sheet.pageCount).toBe(2);
    expect(sheet.pageIndex).toBe(1);

    act(() => sheet.deletePage());
    expect(sheet.pageCount).toBe(1);
    expect(sheet.pageIndex).toBe(0);
  });
});
