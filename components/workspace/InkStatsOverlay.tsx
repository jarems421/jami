"use client";

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  formatInkFrameWindow,
  InkFrameMeter,
  inkInputTraceEnabled,
  type InkFrameWindow,
} from "@/lib/ink-dom/input-trace";

const noSubscription = () => () => {};

/** Whether this tab asked for the ink timing readout (`?inkstats=1`); never on the server. */
function readInkStatsEnabled(): boolean {
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Storage can be blocked; the query string alone still works.
  }
  return inkInputTraceEnabled(window.location.search, storage);
}

export function useInkStatsEnabled(): boolean {
  return useSyncExternalStore(noSubscription, readInkStatsEnabled, () => false);
}

/**
 * The worst two seconds since the notebook began to open: it outlives the
 * loading screen's readout, so a screenshot taken once the notebook is open
 * still shows how the opening went.
 */
let worstSinceOpening: InkFrameWindow | null = null;

function worse(a: InkFrameWindow, b: InkFrameWindow | null): boolean {
  return !b || a.over25 > b.over25 || (a.over25 === b.over25 && a.p95 > b.p95);
}

/**
 * The `?inkstats=1` readout (`lib/ink-dom/input-trace.ts`): the frames now,
 * the worst since the notebook began to open, and, from the ink editor, the
 * last pen stroke's timing in `readoutRef`. Written straight to the DOM, never
 * through React state, so it costs no renders.
 */
export function InkStatsOverlay({
  readoutRef,
  opening = false,
}: {
  readoutRef?: RefObject<HTMLDivElement | null>;
  /** The notebook is still loading: the worst-since-opening record starts again. */
  opening?: boolean;
}) {
  const nowRef = useRef<HTMLDivElement | null>(null);
  const worstRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (opening) worstSinceOpening = null;
    const show = () => {
      if (worstRef.current && worstSinceOpening) {
        worstRef.current.textContent = `worst since opening: ${formatInkFrameWindow(worstSinceOpening)}`;
      }
    };
    show();
    const meter = new InkFrameMeter((window) => {
      if (nowRef.current) nowRef.current.textContent = `now: ${formatInkFrameWindow(window)}`;
      if (worse(window, worstSinceOpening)) worstSinceOpening = window;
      show();
    });
    meter.start();
    // A loading screen usually goes in under a window: what it saw still counts.
    return () => meter.stop(true);
  }, [opening]);

  return createPortal(
    <div
      aria-hidden="true"
      data-ink-stats="true"
      className="pointer-events-none fixed left-2 top-[calc(env(safe-area-inset-top,0px)+4rem)] z-[100] whitespace-pre rounded-md bg-black/75 px-2 py-1.5 font-mono text-2xs leading-snug text-white"
    >
      <div ref={nowRef}>now: measuring…</div>
      <div ref={worstRef} />
      {readoutRef ? <div ref={readoutRef}>Ink timing: write a stroke with the pen.</div> : null}
    </div>,
    document.body
  );
}
