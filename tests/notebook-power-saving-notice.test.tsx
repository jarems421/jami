// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotebookPowerSavingNotice } from "@/hooks/useNotebookPowerSavingNotice";
import { NOTEBOOK_POWER_SAVING_SAMPLING } from "@/lib/workspace/notebook-power-saving";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let now = 0;
let frameQueue: Array<(time: number) => void> = [];

function Probe() {
  const { visible, dismiss } = useNotebookPowerSavingNotice();
  return (
    <button type="button" data-visible={String(visible)} onClick={dismiss}>
      dismiss
    </button>
  );
}

const visible = () => container.querySelector("button")!.dataset.visible === "true";

/** Runs the page's frames every `interval` ms for `ms`. */
function runFrames(interval: number, ms: number) {
  const end = now + ms;
  while (now < end) {
    now += interval;
    const callbacks = frameQueue;
    frameQueue = [];
    act(() => callbacks.forEach((callback) => callback(now)));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  frameQueue = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    frameQueue.push(callback);
    return frameQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useNotebookPowerSavingNotice", () => {
  it("shows once the page is found held to 30 frames a second, and goes when it is not", () => {
    expect(visible()).toBe(false);
    act(() => void vi.advanceTimersByTime(NOTEBOOK_POWER_SAVING_SAMPLING.firstAfterMs));
    runFrames(33.3, NOTEBOOK_POWER_SAVING_SAMPLING.sampleMs + 100);
    expect(visible()).toBe(true);

    // Low Power Mode turned off: the next look finds full speed.
    act(() => void vi.advanceTimersByTime(NOTEBOOK_POWER_SAVING_SAMPLING.everyMs));
    runFrames(16.7, NOTEBOOK_POWER_SAVING_SAMPLING.sampleMs + 100);
    expect(visible()).toBe(false);
  });

  it("stays away for the tab once dismissed", () => {
    act(() => void vi.advanceTimersByTime(NOTEBOOK_POWER_SAVING_SAMPLING.firstAfterMs));
    runFrames(33.3, NOTEBOOK_POWER_SAVING_SAMPLING.sampleMs + 100);
    act(() => container.querySelector("button")!.click());
    expect(visible()).toBe(false);
    expect(window.sessionStorage.getItem("jami:power-saving-notice-dismissed")).toBe("1");
  });

  it("does not show at full speed", () => {
    act(() => void vi.advanceTimersByTime(NOTEBOOK_POWER_SAVING_SAMPLING.firstAfterMs));
    runFrames(16.7, NOTEBOOK_POWER_SAVING_SAMPLING.sampleMs + 100);
    expect(visible()).toBe(false);
  });
});
