import { describe, expect, it } from "vitest";
import {
  NOTEBOOK_AUTOSAVE_IDLE_MS,
  NOTEBOOK_INK_UI_SYNC_IDLE_MS,
  isNotebookSaveCompletionCurrent,
  shouldDiscardNotebookInkExport,
  shouldNotebookSaveReplaceStoredPageContent,
  shouldNotebookSaveUpdateLivePage,
  shouldStartNotebookAutosave,
} from "@/lib/workspace/notebook-autosave";

describe("notebook autosave race guards", () => {
  it("waits five seconds after the latest edit", () => {
    expect(NOTEBOOK_AUTOSAVE_IDLE_MS).toBe(5_000);
  });

  it("batches nonessential ink UI updates after a short idle period", () => {
    expect(NOTEBOOK_INK_UI_SYNC_IDLE_MS).toBe(200);
  });

  it("allows the current latest save to mark the editor saved", () => {
    expect(
      isNotebookSaveCompletionCurrent({
        saveId: 2,
        saveRevision: 5,
        currentRevision: 5,
        latestSaveId: 2,
      })
    ).toBe(true);
  });

  it("rejects an older save completion after newer local edits", () => {
    expect(
      isNotebookSaveCompletionCurrent({
        saveId: 1,
        saveRevision: 5,
        currentRevision: 6,
        latestSaveId: 1,
      })
    ).toBe(false);
  });

  it("rejects an older save completion when a newer save is in flight", () => {
    expect(
      isNotebookSaveCompletionCurrent({
        saveId: 1,
        saveRevision: 5,
        currentRevision: 5,
        latestSaveId: 2,
      })
    ).toBe(false);
  });

  it("does not let stale saves replace the live selected page", () => {
    expect(
      shouldNotebookSaveUpdateLivePage({
        pageId: "page-1",
        selectedPageId: "page-1",
        saveRevision: 10,
        currentRevision: 11,
      })
    ).toBe(false);
  });

  it("allows current saves to update the live selected page", () => {
    expect(
      shouldNotebookSaveUpdateLivePage({
        pageId: "page-1",
        selectedPageId: "page-1",
        saveRevision: 10,
        currentRevision: 10,
      })
    ).toBe(true);
  });

  it("keeps stale active-page content out of stored page metadata", () => {
    expect(
      shouldNotebookSaveReplaceStoredPageContent({
        pageId: "page-1",
        selectedPageId: "page-1",
        saveRevision: 10,
        currentRevision: 11,
      })
    ).toBe(false);
  });

  it("still lets non-active pages accept completed save content", () => {
    expect(
      shouldNotebookSaveReplaceStoredPageContent({
        pageId: "page-2",
        selectedPageId: "page-1",
        saveRevision: 10,
        currentRevision: 11,
      })
    ).toBe(true);
  });

  it("starts autosave only after writing is idle", () => {
    expect(
      shouldStartNotebookAutosave({
        loading: false,
        saveStatus: "unsaved",
        hasSelectedPage: true,
        inkInteractionActive: false,
      })
    ).toBe(true);
    expect(
      shouldStartNotebookAutosave({
        loading: false,
        saveStatus: "unsaved",
        hasSelectedPage: true,
        inkInteractionActive: true,
      })
    ).toBe(false);
  });

  it("discards an export when writing resumes during serialization", () => {
    expect(
      shouldDiscardNotebookInkExport({
        inkAvailable: true,
        inkInteractionActive: false,
        saveRevision: 12,
        currentRevision: 12,
      })
    ).toBe(false);
    expect(
      shouldDiscardNotebookInkExport({
        inkAvailable: true,
        inkInteractionActive: false,
        saveRevision: 12,
        currentRevision: 13,
      })
    ).toBe(true);
    expect(
      shouldDiscardNotebookInkExport({
        inkAvailable: true,
        inkInteractionActive: true,
        saveRevision: 12,
        currentRevision: 12,
      })
    ).toBe(true);
  });
});
