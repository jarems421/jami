// @vitest-environment jsdom

import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import { useNotebookInkController } from "@/hooks/useNotebookInkController";
import { useNotebookPageState, type NotebookPageStore } from "@/hooks/useNotebookPageState";
import { useNotebookPlacedItems } from "@/hooks/useNotebookPlacedItems";
import { normalizeNotebookGraphBlocks } from "@/lib/workspace/notebook-graphs";
import type { NotebookImageRef, NotebookPage } from "@/lib/workspace/notebooks";

const updateImages = vi.fn<(userId: string, input: { imageRefs: NotebookImageRef[] }) => Promise<{ updatedAt: number }>>(
  async () => ({ updatedAt: 1 })
);
const updateGraphs = vi.fn(async () => ({ updatedAt: 1 }));
const deleteFile = vi.fn(async () => undefined);
vi.mock("@/services/study/notebooks", () => ({
  updateNotebookPageImages: (userId: string, input: { imageRefs: NotebookImageRef[] }) => updateImages(userId, input),
  updateNotebookPageGraphs: () => updateGraphs(),
}));
vi.mock("@/services/study/notebook-page-images", () => ({
  addUploadedImageToNotebookPage: vi.fn(),
  deleteUploadedNotebookImageFile: () => deleteFile(),
}));

const image: NotebookImageRef = { id: "upload-i", x: 100, y: 100, displayWidth: 200, displayHeight: 150 };
const moved: NotebookImageRef = { ...image, x: 300 };
const graph = normalizeNotebookGraphBlocks([{ id: "g", x: 80, y: 400, width: 300, height: 260 }])[0];
const page = { id: "p", imageRefs: [image], graphBlocks: [graph], textBlocks: [] } as unknown as NotebookPage;

type Api = { store: NotebookPageStore; placed: ReturnType<typeof useNotebookPlacedItems> };
let api: Api;
let container: HTMLDivElement;
let root: Root;
const noop = () => undefined;

function Harness() {
  const { store } = useNotebookPageState();
  const [, setPages] = useState<NotebookPage[]>([page]);
  const inkEditorRef = useRef<NotebookInkEditorHandle | null>(null);
  const history = useNotebookInkController({
    pageState: store,
    inkEditorRef,
    onEdit: noop,
    resetTextBlockInteraction: noop,
    onUiCommitted: noop,
  });
  const placed = useNotebookPlacedItems({
    userId: "u",
    notebookId: "n",
    pageState: store,
    setPages,
    openPageId: "p",
    tool: "select",
    isPhoneLayout: false,
    closeToolMenus: noop,
    success: noop,
    showError: noop,
    showThrownError: noop,
    shared: { inkEditorRef, history, markUnsaved: noop },
  });
  useEffect(() => {
    api = { store, placed };
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  updateImages.mockClear();
  updateGraphs.mockClear();
  deleteFile.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
  act(() => api.store.selectPage(page));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Lets the queued page writes run. */
const settle = () => act(async () => undefined);

describe("undo for images and graphs", () => {
  it("undoes and redoes moving an image, saving each step", async () => {
    await act(() => api.placed.handleImagesCommit([moved]));
    expect(api.placed.currentImageRefsFor("p")).toEqual([moved]);

    act(() => api.placed.undo());
    // Shown at once, and saved behind.
    expect(api.placed.currentImageRefsFor("p")).toEqual([image]);
    await settle();
    expect(updateImages).toHaveBeenLastCalledWith("u", expect.objectContaining({ imageRefs: [image] }));

    act(() => api.placed.redo());
    expect(api.placed.currentImageRefsFor("p")).toEqual([moved]);
    await settle();
    expect(updateImages).toHaveBeenLastCalledWith("u", expect.objectContaining({ imageRefs: [moved] }));
    expect(updateImages).toHaveBeenCalledTimes(3);
  });

  it("brings back a deleted graph", async () => {
    act(() => api.placed.graphLayerProps.onDelete("g"));
    await settle();
    expect(api.placed.currentGraphBlocksFor("p")).toEqual([]);

    act(() => api.placed.undo());
    expect(api.placed.currentGraphBlocksFor("p")).toEqual([graph]);
    await settle();
    expect(updateGraphs).toHaveBeenCalledTimes(2);
  });

  it("never undoes deleting an image, whose file is gone", async () => {
    act(() => api.placed.imageLayerProps.onDelete("upload-i"));
    await settle();
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(api.placed.currentImageRefsFor("p")).toEqual([]);

    act(() => api.placed.undo());
    await settle();
    expect(api.placed.currentImageRefsFor("p")).toEqual([]);
    expect(updateImages).toHaveBeenCalledTimes(1);
  });
});
