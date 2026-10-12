// @vitest-environment jsdom

import { act, useCallback, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import {
  useNotebookInkController,
  type NotebookInkController,
} from "@/hooks/useNotebookInkController";
import { useNotebookPageState } from "@/hooks/useNotebookPageState";
import { svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";
import type { NotebookTextBlock } from "@/lib/workspace/notebooks";

let container: HTMLDivElement;
let root: Root;
let ink: NotebookInkController;
let store: ReturnType<typeof useNotebookPageState>["store"];

let inkUndoDepth: number;
let inkRedoDepth: number;
let interacting: boolean;
const inkUndo = vi.fn();
const inkRedo = vi.fn();
const onEdit = vi.fn();
const resetTextBlockInteraction = vi.fn();
const onUiCommitted = vi.fn();

let handle: NotebookInkEditorHandle;

function block(id: string): NotebookTextBlock {
  return { id, text: id, x: 0, y: 0, width: 10, height: 10 } as NotebookTextBlock;
}

function Harness() {
  const { store: pageState } = useNotebookPageState();
  const inkEditorRef = useRef<NotebookInkEditorHandle | null>(handle);
  const value = useNotebookInkController({
    pageState,
    inkEditorRef,
    onEdit,
    resetTextBlockInteraction,
    onUiCommitted: useCallback(() => onUiCommitted(), []),
  });
  useEffect(() => {
    ink = value;
    store = pageState;
  });
  return null;
}

/** Simulates js-draw landing a command and reporting its new depth. */
function landInkCommand() {
  inkUndoDepth += 1;
  inkRedoDepth = 0;
  act(() => {
    ink.handleInkHistoryChange(inkUndoDepth, inkRedoDepth);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  inkUndoDepth = 0;
  inkRedoDepth = 0;
  interacting = false;
  inkUndo.mockReset();
  inkRedo.mockReset();
  onEdit.mockReset();
  resetTextBlockInteraction.mockReset();
  onUiCommitted.mockReset();

  handle = {
    clear: vi.fn(),
    getHistoryState: () => ({
      undoDepth: inkUndoDepth,
      redoDepth: inkRedoDepth,
    }),
    hasInk: () => inkUndoDepth > 0,
    isInteracting: () => interacting,
    redo: inkRedo,
    serialize: () => svgNotebookInkData("<svg />"),
    serializeWarm: () => svgNotebookInkData("<svg />"),
    serializeAsync: async () => svgNotebookInkData("<svg />"),
    setEraserMode: vi.fn(),
    undo: inkUndo,
  };

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("useNotebookInkController undo ordering", () => {
  it("undoes the text edit when it happened after the stroke", () => {
    landInkCommand();
    vi.advanceTimersByTime(10);
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);
    });

    act(() => {
      ink.undo();
    });

    // The regression this fixes: ink used to win regardless of order.
    expect(inkUndo).not.toHaveBeenCalled();
    expect(store.read().textBlocks).toEqual([block("a")]);
  });

  it("undoes the stroke when it happened after the text edit", () => {
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);
    });
    vi.advanceTimersByTime(10);
    landInkCommand();

    act(() => {
      ink.undo();
    });

    expect(inkUndo).toHaveBeenCalledTimes(1);
    expect(store.read().textBlocks).toEqual([]);
  });

  it("walks back through a mixed history in reverse order", () => {
    landInkCommand();                       // stroke A
    vi.advanceTimersByTime(10);
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);  // text move
    });
    vi.advanceTimersByTime(10);
    landInkCommand();                       // stroke B

    act(() => {
      ink.undo();
    });
    expect(inkUndo).toHaveBeenCalledTimes(1);           // stroke B

    // js-draw reports its shallower depth after undoing.
    inkUndoDepth -= 1;
    inkRedoDepth += 1;
    act(() => {
      ink.handleInkHistoryChange(inkUndoDepth, inkRedoDepth);
      ink.undo();
    });
    expect(inkUndo).toHaveBeenCalledTimes(1);           // now the text move
    expect(store.read().textBlocks).toEqual([block("a")]);

    act(() => {
      ink.undo();
    });
    expect(inkUndo).toHaveBeenCalledTimes(2);           // finally stroke A
  });

  it("does nothing when both histories are empty", () => {
    act(() => {
      ink.undo();
      ink.redo();
    });
    expect(inkUndo).not.toHaveBeenCalled();
    expect(inkRedo).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("redoes a text edit that was undone last", () => {
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);
      ink.undo();
    });
    expect(store.read().textBlocks).toEqual([block("a")]);

    act(() => {
      ink.redo();
    });
    expect(store.read().textBlocks).toEqual([block("b")]);
  });

  it("drops the redo branch once a new edit lands", () => {
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);
      ink.undo();
    });
    expect(ink.redoDepth).toBe(1);

    act(() => {
      ink.recordTextEdit([block("c")], [block("d")]);
    });
    expect(ink.redoDepth).toBe(0);
  });

  it("reports one combined depth across both histories", () => {
    landInkCommand();
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);
    });
    act(() => {
      ink.commitUi();
    });
    expect(ink.undoDepth).toBe(2);
  });

  it("forgets both histories when the page changes", () => {
    landInkCommand();
    act(() => {
      ink.recordTextEdit([block("a")], [block("b")]);
      ink.clearHistory();
    });
    expect(ink.undoDepth).toBe(0);
    expect(ink.redoDepth).toBe(0);

    act(() => {
      ink.undo();
    });
    expect(inkUndo).not.toHaveBeenCalled();
  });
});

describe("useNotebookInkController editor plumbing", () => {
  it("keeps a stroke burst off the render loop", () => {
    act(() => {
      ink.handleInkChange();
      ink.handleInkChange();
    });
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(onEdit).toHaveBeenLastCalledWith({ deferUi: true });
    expect(onUiCommitted).not.toHaveBeenCalled();
  });

  it("commits the editor UI once the burst settles", () => {
    act(() => {
      ink.handleInkHistoryChange(1, 0);
    });
    expect(onUiCommitted).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onUiCommitted).toHaveBeenCalledTimes(1);
  });

  it("holds the touch cooldown open for the length of a stroke", () => {
    act(() => {
      ink.handleInteractionChange(true);
    });
    expect(ink.isInteracting()).toBe(true);
    expect(ink.stylusCooldownUntilRef.current).toBe(Number.POSITIVE_INFINITY);

    act(() => {
      ink.handleInteractionChange(false);
    });
    expect(ink.isInteracting()).toBe(false);
    // A palm must stay suppressed for a moment after the pen lifts.
    expect(ink.stylusCooldownUntilRef.current).toBeGreaterThan(Date.now());
  });

  it("treats the editor's own interaction flag as interacting", () => {
    interacting = true;
    expect(ink.isInteracting()).toBe(true);
  });
});
