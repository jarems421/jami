// @vitest-environment jsdom

import { act, useCallback, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import { useNotebookPageState } from "@/hooks/useNotebookPageState";
import {
  useNotebookPersistenceController,
  type NotebookPersistenceController,
} from "@/hooks/useNotebookPersistenceController";
import { svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";
import type { NotebookPageSaveResult } from "@/lib/workspace/notebook-save-result";
import type { NotebookPage } from "@/lib/workspace/notebooks";

const saveNotebookPageSnapshot = vi.fn();
const writeNotebookPageDraft = vi.fn();
const writeNotebookPageDraftSync = vi.fn();
const deleteNotebookPageDraft = vi.fn();

vi.mock("@/services/study/notebooks", () => ({
  saveNotebookPageSnapshot: (...args: unknown[]) =>
    saveNotebookPageSnapshot(...args),
}));

vi.mock("@/lib/workspace/notebook-drafts", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/workspace/notebook-drafts")
  >("@/lib/workspace/notebook-drafts");
  return {
    ...actual,
    writeNotebookPageDraft: (...args: unknown[]) =>
      writeNotebookPageDraft(...args),
    writeNotebookPageDraftSync: (...args: unknown[]) =>
      writeNotebookPageDraftSync(...args),
    deleteNotebookPageDraft: (...args: unknown[]) =>
      deleteNotebookPageDraft(...args),
  };
});

const PAGE: NotebookPage = {
  id: "page-1",
  notebookId: "notebook-1",
  pageNumber: 1,
  contentRevision: 3,
  updatedAt: 1000,
} as NotebookPage;

let container: HTMLDivElement;
let root: Root;
let controller: NotebookPersistenceController;
let store: ReturnType<typeof useNotebookPageState>["store"];
let saved: NotebookPageSaveResult[];
let inkInteracting: boolean;
let inkHandle: NotebookInkEditorHandle;
const commitUi = vi.fn();
const scheduleUiCommit = vi.fn();

function Harness() {
  const { store: pageState } = useNotebookPageState();
  const inkEditorRef = useRef<NotebookInkEditorHandle | null>(inkHandle);
  const editorRevisionRef = useRef(0);

  const value = useNotebookPersistenceController({
    pageState,
    userId: "user-1",
    inkEditorRef,
    editorRevisionRef,
    isInkInteracting: useCallback(() => inkInteracting, []),
    fallbackInk: svgNotebookInkData("<svg data-fallback='true' />"),
    onPageSaved: useCallback((result: NotebookPageSaveResult) => {
      saved.push(result);
    }, []),
    onError: useCallback(() => undefined, []),
    onClearError: useCallback(() => undefined, []),
    commitUi,
    scheduleUiCommit,
  });

  useEffect(() => {
    controller = value;
    store = pageState;
  });
  return null;
}

function mountHarness() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  saved = [];
  inkInteracting = false;
  commitUi.mockClear();
  scheduleUiCommit.mockClear();
  saveNotebookPageSnapshot.mockReset().mockResolvedValue({
    contentRevision: 4,
    updatedAt: 2000,
  });
  writeNotebookPageDraft.mockReset().mockResolvedValue(undefined);
  writeNotebookPageDraftSync.mockReset().mockReturnValue(true);
  deleteNotebookPageDraft.mockReset().mockResolvedValue(undefined);
  inkHandle = {
    clear: vi.fn(),
    getHistoryState: () => ({ undoDepth: 0, redoDepth: 0 }),
    hasInk: () => true,
    isInteracting: () => inkInteracting,
    redo: vi.fn(),
    serialize: () => svgNotebookInkData("<svg data-sync='true' />"),
    serializeWarm: () => svgNotebookInkData("<svg />"),
    serializeAsync: async () => svgNotebookInkData("<svg data-async='true' />"),
    setEraserMode: vi.fn(),
    undo: vi.fn(),
  };
  mountHarness();
  act(() => {
    store.selectPage(PAGE);
    store.hydratePage(PAGE.id, PAGE.contentRevision);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("useNotebookPersistenceController", () => {
  it("marks the page unsaved without rendering on the ink hot path", () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true });
    });
    expect(store.read().saveStatus).toBe("unsaved");
    expect(commitUi).not.toHaveBeenCalled();
    expect(scheduleUiCommit).toHaveBeenCalledTimes(1);
  });

  it("commits the editor UI immediately for a non-ink edit", () => {
    act(() => {
      controller.markPageUnsaved();
    });
    expect(commitUi).toHaveBeenCalledTimes(1);
    expect(scheduleUiCommit).not.toHaveBeenCalled();
  });

  it("skips the delayed commit when asked not to schedule one", () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true, scheduleUi: false });
    });
    expect(commitUi).not.toHaveBeenCalled();
    expect(scheduleUiCommit).not.toHaveBeenCalled();
  });

  it("autosaves once the idle delay passes", async () => {
    act(() => {
      controller.markPageUnsaved();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(saveNotebookPageSnapshot).toHaveBeenCalledTimes(1);
    expect(store.read().saveStatus).toBe("saved");
  });

  it("defers autosave while a stroke is still in flight", async () => {
    act(() => {
      controller.markPageUnsaved();
    });
    inkInteracting = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(saveNotebookPageSnapshot).not.toHaveBeenCalled();

    inkInteracting = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(saveNotebookPageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reports the saved page back with the new revision", async () => {
    act(() => {
      controller.markPageUnsaved();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.pageId).toBe("page-1");
    expect(saved[0]?.contentRevision).toBe(4);
    expect(saved[0]?.updatedAt).toBe(2000);
    expect(store.read().contentRevision).toBe(4);
    // The ink goes as the editor handed it over, in whichever form that is.
    const handedOver = svgNotebookInkData("<svg data-async='true' />");
    expect(saveNotebookPageSnapshot.mock.calls[0]?.[1]).toMatchObject({ inkData: handedOver });
    expect(saved[0]?.inkData).toEqual(handedOver);
  });

  it("marks the page failed when the write rejects", async () => {
    saveNotebookPageSnapshot.mockRejectedValue(new Error("offline"));
    act(() => {
      controller.markPageUnsaved();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(store.read().saveStatus).toBe("failed");
  });

  it("does not save a page with no local edits", async () => {
    await act(async () => {
      await controller.saveCurrentPage();
    });
    // markPageUnsaved never ran, so there is nothing to write.
    expect(saveNotebookPageSnapshot).toHaveBeenCalledTimes(1);
    expect(writeNotebookPageDraft).not.toHaveBeenCalled();
  });

  it("refuses to save mid-stroke", async () => {
    inkInteracting = true;
    let result = true;
    await act(async () => {
      result = await controller.saveCurrentPage();
    });
    expect(result).toBe(false);
    expect(saveNotebookPageSnapshot).not.toHaveBeenCalled();
  });

  it("writes a recovery draft after the draft delay", async () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(writeNotebookPageDraft).toHaveBeenCalledTimes(1);
  });

  it("writes a synchronous draft for an unmount mid-edit", () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true, scheduleUi: false });
    });
    let wrote = false;
    act(() => {
      wrote = controller.persistCurrentPageDraftSync();
    });
    expect(wrote).toBe(true);
    expect(writeNotebookPageDraftSync).toHaveBeenCalledTimes(1);
  });

  it("skips the synchronous draft when the page has no edits yet", () => {
    let wrote = true;
    act(() => {
      wrote = controller.persistCurrentPageDraftSync();
    });
    expect(wrote).toBe(false);
    expect(writeNotebookPageDraftSync).not.toHaveBeenCalled();
  });

  it("captures the page synchronously when leaving the route", () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true, scheduleUi: false });
    });
    let queued = false;
    act(() => {
      queued = controller.queueCurrentPageSaveForExit();
    });
    expect(queued).toBe(true);
    expect(controller.hasSaveInFlight()).toBe(true);
  });

  it("does not queue an exit save during a stroke", () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true, scheduleUi: false });
    });
    inkInteracting = true;
    let queued = true;
    act(() => {
      queued = controller.queueCurrentPageSaveForExit();
    });
    expect(queued).toBe(false);
  });

  it("cancels pending work so a notebook switch cannot save the old page", async () => {
    act(() => {
      controller.markPageUnsaved({ deferUi: true, scheduleUi: false });
      controller.resetSaveTracking();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(saveNotebookPageSnapshot).not.toHaveBeenCalled();
    expect(writeNotebookPageDraft).not.toHaveBeenCalled();
  });

  it("schedules pending work without bumping the edit revision", async () => {
    act(() => {
      controller.schedulePendingWork();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // The revision is still 0, so the draft writer stays out of it.
    expect(writeNotebookPageDraft).not.toHaveBeenCalled();
    expect(saveNotebookPageSnapshot).toHaveBeenCalledTimes(1);
  });
});
