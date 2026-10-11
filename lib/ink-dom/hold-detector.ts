import { NOTEBOOK_STRAIGHTEN_HOLD } from "@/lib/workspace/notebook-ink-contact";

/**
 * A pen held still at the end of a stroke.
 *
 * Held means the tip has stayed within `maxRadius` screen pixels of where it
 * stopped for `minTimeSeconds`. It works in screen pixels and milliseconds, on
 * the position the ink was drawn to (the smoothed point) and the event's
 * timestamp.
 *
 * It began as a port of js-draw's `StationaryPenDetector`, which also asked for
 * a low average speed, worked out sample to sample. A Pencil reports 240 times
 * a second, and a resting hand's tremor of a fraction of a pixel between two
 * samples 4 ms apart reads as tens of pixels a second: the clock kept starting
 * again, and the snap came late or not at all, "when it wants to". Drift is
 * what a hold is about, so drift is the whole test now: wobbling on the spot
 * holds, creeping away from it does not.
 */

export type InkTimers = {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** The clock event timestamps are on, `performance.now()` by default. */
  now?: () => number;
};

/** The window's timers, for a session that is not given any. */
export function browserInkTimers(): InkTimers {
  return {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    now: () => performance.now(),
  };
}

export type InkHoldConfig = {
  /** Screen pixels the tip may drift from where it stopped and still be held. */
  maxRadius: number;
  minTimeSeconds: number;
};

export class InkHoldDetector {
  private anchorX: number;
  private anchorY: number;
  private anchorTime: number;
  private timer: number | null = null;
  private destroyed = false;
  private readonly now: () => number;
  private readonly holdMs: number;

  /**
   * `x`, `y` and `time` are where and when the stroke began. The clock starts
   * at once: a pen that never moves again still holds.
   */
  constructor(
    x: number,
    y: number,
    time: number,
    private readonly onHold: () => void,
    private readonly timers: InkTimers,
    private readonly config: InkHoldConfig = NOTEBOOK_STRAIGHTEN_HOLD
  ) {
    this.anchorX = x;
    this.anchorY = y;
    this.anchorTime = time;
    this.now = timers.now ?? (() => performance.now());
    this.holdMs = config.minTimeSeconds * 1000;
    this.arm(this.holdMs);
  }

  /**
   * Takes the next position of the pen. True when it is being held still, in
   * which case the move is not added to the stroke.
   */
  move(x: number, y: number, time: number): boolean {
    if (this.destroyed) return false;
    const dx = x - this.anchorX;
    const dy = y - this.anchorY;
    if (dx * dx + dy * dy > this.config.maxRadius * this.config.maxRadius) {
      // Moved on: the hold, if one comes, starts from here.
      this.anchorX = x;
      this.anchorY = y;
      this.anchorTime = time;
      this.arm(this.holdMs);
      return false;
    }
    return time - this.anchorTime >= this.holdMs;
  }

  destroy() {
    this.destroyed = true;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Makes sure the timer will look again by the time a hold from the anchor
   * would be due. One timer at most: on firing it checks how long the pen has
   * really been still, and either holds or waits out the rest.
   */
  private arm(ms: number) {
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      const remaining = this.holdMs - (this.now() - this.anchorTime);
      if (remaining <= 0) this.onHold();
      else this.arm(remaining);
    }, Math.max(0, ms));
  }
}
