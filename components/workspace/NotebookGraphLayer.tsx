"use client";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import NotebookGraphView from "@/components/workspace/NotebookGraphView";
import { NotebookIcon } from "@/components/workspace/NotebookToolbarIconButton";
import {
  moveNotebookGraphBlock,
  pinchGraphView,
  resizeNotebookGraphBlock,
  zoomGraphView,
  type GraphScreenFrame,
  type GraphScreenPoint,
  type NotebookGraphBlock,
  type NotebookGraphResizeHandle,
} from "@/lib/workspace/notebook-graphs";
import NotebookResizeHandles from "@/components/workspace/NotebookResizeHandles";
import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
} from "@/lib/workspace/notebooks";

/** Screen pixels a press has to travel before it counts as a drag; see NotebookImageLayer. */
const DRAG_THRESHOLD_PX = 3;

/**
 * Drawing units per page unit. Below one draws a graph's numbers and lines a
 * little larger than their nominal size, which is what stays legible on a page
 * read at arm's length on an iPad.
 */
const DRAWING_SCALE = 0.8;

const ACTION_CLASS =
  "pointer-events-auto inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-text-primary outline-none transition-colors hover:bg-[var(--color-glass-subtle)] focus-visible:ring-2 focus-visible:ring-accent/55";

function styleFor(graph: NotebookGraphBlock) {
  return {
    left: `${(graph.x / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
    top: `${(graph.y / NOTEBOOK_PAGE_COORDINATE_HEIGHT) * 100}%`,
    width: `${(graph.width / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
    height: `${(graph.height / NOTEBOOK_PAGE_COORDINATE_HEIGHT) * 100}%`,
    ...(graph.rotation ? { transform: `rotate(${graph.rotation}rad)` } : {}),
  };
}

type Gesture = {
  kind: "move" | "resize";
  corner?: NotebookGraphResizeHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  layerWidth: number;
  layerHeight: number;
  original: NotebookGraphBlock;
};

/** Two fingers on one graph, zooming what it shows rather than where it sits. */
type Pinch = {
  ids: [number, number];
  from: [GraphScreenPoint, GraphScreenPoint];
  points: Map<number, GraphScreenPoint>;
  frame: GraphScreenFrame;
  /** The graph as the pinch found it, including anywhere the first finger had already moved it. */
  base: NotebookGraphBlock;
  /** Whether that first finger had moved it, which is worth saving even if the pinch changes nothing. */
  moved: boolean;
};

type Pending = Record<string, { commitId: number; graph: NotebookGraphBlock }>;

type Props = {
  graphs: NotebookGraphBlock[];
  editingEnabled?: boolean;
  selectedGraphId?: string | null;
  onSelect?: (graphId: string | null) => void;
  onCommit?: (graphs: NotebookGraphBlock[]) => void | Promise<void>;
  onEdit?: (graphId: string) => void;
  onDelete?: (graphId: string) => void;
};

function geometryFor(gesture: Gesture, clientX: number, clientY: number) {
  const deltaX = ((clientX - gesture.startClientX) / gesture.layerWidth) * NOTEBOOK_PAGE_COORDINATE_WIDTH;
  const deltaY = ((clientY - gesture.startClientY) / gesture.layerHeight) * NOTEBOOK_PAGE_COORDINATE_HEIGHT;
  return gesture.kind === "move"
    ? moveNotebookGraphBlock(gesture.original, deltaX, deltaY)
    : resizeNotebookGraphBlock(gesture.original, deltaX, deltaY, gesture.corner);
}

function pinchedGraph(pinch: Pinch): NotebookGraphBlock {
  const first = pinch.points.get(pinch.ids[0]) ?? pinch.from[0];
  const second = pinch.points.get(pinch.ids[1]) ?? pinch.from[1];
  return { ...pinch.base, view: pinchGraphView(pinch.base.view, pinch.frame, pinch.from, [first, second]) };
}

/**
 * Graphs on a notebook page, and moving, resizing, zooming and editing them.
 *
 * One finger moves a graph and two pinch it, zooming what it shows the way
 * the editor does -- so a graph on the page can still be looked into after it
 * has been placed, not only through its zoom buttons.
 *
 * They sit under the ink, so a student can annotate a graph with the pen --
 * mark an intercept, sketch a tangent -- the way they would on paper. The
 * gesture handling follows NotebookImageLayer: refs for the live gesture, one
 * preview render a frame, and each graph's last placement held until its save
 * lands.
 */
function NotebookGraphLayer({
  graphs,
  editingEnabled = false,
  selectedGraphId = null,
  onSelect,
  onCommit,
  onEdit,
  onDelete,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pinchRef = useRef<Pinch | null>(null);
  const pointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const [draft, setDraft] = useState<NotebookGraphBlock | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const pendingRef = useRef<Pending>({});
  const graphsRef = useRef(graphs);
  const commitIdRef = useRef(0);

  useEffect(() => {
    graphsRef.current = graphs;
    pendingRef.current = pending;
  });

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  const displayedGraphs = graphs.map((graph) => {
    if (draft?.id === graph.id) return draft;
    return pending[graph.id]?.graph ?? graph;
  });

  const commitGraph = useCallback(
    (next: NotebookGraphBlock) => {
      const commitId = (commitIdRef.current += 1);
      const nextPending = { ...pendingRef.current, [next.id]: { commitId, graph: next } };
      pendingRef.current = nextPending;
      setPending(nextPending);
      const list = graphsRef.current.map((graph) => nextPending[graph.id]?.graph ?? graph);
      void Promise.resolve(onCommit?.(list))
        .catch(() => undefined)
        .finally(() => {
          setPending((current) => {
            if (current[next.id]?.commitId !== commitId) return current;
            const rest = { ...current };
            delete rest[next.id];
            return rest;
          });
        });
    },
    [onCommit]
  );

  const startGesture = useCallback(
    (graph: NotebookGraphBlock, event: ReactPointerEvent<HTMLElement>, corner?: NotebookGraphResizeHandle) => {
      event.stopPropagation();
      const bounds = layerRef.current?.getBoundingClientRect();
      if (!bounds?.width || !bounds.height) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointRef.current = null;
      gestureRef.current = {
        kind: corner ? "resize" : "move",
        ...(corner ? { corner } : {}),
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        layerWidth: bounds.width,
        layerHeight: bounds.height,
        original: graph,
      };
    },
    []
  );

  /**
   * A second finger on the graph the first is moving: from here it is a pinch.
   *
   * The graph stays wherever the first finger had taken it, and the pinch
   * zooms it there.
   */
  const startPinch = useCallback((graph: NotebookGraphBlock, event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (
      event.pointerType !== "touch" ||
      !gesture ||
      gesture.kind !== "move" ||
      gesture.original.id !== graph.id ||
      gesture.pointerId === event.pointerId
    ) {
      return false;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    event.stopPropagation();
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointRef.current;
    const moved =
      point !== null &&
      Math.hypot(point.clientX - gesture.startClientX, point.clientY - gesture.startClientY) >= DRAG_THRESHOLD_PX;
    const base = moved && point ? geometryFor(gesture, point.clientX, point.clientY) : gesture.original;
    const first = point ? { x: point.clientX, y: point.clientY } : { x: gesture.startClientX, y: gesture.startClientY };
    const second = { x: event.clientX, y: event.clientY };
    gestureRef.current = null;
    pointRef.current = null;
    pinchRef.current = {
      ids: [gesture.pointerId, event.pointerId],
      from: [first, second],
      points: new Map([
        [gesture.pointerId, first],
        [event.pointerId, second],
      ]),
      frame: {
        rect,
        drawingWidth: base.width * DRAWING_SCALE,
        drawingHeight: base.height * DRAWING_SCALE,
        hasTitle: Boolean(base.title),
      },
      base,
      moved,
    };
    setDraft(base);
    return true;
  }, []);

  const moveGesture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pinch = pinchRef.current;
    if (pinch?.ids.includes(event.pointerId)) {
      event.stopPropagation();
      pinch.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const current = pinchRef.current;
        if (current) setDraft(pinchedGraph(current));
      });
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.stopPropagation();
    pointRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const current = gestureRef.current;
      const point = pointRef.current;
      if (!current || !point) return;
      setDraft(geometryFor(current, point.clientX, point.clientY));
    });
  }, []);

  const finishGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pinch = pinchRef.current;
      if (pinch?.ids.includes(event.pointerId)) {
        event.stopPropagation();
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        // The finger still down ends nothing: this pinch is over, and it is saved once.
        pinchRef.current = null;
        setDraft(null);
        const travelled = pinch.ids.some((id, index) => {
          const at = pinch.points.get(id);
          const from = pinch.from[index];
          return at !== undefined && from !== undefined && Math.hypot(at.x - from.x, at.y - from.y) >= DRAG_THRESHOLD_PX;
        });
        if (travelled) commitGraph(pinchedGraph(pinch));
        else if (pinch.moved) commitGraph(pinch.base);
        return;
      }
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      event.stopPropagation();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      gestureRef.current = null;
      const point =
        event.type === "pointercancel" ? pointRef.current : { clientX: event.clientX, clientY: event.clientY };
      pointRef.current = null;
      setDraft(null);
      if (!point) return;
      const travelled = Math.hypot(point.clientX - gesture.startClientX, point.clientY - gesture.startClientY);
      if (travelled < DRAG_THRESHOLD_PX) return;
      commitGraph(geometryFor(gesture, point.clientX, point.clientY));
    },
    [commitGraph]
  );

  const handleKeyDown = useCallback(
    (graph: NotebookGraphBlock, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === "Delete" || event.key === "Backspace") && onDelete) {
        event.preventDefault();
        onDelete(graph.id);
        return;
      }
      if (event.key === "Enter" && onEdit) {
        event.preventDefault();
        onEdit(graph.id);
        return;
      }
      if (event.key === "+" || event.key === "=" || event.key === "-") {
        event.preventDefault();
        commitGraph({ ...graph, view: zoomGraphView(graph.view, event.key === "-" ? 1.25 : 0.8) });
        return;
      }
      const amount = event.shiftKey ? 24 : 8;
      const delta =
        event.key === "ArrowLeft"
          ? { x: -amount, y: 0 }
          : event.key === "ArrowRight"
            ? { x: amount, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: -amount }
              : event.key === "ArrowDown"
                ? { x: 0, y: amount }
                : null;
      if (!delta) return;
      event.preventDefault();
      commitGraph(moveNotebookGraphBlock(graph, delta.x, delta.y));
    },
    [commitGraph, onDelete, onEdit]
  );

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {displayedGraphs.map((graph) => (
        <div
          key={graph.id}
          className="pointer-events-none absolute z-10 overflow-hidden rounded-sm border border-slate-950/15"
          style={styleFor(graph)}
        >
          <NotebookGraphView graph={graph} width={graph.width * DRAWING_SCALE} height={graph.height * DRAWING_SCALE} />
        </div>
      ))}
      {editingEnabled ? (
        <div className="pointer-events-none absolute inset-0 z-[26]">
          {displayedGraphs.map((graph) => {
            const selected = selectedGraphId === graph.id;
            const dragging = draft?.id === graph.id;
            const name = graph.title ? `graph ${graph.title}` : "graph";
            return (
              <div key={graph.id} className="pointer-events-none absolute" style={styleFor(graph)}>
                <button
                  type="button"
                  aria-label={`Move ${name}. Enter to edit, plus or minus to zoom, or pinch with two fingers.`}
                  aria-pressed={selected}
                  className={`pointer-events-auto absolute inset-0 touch-none rounded-sm border bg-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/55 ${
                    selected ? "cursor-move border-accent shadow-ring" : "cursor-pointer border-transparent hover:border-accent/55"
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect?.(graph.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onEdit?.(graph.id);
                  }}
                  onKeyDown={(event) => handleKeyDown(graph, event)}
                  onPointerDown={(event) => {
                    if (startPinch(graph, event)) return;
                    onSelect?.(graph.id);
                    startGesture(graph, event);
                  }}
                  onPointerMove={moveGesture}
                  onPointerUp={finishGesture}
                  onPointerCancel={finishGesture}
                />
                {selected && !dragging ? (
                  <div
                    role="toolbar"
                    aria-label={`${name} options`}
                    className={`pointer-events-auto absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-panel)] p-1 shadow-e1 ${
                      // A graph at the very top of the page keeps its options inside it.
                      graph.y < 64 ? "top-2" : "bottom-full mb-2"
                    }`}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-label="Zoom out"
                      title="Zoom out"
                      className={ACTION_CLASS}
                      onClick={(event) => {
                        event.stopPropagation();
                        commitGraph({ ...graph, view: zoomGraphView(graph.view, 1.25) });
                      }}
                    >
                      <NotebookIcon name="minus" />
                    </button>
                    <button
                      type="button"
                      aria-label="Zoom in"
                      title="Zoom in"
                      className={ACTION_CLASS}
                      onClick={(event) => {
                        event.stopPropagation();
                        commitGraph({ ...graph, view: zoomGraphView(graph.view, 0.8) });
                      }}
                    >
                      <NotebookIcon name="plus" />
                    </button>
                    {onEdit ? (
                      <button
                        type="button"
                        className={ACTION_CLASS}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEdit(graph.id);
                        }}
                      >
                        <NotebookIcon name="graph" />
                        Edit
                      </button>
                    ) : null}
                    {onDelete ? (
                      <button
                        type="button"
                        aria-label={`Delete ${name}`}
                        className={`${ACTION_CLASS} hover:text-[var(--color-error-mark)]`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(graph.id);
                        }}
                      >
                        <NotebookIcon name="trash" />
                        Delete
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {selected ? (
                  <NotebookResizeHandles
                    name={name}
                    onStart={(handle, event) => startGesture(graph, event, handle)}
                    onMove={moveGesture}
                    onEnd={finishGesture}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default memo(NotebookGraphLayer);
