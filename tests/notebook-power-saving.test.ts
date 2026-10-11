// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isNotebookFrameRateCapped, notebookPowerSavingMessage } from "@/lib/workspace/notebook-power-saving";

const frames = (pattern: number[], count = 30) => Array.from({ length: count }, (_, index) => pattern[index % pattern.length]);

describe("isNotebookFrameRateCapped", () => {
  it("is a page drawn every 33 ms, as Low Power Mode holds it, timer jitter and all", () => {
    expect(isNotebookFrameRateCapped(frames([33.3]))).toBe(true);
    expect(isNotebookFrameRateCapped(frames([33, 34, 32.9, 35, 33.4]))).toBe(true);
  });

  it("is not a page drawn at full rate, 60 or 120 a second", () => {
    expect(isNotebookFrameRateCapped(frames([16.7]))).toBe(false);
    expect(isNotebookFrameRateCapped(frames([8.3]))).toBe(false);
  });

  it("is not a page merely busy at 60, whose slow frames come between quick ones", () => {
    expect(isNotebookFrameRateCapped(frames([16.7, 33.4, 16.7, 50, 33.4]))).toBe(false);
    expect(isNotebookFrameRateCapped(frames([33.4, 33.4, 33.4, 16.7]))).toBe(false);
  });

  it("is not a page stalling longer than the cap", () => {
    expect(isNotebookFrameRateCapped(frames([66, 50, 83]))).toBe(false);
  });

  it("will not say from too few frames", () => {
    expect(isNotebookFrameRateCapped(frames([33.3], 10))).toBe(false);
  });
});

describe("notebookPowerSavingMessage", () => {
  it("names Low Power Mode and where to turn it off on an iPad, battery saver elsewhere", () => {
    expect(notebookPowerSavingMessage(true)).toContain("Settings → Battery");
    expect(notebookPowerSavingMessage(true)).toContain("Low Power Mode");
    expect(notebookPowerSavingMessage(false)).toContain("Battery saver");
  });
});
