import {
  createElement,
  forwardRef,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookFile } from "@/lib/workspace/notebooks";

const layerSpies = vi.hoisted(() => ({
  backgroundProps: [] as Array<Record<string, unknown>>,
  imageProps: [] as Array<Record<string, unknown>>,
  inkEditorProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    layerSpies.imageProps.push(props);
    return null;
  },
}));

vi.mock("@/components/workspace/NotebookPageBackground", () => ({
  default: (props: Record<string, unknown>) => {
    layerSpies.backgroundProps.push(props);
    return null;
  },
}));

vi.mock("@/components/workspace/NotebookInkEditor", () => ({
  NotebookInkEditor: forwardRef<unknown, Record<string, unknown>>(
    function MockNotebookInkEditor(props) {
      layerSpies.inkEditorProps.push(props);
      return null;
    }
  ),
}));

import {
  NotebookLivePageLayers,
  type NotebookLivePageLayersProps,
} from "@/components/workspace/NotebookLivePageLayers";

const pdfFile: NotebookFile = {
  id: "file-1",
  notebookId: "notebook-1",
  folderId: "folder-1",
  fileName: "paper.pdf",
  fileType: "application/pdf",
  storagePath: "notebooks/paper.pdf",
  uploadedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

function makeProps(
  overrides: Partial<NotebookLivePageLayersProps> = {}
): NotebookLivePageLayersProps {
  return {
    backgroundProps: {
      pageColor: "white",
      pageStyle: "lined",
      backgroundFile: pdfFile,
      backgroundUrl: "https://example.com/paper.pdf",
      pageIndex: 2,
      imageStrategy: "next-image",
      imageRenderKey: "page-1:file-1:image",
      imageOnSettled: vi.fn(),
      imageLoadingLabel: "Loading file...",
      imageSizes: "48rem",
      imageClassName: "object-contain",
      pdfRenderKey: "page-1:file-1:2",
      pdfAriaHidden: false,
      pdfAriaLabel: "Notebook file: paper.pdf, page 3",
      pdfFadeIn: false,
      pdfOnRenderStateChange: vi.fn(),
      pdfOnCanvasReady: vi.fn(),
    },
    editingEnabled: true,
    eraserWidth: "medium",
    hasPersistedInk: true,
    inkEditorMountRevision: 4,
    inkEditorProps: {
      activeTool: "eraser",
      eraserMode: "precision",
      penColor: "black",
      penSettings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
      penThickness: 3,
      highlighterColor: "yellow",
      highlighterThickness: 18,
      onChange: vi.fn(),
      onHistoryChange: vi.fn(),
      onInteractionChange: vi.fn(),
      onReady: vi.fn(),
      onReadyError: vi.fn(),
      onPointerCancel: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
    },
    inkEditorRef: { current: null },
    inkReady: false,
    onSwipeInkSnapshotReady: vi.fn(),
    pageHeight: 1240,
    pageId: "page-1",
    pageWidth: 900,
    persistedInk: { version: 2, format: "js-draw-svg", svg: "<svg data-page='one'></svg>" },
    swipeInkSnapshot: null,
    ...overrides,
  };
}

function renderLayers(props: NotebookLivePageLayersProps) {
  renderToStaticMarkup(createElement(NotebookLivePageLayers, props));
}

describe("NotebookLivePageLayers", () => {
  beforeEach(() => {
    layerSpies.backgroundProps.length = 0;
    layerSpies.imageProps.length = 0;
    layerSpies.inkEditorProps.length = 0;
  });

  it("forwards the live background contract with fixed layer classes", () => {
    const props = makeProps();

    renderLayers(props);

    expect(layerSpies.backgroundProps).toHaveLength(1);
    expect(layerSpies.backgroundProps[0]).toMatchObject({
      ...props.backgroundProps,
      // Promoted to GPU layers, so wet ink never repaints ruled paper or a PDF.
      pageStyleClassName:
        "pointer-events-none absolute inset-0 z-0 [contain:paint] [transform:translateZ(0)] [will-change:transform]",
      fileLayerClassName:
        "pointer-events-none absolute inset-0 z-[1] flex items-center justify-center overflow-hidden [contain:paint] [transform:translateZ(0)] [will-change:transform]",
      inkSvg: "<svg data-page='one'></svg>",
      inkSizes: "48rem",
      inkClassName:
        "pointer-events-none absolute inset-0 z-[12] object-fill",
    });
  });

  it("shows static persisted ink only until the live editor is ready", () => {
    renderLayers(makeProps({ inkReady: true }));
    expect(layerSpies.backgroundProps[0]?.inkSvg).toBeUndefined();

    layerSpies.backgroundProps.length = 0;
    renderLayers(makeProps({ hasPersistedInk: false }));
    expect(layerSpies.backgroundProps[0]?.inkSvg).toBeUndefined();
  });

  it.each([
    ["small", 36],
    ["medium", 56],
    ["large", 76],
  ] as const)(
    "maps the %s eraser and derives editor read-only state",
    (eraserWidth, eraserThickness) => {
      const props = makeProps({
        editingEnabled: false,
        eraserWidth,
      });

      renderLayers(props);

      expect(layerSpies.inkEditorProps).toHaveLength(1);
      expect(layerSpies.inkEditorProps[0]).toMatchObject({
        ...props.inkEditorProps,
        pageId: "page-1",
        pageWidth: 900,
        pageHeight: 1240,
        initialInk: props.persistedInk,
        eraserThickness,
        readOnly: true,
      });
    }
  );

  it("keeps the live editor remount key tied to page and mount revision", () => {
    const rendered = NotebookLivePageLayers(
      makeProps({
        inkEditorMountRevision: 7,
        pageId: "page-keyed",
      })
    );
    const children = rendered.props.children as ReactElement[];

    expect(children[1]?.key).toBe("page-keyed:7");
  });

  it("renders only the current page snapshot and reports when it loads", () => {
    const onSwipeInkSnapshotReady = vi.fn();
    renderLayers(
      makeProps({
        onSwipeInkSnapshotReady,
        swipeInkSnapshot: {
          pageId: "another-page",
          svg: "<svg data-page='other'></svg>",
        },
      })
    );
    expect(layerSpies.imageProps).toHaveLength(0);

    renderLayers(
      makeProps({
        onSwipeInkSnapshotReady,
        swipeInkSnapshot: {
          pageId: "page-1",
          svg: "<svg data-page='one'></svg>",
        },
      })
    );

    expect(layerSpies.imageProps).toHaveLength(1);
    expect(layerSpies.imageProps[0]).toMatchObject({
      alt: "",
      "aria-hidden": "true",
      fill: true,
      unoptimized: true,
      sizes: "48rem",
      className:
        "notebook-page-swipe-ink-snapshot pointer-events-none absolute inset-0 z-[25] object-fill",
    });
    expect(layerSpies.imageProps[0]?.src).toContain(
      encodeURIComponent("<svg data-page='one'></svg>")
    );

    const onLoad = layerSpies.imageProps[0]?.onLoad;
    expect(onLoad).toBeTypeOf("function");
    (onLoad as () => void)();
    expect(onSwipeInkSnapshotReady).toHaveBeenCalledOnce();
    expect(onSwipeInkSnapshotReady).toHaveBeenCalledWith("page-1");
  });
});
