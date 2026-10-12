"use client";

import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { InkPoint } from "@/lib/ink/model";
import { inkRulerDegrees, slideInkRuler, twistInkRuler, type InkRuler } from "@/lib/ink/tools/ruler";

type Handler = (event: ReactPointerEvent<HTMLDivElement>) => void;

/**
 * The ruler, laid over the page in page units so it zooms with it.
 *
 * Fingers that land on it move it (one) and turn it (two, about the point
 * between them, settling on every 15 degrees). The pen and the mouse are not
 * its business: they go straight on to the ink underneath (`ink`), so a stroke
 * can start on the ruler's edge as well as beside it. Touch on it never pans
 * the page.
 */
export default function NotebookRuler({
  ruler,
  page,
  toPage,
  onChange,
  ink,
}: {
  ruler: InkRuler;
  page: { width: number; height: number };
  /** A client position on the page, in page units; null while the page is not measured. */
  toPage: (clientX: number, clientY: number) => InkPoint | null;
  onChange: (ruler: InkRuler) => void;
  ink: { onPointerDown: Handler; onPointerMove: Handler; onPointerUp: Handler; onPointerCancel: Handler; onLostPointerCapture: Handler };
}) {
  const fingersRef = useRef(new Map<number, InkPoint>());
  /** The ruler and the two fingers when the second one landed. */
  const twistRef = useRef<{ start: InkRuler; before: [InkPoint, InkPoint] } | null>(null);
  // The ruler as the last move left it, ahead of the render that shows it.
  const rulerRef = useRef(ruler);
  useLayoutEffect(() => {
    rulerRef.current = ruler;
  }, [ruler]);
  const place = (next: InkRuler) => {
    rulerRef.current = next;
    onChange(next);
  };

  const fingers = () => [...fingersRef.current.values()];
  const restartTwist = () => {
    const [a, b] = fingers();
    twistRef.current = a && b ? { start: rulerRef.current, before: [a, b] } : null;
  };

  const down: Handler = (event) => {
    if (event.pointerType !== "touch") return ink.onPointerDown(event);
    event.stopPropagation();
    const at = toPage(event.clientX, event.clientY);
    if (!at || fingersRef.current.size >= 2) return;
    fingersRef.current.set(event.pointerId, at);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser has already let go of; the next move sorts it out.
    }
    restartTwist();
  };

  const move: Handler = (event) => {
    if (event.pointerType !== "touch") return ink.onPointerMove(event);
    event.stopPropagation();
    const last = fingersRef.current.get(event.pointerId);
    const at = toPage(event.clientX, event.clientY);
    if (!last || !at) return;
    fingersRef.current.set(event.pointerId, at);
    const twist = twistRef.current;
    if (twist) {
      const [a, b] = fingers();
      place(twistInkRuler(twist.start, twist.before, [a, b]));
    } else {
      place(slideInkRuler(rulerRef.current, last, at));
    }
  };

  const lift = (forward: Handler): Handler => (event) => {
    if (event.pointerType !== "touch") return forward(event);
    event.stopPropagation();
    if (!fingersRef.current.delete(event.pointerId)) return;
    restartTwist();
  };

  const degrees = inkRulerDegrees(ruler.angle);
  return (
    <div
      role="presentation"
      data-notebook-ruler="true"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={lift(ink.onPointerUp)}
      onPointerCancel={lift(ink.onPointerCancel)}
      onLostPointerCapture={lift(ink.onLostPointerCapture)}
      className="absolute z-10 touch-none select-none rounded-md border shadow-e2"
      style={{
        left: `${(ruler.cx / page.width) * 100}%`,
        top: `${(ruler.cy / page.height) * 100}%`,
        width: `${(ruler.length / page.width) * 100}%`,
        height: `${(ruler.width / page.height) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${ruler.angle}rad)`,
        // A grey the page shows through, clear on white paper and on black.
        backgroundColor: "rgba(100, 116, 139, 0.22)",
        borderColor: "rgba(100, 116, 139, 0.7)",
        backgroundImage:
          "repeating-linear-gradient(to right, rgba(71, 85, 105, 0.85) 0 1px, transparent 1px 10px), repeating-linear-gradient(to right, rgba(71, 85, 105, 0.85) 0 1px, transparent 1px 50px)",
        backgroundSize: "100% 22%, 100% 40%",
        backgroundRepeat: "no-repeat",
      }}
    >
      <span
        aria-label={`Ruler at ${degrees} degrees`}
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-surface-panel-strong)] px-2 py-0.5 text-xs font-semibold tabular-nums text-text-primary"
        style={{ transform: `translate(-50%, -50%) rotate(${-ruler.angle}rad)` }}
      >
        {degrees}°
      </span>
    </div>
  );
}
