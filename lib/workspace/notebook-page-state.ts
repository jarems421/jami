import type {
  NotebookPage,
  NotebookPageColor,
  NotebookPageStyle,
  NotebookStrokeTool,
  NotebookTextBlock,
} from "@/lib/workspace/notebooks";

/** Autosave state for the open page. Re-exported by `NotebookSaveIndicator`. */
export type NotebookSaveStatus = "saved" | "unsaved" | "saving" | "failed";

export type NotebookEditorTool = NotebookStrokeTool | "text" | "select" | "lasso";

/*
 * Whether images and graphs can be picked up and moved.
 *
 * There is no select button any more. Select is still where the notebook rests
 * when no tool is on, but on an iPad without a keyboard nothing leads back to
 * it once a pen is chosen -- so the text tool, the one non-drawing tool on the
 * toolbar, moves placed things too.
 */
export function notebookToolMovesPlacedItems(tool: NotebookEditorTool) {
  return tool === "select" || tool === "text";
}

/**
 * The notebook state every controller needs to agree on.
 *
 * Autosave, hydration, page navigation, and the ink engine all read and write
 * these values. Holding them in one snapshot is what stops a `setX` and its
 * mirror `xRef.current = x` from drifting apart, which is why writes go through
 * {@link applyNotebookPageStateAction} rather than being set field by field.
 */
export type NotebookPageState = {
  /** The open page, mirrored from the `pages` list so handlers can read it. */
  selectedPage: NotebookPage | null;
  textBlocks: NotebookTextBlock[];
  pageColor: NotebookPageColor;
  pageStyle: NotebookPageStyle;
  saveStatus: NotebookSaveStatus;
  tool: NotebookEditorTool;
  /**
   * Server revision of the loaded page content. Stale-write guards compare
   * against this, so it must move in lockstep with `selectedPage`.
   */
  contentRevision: number;
  /** Page whose content has been loaded into the editor, or null while loading. */
  hydratedPageId: string | null;
};

export type NotebookPageStateAction =
  | { type: "selectPage"; page: NotebookPage | null }
  | { type: "hydratePage"; pageId: string; contentRevision: number }
  | { type: "resetHydration" }
  | { type: "setTextBlocks"; textBlocks: NotebookTextBlock[] }
  | { type: "setPageColor"; pageColor: NotebookPageColor }
  | { type: "setPageStyle"; pageStyle: NotebookPageStyle }
  | { type: "setSaveStatus"; saveStatus: NotebookSaveStatus }
  | { type: "setTool"; tool: NotebookEditorTool }
  | { type: "setContentRevision"; contentRevision: number }
  | { type: "resetForNotebookChange" };

export const INITIAL_NOTEBOOK_PAGE_STATE: NotebookPageState = {
  selectedPage: null,
  textBlocks: [],
  pageColor: "white",
  pageStyle: "plain",
  saveStatus: "saved",
  tool: "pen",
  contentRevision: 0,
  hydratedPageId: null,
};

export function applyNotebookPageStateAction(
  state: NotebookPageState,
  action: NotebookPageStateAction
): NotebookPageState {
  switch (action.type) {
    case "selectPage": {
      if (state.selectedPage === action.page) return state;
      return { ...state, selectedPage: action.page };
    }
    case "hydratePage": {
      return {
        ...state,
        hydratedPageId: action.pageId,
        contentRevision: action.contentRevision,
      };
    }
    case "resetHydration": {
      if (state.hydratedPageId === null) return state;
      return { ...state, hydratedPageId: null };
    }
    case "setTextBlocks": {
      if (state.textBlocks === action.textBlocks) return state;
      return { ...state, textBlocks: action.textBlocks };
    }
    case "setPageColor": {
      if (state.pageColor === action.pageColor) return state;
      return { ...state, pageColor: action.pageColor };
    }
    case "setPageStyle": {
      if (state.pageStyle === action.pageStyle) return state;
      return { ...state, pageStyle: action.pageStyle };
    }
    case "setSaveStatus": {
      if (state.saveStatus === action.saveStatus) return state;
      return { ...state, saveStatus: action.saveStatus };
    }
    case "setTool": {
      if (state.tool === action.tool) return state;
      return { ...state, tool: action.tool };
    }
    case "setContentRevision": {
      if (state.contentRevision === action.contentRevision) return state;
      return { ...state, contentRevision: action.contentRevision };
    }
    case "resetForNotebookChange": {
      // Keep the chosen tool: it is a user preference, not page content.
      return {
        ...INITIAL_NOTEBOOK_PAGE_STATE,
        tool: state.tool,
      };
    }
  }
}

/** True when the editor content matches the page the user has selected. */
export function isNotebookPageHydrated(state: NotebookPageState) {
  return (
    state.selectedPage !== null &&
    state.hydratedPageId === state.selectedPage.id
  );
}

/** Unsaved and failed both mean the page still holds work worth flushing. */
export function notebookPageHasPendingWork(state: NotebookPageState) {
  return state.saveStatus === "unsaved" || state.saveStatus === "failed";
}
