/**
 * An on-device readout of how long the pen's input takes to become ink.
 *
 * Off unless the notebook is opened with `?inkstats=1` (and kept on for the
 * tab until `?inkstats=0`). With it on, every pen stroke is timed and the
 * figures are shown over the page when the pen lifts. It exists because the
 * delay a hand feels on an iPad cannot be measured anywhere else: desktop
 * Chromium, throttled or not, does not draw or deliver input the way Safari
 * on an iPad does.
 *
 * What it measures, per packet (one `pointermove`):
 * - how old the newest and the oldest sample in it are when the handler starts
 *   (`timeStamp` against the clock): the browser's delivery, plus any task
 *   that kept the main thread busy;
 * - how long the handler takes, which is all the ink work, drawing included;
 * - how many coalesced and predicted samples came with it, and how far past
 *   the newest sample the browser's prediction reached;
 * - how far ahead of the line the predicted tip was drawn, if it was;
 * - how long after the handler the next frame begins.
 *
 * And the frames themselves while the pen is down, and the lift. The display
 * pipeline after a frame (compositing, the screen) is not visible from a page.
 * A live line above it (`InkFrameMeter`) gives the frames of the last couple
 * of seconds whatever is happening, pen or no pen.
 *
 * Nothing is allocated while a stroke is written: the buffers are made once
 * and the frame loop reuses one callback. Strokes longer than the buffers keep
 * their first `capacity` packets.
 */

export type InkTracePercentiles = { p50: number; p95: number; max: number };

export type InkTraceSummary = {
  packets: number;
  durationMs: number;
  newestAgeMs: InkTracePercentiles;
  oldestAgeMs: InkTracePercentiles;
  handlerMs: InkTracePercentiles;
  toFrameMs: InkTracePercentiles;
  frameMs: InkTracePercentiles;
  framesOver25: number;
  frames: number;
  coalescedPerPacket: number;
  predictedShare: number;
  /** How far past the newest sample the prediction reached, over the packets that had one. */
  predictedAheadMs: InkTracePercentiles;
  /** The share of packets that drew a predicted tip. */
  tipShare: number;
  /** How far ahead of the line the tip reached, in CSS pixels, over the packets that drew one. */
  tipPx: InkTracePercentiles;
  liftMs: number;
};

export type InkTraceContext = {
  tool: string;
  /** CSS pixels per page unit when the stroke began. */
  scale: number;
  devicePixelRatio: number;
};

export type InkTraceClock = {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
};

const browserClock: InkTraceClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

const STORAGE_KEY = "jami:ink-stats";

/** Whether the readout is on for this tab: `?inkstats=1` turns it on, `?inkstats=0` off. */
export function inkInputTraceEnabled(search: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): boolean {
  const asked = new URLSearchParams(search).get("inkstats");
  try {
    if (asked === "1") storage?.setItem(STORAGE_KEY, "1");
    if (asked === "0") storage?.removeItem(STORAGE_KEY);
    return asked === "1" || (asked !== "0" && storage?.getItem(STORAGE_KEY) === "1");
  } catch {
    return asked === "1";
  }
}

/** The 50th and 95th percentiles and the largest of the first `count` values. */
export function inkTracePercentiles(values: Float64Array, count: number): InkTracePercentiles {
  if (count <= 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(count - 1, Math.floor(share * count))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[count - 1] };
}

export class InkInputTrace {
  private readonly newestAge: Float64Array;
  private readonly oldestAge: Float64Array;
  private readonly handler: Float64Array;
  private readonly ends: Float64Array;
  private readonly coalesced: Float64Array;
  private readonly predicted: Float64Array;
  private readonly predictedAhead: Float64Array;
  private readonly tipReach: Float64Array;
  private readonly frameTimes: Float64Array;
  private readonly toFrame: Float64Array;
  private readonly intervals: Float64Array;
  private packets = 0;
  private predictions = 0;
  private tips = 0;
  private frames = 0;
  private started = 0;
  private frameHandle: number | null = null;
  private readonly onFrame = () => {
    if (this.frames < this.frameTimes.length) {
      this.frameTimes[this.frames] = this.clock.now();
      this.frames += 1;
    }
    this.frameHandle = this.clock.requestFrame(this.onFrame);
  };

  constructor(
    private readonly capacity = 2048,
    private readonly clock: InkTraceClock = browserClock
  ) {
    this.newestAge = new Float64Array(capacity);
    this.oldestAge = new Float64Array(capacity);
    this.handler = new Float64Array(capacity);
    this.ends = new Float64Array(capacity);
    this.coalesced = new Float64Array(capacity);
    this.predicted = new Float64Array(capacity);
    this.predictedAhead = new Float64Array(capacity);
    this.tipReach = new Float64Array(capacity);
    this.frameTimes = new Float64Array(capacity);
    this.toFrame = new Float64Array(capacity);
    this.intervals = new Float64Array(capacity);
  }

  /** A stroke begins: the buffers are reset and frames are watched until it ends. */
  begin(): void {
    this.stopFrames();
    this.packets = 0;
    this.predictions = 0;
    this.tips = 0;
    this.frames = 0;
    this.started = this.clock.now();
    this.frameHandle = this.clock.requestFrame(this.onFrame);
  }

  /**
   * One packet: the newest and oldest sample times, when the handler started
   * and ended, how many samples and predictions came with it, how far past the
   * newest sample the last prediction was (ignored without one), and how far
   * ahead of the line the tip was drawn, in CSS pixels (0 for no tip).
   */
  packet(
    newestTime: number,
    oldestTime: number,
    start: number,
    end: number,
    coalesced: number,
    predicted: number,
    predictedAheadMs: number,
    tipPx: number
  ): void {
    const index = this.packets;
    if (index >= this.capacity) return;
    this.newestAge[index] = start - newestTime;
    this.oldestAge[index] = start - oldestTime;
    this.handler[index] = end - start;
    this.ends[index] = end;
    this.coalesced[index] = coalesced;
    this.predicted[index] = predicted;
    this.packets = index + 1;
    if (predicted > 0 && Number.isFinite(predictedAheadMs)) {
      this.predictedAhead[this.predictions] = predictedAheadMs;
      this.predictions += 1;
    }
    if (tipPx > 0) {
      this.tipReach[this.tips] = tipPx;
      this.tips += 1;
    }
  }

  /** The stroke has ended (the lift took `liftMs`): its figures. */
  end(liftMs: number): InkTraceSummary {
    this.stopFrames();
    const packets = this.packets;
    const frames = this.frames;
    // How long after each packet the next frame began; a packet after the
    // last frame recorded has none to wait for and is left out.
    let waits = 0;
    let frame = 0;
    for (let index = 0; index < packets; index += 1) {
      while (frame < frames && this.frameTimes[frame] < this.ends[index]) frame += 1;
      if (frame >= frames) break;
      this.toFrame[waits] = this.frameTimes[frame] - this.ends[index];
      waits += 1;
    }
    let over25 = 0;
    for (let index = 1; index < frames; index += 1) {
      const interval = this.frameTimes[index] - this.frameTimes[index - 1];
      this.intervals[index - 1] = interval;
      if (interval > 25) over25 += 1;
    }
    let coalesced = 0;
    let withPrediction = 0;
    for (let index = 0; index < packets; index += 1) {
      coalesced += this.coalesced[index];
      if (this.predicted[index] > 0) withPrediction += 1;
    }
    return {
      packets,
      durationMs: this.clock.now() - this.started,
      newestAgeMs: inkTracePercentiles(this.newestAge, packets),
      oldestAgeMs: inkTracePercentiles(this.oldestAge, packets),
      handlerMs: inkTracePercentiles(this.handler, packets),
      toFrameMs: inkTracePercentiles(this.toFrame, waits),
      frameMs: inkTracePercentiles(this.intervals, Math.max(0, frames - 1)),
      framesOver25: over25,
      frames: Math.max(0, frames - 1),
      coalescedPerPacket: packets > 0 ? coalesced / packets : 0,
      predictedShare: packets > 0 ? withPrediction / packets : 0,
      predictedAheadMs: inkTracePercentiles(this.predictedAhead, this.predictions),
      tipShare: packets > 0 ? this.tips / packets : 0,
      tipPx: inkTracePercentiles(this.tipReach, this.tips),
      liftMs,
    };
  }

  /** The stroke was cancelled: nothing to report. */
  cancel(): void {
    this.stopFrames();
    this.packets = 0;
    this.predictions = 0;
    this.tips = 0;
    this.frames = 0;
  }

  private stopFrames(): void {
    if (this.frameHandle !== null) this.clock.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }
}

export type InkFrameWindow = InkTracePercentiles & { frames: number; over25: number; windowMs: number };

/**
 * The readout's live line: the frames over the last couple of seconds, pen or
 * no pen, so how smooth the notebook is while it opens, sits idle, pans or has
 * its toolbar dragged can be read on the device too. On an iPad a frame waits
 * for the one before to be composited, so a page that is heavy to draw shows
 * here as long frames even when no script is running.
 */
export class InkFrameMeter {
  private readonly intervals: Float64Array;
  private count = 0;
  private last = 0;
  private windowStart = 0;
  private handle: number | null = null;
  private readonly onFrame = () => {
    const now = this.clock.now();
    if (this.last > 0 && this.count < this.intervals.length) {
      this.intervals[this.count] = now - this.last;
      this.count += 1;
    }
    this.last = now;
    if (now - this.windowStart >= this.windowMs) {
      this.report(this.window(now - this.windowStart));
      this.count = 0;
      this.windowStart = now;
    }
    this.handle = this.clock.requestFrame(this.onFrame);
  };

  constructor(
    private readonly report: (window: InkFrameWindow) => void,
    private readonly windowMs = 2000,
    private readonly clock: InkTraceClock = browserClock
  ) {
    this.intervals = new Float64Array(1024);
  }

  start(): void {
    this.stop();
    this.count = 0;
    this.last = 0;
    this.windowStart = this.clock.now();
    this.handle = this.clock.requestFrame(this.onFrame);
  }

  /**
   * Stops measuring. With `flush`, a window cut short is reported first, so a
   * screen gone in under a window (a notebook's loading screen) still counts.
   */
  stop(flush = false): void {
    if (this.handle !== null) this.clock.cancelFrame(this.handle);
    this.handle = null;
    if (flush && this.count > 0) {
      this.report(this.window(this.clock.now() - this.windowStart));
      this.count = 0;
    }
  }

  private window(elapsed: number): InkFrameWindow {
    let over25 = 0;
    for (let index = 0; index < this.count; index += 1) if (this.intervals[index] > 25) over25 += 1;
    return { ...inkTracePercentiles(this.intervals, this.count), frames: this.count, over25, windowMs: elapsed };
  }
}

const ms = (value: number) => (value >= 10 ? value.toFixed(0) : value.toFixed(1));

/** The live line, as the readout shows it. */
export function formatInkFrameWindow(window: InkFrameWindow): string {
  return `frames, last ${(window.windowMs / 1000).toFixed(1)} s   ${ms(window.p50)} / ${ms(window.p95)} / ${ms(window.max)} ms, ${window.over25} of ${window.frames} over 25 ms`;
}
const spread = (value: InkTracePercentiles, unit = "ms") =>
  `${ms(value.p50)} / ${ms(value.p95)} / ${ms(value.max)} ${unit}`;

/** The figures as the readout shows them, one line each. */
export function formatInkTrace(summary: InkTraceSummary, context: InkTraceContext): string {
  const hz = summary.frameMs.p50 > 0 ? Math.round(1000 / summary.frameMs.p50) : 0;
  return [
    `Last stroke: ${context.tool}, ${summary.packets} packets in ${ms(summary.durationMs)} ms, zoom ${context.scale.toFixed(2)} x${context.devicePixelRatio}`,
    `p50 / p95 / max`,
    `newest sample age   ${spread(summary.newestAgeMs)}`,
    `oldest sample age   ${spread(summary.oldestAgeMs)}`,
    `ink work per packet ${spread(summary.handlerMs)}`,
    `wait for next frame ${spread(summary.toFrameMs)}`,
    `frames (~${hz} Hz)    ${spread(summary.frameMs)}, ${summary.framesOver25} of ${summary.frames} over 25 ms`,
    `samples per packet  ${summary.coalescedPerPacket.toFixed(1)}, predicted in ${(summary.predictedShare * 100).toFixed(0)}% of packets`,
    `prediction reaches  ${spread(summary.predictedAheadMs)}`,
    `tip ahead of line   ${spread(summary.tipPx, "px")}, in ${(summary.tipShare * 100).toFixed(0)}% of packets`,
    `lift                ${ms(summary.liftMs)} ms`,
  ].join("\n");
}
