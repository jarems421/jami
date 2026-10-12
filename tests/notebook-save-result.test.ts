import { describe, expect, it } from "vitest";
import { withNotebookPage } from "@/lib/workspace/notebook-navigation";
import {
  applyNotebookPageSave,
  applyNotebookPreviewFromSave,
  type NotebookPageSaveResult,
} from "@/lib/workspace/notebook-save-result";
import {
  MAX_NOTEBOOK_PREVIEW_SVG_LENGTH,
  type Notebook,
  type NotebookPage,
} from "@/lib/workspace/notebooks";

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
    contentRevision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeResult(overrides: Partial<NotebookPageSaveResult> = {}): NotebookPageSaveResult {
  return {
    pageId: "page-1",
    typedContent: "  saved notes  ",
    textBlocks: [{ id: "b", x: 0, y: 0, width: 10, height: 10, text: "saved", outlineVisible: false }],
    inkData: { version: 2, format: "js-draw-svg", svg: "<svg>saved</svg>" },
    pageColor: "cream",
    pageStyle: "lined",
    status: "working",
    contentRevision: 4,
    updatedAt: 50,
    replaceStoredContent: true,
    ...overrides,
  };
}

describe("applying a completed save to the loaded page", () => {
  it("takes the saved content when nothing newer landed mid-save", () => {
    const legacy = makePage({
      strokeData: { version: 1, strokes: [{ points: [], color: "black", width: 2, tool: "pen" }] },
    });
    const saved = applyNotebookPageSave(legacy, makeResult());
    expect(saved.textBlocks.map((block) => block.text)).toEqual(["saved"]);
    expect(saved.inkData).toEqual({ version: 2, format: "js-draw-svg", svg: "<svg>saved</svg>" });
    // Saved ink is in the current format, so the legacy stroke list goes.
    expect(saved.strokeData).toBeUndefined();
    expect(saved.pageColor).toBe("cream");
    expect(saved.pageStyle).toBe("lined");
    expect(saved.typedContent).toBe("saved notes");
  });

  it("keeps the page's own content when a newer edit landed mid-save", () => {
    const page = makePage({
      textBlocks: [{ id: "b", x: 0, y: 0, width: 10, height: 10, text: "newer", outlineVisible: false }],
    });
    const saved = applyNotebookPageSave(page, makeResult({ replaceStoredContent: false }));
    expect(saved.textBlocks.map((block) => block.text)).toEqual(["newer"]);
    expect(saved.pageColor).toBe("white");
    // Revision, status and time always move on.
    expect(saved.contentRevision).toBe(4);
    expect(saved.status).toBe("working");
    expect(saved.updatedAt).toBe(50);
  });

  it("stores no typed content when the saved notes are blank", () => {
    expect(applyNotebookPageSave(makePage(), makeResult({ typedContent: "   " })).typedContent).toBeUndefined();
  });
});

describe("the notebook's preview after a save", () => {
  const notebook: Notebook = {
    id: "notebook-1",
    folderId: "folder-1",
    title: "Physics",
    type: "blank",
    topicIds: [],
    sourceIds: [],
    pageColor: "white",
    pageStyle: "plain",
    previewInkSvg: "<svg>old</svg>",
    previewPageId: "page-0",
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };

  it("shows the page just saved", () => {
    const next = applyNotebookPreviewFromSave(notebook, makeResult());
    expect(next.previewInkSvg).toBe("<svg>saved</svg>");
    expect(next.previewPageId).toBe("page-1");
    expect(next.updatedAt).toBe(50);
  });

  it("drops an ink preview too large to keep on the notebook record", () => {
    const huge = "x".repeat(MAX_NOTEBOOK_PREVIEW_SVG_LENGTH + 1);
    const inkData = { version: 2, format: "js-draw-svg", svg: huge } as const;
    expect(applyNotebookPreviewFromSave(notebook, makeResult({ inkData })).previewInkSvg).toBeUndefined();
  });

  it("keeps no preview of a page stored as Jami Ink's encoding alone, far too big for one", () => {
    const inkData = { version: 3, format: "jami-ink", data: "j3:AAAA" } as const;
    const next = applyNotebookPreviewFromSave(notebook, makeResult({ inkData }));
    expect(next.previewInkSvg).toBeUndefined();
    expect(next.previewPageId).toBe("page-1");
  });
});

describe("adding a page to the page list", () => {
  it("keeps page order and replaces a copy already there", () => {
    const pages = [makePage({ id: "a", pageNumber: 1 }), makePage({ id: "c", pageNumber: 3 })];
    expect(withNotebookPage(pages, makePage({ id: "b", pageNumber: 2 })).map((page) => page.id)).toEqual(["a", "b", "c"]);
    const replaced = withNotebookPage(pages, makePage({ id: "c", pageNumber: 3, title: "new" }));
    expect(replaced).toHaveLength(2);
    expect(replaced[1]?.title).toBe("new");
  });
});
