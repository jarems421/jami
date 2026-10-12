"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NotebookIcon } from "@/components/workspace/NotebookToolbarIconButton";
import type { NotebookLassoController } from "@/hooks/useNotebookLasso";
import type { InkPoint } from "@/lib/ink/model";
import { isInsideInkLoop, type InkLassoTransform } from "@/lib/ink/tools/lasso";
import { inkColorForTool } from "@/lib/ink-dom/stroke-color";
import { getNotebookStrokePaintColor } from "@/lib/workspace/notebook-page-content";
import { NOTEBOOK_PAGE_COORDINATE_HEIGHT, NOTEBOOK_PAGE_COORDINATE_WIDTH } from "@/lib/workspace/notebooks";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";

const WIDTH = NOTEBOOK_PAGE_COORDINATE_WIDTH;
const HEIGHT = NOTEBOOK_PAGE_COORDINATE_HEIGHT;
/** How near a handle, in page units, a press takes it. */
const HANDLE_REACH = 26;
/** How far out from the top of the box the turn handle stands. */
const TURN_HANDLE_OFFSET = 40;
const COLOURS: NotebookStrokeColor[] = ["black", "white", "red", "green"];

type Gesture =
  | { kind: "loop"; pointerId: number; points: InkPoint[] }
  | { kind: "move" | "scale" | "turn"; pointerId: number; start: InkPoint; from: InkLassoTransform };

const distance = (a: InkPoint, b: InkPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The lasso on the page: draw a loop round what to pick up, then drag inside
 * the box to move it, pull the corner to resize it, or swing the round handle
 * to turn it. The bar under it recolours ink, makes it thicker or thinner, or
 * deletes everything picked up. The pen and the mouse use it; fingers pass on
 * to the page.
 */
export default function NotebookLassoLayer({ lasso }: { lasso: NotebookLassoController }) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [loop, setLoop] = useState<InkPoint[] | null>(null);
  const { selection } = lasso;
  if (!lasso.active) return null;

  const toPage = (event: ReactPointerEvent): InkPoint | null => {
    const box = layerRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      x: ((event.clientX - box.left) / box.width) * WIDTH,
      y: ((event.clientY - box.top) / box.height) * HEIGHT,
    };
  };

  const geometry = selection
    ? (() => {
        const { box } = selection;
        const corners = [
          { x: box.minX, y: box.minY },
          { x: box.maxX, y: box.minY },
          { x: box.maxX, y: box.maxY },
          { x: box.minX, y: box.maxY },
        ].map(lasso.corner);
        const centre = lasso.corner({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
        const top = lasso.corner({ x: (box.minX + box.maxX) / 2, y: box.minY });
        const out = distance(top, centre) || 1;
        const turn = {
          x: top.x + ((top.x - centre.x) / out) * TURN_HANDLE_OFFSET,
          y: top.y + ((top.y - centre.y) / out) * TURN_HANDLE_OFFSET,
        };
        return { corners, centre, top, turn, scale: corners[2] };
      })()
    : null;

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || gestureRef.current) return;
    const at = toPage(event);
    if (!at) return;
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
        gestureRef.current = { kind, pointerId: event.pointerId, start: at, from: selection.transform };
        lasso.beginGesture();
        return;
      }
      lasso.letGo();
    }
    gestureRef.current = { kind: "loop", pointerId: event.pointerId, points: [at] };
    setLoop([at]);
  };

  const transformFor = (gesture: Extract<Gesture, { kind: "move" | "scale" | "turn" }>, at: InkPoint) => {
    const { from, start } = gesture;
    const centre = { x: from.cx + from.dx, y: from.cy + from.dy };
    if (gesture.kind === "move") {
      return { ...from, dx: from.dx + at.x - start.x, dy: from.dy + at.y - start.y };
    }
    if (gesture.kind === "scale") {
      const reach = distance(start, centre) || 1;
      return { ...from, scale: Math.min(8, Math.max(0.1, (from.scale * distance(at, centre)) / reach)) };
    }
    const turned =
      Math.atan2(at.y - centre.y, at.x - centre.x) - Math.atan2(start.y - centre.y, start.x - centre.x);
    return { ...from, rotation: from.rotation + turned };
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const at = toPage(event);
    if (!at) return;
    event.stopPropagation();
    if (gesture.kind === "loop") {
      const last = gesture.points[gesture.points.length - 1];
      if (distance(last, at) < 2) return;
      gesture.points.push(at);
      setLoop([...gesture.points]);
      return;
    }
    lasso.moveGesture(transformFor(gesture, at));
  };

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.stopPropagation();
    if (gesture.kind === "loop") {
      setLoop(null);
      lasso.pickUp(gesture.points);
      return;
    }
    const at = toPage(event);
    lasso.endGesture(at ? transformFor(gesture, at) : gesture.from);
  };

  const points = (list: InkPoint[]) => list.map((point) => `${point.x},${point.y}`).join(" ");
  const lowest = geometry ? Math.max(...geometry.corners.map((corner) => corner.y)) : 0;
  const middle = geometry ? geometry.corners.reduce((sum, corner) => sum + corner.x, 0) / 4 : 0;

  return (
    <div
      ref={layerRef}
      data-notebook-lasso="true"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className="absolute inset-0 z-40 touch-none select-none"
    >
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
              points={points(geometry.corners)}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeDasharray="8 6"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={geometry.top.x}
              y1={geometry.top.y}
              x2={geometry.turn.x}
              y2={geometry.turn.y}
              stroke="var(--color-accent)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={geometry.turn.x} cy={geometry.turn.y} r={10} fill="var(--color-accent)" />
            <rect
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
          role="toolbar"
          aria-label="Selection"
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] p-1 shadow-e2"
          style={{
            left: `${(Math.min(Math.max(middle, 120), WIDTH - 120) / WIDTH) * 100}%`,
            top: `${(Math.min(lowest + 28, HEIGHT - 60) / HEIGHT) * 100}%`,
          }}
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
