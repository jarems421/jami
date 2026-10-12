"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import type { NotebookPageStore } from "@/hooks/useNotebookPageState";
import { NOTEBOOK_INK_UI_SYNC_IDLE_MS } from "@/lib/workspace/notebook-autosave";
import {
  chooseNotebookHistorySource,
  pushNotebookHistoryEntry,
  syncInkHistoryTimestamps,
  type NotebookInkHistoryStamp,
  type NotebookPageHistoryEntry,
  type NotebookPlacedEdit,
  type NotebookPlacedStep,
} from "@/lib/workspace/notebook-history";
import type { NotebookTextBlock } from "@/lib/workspace/notebooks";

/** How long after a stroke ends that touch input is still treated as a palm. */
const STYLUS_TOUCH_COOLDOWN_MS = 180;

type PendingInkUi = {
  hasContent: boolean;
  undoDepth: number;
  redoDepth: number;
};

type UseNotebookInkControllerOptions = {
  pageState: NotebookPageStore;
  inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
  /** Marks the page dirty. `deferUi` keeps a stroke burst off the render loop. */
  onEdit: (options?: { deferUi?: boolean; scheduleUi?: boolean }) => void;
  /** Drops any text block selection or in-flight gesture. */
  resetTextBlockInteraction: () => void;
  /** Clears a stale autosave error once the editor UI catches up. */
  onUiCommitted: () => void;
};

export type NotebookInkController = {
  inkReadyRef: RefObject<boolean>;
  inkInteractionActiveRef: RefObject<boolean>;
  stylusInteractionRef: RefObject<boolean>;
  stylusCooldownUntilRef: RefObject<number>;
  inkReady: boolean;
  inkHasContent: boolean;
  /** Combined depth across ink, text and placed things, for the toolbar buttons. */
  undoDepth: number;
  redoDepth: number;
  setInkReady: (ready: boolean) => void;
  setInkHasContent: (hasContent: boolean) => void;
  /** True while a stroke is in flight or inside its touch cooldown. */
  isInteracting: () => boolean;
  recordTextEdit: (
    previous: NotebookTextBlock[],
    next: NotebookTextBlock[]
  ) => void;
  /** Records a change to images or graphs (`placedHistoryChange`). */
  recordPlacedEdit: (edit: NotebookPlacedEdit) => void;
  /** Whatever `run` records -- ink, text and placed things moved by one lasso drag -- undoes and redoes as one step. */
  together: (run: () => void) => void;
  /**
   * Undoes the latest step: ink and text here, while changes to images and
   * graphs come back for the page to apply (`useNotebookPlacedItems`).
   */
  undoStep: () => NotebookPlacedStep[];
  redoStep: () => NotebookPlacedStep[];
  clearHistory: () => void;
  /** Wipes the open page's ink as one edit. Text boxes stay. */
  clearInk: () => void;
  handleInkChange: () => void;
  handleInkHistoryChange: (undoDepth: number, redoDepth: number) => void;
  handleInteractionChange: (active: boolean) => void;
  commitUi: () => void;
  scheduleUiCommit: () => void;
  cancelUiCommit: () => void;
};

/**
 * Owns the ink editor and reconciles its history with the page's own.
 *
 * The ink editor keeps its stroke history internally and reports only how
 * deep it is, so undo used to check ink first and only fall through to text
 * blocks once every stroke was gone — meaning undo did not follow the order
 * the student actually worked in. This controller keeps a stack of stamps
 * mirroring the editor's depth, beside its own stack of text, image and graph
 * edits, and steps whichever moved most recently. Edits made together (a
 * lasso drag moving ink, text and pictures at once) share a group and are
 * stepped together.
 */
export function useNotebookInkController({
  pageState,
  inkEditorRef,
  onEdit,
  resetTextBlockInteraction,
  onUiCommitted,
}: UseNotebookInkControllerOptions): NotebookInkController {
  const inkReadyRef = useRef(false);
  const inkInteractionActiveRef = useRef(false);
  const stylusInteractionRef = useRef(false);
  const stylusCooldownUntilRef = useRef(0);
  const uiSyncTimerRef = useRef<number | null>(null);
  const pendingUiRef = useRef<PendingInkUi | null>(null);

  const pageUndoRef = useRef<NotebookPageHistoryEntry[]>([]);
  const pageRedoRef = useRef<NotebookPageHistoryEntry[]>([]);
  const inkUndoStampsRef = useRef<NotebookInkHistoryStamp[]>([]);
  const inkRedoStampsRef = useRef<NotebookInkHistoryStamp[]>([]);
  /** The group edits are recorded into while `together` runs, or being stepped. */
  const groupRef = useRef<number | null>(null);
  const groupCountRef = useRef(0);

  const [inkReady, setInkReady] = useState(false);
  const [inkHasContent, setInkHasContent] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);

  const latestRef = useRef({ onEdit, resetTextBlockInteraction, onUiCommitted });
  useEffect(() => {
    latestRef.current = { onEdit, resetTextBlockInteraction, onUiCommitted };
  }, [onEdit, onUiCommitted, resetTextBlockInteraction]);

  const publishDepths = useCallback(() => {
    setUndoDepth(inkUndoStampsRef.current.length + pageUndoRef.current.length);
    setRedoDepth(inkRedoStampsRef.current.length + pageRedoRef.current.length);
  }, []);

  const cancelUiCommit = useCallback(() => {
    if (uiSyncTimerRef.current === null) return;
    window.clearTimeout(uiSyncTimerRef.current);
    uiSyncTimerRef.current = null;
  }, []);

  const commitUi = useCallback(() => {
    cancelUiCommit();
    const pending = pendingUiRef.current;
    if (pending) {
      pendingUiRef.current = null;
      setInkHasContent(pending.hasContent);
    }
    publishDepths();
    pageState.flushPendingRender();
    latestRef.current.onUiCommitted();
  }, [cancelUiCommit, pageState, publishDepths]);

  const scheduleUiCommit = useCallback(() => {
    cancelUiCommit();
    uiSyncTimerRef.current = window.setTimeout(() => {
      uiSyncTimerRef.current = null;
      /*
       * As a transition, so React renders it in slices and lets input in
       * between them.
       *
       * This re-renders the whole notebook page, and it lands in the gaps
       * between words -- exactly when the next stroke is about to start. Left
       * as an ordinary update from a timer, React renders it in one piece, and
       * a pen landing part-way through waits for all of it before its first
       * ink. Nothing here is urgent: it is the undo buttons and the save
       * indicator catching up with strokes already on the page.
       */
      startTransition(commitUi);
    }, NOTEBOOK_INK_UI_SYNC_IDLE_MS);
  }, [cancelUiCommit, commitUi]);

  const isInteracting = useCallback(
    () =>
      inkInteractionActiveRef.current ||
      Boolean(inkEditorRef.current?.isInteracting()),
    [inkEditorRef]
  );

  /** A text, image or graph edit, newest on the page's own stack. */
  const recordPageEdit = useCallback(
    (edit: NotebookPlacedEdit | { kind: "texts"; previous: NotebookTextBlock[]; next: NotebookTextBlock[] }) => {
      pageUndoRef.current = pushNotebookHistoryEntry(pageUndoRef.current, {
        ...edit,
        at: Date.now(),
        group: groupRef.current,
      });
      // A new edit invalidates the redo branch on both histories.
      pageRedoRef.current = [];
      inkRedoStampsRef.current = [];
      publishDepths();
    },
    [publishDepths]
  );

  const recordTextEdit = useCallback(
    (previous: NotebookTextBlock[], next: NotebookTextBlock[]) => recordPageEdit({ kind: "texts", previous, next }),
    [recordPageEdit]
  );

  const together = useCallback((run: () => void) => {
    if (groupRef.current !== null) {
      run();
      return;
    }
    groupCountRef.current += 1;
    groupRef.current = groupCountRef.current;
    try {
      run();
    } finally {
      groupRef.current = null;
    }
  }, []);

  /**
   * One step back or forward: whichever of the ink and the page's own edits
   * moved last, with every edit made together with it.
   */
  const step = useCallback(
    (direction: "undo" | "redo"): NotebookPlacedStep[] => {
      const undoing = direction === "undo";
      const stamps = undoing ? inkUndoStampsRef.current : inkRedoStampsRef.current;
      const from = undoing ? pageUndoRef : pageRedoRef;
      const to = undoing ? pageRedoRef : pageUndoRef;
      const inkTop = stamps.at(-1) ?? null;
      const pageTop = from.current.at(-1) ?? null;
      const source = chooseNotebookHistorySource({
        inkTimestamp: inkTop?.at ?? null,
        pageTimestamp: pageTop?.at ?? null,
      });
      if (source === null) return [];
      const group = (source === "ink" ? inkTop?.group : pageTop?.group) ?? null;
      // Ink commands to step: the one on top, or every one of the group on top.
      const inkSteps =
        group === null
          ? Number(source === "ink")
          : stamps.length - 1 - stamps.findLastIndex((stamp) => stamp.group !== group);

      const placed: NotebookPlacedStep[] = [];
      let textsChanged = false;
      const stepEntry = (entry: NotebookPageHistoryEntry) => {
        from.current = from.current.slice(0, -1);
        to.current = pushNotebookHistoryEntry(to.current, entry);
        if (entry.kind === "texts") {
          pageState.setTextBlocks(undoing ? entry.previous : entry.next);
          textsChanged = true;
        } else {
          placed.push({ edit: entry, direction });
        }
      };
      if (group === null) {
        if (source === "page" && pageTop) stepEntry(pageTop);
      } else {
        for (let top = from.current.at(-1); top?.group === group; top = from.current.at(-1)) stepEntry(top);
      }
      if (inkSteps > 0) {
        // The editor reports its new depth as it steps, which carries the
        // stamps across with their group.
        groupRef.current = group;
        try {
          for (let count = 0; count < inkSteps; count += 1) {
            if (undoing) inkEditorRef.current?.undo();
            else inkEditorRef.current?.redo();
          }
        } finally {
          groupRef.current = null;
        }
      }
      publishDepths();
      if (textsChanged) {
        latestRef.current.resetTextBlockInteraction();
        latestRef.current.onEdit();
      }
      return placed;
    },
    [inkEditorRef, pageState, publishDepths]
  );

  const undoStep = useCallback(() => step("undo"), [step]);
  const redoStep = useCallback(() => step("redo"), [step]);

  const clearHistory = useCallback(() => {
    pageUndoRef.current = [];
    pageRedoRef.current = [];
    inkUndoStampsRef.current = [];
    inkRedoStampsRef.current = [];
    pendingUiRef.current = null;
    inkInteractionActiveRef.current = false;
    cancelUiCommit();
    setUndoDepth(0);
    setRedoDepth(0);
  }, [cancelUiCommit]);

  const clearInk = useCallback(() => {
    inkEditorRef.current?.clear();
    setInkHasContent(false);
    latestRef.current.onEdit();
  }, [inkEditorRef]);

  const handleInkChange = useCallback(() => {
    const current = pendingUiRef.current;
    pendingUiRef.current = {
      hasContent: inkEditorRef.current?.hasInk() ?? false,
      undoDepth: current?.undoDepth ?? inkUndoStampsRef.current.length,
      redoDepth: current?.redoDepth ?? inkRedoStampsRef.current.length,
    };
    latestRef.current.onEdit({ deferUi: true });
  }, [inkEditorRef]);

  const handleInkHistoryChange = useCallback(
    (nextUndoDepth: number, nextRedoDepth: number) => {
      const now = { at: Date.now(), group: groupRef.current };
      inkUndoStampsRef.current = syncInkHistoryTimestamps(
        inkUndoStampsRef.current,
        nextUndoDepth,
        now
      );
      inkRedoStampsRef.current = syncInkHistoryTimestamps(
        inkRedoStampsRef.current,
        nextRedoDepth,
        now
      );
      pendingUiRef.current = {
        hasContent:
          pendingUiRef.current?.hasContent ??
          (inkEditorRef.current?.hasInk() ?? false),
        undoDepth: nextUndoDepth,
        redoDepth: nextRedoDepth,
      };
      scheduleUiCommit();
    },
    [inkEditorRef, scheduleUiCommit]
  );

  const handleInteractionChange = useCallback((active: boolean) => {
    inkInteractionActiveRef.current = active;
    stylusInteractionRef.current = active;
    // While a stroke is live the cooldown never expires; a palm resting on the
    // page must not be read as a touch gesture until well after the pen lifts.
    stylusCooldownUntilRef.current = active
      ? Number.POSITIVE_INFINITY
      : Date.now() + STYLUS_TOUCH_COOLDOWN_MS;
  }, []);

  useEffect(() => cancelUiCommit, [cancelUiCommit]);

  return {
    inkReadyRef,
    inkInteractionActiveRef,
    stylusInteractionRef,
    stylusCooldownUntilRef,
    inkReady,
    inkHasContent,
    undoDepth,
    redoDepth,
    setInkReady,
    setInkHasContent,
    isInteracting,
    recordTextEdit,
    recordPlacedEdit: recordPageEdit,
    together,
    undoStep,
    redoStep,
    clearHistory,
    clearInk,
    handleInkChange,
    handleInkHistoryChange,
    handleInteractionChange,
    commitUi,
    scheduleUiCommit,
    cancelUiCommit,
  };
}
