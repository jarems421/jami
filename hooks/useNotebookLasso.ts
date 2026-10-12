"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import type { InkColor, InkItem, InkPoint } from "@/lib/ink/model";
import {
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
  sameLassoFrame,
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
  /** Shown on the page at once, saved behind, and recorded for undo. */
  saveImages: (images: NotebookImageRef[]) => void;
  saveGraphs: (graphs: NotebookGraphBlock[]) => void;
  /** Deletes images and their files: never undone. */
  deleteImages: (ids: readonly string[]) => void;
  texts: () => NotebookTextBlock[];
  setTexts: (texts: NotebookTextBlock[]) => void;
  /** Records a text edit for undo. */
  recordTexts: (previous: NotebookTextBlock[], next: NotebookTextBlock[]) => void;
  markUnsaved: () => void;
  /** Whatever `run` records for undo is one step. */
  together: (run: () => void) => void;
};

/** A drag has begun: the selection it moves, and the ink it took off the page, as it was there. */
export type NotebookLassoLift = { selection: NotebookLassoSelection; ink: InkItem[] };

const sameTransform = (a: InkLassoTransform, b: InkLassoTransform) =>
  a.cx === b.cx && a.cy === b.cy && a.dx === b.dx && a.dy === b.dy && a.scale === b.scale && a.rotation === b.rotation;

const centreOf = (box: { x?: number; y?: number; width: number; height: number }) => ({
  x: (box.x ?? 0) + box.width / 2,
  y: (box.y ?? 0) + box.height / 2,
});

/** A selection of these, with its box worked out and no move made yet. */
function selectionOf(
  ink: InkItem[],
  images: NotebookImageRef[],
  graphs: NotebookGraphBlock[],
  texts: NotebookTextBlock[]
): NotebookLassoSelection | null {
  const box = boundsOfInkPoints([
    ...ink.flatMap(inkItemOutlinePoints),
    ...images.flatMap((image) => lassoPlacedBox(lassoImageFrame(image))),
    ...graphs.flatMap((graph) => lassoPlacedBox(lassoBoxFrame(graph))),
    ...texts.flatMap((text) => lassoPlacedBox(lassoBoxFrame(text))),
  ]);
  if (!box) return null;
  return {
    ink,
    images,
    graphs,
    texts,
    box,
    transform: identityInkLassoTransform((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2),
  };
}

/**
 * The lasso: a loop round part of the page picks up the ink, images, graphs
 * and text boxes inside it, which then move, resize and turn together (text
 * boxes stay upright), change colour or thickness (ink), or go.
 *
 * A drag changes nothing on the page until it ends: the ink is taken off the
 * page for it and carried as one picture, and the placed things by their own
 * elements' CSS (`NotebookLassoLayer`), so nothing renders while it moves. At
 * the end each is saved once, and the whole drag is one undo step: the ink
 * (`NotebookInkLasso`), images and graphs as their own moves are, and text
 * boxes through the text history. A drag that ends where it began saves
 * nothing. Nothing is picked up while the lasso is not the tool, and a new
 * page or another tool lets go.
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
  /** The ink items the lasso last put on the page: anything else there under their ids was put there since. */
  const ownInkRef = useRef(new Set<InkItem>());
  /** The ink a drag has taken off the page, to put back when it ends. */
  const liftedRef = useRef<InkItem[] | null>(null);

  // A new page, or putting the lasso down, lets go of what it held.
  const [held, setHeld] = useState({ pageId, active });
  if (held.pageId !== pageId || held.active !== active) {
    setHeld({ pageId, active });
    if (selection) setSelection(null);
  }

  const choose = useCallback((next: NotebookLassoSelection | null) => {
    selectionRef.current = next;
    ownInkRef.current = new Set(next?.ink ?? []);
    setSelection(next);
  }, []);

  const pickUp = useCallback(
    (loop: InkPoint[]) => {
      const lasso = inkEditorRef.current?.lasso;
      const sources = placedRef.current;
      const inside = (box: { x?: number; y?: number; width: number; height: number }) =>
        isInsideInkLoop(loop, centreOf(box));
      const next = selectionOf(
        lasso ? lasso.items(lasso.inkInLoop(loop)) : [],
        sources
          .images()
          .filter((image) =>
            inside({ x: image.x, y: image.y, width: image.displayWidth ?? 0, height: image.displayHeight ?? 0 })
          ),
        sources.graphs().filter((graph) => inside(graph)),
        sources.texts().filter((text) => inside(text))
      );
      choose(next);
      return next !== null;
    },
    [choose, inkEditorRef]
  );

  /**
   * The selection as the page has it now. An undo, an erase or a text edit
   * since the last move can have changed what was picked up; then what is on
   * the page now is what moves, from where it is.
   */
  const current = useCallback(() => {
    const selection = selectionRef.current;
    if (!selection) return null;
    const lasso = inkEditorRef.current?.lasso;
    const sources = placedRef.current;
    const ink = lasso ? lasso.items(selection.ink.map((item) => item.id)) : selection.ink;
    const byId = <T extends { id: string }>(list: T[], picked: T[]) => {
      const ids = new Set(picked.map((each) => each.id));
      return list.filter((each) => ids.has(each.id));
    };
    const images = byId(sources.images(), selection.images);
    const graphs = byId(sources.graphs(), selection.graphs);
    const texts = byId(sources.texts(), selection.texts);
    const { transform } = selection;
    const inkAsLeft = ink.length === selection.ink.length && ink.every((item) => ownInkRef.current.has(item));
    const imageNow = (id: string) => {
      const image = images.find((each) => each.id === id);
      return image ? lassoImageFrame(image) : null;
    };
    const boxNow = (list: Array<NotebookGraphBlock | NotebookTextBlock>, id: string) => {
      const box = list.find((each) => each.id === id);
      return box ? lassoBoxFrame(box) : null;
    };
    const placedAsLeft =
      images.length === selection.images.length &&
      graphs.length === selection.graphs.length &&
      texts.length === selection.texts.length &&
      selection.images.every((image) =>
        sameLassoFrame(lassoImageFrame(transformLassoImage(image, transform)), imageNow(image.id))
      ) &&
      selection.graphs.every((graph) =>
        sameLassoFrame(lassoBoxFrame(transformLassoGraph(graph, transform)), boxNow(graphs, graph.id))
      ) &&
      selection.texts.every((text) =>
        sameLassoFrame(lassoBoxFrame(transformLassoText(text, transform)), boxNow(texts, text.id))
      );
    if (inkAsLeft && placedAsLeft) return selection;
    const resynced = selectionOf(ink, images, graphs, texts);
    choose(resynced);
    return resynced;
  }, [choose, inkEditorRef]);

  /** A drag begins: the ink comes off the page for it, until `endGesture`. */
  const beginGesture = useCallback((): NotebookLassoLift | null => {
    const selection = current();
    if (!selection) return null;
    const lasso = inkEditorRef.current?.lasso;
    const ink = lasso ? lasso.items(selection.ink.map((item) => item.id)) : [];
    if (lasso && ink.length > 0) {
      lasso.beginEdit();
      lasso.hideItems(ink.map((item) => item.id));
      liftedRef.current = ink;
    }
    return { selection, ink };
  }, [current, inkEditorRef]);

  /**
   * The drag ends: everything picked up goes where `transform` puts it, saved
   * once each. Where it began, or with nothing held any more, the ink goes
   * back as it was and nothing is saved.
   */
  const endGesture = useCallback(
    (transform: InkLassoTransform) => {
      const lasso = inkEditorRef.current?.lasso;
      const lifted = liftedRef.current;
      liftedRef.current = null;
      const selection = selectionRef.current;
      if (!selection || sameTransform(transform, selection.transform)) {
        if (lifted) lasso?.endEdit(lifted);
        return;
      }
      const sources = placedRef.current;
      sources.together(() => {
        if (lifted) {
          const ink = selection.ink.map((item) => transformInkItem(item, transform));
          lasso?.endEdit(ink);
          ownInkRef.current = new Set(ink);
        }
        if (selection.images.length > 0) {
          const moved = new Map(selection.images.map((image) => [image.id, transformLassoImage(image, transform)]));
          sources.saveImages(sources.images().map((image) => moved.get(image.id) ?? image));
        }
        if (selection.graphs.length > 0) {
          const moved = new Map(selection.graphs.map((graph) => [graph.id, transformLassoGraph(graph, transform)]));
          sources.saveGraphs(sources.graphs().map((graph) => moved.get(graph.id) ?? graph));
        }
        if (selection.texts.length > 0) {
          const moved = new Map(selection.texts.map((text) => [text.id, transformLassoText(text, transform)]));
          const before = sources.texts();
          const after = before.map((text) => moved.get(text.id) ?? text);
          sources.setTexts(after);
          sources.recordTexts(before, after);
          sources.markUnsaved();
        }
      });
      const next = { ...selection, transform };
      selectionRef.current = next;
      setSelection(next);
    },
    [inkEditorRef]
  );

  /** Ink restyled where it stands, and where it was picked up, so a later move keeps the new look. */
  const restyle = useCallback(
    (change: (item: InkItem) => InkItem) => {
      const selection = current();
      const lasso = inkEditorRef.current?.lasso;
      if (!selection || !lasso || selection.ink.length === 0) return;
      const restyled = lasso.items(selection.ink.map((item) => item.id)).map(change);
      lasso.beginEdit();
      lasso.showEdit(restyled);
      lasso.endEdit();
      const next = { ...selection, ink: selection.ink.map(change) };
      selectionRef.current = next;
      ownInkRef.current = new Set(restyled);
      setSelection(next);
    },
    [current, inkEditorRef]
  );

  const recolour = useCallback((color: InkColor) => restyle((item) => recolourInkItem(item, color)), [restyle]);
  const thicken = useCallback((direction: 1 | -1) => restyle((item) => thickenInkItem(item, direction)), [restyle]);

  /** Deletes everything picked up, as one undo step -- images apart, whose files go with them. */
  const remove = useCallback(() => {
    const selection = current();
    if (!selection) return;
    const sources = placedRef.current;
    const gone = (ids: { id: string }[]) => new Set(ids.map((each) => each.id));
    sources.together(() => {
      inkEditorRef.current?.lasso?.removeItems(selection.ink.map((item) => item.id));
      if (selection.images.length > 0) sources.deleteImages(selection.images.map((image) => image.id));
      if (selection.graphs.length > 0) {
        const ids = gone(selection.graphs);
        sources.saveGraphs(sources.graphs().filter((graph) => !ids.has(graph.id)));
      }
      if (selection.texts.length > 0) {
        const ids = gone(selection.texts);
        const before = sources.texts();
        const after = before.filter((text) => !ids.has(text.id));
        sources.setTexts(after);
        sources.recordTexts(before, after);
        sources.markUnsaved();
      }
    });
    choose(null);
  }, [choose, current, inkEditorRef]);

  const letGo = useCallback(() => choose(null), [choose]);

  /** Fits the box to where what it holds now is: an undo or a redo can have moved it. */
  const refresh = useCallback(() => {
    current();
  }, [current]);

  return {
    active,
    selection,
    pickUp,
    beginGesture,
    endGesture,
    recolour,
    thicken,
    remove,
    letGo,
    refresh,
    /** Calls back once the ink put back on the page is drawn, for whatever stood in for it. */
    whenInkDrawn: (callback: () => void) => {
      const lasso = inkEditorRef.current?.lasso;
      if (lasso) return lasso.whenVisibleDrawn(callback);
      callback();
      return () => undefined;
    },
  };
}

export type NotebookLassoController = ReturnType<typeof useNotebookLasso>;
