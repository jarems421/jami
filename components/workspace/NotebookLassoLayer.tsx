"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NotebookIcon } from "@/components/workspace/NotebookToolbarIconButton";
import type { NotebookLassoController, NotebookLassoLift } from "@/hooks/useNotebookLasso";
import type { InkBox, InkPoint } from "@/lib/ink/model";
import { applyInkLassoTransform, isInsideInkLoop, type InkLassoTransform } from "@/lib/ink/tools/lasso";
import { dropInkGhost, paintInkGhost } from "@/lib/ink-dom/lasso-ghost";
import { inkColorForTool } from "@/lib/ink-dom/stroke-color";
import { lassoBoxFrame, lassoImageFrame, type LassoBox, type LassoFrame } from "@/lib/workspace/notebook-lasso";
import { getNotebookStrokePaintColor } from "@/lib/workspace/notebook-page-content";
import { NOTEBOOK_PAGE_COORDINATE_HEIGHT, NOTEBOOK_PAGE_COORDINATE_WIDTH } from "@/lib/workspace/notebooks";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";

const WIDTH = NOTEBOOK_PAGE_COORDINATE_WIDTH;
const HEIGHT = NOTEBOOK_PAGE_COORDINATE_HEIGHT;
/** How near a handle, in page units, a press takes it. */
const HANDLE_REACH = 26;
/** How far out from the top of the box the turn handle stands. */
const TURN_HANDLE_OFFSET = 40;
/** Screen pixels a press in the box travels before it moves anything, so a tap never nudges it. */
const DRAG_THRESHOLD_PX = 3;
const COLOURS: NotebookStrokeColor[] = ["black", "white", "red", "green"];

type Rect = { left: number; top: number; width: number; height: number };

type Loop = { kind: "loop"; pointerId: number; rect: Rect; points: InkPoint[] };

type Drag = {
  kind: "move" | "scale" | "turn";
  pointerId: number;
  /** The layer on screen when the press landed: the page does not zoom mid-drag. */
  rect: Rect;
  start: InkPoint;
  startClient: { x: number; y: number };
  /** Where the selection was when the drag began, and its box. */
  from: InkLassoTransform;
  box: LassoBox;
  /** Where the drag has taken it so far. */
  transform: InkLassoTransform;
  /** What carries it about, once it has begun to move. */
  carried: Carried | null;
};

type Carried = {
  ghost: { canvas: HTMLCanvasElement; box: InkBox } | null;
  /** The elements showing what is placed, each with where its middle was. */
  placed: { element: HTMLElement; middle: InkPoint; upright: boolean }[];
  /** CSS pixels per page unit, on the page's own scale. */
  unit: number;
};

const distance = (a: InkPoint, b: InkPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const points = (list: InkPoint[]) => list.map((point) => `${point.x},${point.y}`).join(" ");

const pagePoint = (rect: Rect, event: { clientX: number; clientY: number }): InkPoint => ({
  x: ((event.clientX - rect.left) / rect.width) * WIDTH,
  y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
});

/** The box round the selection where `transform` puts it, its handles, and where its bar goes. */
function boxGeometry(box: LassoBox, transform: InkLassoTransform) {
  const at = (point: InkPoint) => applyInkLassoTransform(transform, point);
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ].map(at);
  const centre = at({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
  const top = at({ x: (box.minX + box.maxX) / 2, y: box.minY });
  const out = distance(top, centre) || 1;
  const turn = {
    x: top.x + ((top.x - centre.x) / out) * TURN_HANDLE_OFFSET,
    y: top.y + ((top.y - centre.y) / out) * TURN_HANDLE_OFFSET,
  };
  const lowest = Math.max(...corners.map((corner) => corner.y));
  const middle = corners.reduce((sum, corner) => sum + corner.x, 0) / 4;
  return {
    corners,
    top,
    turn,
    scale: corners[2],
    bar: {
      left: `${(Math.min(Math.max(middle, 120), WIDTH - 120) / WIDTH) * 100}%`,
      top: `${(Math.min(lowest + 28, HEIGHT - 60) / HEIGHT) * 100}%`,
    },
  };
}

type BoxGeometry = ReturnType<typeof boxGeometry>;

function transformFor(drag: Drag, at: InkPoint): InkLassoTransform {
  const { from, start } = drag;
  const centre = { x: from.cx + from.dx, y: from.cy + from.dy };
  if (drag.kind === "move") {
    return { ...from, dx: from.dx + at.x - start.x, dy: from.dy + at.y - start.y };
  }
  if (drag.kind === "scale") {
    const reach = distance(start, centre) || 1;
    return { ...from, scale: Math.min(8, Math.max(0.1, (from.scale * distance(at, centre)) / reach)) };
  }
  const turned = Math.atan2(at.y - centre.y, at.x - centre.x) - Math.atan2(start.y - centre.y, start.x - centre.x);
  return { ...from, rotation: from.rotation + turned };
}

/**
 * Takes up what a drag carries: the ink, painted once onto a canvas in `host`
 * (it is off the page meanwhile), and the elements showing what is placed,
 * found among the page's layers by their `data-notebook-placed` marks.
 */
function takeUp(lift: NotebookLassoLift, from: InkLassoTransform, layer: HTMLElement, host: HTMLElement): Carried {
  const rect = layer.getBoundingClientRect();
  const ghost = paintInkGhost(lift.ink, (rect.width / WIDTH) * (window.devicePixelRatio || 1));
  const centre = { x: from.cx + from.dx, y: from.cy + from.dy };
  if (ghost) {
    const { canvas, box } = ghost;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    Object.assign(canvas.style, {
      position: "absolute",
      left: `${(box.minX / WIDTH) * 100}%`,
      top: `${(box.minY / HEIGHT) * 100}%`,
      width: `${(width / WIDTH) * 100}%`,
      height: `${(height / HEIGHT) * 100}%`,
      transformOrigin: `${((centre.x - box.minX) / width) * 100}% ${((centre.y - box.minY) / height) * 100}%`,
    });
    host.append(canvas);
  }
  const { selection } = lift;
  const wanted = new Map<string, { frame: LassoFrame; upright: boolean }>();
  for (const image of selection.images) wanted.set(`image:${image.id}`, { frame: lassoImageFrame(image), upright: false });
  for (const graph of selection.graphs) wanted.set(`graph:${graph.id}`, { frame: lassoBoxFrame(graph), upright: false });
  for (const text of selection.texts) wanted.set(`text:${text.id}`, { frame: lassoBoxFrame(text), upright: true });
  const placed: Carried["placed"] = [];
  if (wanted.size > 0) {
    for (const element of layer.parentElement?.querySelectorAll<HTMLElement>("[data-notebook-placed]") ?? []) {
      const found = wanted.get(element.dataset.notebookPlaced ?? "");
      if (!found) continue;
      const { frame } = found;
      // Where it is on the page now: the selection's own record is where it was picked up.
      const middle = applyInkLassoTransform(from, { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
      placed.push({ element, middle, upright: found.upright });
    }
  }
  return { ghost, placed, unit: layer.offsetWidth / WIDTH };
}

/**
 * Puts what a drag carries where `to` takes it from `from`, by CSS alone:
 * nothing is drawn again and nothing renders. The placed elements move by
 * their `translate`, `rotate` and `scale` properties, which apply ahead of
 * the `transform` their own layers turn them with, and which those layers
 * never set. A text box is only carried, upright and its own size, and takes
 * its new width when the drag ends.
 */
function carry(carried: Carried, from: InkLassoTransform, to: InkLassoTransform) {
  const centre = { x: from.cx + from.dx, y: from.cy + from.dy };
  const shift = { x: to.dx - from.dx, y: to.dy - from.dy };
  const scale = to.scale / from.scale;
  const turn = to.rotation - from.rotation;
  const { ghost } = carried;
  if (ghost) {
    const width = ghost.box.maxX - ghost.box.minX;
    const height = ghost.box.maxY - ghost.box.minY;
    ghost.canvas.style.transform = `translate(${(shift.x / width) * 100}%, ${(shift.y / height) * 100}%) rotate(${turn}rad) scale(${scale})`;
  }
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  for (const { element, middle, upright } of carried.placed) {
    const ox = (middle.x - centre.x) * scale;
    const oy = (middle.y - centre.y) * scale;
    const x = centre.x + shift.x + ox * cos - oy * sin - middle.x;
    const y = centre.y + shift.y + ox * sin + oy * cos - middle.y;
    element.style.translate = `${x * carried.unit}px ${y * carried.unit}px`;
    if (upright) continue;
    element.style.rotate = `${turn}rad`;
    element.style.scale = String(scale);
  }
}

/** Hands the placed elements back to their layers. */
function release(carried: Carried) {
  for (const { element } of carried.placed) {
    element.style.translate = "";
    element.style.rotate = "";
    element.style.scale = "";
  }
}

/**
 * The lasso on the page: draw a loop round what to pick up, then drag inside
 * the box to move it, pull the corner to resize it, or swing the round handle
 * to turn it. The bar under it recolours ink, makes it thicker or thinner, or
 * deletes everything picked up. The pen and the mouse use it; fingers pass on
 * to the page.
 *
 * A drag renders nothing while it moves: the ink is lifted off the page and
 * carried as one picture painted once, the placed things by CSS on their own
 * elements, and the box by its attributes, all from the pointer's own events.
 * Where the drag ends everything is put down for real (`useNotebookLasso`),
 * and what stood in for it goes once that is drawn, in the same frame.
 */
export default function NotebookLassoLayer({ lasso }: { lasso: NotebookLassoController }) {
  const ghostHostRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<SVGPolygonElement | null>(null);
  const stemRef = useRef<SVGLineElement | null>(null);
  const turnRef = useRef<SVGCircleElement | null>(null);
  const scaleRef = useRef<SVGRectElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Loop | Drag | null>(null);
  /** Placed elements to hand back once their layers have drawn them where a drag left them. */
  const releaseRef = useRef<Carried | null>(null);
  const [loop, setLoop] = useState<InkPoint[] | null>(null);
  const [, setDrops] = useState(0);
  const { selection, active } = lasso;
  const holding = active && selection !== null;

  // Put down, a loop half drawn goes.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (loop) setLoop(null);
  }

  /** The box and its bar where a drag has them, set directly while it moves. */
  const paintBox = (geometry: BoxGeometry) => {
    outlineRef.current?.setAttribute("points", points(geometry.corners));
    const stem = stemRef.current;
    if (stem) {
      stem.setAttribute("x1", String(geometry.top.x));
      stem.setAttribute("y1", String(geometry.top.y));
      stem.setAttribute("x2", String(geometry.turn.x));
      stem.setAttribute("y2", String(geometry.turn.y));
    }
    turnRef.current?.setAttribute("cx", String(geometry.turn.x));
    turnRef.current?.setAttribute("cy", String(geometry.turn.y));
    scaleRef.current?.setAttribute("x", String(geometry.scale.x - 9));
    scaleRef.current?.setAttribute("y", String(geometry.scale.y - 9));
    const bar = barRef.current;
    if (bar) {
      bar.style.left = geometry.bar.left;
      bar.style.top = geometry.bar.top;
    }
  };

  /** The drag is over: everything goes where `transform` puts it, and what carried it goes once that is drawn. */
  const finish = (drag: Drag, transform: InkLassoTransform, abandoned: boolean) => {
    const { carried } = drag;
    if (!carried) return;
    lasso.endGesture(transform);
    const { ghost } = carried;
    if (ghost) lasso.whenInkDrawn(() => dropInkGhost(ghost.canvas));
    if (abandoned) {
      release(carried);
      return;
    }
    paintBox(boxGeometry(drag.box, transform));
    // Their layers draw them where they now are in the render this asks for.
    releaseRef.current = carried;
    setDrops((count) => count + 1);
  };

  // Their layers have drawn the placed things where the drag left them.
  useLayoutEffect(() => {
    const carried = releaseRef.current;
    releaseRef.current = null;
    if (carried) release(carried);
  });

  // The lasso put down, or what it held let go of, mid-gesture: a drag puts
  // everything back where it was.
  useLayoutEffect(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.kind === "loop") {
      if (!active) gestureRef.current = null;
      return;
    }
    if (holding) return;
    gestureRef.current = null;
    finish(gesture, gesture.from, true);
  });

  if (!active) return null;

  const geometry = selection ? boxGeometry(selection.box, selection.transform) : null;

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || gestureRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const at = pagePoint(rect, event);
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (selection && geometry) {
      const kind =
        distance(at, geometry.turn) <= HANDLE_REACH
          ? "turn"
          : distance(at, geometry.scale) <= HANDLE_REACH
            ? "scale"
            : isInsideInkLoop(geometry.corners, at)
              ? "move"
              : null;
      if (kind) {
        gestureRef.current = {
          kind,
          pointerId: event.pointerId,
          rect,
          start: at,
          startClient: { x: event.clientX, y: event.clientY },
          from: selection.transform,
          box: selection.box,
          transform: selection.transform,
          carried: null,
        };
        return;
      }
      lasso.letGo();
    }
    gestureRef.current = { kind: "loop", pointerId: event.pointerId, rect, points: [at] };
    setLoop([at]);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const at = pagePoint(gesture.rect, event);
    if (gesture.kind === "loop") {
      const last = gesture.points[gesture.points.length - 1];
      if (distance(last, at) < 2) return;
      gesture.points.push(at);
      setLoop([...gesture.points]);
      return;
    }
    if (!gesture.carried) {
      const travelled = Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y);
      if (travelled < DRAG_THRESHOLD_PX) return;
      const lift = lasso.beginGesture();
      if (!lift) {
        gestureRef.current = null;
        return;
      }
      // What it found on the page, which may have changed since the press.
      gesture.from = lift.selection.transform;
      gesture.box = lift.selection.box;
      gesture.carried = takeUp(lift, gesture.from, event.currentTarget, ghostHostRef.current ?? event.currentTarget);
    }
    gesture.transform = transformFor(gesture, at);
    carry(gesture.carried, gesture.from, gesture.transform);
    paintBox(boxGeometry(gesture.box, gesture.transform));
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.stopPropagation();
    if (gesture.kind === "loop") {
      setLoop(null);
      if (!cancelled) lasso.pickUp(gesture.points);
      return;
    }
    if (!gesture.carried) return;
    finish(gesture, cancelled ? gesture.transform : transformFor(gesture, pagePoint(gesture.rect, event)), false);
  };

  return (
    <div
      data-notebook-lasso="true"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(event) => end(event, false)}
      onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={(event) => end(event, true)}
      className="absolute inset-0 z-40 touch-none select-none"
    >
      {/* The ink a drag carries, painted once (`paintInkGhost`). */}
      <div ref={ghostHostRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      >
        {loop && loop.length > 1 ? (
          <polygon
            points={points(loop)}
            fill="var(--color-accent)"
            fillOpacity={0.08}
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeDasharray="8 6"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {geometry ? (
          <>
            <polygon
              ref={outlineRef}
              points={points(geometry.corners)}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeDasharray="8 6"
              vectorEffect="non-scaling-stroke"
            />
            <line
              ref={stemRef}
              x1={geometry.top.x}
              y1={geometry.top.y}
              x2={geometry.turn.x}
              y2={geometry.turn.y}
              stroke="var(--color-accent)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <circle ref={turnRef} cx={geometry.turn.x} cy={geometry.turn.y} r={10} fill="var(--color-accent)" />
            <rect
              ref={scaleRef}
              x={geometry.scale.x - 9}
              y={geometry.scale.y - 9}
              width={18}
              height={18}
              rx={4}
              fill="var(--color-accent)"
            />
          </>
        ) : null}
      </svg>
      {selection && geometry ? (
        <div
          ref={barRef}
          role="toolbar"
          aria-label="Selection"
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] p-1 shadow-e2"
          style={geometry.bar}
        >
          {selection.ink.length > 0 ? (
            <>
              {COLOURS.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  aria-label={`Make it ${colour}`}
                  title={`Make it ${colour}`}
                  onClick={() => lasso.recolour(inkColorForTool(colour, "pen"))}
                  className="grid h-11 w-11 place-items-center rounded-full transition hover:bg-[var(--color-glass-subtle)]"
                >
                  <span
                    aria-hidden="true"
                    className="h-6 w-6 rounded-full border border-[var(--color-border-strong)]"
                    style={{ backgroundColor: getNotebookStrokePaintColor(colour, "pen") }}
                  />
                </button>
              ))}
              <span aria-hidden="true" className="mx-0.5 h-6 w-px bg-[var(--color-border)]" />
              <button
                type="button"
                aria-label="Thinner"
                title="Thinner"
                onClick={() => lasso.thicken(-1)}
                className="grid h-11 w-11 place-items-center rounded-full text-text-secondary transition hover:bg-[var(--color-glass-subtle)]"
              >
                <NotebookIcon name="minus" />
              </button>
              <button
                type="button"
                aria-label="Thicker"
                title="Thicker"
                onClick={() => lasso.thicken(1)}
                className="grid h-11 w-11 place-items-center rounded-full text-text-secondary transition hover:bg-[var(--color-glass-subtle)]"
              >
                <NotebookIcon name="plus" />
              </button>
              <span aria-hidden="true" className="mx-0.5 h-6 w-px bg-[var(--color-border)]" />
            </>
          ) : null}
          <button
            type="button"
            aria-label="Delete what is selected"
            title="Delete"
            onClick={lasso.remove}
            className="grid h-11 w-11 place-items-center rounded-full text-error transition hover:bg-[var(--color-error-muted)]"
          >
            <NotebookIcon name="trash" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
