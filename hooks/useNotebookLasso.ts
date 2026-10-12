"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import type { InkColor, InkItem, InkPoint } from "@/lib/ink/model";
import {
  applyInkLassoTransform,
  boundsOfInkPoints,
  identityInkLassoTransform,
  inkItemOutlinePoints,
  isInsideInkLoop,
  recolourInkItem,
  thickenInkItem,
  transformInkItem,
  type InkLassoTransform,
} from "@/lib/ink/tools/lasso";
import type { NotebookGraphBlock } from "@/lib/workspace/notebook-graphs";
import type { NotebookImageRef, NotebookTextBlock } from "@/lib/workspace/notebooks";
import {
  lassoBoxFrame,
  lassoImageFrame,
  lassoPlacedBox,
  transformLassoGraph,
  transformLassoImage,
  transformLassoText,
  type LassoBox,
} from "@/lib/workspace/notebook-lasso";

/** What the lasso picked up, as it was when picked up, and how it has been moved since. */
export type NotebookLassoSelection = {
  ink: InkItem[];
  images: NotebookImageRef[];
  graphs: NotebookGraphBlock[];
  texts: NotebookTextBlock[];
  box: LassoBox;
  transform: InkLassoTransform;
};

export type NotebookLassoPlaced = {
  images: () => NotebookImageRef[];
  graphs: () => NotebookGraphBlock[];
  /** Shows them at once, unsaved, while a gesture runs. */
  showImages: (images: NotebookImageRef[]) => void;
  showGraphs: (graphs: NotebookGraphBlock[]) => void;
  /** Saves them, when a gesture ends. */
  saveImages: (images: NotebookImageRef[]) => void;
  saveGraphs: (graphs: NotebookGraphBlock[]) => void;
  texts: () => NotebookTextBlock[];
  setTexts: (texts: NotebookTextBlock[]) => void;
  /** Records a text edit for undo. */
  recordTexts: (previous: NotebookTextBlock[], next: NotebookTextBlock[]) => void;
  markUnsaved: () => void;
};

const centreOf = (box: { x?: number; y?: number; width: number; height: number }) => ({
  x: (box.x ?? 0) + box.width / 2,
  y: (box.y ?? 0) + box.height / 2,
});

/**
 * The lasso: a loop round part of the page picks up the ink, images, graphs
 * and text boxes inside it, which then move, resize and turn together (text
 * boxes stay upright), change colour or thickness (ink), or go.
 *
 * Ink edits land through the engine as one undo step per gesture
 * (`NotebookInkLasso`); images and graphs are saved as their own moves always
 * are, and text boxes through the text history. Nothing is picked up while
 * the lasso is not the tool, and a new page or another tool lets go.
 */
export function useNotebookLasso({
  active,
  pageId,
  inkEditorRef,
  placed,
}: {
  active: boolean;
  pageId: string | undefined;
  inkEditorRef: RefObject<NotebookInkEditorHandle | null>;
  placed: NotebookLassoPlaced;
}) {
  const [selection, setSelection] = useState<NotebookLassoSelection | null>(null);
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  const placedRef = useRef(placed);
  useEffect(() => {
    placedRef.current = placed;
  }, [placed]);
  /** The text boxes as a gesture found them, for its one undo step. */
  const gestureTextsRef = useRef<NotebookTextBlock[] | null>(null);

  // A new page, or putting the lasso down, lets go of what it held.
  const [held, setHeld] = useState({ pageId, active });
  if (held.pageId !== pageId || held.active !== active) {
    setHeld({ pageId, active });
    if (selection) setSelection(null);
  }

  const pickUp = useCallback(
    (loop: InkPoint[]) => {
      const lasso = inkEditorRef.current?.lasso;
      const sources = placedRef.current;
      const ink = lasso ? lasso.items(lasso.inkInLoop(loop)) : [];
      const inside = (box: { x?: number; y?: number; width: number; height: number }) =>
        isInsideInkLoop(loop, centreOf(box));
      const images = sources.images().filter((image) =>
        inside({ x: image.x, y: image.y, width: image.displayWidth ?? 0, height: image.displayHeight ?? 0 })
      );
      const graphs = sources.graphs().filter((graph) => inside(graph));
      const texts = sources.texts().filter((text) => inside(text));
      const points = [
        ...ink.flatMap(inkItemOutlinePoints),
        ...images.flatMap((image) => lassoPlacedBox(lassoImageFrame(image))),
        ...graphs.flatMap((graph) => lassoPlacedBox(lassoBoxFrame(graph))),
        ...texts.flatMap((text) => lassoPlacedBox(lassoBoxFrame(text))),
      ];
      const box = boundsOfInkPoints(points);
      if (!box) {
        setSelection(null);
        return false;
      }
      setSelection({
        ink,
        images,
        graphs,
        texts,
        box,
        transform: identityInkLassoTransform((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2),
      });
      return true;
    },
    [inkEditorRef]
  );

  /** Puts everything picked up where `transform` says, from where it was picked up. */
  const place = useCallback(
    (transform: InkLassoTransform, mode: "show" | "save") => {
      const current = selectionRef.current;
      if (!current) return;
      const sources = placedRef.current;
      inkEditorRef.current?.lasso?.showEdit(current.ink.map((item) => transformInkItem(item, transform)));
      const movedImages = new Map(current.images.map((image) => [image.id, transformLassoImage(image, transform)]));
      const movedGraphs = new Map(current.graphs.map((graph) => [graph.id, transformLassoGraph(graph, transform)]));
      const movedTexts = new Map(current.texts.map((text) => [text.id, transformLassoText(text, transform)]));
      if (movedImages.size > 0) {
        const images = sources.images().map((image) => movedImages.get(image.id) ?? image);
        (mode === "save" ? sources.saveImages : sources.showImages)(images);
      }
      if (movedGraphs.size > 0) {
        const graphs = sources.graphs().map((graph) => movedGraphs.get(graph.id) ?? graph);
        (mode === "save" ? sources.saveGraphs : sources.showGraphs)(graphs);
      }
      if (movedTexts.size > 0) {
        sources.setTexts(sources.texts().map((text) => movedTexts.get(text.id) ?? text));
      }
      setSelection({ ...current, transform });
    },
    [inkEditorRef]
  );

  const beginGesture = useCallback(() => {
    inkEditorRef.current?.lasso?.beginEdit();
    gestureTextsRef.current = placedRef.current.texts();
  }, [inkEditorRef]);

  const moveGesture = useCallback((transform: InkLassoTransform) => place(transform, "show"), [place]);

  const endGesture = useCallback(
    (transform: InkLassoTransform) => {
      place(transform, "save");
      inkEditorRef.current?.lasso?.endEdit();
      const sources = placedRef.current;
      const before = gestureTextsRef.current;
      gestureTextsRef.current = null;
      if (before && (selectionRef.current?.texts.length ?? 0) > 0) {
        sources.recordTexts(before, sources.texts());
        sources.markUnsaved();
      }
    },
    [inkEditorRef, place]
  );

  /** Ink restyled where it stands, and where it was picked up, so a later move keeps the new look. */
  const restyle = useCallback(
    (change: (item: InkItem) => InkItem) => {
      const current = selectionRef.current;
      const lasso = inkEditorRef.current?.lasso;
      if (!current || !lasso || current.ink.length === 0) return;
      lasso.beginEdit();
      lasso.showEdit(lasso.items(current.ink.map((item) => item.id)).map(change));
      lasso.endEdit();
      setSelection({ ...current, ink: current.ink.map(change) });
    },
    [inkEditorRef]
  );

  const recolour = useCallback((color: InkColor) => restyle((item) => recolourInkItem(item, color)), [restyle]);
  const thicken = useCallback((direction: 1 | -1) => restyle((item) => thickenInkItem(item, direction)), [restyle]);

  const remove = useCallback(() => {
    const current = selectionRef.current;
    if (!current) return;
    const sources = placedRef.current;
    inkEditorRef.current?.lasso?.removeItems(current.ink.map((item) => item.id));
    const gone = (ids: { id: string }[]) => new Set(ids.map((each) => each.id));
    if (current.images.length > 0) {
      const ids = gone(current.images);
      sources.saveImages(sources.images().filter((image) => !ids.has(image.id)));
    }
    if (current.graphs.length > 0) {
      const ids = gone(current.graphs);
      sources.saveGraphs(sources.graphs().filter((graph) => !ids.has(graph.id)));
    }
    if (current.texts.length > 0) {
      const ids = gone(current.texts);
      const before = sources.texts();
      const after = before.filter((text) => !ids.has(text.id));
      sources.setTexts(after);
      sources.recordTexts(before, after);
      sources.markUnsaved();
    }
    setSelection(null);
  }, [inkEditorRef]);

  const letGo = useCallback(() => setSelection(null), []);

  return {
    active,
    selection,
    pickUp,
    beginGesture,
    moveGesture,
    endGesture,
    recolour,
    thicken,
    remove,
    letGo,
    /** Where a corner of the selection's box is now. */
    corner: (point: InkPoint) =>
      selection ? applyInkLassoTransform(selection.transform, point) : point,
  };
}

export type NotebookLassoController = ReturnType<typeof useNotebookLasso>;
