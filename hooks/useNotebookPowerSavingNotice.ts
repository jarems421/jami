"use client";

import { useCallback, useEffect, useState } from "react";
import {
  isNotebookFrameRateCapped,
  NOTEBOOK_POWER_SAVING_SAMPLING,
} from "@/lib/workspace/notebook-power-saving";

const DISMISSED_KEY = "jami:power-saving-notice-dismissed";

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether to tell the student their device is holding the notebook to 30
 * frames a second to save power (`lib/workspace/notebook-power-saving.ts`).
 *
 * Looks for a second shortly after the notebook opens, every minute after
 * that, and whenever the tab comes back into view (as it does on returning
 * from Settings), so the notice goes as soon as Low Power Mode is off. Once
 * dismissed it stays away for the tab.
 */
export function useNotebookPowerSavingNotice() {
  const [capped, setCapped] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    const { firstAfterMs, sampleMs, everyMs } = NOTEBOOK_POWER_SAVING_SAMPLING;
    const intervals: number[] = [];
    let frame = 0;
    let last = 0;
    let until = 0;
    let sampling = false;
    let stopped = false;

    const tick = (now: number) => {
      if (stopped) return;
      if (last > 0) intervals.push(now - last);
      last = now;
      if (now < until) {
        frame = requestAnimationFrame(tick);
        return;
      }
      sampling = false;
      setCapped(isNotebookFrameRateCapped(intervals));
    };
    const sample = () => {
      if (stopped || sampling || document.visibilityState !== "visible") return;
      sampling = true;
      intervals.length = 0;
      last = 0;
      until = performance.now() + sampleMs;
      frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") sample();
    };

    const first = window.setTimeout(sample, firstAfterMs);
    const every = window.setInterval(sample, everyMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(first);
      window.clearInterval(every);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Blocked storage: dismissed until the notebook is next opened.
    }
  }, []);

  return { visible: capped && !dismissed, dismiss };
}
