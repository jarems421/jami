export const NOTEBOOK_AUTOSAVE_IDLE_MS = 5_000;
export const NOTEBOOK_INK_UI_SYNC_IDLE_MS = 200;
/**
 * How long the page must sit still before a swipe snapshot is prepared.
 *
 * Long enough that it does not fire between two strokes of the same letter,
 * short enough that a page is ready to swipe well before a hand gets there.
 */
export const NOTEBOOK_INK_WARM_SNAPSHOT_IDLE_MS = 600;

export type NotebookSaveCompletionInput = {
  saveId: number;
  saveRevision: number;
  currentRevision: number;
  latestSaveId: number;
};

export function isNotebookSaveCompletionCurrent(input: NotebookSaveCompletionInput) {
  return input.saveId === input.latestSaveId && input.saveRevision === input.currentRevision;
}

export function shouldNotebookSaveUpdateLivePage(input: {
  pageId: string;
  selectedPageId: string | null;
  saveRevision: number;
  currentRevision: number;
}) {
  return (
    input.pageId === input.selectedPageId && input.saveRevision === input.currentRevision
  );
}

export function shouldNotebookSaveReplaceStoredPageContent(input: {
  pageId: string;
  selectedPageId: string | null;
  saveRevision: number;
  currentRevision: number;
}) {
  return input.pageId !== input.selectedPageId || input.saveRevision === input.currentRevision;
}

export function shouldStartNotebookAutosave(input: {
  loading: boolean;
  saveStatus: "saved" | "unsaved" | "saving" | "failed";
  hasSelectedPage: boolean;
  inkInteractionActive: boolean;
}) {
  return (
    !input.loading &&
    input.saveStatus === "unsaved" &&
    input.hasSelectedPage &&
    !input.inkInteractionActive
  );
}

export function shouldDiscardNotebookInkExport(input: {
  inkAvailable: boolean;
  inkInteractionActive: boolean;
  saveRevision: number;
  currentRevision: number;
}) {
  return (
    !input.inkAvailable ||
    input.inkInteractionActive ||
    input.saveRevision !== input.currentRevision
  );
}
