import {
  applyInkChange,
  inkAddChange,
  inkClearChange,
  inkDiffChange,
  inkRemoveChange,
  InkHistory,
  invertInkChange,
  type InkChange,
} from "@/lib/ink/history";
import { inkToSvg } from "@/lib/ink/export-svg";
import { importJsDrawSvg } from "@/lib/ink/import-js-draw-svg";
import {
  createInkItemId,
  emptyInkDocument,
  inkItemBounds,
  type InkBox,
  type InkDocument,
  type InkOutlineItem,
  type InkPoint,
} from "@/lib/ink/model";
import { InkSpatialIndex } from "@/lib/ink/spatial-index";
import { planInkScribbleErase } from "@/lib/ink/tools/scribble-erase";
import type { InkTimers } from "@/lib/ink-dom/hold-detector";
import {
  createInkRenderer,
  type InkPageSize,
  type InkRenderer,
  type InkRendererOptions,
  type InkViewport,
} from "@/lib/ink-dom/renderer";
import { InkEraseGesture, type InkEraseInput } from "@/lib/ink-dom/surface-erase";
import {
  InkStrokeSession,
  type InkPointerSample,
  type InkScreenMapping,
  type InkStrokeTool,
} from "@/lib/ink-dom/stroke-session";

/**
 * `InkSurface`: the engine core of Jami Ink for one page. It owns the page's
 * document, its undo history, the spatial index and the renderer, and runs the
 * pen and eraser gestures. It is plain TypeScript outside React; whoever hosts
 * it (`NotebookInkEditor`) turns pointer events into the calls below and says
 * where the sheet is on screen. It reads no layout and allocates no canvas.
 *
 * - **A stroke** is an `InkStrokeSession` drawing on the renderer's live layer.
 *   At the lift the surface commits exactly what live ink last drew (the same
 *   path and paint objects), so the lift changes no pixel. A scribble over
 *   existing ink instead removes what it covered, as one undo step, and the
 *   scribble itself never enters the document.
 * - **An erase** (`surface-erase.ts`) edits the page packet by packet so ink
 *   goes as the eraser passes, and becomes one undo step when it ends.
 * - **The index** (`InkSpatialIndex`) is kept in step with every change, on
 *   boxes that include the stroke's reach.
 */

export type InkScribble = { band: { hull: InkPoint[]; bounds: InkBox }; majorExtent: number };

export type InkSurfaceOptions = {
  page: InkPageSize;
  /** After every edit (a stroke, an erase, undo, redo, clear), never on load. */
  onChange(): void;
  onHistoryChange(undoDepth: number, redoDepth: number): void;
  renderer?: InkRendererOptions;
  /** For tests: stands in for the renderer. */
  createRenderer?: (host: HTMLElement, options: InkRendererOptions & { page: InkPageSize }) => InkRenderer;
  /** Passed to stroke sessions (the hold that straightens a line). */
  timers?: InkTimers;
};

export type InkSurface = {
  /** Shows a saved page: history cleared, no `onChange`. */
  load(svg: string): void;
  setViewport(viewport: InkViewport): void;
  beginGesture(): void;
  endGesture(): void;
  whenVisibleDrawn(callback: () => void): () => void;
  beginStroke(input: { tool: InkStrokeTool; mapping: InkScreenMapping; first: InkPointerSample }): void;
  /** Returns how far ahead of the line the predicted tip was drawn, in CSS pixels (0 for none). */
  moveStroke(samples: readonly InkPointerSample[], predicted?: readonly InkPointerSample[]): number;
  /** `"empty"`: the stroke had nothing worth keeping. `"scribbled"`: it erased ink instead. */
  endStroke(scribble?: InkScribble | null): "committed" | "scribbled" | "empty";
  cancelStroke(): void;
  /** `at`, and every point after, in page units. */
  beginErase(input: InkEraseInput): void;
  moveErase(points: readonly InkPoint[]): void;
  endErase(): void;
  cancelErase(): void;
  /** A stroke or an erase is in progress. */
  readonly busy: boolean;
  undo(): void;
  redo(): void;
  clear(): void;
  hasInk(): boolean;
  historyState(): { undoDepth: number; redoDepth: number };
  /** The committed document as SVG; cached until the document changes. */
  serialize(): string;
  destroy(): void;
};

type Stroke = { session: InkStrokeSession; pen: boolean };

function isEmptyChange(change: InkChange): boolean {
  return change.removed.length === 0 && change.added.length === 0;
}

export function createInkSurface(host: HTMLElement, options: InkSurfaceOptions): InkSurface {
  const rendererOptions = { ...options.renderer, page: options.page };
  const renderer = (options.createRenderer ?? createInkRenderer)(host, rendererOptions);
  const index = new InkSpatialIndex();
  const history = new InkHistory();
  let doc: InkDocument = emptyInkDocument();
  let stroke: Stroke | null = null;
  let erase: InkEraseGesture | null = null;
  let cancelWarmUp: (() => void) | null = null;
  let destroyed = false;
  let serialized: { doc: InkDocument; svg: string } | null = null;

  function syncIndex(change: InkChange): void {
    for (const { item } of change.removed) index.delete(item.id);
    for (const { item } of change.added) index.set(item.id, inkItemBounds(item));
  }

  /** Puts `change` on the page: document, index and renderer. No history. */
  function apply(change: InkChange): void {
    doc = applyInkChange(doc, change);
    syncIndex(change);
    renderer.applyChange(doc, change);
  }

  function reportHistory(): void {
    options.onHistoryChange(history.undoDepth, history.redoDepth);
  }

  /** Records an edit that is already on the page and tells the host. */
  function recorded(change: InkChange): void {
    history.push(change);
    options.onChange();
    reportHistory();
  }

  function dropGestures(): void {
    if (stroke) {
      const old = stroke;
      stroke = null;
      old.session.cancel();
    }
    if (erase) cancelErase();
  }

  function cancelErase(): void {
    const gesture = erase;
    if (!gesture) return;
    erase = null;
    const undone = invertInkChange(inkDiffChange(gesture.startDoc, doc));
    if (!isEmptyChange(undone)) apply(undone);
  }

  function step(direction: "undo" | "redo"): void {
    if (destroyed || stroke || erase) return;
    const result = direction === "undo" ? history.undo(doc) : history.redo(doc);
    if (!result) return;
    doc = result.doc;
    syncIndex(result.change);
    renderer.applyChange(doc, result.change);
    options.onChange();
    reportHistory();
  }

  return {
    load(svg) {
      if (destroyed) return;
      dropGestures();
      cancelWarmUp?.();
      doc = importJsDrawSvg(svg)?.document ?? emptyInkDocument();
      index.clear();
      for (const item of doc.items) index.set(item.id, inkItemBounds(item));
      history.clear();
      renderer.setDocument(doc);
      reportHistory();
      // Compile the GPU's shaders once the page's ink is showing, not before.
      cancelWarmUp = renderer.whenVisibleDrawn(() => {
        cancelWarmUp = null;
        if (!destroyed) renderer.warmUp();
      });
    },

    setViewport: (viewport) => renderer.setViewport(viewport),
    beginGesture: () => renderer.beginGesture(),
    endGesture: () => renderer.endGesture(),
    whenVisibleDrawn: (callback) => renderer.whenVisibleDrawn(callback),

    beginStroke({ tool, mapping, first }) {
      if (destroyed) return;
      dropGestures();
      stroke = {
        session: new InkStrokeSession({ tool, mapping, sink: renderer, first, timers: options.timers }),
        pen: tool.kind === "pen",
      };
    },

    moveStroke(samples, predicted) {
      return stroke?.session.move(samples, predicted) ?? 0;
    },

    endStroke(scribble) {
      const current = stroke;
      if (!current) return "empty";
      stroke = null;

      if (scribble && current.pen) {
        const covered = planInkScribbleErase({
          doc,
          candidates: index.query(scribble.band.bounds),
          band: scribble.band,
          majorExtent: scribble.majorExtent,
        });
        if (covered.length > 0) {
          current.session.cancel();
          const change = inkRemoveChange(doc, covered);
          apply(change);
          recorded(change);
          return "scribbled";
        }
      }

      const result = current.session.lift();
      if (!result) return "empty";
      const item: InkOutlineItem = {
        kind: "outline",
        id: createInkItemId(),
        layer: result.layer,
        path: result.path,
        paint: result.paint,
      };
      const change = inkAddChange(doc, [item]);
      doc = applyInkChange(doc, change);
      syncIndex(change);
      renderer.commitLive(doc, change);
      recorded(change);
      return "committed";
    },

    cancelStroke() {
      const current = stroke;
      stroke = null;
      current?.session.cancel();
    },

    beginErase(input) {
      if (destroyed) return;
      dropGestures();
      erase = new InkEraseGesture({ index, doc: () => doc, apply }, input);
    },

    moveErase(points) {
      erase?.move(points);
    },

    endErase() {
      const gesture = erase;
      if (!gesture) return;
      erase = null;
      const change = inkDiffChange(gesture.startDoc, doc);
      if (!isEmptyChange(change)) recorded(change);
    },

    cancelErase,

    get busy() {
      return stroke !== null || erase !== null;
    },

    undo: () => step("undo"),
    redo: () => step("redo"),

    clear() {
      if (destroyed || stroke || erase || doc.items.length === 0) return;
      const change = inkClearChange(doc);
      apply(change);
      recorded(change);
    },

    hasInk: () => doc.items.length > 0,
    historyState: () => ({ undoDepth: history.undoDepth, redoDepth: history.redoDepth }),

    serialize() {
      if (!serialized || serialized.doc !== doc) serialized = { doc, svg: inkToSvg(doc, options.page) };
      return serialized.svg;
    },

    destroy() {
      if (destroyed) return;
      dropGestures();
      destroyed = true;
      cancelWarmUp?.();
      cancelWarmUp = null;
      renderer.destroy();
    },
  };
}
