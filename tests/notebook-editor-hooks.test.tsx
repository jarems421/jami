// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotebookPageState, type NotebookPageStore } from "@/hooks/useNotebookPageState";
import type { NotebookPage, NotebookTextBlock } from "@/lib/workspace/notebooks";

/**
 * Three parts of the notebook editor page, moved into hooks of their own:
 * how it meets Tutor, what keeps a gesture from being left half-done, and
 * what it does as the ink editor starts and as strokes begin and end. These
 * pin what the page did with them before they moved.
 */

const mocks = vi.hoisted(() => ({
  recordTutorUse: vi.fn(async () => undefined),
  installStylusListeners: vi.fn(() => () => undefined),
  clearSelection: vi.fn(),
  loadPageView: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("@/services/study/practice-papers", () => ({
  recordPracticePaperTutorUse: mocks.recordTutorUse,
}));
vi.mock("@/services/learning/notebook-page-view", () => ({
  loadNotebookPageLearningView: mocks.loadPageView,
  forgetNotebookPageLearningView: vi.fn(),
}));
vi.mock("@/lib/workspace/notebook-interaction-lock", () => ({
  installNotebookStylusTouchListeners: mocks.installStylusListeners,
  clearNotebookNativeSelection: mocks.clearSelection,
}));

const { useNotebookTutorBridge } = await import("@/hooks/useNotebookTutorBridge");
const { useNotebookInteractionGuards } = await import("@/hooks/useNotebookInteractionGuards");
const { useNotebookInkEditorEvents } = await import("@/hooks/useNotebookInkEditorEvents");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE: NotebookPage = {
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
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Renders a hook with a real page store, and hands both back. */
function renderWithStore<T>(useHook: (store: NotebookPageStore) => T) {
  const seen: { store?: NotebookPageStore; value?: T } = {};
  function Harness() {
    const { store } = useNotebookPageState();
    const value = useHook(store);
    useEffect(() => {
      seen.store = store;
      seen.value = value;
    });
    return null;
  }
  act(() => root.render(<Harness />));
  return seen as { store: NotebookPageStore; value: T };
}

describe("the notebook's Tutor bridge", () => {
  const options = (overrides: Partial<Parameters<typeof useNotebookTutorBridge>[0]> = {}) => ({
    userId: "user-1",
    notebook: { id: "notebook-1" } as Parameters<typeof useNotebookTutorBridge>[0]["notebook"],
    selectedPage: null,
    assistantOpen: false,
    setAssistantOpen: vi.fn(),
    setPagesDrawerOpen: vi.fn(),
    closeDrawingToolMenus: vi.fn(),
    practicePaperStatus: null,
    pageHasWork: false,
    pageEditingEnabled: true,
    currentImageRefsFor: () => [],
    currentGraphBlocksFor: () => [],
    insertTextBlock: vi.fn(() => true),
    showError: vi.fn(),
    success: vi.fn(),
    ...overrides,
  });

  it("opens Tutor over the page, noting its use during a practice paper", () => {
    const input = options({ practicePaperStatus: "in_progress" });
    const { value } = renderWithStore((pageState) => useNotebookTutorBridge({ ...input, pageState }));
    act(() => value.handleAssistantOpenChange(true));
    expect(mocks.recordTutorUse).toHaveBeenCalledWith("user-1", "notebook-1");
    expect(input.setPagesDrawerOpen).toHaveBeenCalledWith(false);
    expect(input.closeDrawingToolMenus).toHaveBeenCalled();
    expect(input.setAssistantOpen).toHaveBeenCalledWith(true);
  });

  it("offers marking only once the page has work on it", () => {
    const blank = renderWithStore((pageState) => useNotebookTutorBridge({ ...options(), pageState }));
    expect(blank.value.quickActions.map((action) => action.label)).not.toContain("Mark my work");
  });

  it("asks the engine about the page only while Tutor is open, and takes its starting point", async () => {
    const page = { id: "page-1", notebookId: "notebook-1" } as NotebookPage;
    mocks.loadPageView.mockClear();
    mocks.loadPageView.mockResolvedValue({
      attribution: "page-topics",
      concepts: [{ key: "topic:eigen", label: "Eigenvectors" }],
      action: { kind: "exam-question", topicKey: "topic:eigen", label: "Eigenvectors" },
    });

    renderWithStore((pageState) => useNotebookTutorBridge({ ...options({ selectedPage: page }), pageState }));
    expect(mocks.loadPageView).not.toHaveBeenCalled();

    const open = options({ selectedPage: page, assistantOpen: true, pageHasWork: true });
    const seen = renderWithStore((pageState) => useNotebookTutorBridge({ ...open, pageState }));
    // The view arrives after the first render; the harness keeps the latest value.
    await act(async () => undefined);
    expect(mocks.loadPageView).toHaveBeenCalledWith("notebook-1", "page-1");
    expect(seen.value.quickActions.map((action) => action.label)).toEqual([
      "Check my working",
      "Mark my work",
      "Try an exam question",
    ]);
    expect(seen.value.pageFocus?.view.concepts).toEqual([{ key: "topic:eigen", label: "Eigenvectors" }]);
  });

  it("puts an answer on an editable page, and refuses one that is not", () => {
    const input = options();
    const { store, value } = renderWithStore((pageState) => useNotebookTutorBridge({ ...input, pageState }));
    expect(value.handleTutorAnswerInsert("x = 4")).toBe(false);

    act(() => store.selectPage(PAGE));
    let added = false;
    act(() => {
      added = value.handleTutorAnswerInsert("x = 4");
    });
    expect(added).toBe(true);
    const inserted = vi.mocked(input.insertTextBlock).mock.calls[0]?.[0] as NotebookTextBlock | undefined;
    expect(inserted?.text).toContain("x = 4");
    expect(input.success).toHaveBeenCalledWith("Answer added to this page.");

    const locked = options({ pageEditingEnabled: false });
    const second = renderWithStore((pageState) => useNotebookTutorBridge({ ...locked, pageState }));
    act(() => second.store.selectPage(PAGE));
    expect(second.value.handleTutorAnswerInsert("x = 4")).toBe(false);
    expect(locked.showError).toHaveBeenCalledWith("This page can't be edited here, so the answer can't be added to it.");
  });
});

describe("the notebook's interaction guards", () => {
  const guards = (readySurfacePageId: string | null) => {
    const input = {
      finishActiveTextBlockGesture: vi.fn(),
      stylusInteractionRef: { current: true },
      stylusCooldownUntilRef: { current: 0 },
      cancelActivePinch: vi.fn(() => true),
      cancelPinchZoomAnimationFrame: vi.fn(),
      setPagePan: vi.fn(),
      pagePanLiveRef: { current: { x: 12, y: -4 } },
      interruptPageTurn: vi.fn(),
      pageSurfaceRef: { current: document.createElement("div") },
      readySurfacePageId,
      inkInteractionActiveRef: { current: false },
    };
    function Harness() {
      useNotebookInteractionGuards(input);
      return null;
    }
    act(() => root.render(<Harness />));
    return input;
  };

  it("finishes every gesture when the app loses focus or the page is hidden", () => {
    const input = guards("page-1");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(input.finishActiveTextBlockGesture).toHaveBeenCalledTimes(1);
    expect(input.stylusInteractionRef.current).toBe(false);
    expect(input.stylusCooldownUntilRef.current).toBeGreaterThan(Date.now());
    expect(input.cancelActivePinch).toHaveBeenCalledWith({ clearPointers: true });
    expect(input.setPagePan).toHaveBeenCalledWith({ x: 12, y: -4 });
    expect(input.interruptPageTurn).toHaveBeenCalledTimes(1);
    expect(mocks.clearSelection).toHaveBeenCalledWith(document);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(input.interruptPageTurn).toHaveBeenCalledTimes(2);
  });

  it("guards the page from Safari taking a Pencil stroke only once the page is laid out", () => {
    guards(null);
    expect(mocks.installStylusListeners).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    guards("page-1");
    expect(mocks.installStylusListeners).toHaveBeenCalledTimes(1);
  });
});

describe("the notebook's ink editor events", () => {
  const events = () => {
    const input = {
      inkReadyRef: { current: false },
      setInkReady: vi.fn(),
      requestHandoffCheck: vi.fn(),
      showError: vi.fn(),
      handleInkInteractionChange: vi.fn(),
      closeDrawingToolMenus: vi.fn(),
      pagesDrawerOpen: true,
      setPagesDrawerOpen: vi.fn(),
      clearPlacedSelection: vi.fn(),
      cancelInkUiSync: vi.fn(),
      scheduleInkUiSync: vi.fn(),
      cancelScheduledPersistence: vi.fn(),
      schedulePendingWork: vi.fn(),
    };
    const seen = renderWithStore((pageState) => useNotebookInkEditorEvents({ ...input, pageState }));
    return { input, ...seen };
  };

  it("marks the page ready, or says the editor could not start", () => {
    const { input, value } = events();
    act(() => value.onReady());
    expect(input.inkReadyRef.current).toBe(true);
    expect(input.setInkReady).toHaveBeenCalledWith(true);
    act(() => value.onReadyError());
    expect(input.showError).toHaveBeenCalledWith(
      "This page opened, but the ink editor could not start. Your saved writing is still visible."
    );
    expect(input.requestHandoffCheck).toHaveBeenCalledTimes(2);
  });

  it("clears the way as a stroke begins, and schedules what it held back as it ends", () => {
    const { input, store, value } = events();
    act(() => value.onInteractionChange(true));
    expect(input.closeDrawingToolMenus).toHaveBeenCalled();
    expect(input.setPagesDrawerOpen).toHaveBeenCalledWith(false);
    expect(input.clearPlacedSelection).toHaveBeenCalled();
    expect(input.cancelInkUiSync).toHaveBeenCalled();
    expect(input.cancelScheduledPersistence).toHaveBeenCalled();

    act(() => value.onInteractionChange(false));
    expect(input.scheduleInkUiSync).toHaveBeenCalledTimes(1);
    expect(input.schedulePendingWork).not.toHaveBeenCalled();

    act(() => store.setSaveStatus("unsaved"));
    act(() => value.onInteractionChange(false));
    expect(input.schedulePendingWork).toHaveBeenCalledTimes(1);
  });
});
