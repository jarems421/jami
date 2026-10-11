import { describe, expect, it, vi } from "vitest";
import { InkHoldDetector } from "@/lib/ink-dom/hold-detector";
import { NOTEBOOK_STRAIGHTEN_HOLD } from "@/lib/workspace/notebook-ink-contact";
import { InkFakeClock } from "./support/ink-fake-timers";

/** The notebook's hold: within 8 px for half a second. */
function detectorAt(clock: InkFakeClock, x = 0, y = 0) {
  const onHold = vi.fn();
  const detector = new InkHoldDetector(x, y, clock.time, onHold, clock.timers);
  return { detector, onHold };
}

describe("the notebook's hold", () => {
  it("is half a second within eight screen pixels", () => {
    expect(NOTEBOOK_STRAIGHTEN_HOLD).toMatchObject({ minTimeSeconds: 0.5, maxRadius: 8 });
  });
});

describe("the hold detector's timer", () => {
  it("fires after half a second even if the pen never moves again", () => {
    const clock = new InkFakeClock();
    const { onHold } = detectorAt(clock);
    clock.advanceTo(499);
    expect(onHold).not.toHaveBeenCalled();
    clock.advanceTo(500);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("waits half a second from where the pen stopped, not from the pen landing", () => {
    const clock = new InkFakeClock();
    const { detector, onHold } = detectorAt(clock);
    // Writing at 100 px a second until 800 ms.
    for (let t = 100; t <= 800; t += 100) {
      clock.advanceTo(t);
      expect(detector.move(t / 10, 0, t)).toBe(false);
    }
    clock.advanceTo(1299);
    expect(onHold).not.toHaveBeenCalled();
    clock.advanceTo(1300);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("holds through a resting hand's tremor at the Pencil's full rate", () => {
    const clock = new InkFakeClock();
    const { detector, onHold } = detectorAt(clock);
    // A third of a pixel either way every 4 ms: tens of pixels a second
    // sample to sample, which restarted the old detector's clock every time.
    for (let t = 4; t <= 520; t += 4) {
      clock.advanceTo(t);
      detector.move((t / 4) % 2 === 0 ? 0.33 : -0.33, 0.2, t);
    }
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("stops when destroyed and holds nothing afterwards", () => {
    const clock = new InkFakeClock();
    const { detector, onHold } = detectorAt(clock);
    expect(clock.pendingCount).toBe(1);
    detector.destroy();
    expect(clock.pendingCount).toBe(0);
    clock.advanceTo(5000);
    expect(onHold).not.toHaveBeenCalled();
    expect(detector.move(50, 50, 5001)).toBe(false);
  });
});

describe("the hold detector's verdict on each move", () => {
  it("says moving until the pen has been still for half a second, then held", () => {
    const clock = new InkFakeClock();
    const { detector } = detectorAt(clock);
    const verdicts: boolean[] = [];
    for (let step = 1; step <= 8; step += 1) {
      const t = step * 100;
      clock.advanceTo(t);
      verdicts.push(detector.move(step % 2 === 0 ? 0 : 0.2, 0, t));
    }
    expect(verdicts).toEqual([false, false, false, false, true, true, true, true]);
  });

  it("starts counting again when the pen drifts past the radius", () => {
    const clock = new InkFakeClock();
    const { detector, onHold } = detectorAt(clock);
    clock.advanceTo(300);
    expect(detector.move(7, 0, 300)).toBe(false);
    clock.advanceTo(400);
    // 9 px from where it stopped is past the 8 px radius: a new hold begins here.
    expect(detector.move(9, 0, 400)).toBe(false);
    clock.advanceTo(899);
    expect(detector.move(9.5, 0, 899)).toBe(false);
    expect(onHold).not.toHaveBeenCalled();
    clock.advanceTo(900);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(detector.move(9.5, 0, 900)).toBe(true);
  });

  it("holds again after moving on, but only once per stop", () => {
    const clock = new InkFakeClock();
    const { detector, onHold } = detectorAt(clock);
    clock.advanceTo(500);
    expect(onHold).toHaveBeenCalledTimes(1);
    clock.advanceTo(2000);
    expect(onHold).toHaveBeenCalledTimes(1);
    clock.advanceTo(2100);
    detector.move(40, 0, 2100);
    clock.advanceTo(2600);
    expect(onHold).toHaveBeenCalledTimes(2);
  });
});
