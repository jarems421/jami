import type { PointerEvent as ReactPointerEvent } from "react";
import type { NotebookEraserMode } from "@/lib/workspace/notebook-eraser";
import type { NotebookInkStyle } from "@/lib/workspace/notebook-ink-types";
import type { NotebookInkRenderWindow } from "@/lib/workspace/notebook-ink-window";
import type { NotebookInkData } from "@/lib/workspace/notebooks";

/**
 * What the page and the exam working sheet do with a notebook's ink, whichever
 * engine is behind it (js-draw, or Jami Ink when `enableJamiInk` is on).
 *
 * The ink comes out as it is stored: SVG from js-draw, and from Jami Ink the
 * same with its own encoding alongside (`NotebookInkData`). Whatever wants a
 * picture of it reads it through `notebookInkSvg`.
 */
export type NotebookInkEditorHandle = {
  clear(): void;
  getHistoryState(): { undoDepth: number; redoDepth: number };
  hasInk(): boolean;
  isInteracting(): boolean;
  redo(): void;
  serialize(): NotebookInkData | null;
  serializeAsync(): Promise<NotebookInkData | null>;
  /**
   * The most recent snapshot, taken off the critical path.
   *
   * A page swipe needs the outgoing page the instant the gesture starts, and
   * `serialize()` blocks the main thread to produce it -- on the very
   * pointermove that begins the swipe, which is where a stall is most visible.
   * This returns a snapshot that was already prepared while the page sat idle,
   * and falls back to the blocking path only when there is none.
   */
  serializeWarm(): NotebookInkData | null;
  setEraserMode(mode: NotebookEraserMode): void;
  undo(): void;
};

export type NotebookInkEditorCallbacks = {
  onChange(): void;
  onHistoryChange(undoDepth: number, redoDepth: number): void;
  onInteractionChange(active: boolean): void;
  onReady?(): void;
  onReadyError?(error: unknown): void;
};

/**
 * Where the sheet sits in the frame that shows it: the sheet's origin inside
 * the frame (`pageX`, `pageY`, negative once the sheet is pushed left or up)
 * and the frame's size. The same numbers `getNotebookInkRenderWindow` takes.
 *
 * Jami Ink needs the part of the sheet on screen after every pan settles, and
 * the snapped `inkWindow` does not change for a small pan. js-draw ignores it.
 */
export type NotebookInkFrame = {
  pageX: number;
  pageY: number;
  frameWidth: number;
  frameHeight: number;
};

export type NotebookInkEditorProps = NotebookInkStyle &
  NotebookInkEditorCallbacks & {
    /** The page's saved ink, read once when the editor mounts; null for a blank page. */
    initialInk: NotebookInkData | null;
    /**
     * The slice of a zoomed sheet worth painting, or null for the whole sheet.
     * See `notebook-ink-window.ts` for why a zoomed page is not painted whole.
     */
    inkWindow?: NotebookInkRenderWindow | null;
    inkFrame?: NotebookInkFrame | null;
    pageHeight: number;
    pageId: string;
    pageWidth: number;
    onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void;
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void;
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void;
    readOnly?: boolean;
    /** Scribbling out with the pen deletes the strokes it covers. */
    scribbleToErase?: boolean;
    /**
     * Holding the pen still may snap a stroke to a shape, not only a line, when
     * the pen's settings ask for shapes. Notebook pages only: the exam working
     * sheet straightens lines and nothing more (AGENTS.md, Jami Ink). Jami Ink
     * only; js-draw straightens lines alone.
     */
    shapesOnHold?: boolean;
  };
