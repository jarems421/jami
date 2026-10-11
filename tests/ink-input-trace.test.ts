// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  formatInkFrameWindow,
  formatInkTrace,
  InkFrameMeter,
  InkInputTrace,
  inkInputTraceEnabled,
  inkTracePercentiles,
  type InkFrameWindow,
  type InkTraceClock,
} from "@/lib/ink-dom/input-trace";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A clock the test moves by hand, with frames it runs on demand. */
function fakeClock() {
  let time = 0;
  let next = 1;
  const pending = new Map<number, () => void>();
  const clock: InkTraceClock = {
    now: () => time,
    requestFrame(callback) {
      const handle = next;
      next += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      pending.delete(handle);
    },
  };
  return {
    clock,
    at(value: number) {
      time = value;
    },
    frame(value: number) {
      time = value;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
    waiting: () => pending.size,
  };
}

describe("inkInputTraceEnabled", () => {
  it("is off unless asked for, and stays on for the tab until turned off", () => {
    const storage = memoryStorage();
    expect(inkInputTraceEnabled("", storage)).toBe(false);
    expect(inkInputTraceEnabled("?page=p1&inkstats=1", storage)).toBe(true);
    expect(inkInputTraceEnabled("?page=p2", storage)).toBe(true);
    expect(inkInputTraceEnabled("?inkstats=0", storage)).toBe(false);
    expect(inkInputTraceEnabled("?page=p2", storage)).toBe(false);
  });

  it("works from the query string alone when storage is unavailable or throws", () => {
    expect(inkInputTraceEnabled("?inkstats=1", null)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(inkInputTraceEnabled("?inkstats=1", throwing)).toBe(true);
    expect(inkInputTraceEnabled("", throwing)).toBe(false);
  });
});

describe("inkTracePercentiles", () => {
  it("reads the median, the 95th percentile and the largest of the values recorded", () => {
    const values = new Float64Array(200);
    for (let index = 0; index < 100; index += 1) values[index] = 100 - index;
    expect(inkTracePercentiles(values, 100)).toEqual({ p50: 51, p95: 96, max: 100 });
    expect(inkTracePercentiles(values, 0)).toEqual({ p50: 0, p95: 0, max: 0 });
  });
});

describe("InkInputTrace", () => {
  it("times each packet's sample ages and work, the wait for the next frame, and the frames", () => {
    const time = fakeClock();
    const trace = new InkInputTrace(64, time.clock);
    time.at(1000);
    trace.begin();
    // Frames every 16 ms; a packet lands 4 ms into each, with samples 6 to 14 ms old.
    for (let frame = 0; frame < 5; frame += 1) {
      const start = 1004 + frame * 16;
      trace.packet(start - 6, start - 14, start, start + 2, 4, frame < 4 ? 1 : 0);
      time.frame(1016 + frame * 16);
    }
    // One slow frame.
    time.frame(1016 + 4 * 16 + 40);
    time.at(1200);
    const summary = trace.end(1.5);

    expect(summary.packets).toBe(5);
    expect(summary.durationMs).toBe(200);
    expect(summary.newestAgeMs).toEqual({ p50: 6, p95: 6, max: 6 });
    expect(summary.oldestAgeMs).toEqual({ p50: 14, p95: 14, max: 14 });
    expect(summary.handlerMs).toEqual({ p50: 2, p95: 2, max: 2 });
    expect(summary.toFrameMs).toEqual({ p50: 10, p95: 10, max: 10 });
    expect(summary.frames).toBe(5);
    expect(summary.frameMs.p50).toBe(16);
    expect(summary.frameMs.max).toBe(40);
    expect(summary.framesOver25).toBe(1);
    expect(summary.coalescedPerPacket).toBe(4);
    expect(summary.predictedShare).toBeCloseTo(0.8, 6);
    expect(summary.liftMs).toBe(1.5);
    // The frame loop stops with the stroke.
    expect(time.waiting()).toBe(0);
  });

  it("keeps the first packets of a stroke longer than its buffers, and starts afresh each stroke", () => {
    const time = fakeClock();
    const trace = new InkInputTrace(3, time.clock);
    trace.begin();
    for (let index = 0; index < 10; index += 1) trace.packet(0, 0, index, index + 1, 1, 0);
    expect(trace.end(0).packets).toBe(3);
    trace.begin();
    trace.packet(0, 0, 5, 6, 1, 0);
    expect(trace.end(0).packets).toBe(1);
  });

  it("stops watching frames when a stroke is cancelled", () => {
    const time = fakeClock();
    const trace = new InkInputTrace(8, time.clock);
    trace.begin();
    expect(time.waiting()).toBe(1);
    trace.cancel();
    expect(time.waiting()).toBe(0);
  });
});

describe("InkFrameMeter", () => {
  it("reports the frames of each window, pen or no pen, until stopped", () => {
    const time = fakeClock();
    const windows: InkFrameWindow[] = [];
    const meter = new InkFrameMeter((window) => windows.push(window), 100, time.clock);
    time.at(0);
    meter.start();
    // 16 ms frames with one 50 ms stall, over just past one window.
    let now = 0;
    for (const gap of [16, 16, 16, 50, 16, 16]) {
      now += gap;
      time.frame(now);
    }
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ frames: 4, over25: 1, max: 50, p50: 16, windowMs: 114 });
    expect(formatInkFrameWindow(windows[0])).toBe("frames, last 0.1 s   16 / 50 / 50 ms, 1 of 4 over 25 ms");

    meter.stop();
    expect(time.waiting()).toBe(0);
  });

  it("reports a window cut short when stopped with a flush, so a brief loading screen still counts", () => {
    const time = fakeClock();
    const windows: InkFrameWindow[] = [];
    const meter = new InkFrameMeter((window) => windows.push(window), 2000, time.clock);
    time.at(0);
    meter.start();
    time.frame(16);
    time.frame(80);
    time.frame(96);
    meter.stop(true);
    expect(windows).toEqual([expect.objectContaining({ frames: 2, over25: 1, max: 64, windowMs: 96 })]);

    // Nothing measured since: a second flush reports nothing.
    meter.stop(true);
    expect(windows).toHaveLength(1);
  });
});

describe("formatInkTrace", () => {
  it("says what was measured, one figure per line", () => {
    const time = fakeClock();
    const trace = new InkInputTrace(8, time.clock);
    trace.begin();
    trace.packet(0, 0, 8, 9, 2, 1);
    time.frame(16);
    time.frame(32);
    const text = formatInkTrace(trace.end(0.4), { tool: "pen, pen", scale: 2.5, devicePixelRatio: 2 });
    expect(text).toContain("Last stroke: pen, pen, 1 packets");
    expect(text).toContain("zoom 2.50 x2");
    expect(text).toContain("newest sample age   8.0 / 8.0 / 8.0 ms");
    expect(text).toContain("wait for next frame 7.0 / 7.0 / 7.0 ms");
    expect(text).toContain("frames (~63 Hz)");
    expect(text).toContain("samples per packet  2.0, predicted in 100% of packets");
  });
});
