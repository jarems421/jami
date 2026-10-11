import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInkChiselBuilder } from "@/lib/ink/geometry/chisel";
import { createInkPenBuilder } from "@/lib/ink/geometry/pen";
import { importJsDrawSvg } from "@/lib/ink/import-js-draw-svg";
import { inkItemLayer, type InkColor, type InkPaint, type InkPathCommand } from "@/lib/ink/model";
import {
  HIGHLIGHTER_SETTLE_MS,
  InkStrokeSession,
  inkColorForTool,
  penInkPaint,
  type InkLiveSink,
  type InkPointerSample,
  type InkStrokeTool,
} from "@/lib/ink-dom/stroke-session";
import type { InkLiveTip } from "@/lib/ink-dom/renderer";
import { NotebookInkSmoother } from "@/lib/workspace/notebook-ink-smoothing";
import {
  clampNotebookPenSettings,
  getNotebookInkSmoothingOptions,
  getNotebookPenFeelFromSettings,
  NOTEBOOK_PEN_SETTINGS_DEFAULT,
  type NotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";
import { InkFakeClock } from "./support/ink-fake-timers";

const MAPPING = { left: 20, top: 40, scale: 2 };
const BLACK = inkColorForTool("black", "pen");
const YELLOW = inkColorForTool("yellow", "highlighter");
const GUIDED = NOTEBOOK_PEN_SETTINGS_DEFAULT;
const NO_HOLD: NotebookPenSettings = { ...NOTEBOOK_PEN_SETTINGS_DEFAULT, straightenOnHold: "off" };

type Draw = { path: InkPathCommand[]; paint: InkPaint; tip: InkLiveTip | null };

function recordingSink() {
  const events: string[] = [];
  const draws: Draw[] = [];
  const sink: InkLiveSink = {
    beginLive: (layer) => {
      events.push(`begin:${layer}`);
    },
    drawLive: (path, paint, tip) => {
      events.push("draw");
      draws.push({ path, paint, tip: tip ?? null });
    },
    cancelLive: () => {
      events.push("cancel");
    },
  };
  return { sink, events, draws };
}

function sample(x: number, y: number, time: number, pressure = 0.5): InkPointerSample {
  return { clientX: x, clientY: y, pressure, timeStamp: time };
}

/** A wave along the page, one sample every 4.2 ms (a pencil at 240 Hz). */
function wave(count: number, pressureAt: (index: number) => number = () => 0.5): InkPointerSample[] {
  return Array.from({ length: count }, (_unused, index) =>
    sample(100 + index * 5, 200 + 24 * Math.sin(index / 4), 4.2 + index * 4.2, pressureAt(index))
  );
}

const FIRST = sample(100, 200, 0);

function penTool(overrides: Partial<Extract<InkStrokeTool, { kind: "pen" }>> = {}): InkStrokeTool {
  return {
    kind: "pen",
    color: BLACK,
    thickness: 4,
    pressure: false,
    settings: NO_HOLD,
    predictTip: false,
    ...overrides,
  };
}

function highlighterTool(): InkStrokeTool {
  return { kind: "highlighter", color: YELLOW, thickness: 30, settings: NO_HOLD, nibAngle: () => 0.5 };
}

/**
 * What js-draw's pipeline does to the same samples, written out by hand from
 * its formulas: smooth in screen pixels, map to the page, width = pressure x
 * thickness (floored at 0.3) or half the thickness, straight into the builder.
 */
class ReferencePen {
  readonly pen;
  private readonly smoother;

  constructor(
    first: InkPointerSample,
    private readonly input: { thickness: number; pressure: boolean; settings: NotebookPenSettings }
  ) {
    const settings = clampNotebookPenSettings(input.settings);
    this.smoother = new NotebookInkSmoother(
      { x: first.clientX, y: first.clientY, time: first.timeStamp },
      getNotebookInkSmoothingOptions(settings)
    );
    this.pen = createInkPenBuilder(
      {
        x: (first.clientX - MAPPING.left) / MAPPING.scale,
        y: (first.clientY - MAPPING.top) / MAPPING.scale,
        width: this.widthOf(first.pressure),
        time: first.timeStamp,
      },
      // Tapered from the first sample when it writes with pressure, as the session's pen is.
      { feel: getNotebookPenFeelFromSettings(settings), pixelSize: 1 / MAPPING.scale, tapered: input.pressure }
    );
  }

  private widthOf(pressure: number) {
    return this.input.pressure ? Math.max(pressure, 0.3) * this.input.thickness : 0.5 * this.input.thickness;
  }

  add(next: InkPointerSample) {
    const settled = this.smoother.next({ x: next.clientX, y: next.clientY, time: next.timeStamp });
    this.pen.addPoint({
      x: (settled.x - MAPPING.left) / MAPPING.scale,
      y: (settled.y - MAPPING.top) / MAPPING.scale,
      width: this.widthOf(next.pressure),
      time: next.timeStamp,
    });
  }

  paintOf(color: InkColor = BLACK) {
    const geometry = this.pen.geometry();
    return { path: geometry.path, paint: penInkPaint(geometry.paint, color) };
  }
}

function packets<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

describe("a pen stroke draws what js-draw's pen pipeline draws", () => {
  it("shows the contact at once, as a dot, before any movement", () => {
    const { sink, events, draws } = recordingSink();
    new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    expect(events).toEqual(["begin:pen", "draw"]);
    // First point (100, 200) is page (40, 80); a nib of 0.5 x 4 = 2 is a dot of radius 1.
    expect(draws[0].path[0]).toEqual({ op: "M", x: 41, y: 80 });
    expect(draws[0].paint).toEqual({ fill: BLACK, stroke: null, opacity: 1 });
    expect(draws[0].tip).toBeNull();
  });

  it("matches the pen builder fed the smoothed page samples, packet by packet", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: NO_HOLD });
    for (const packet of packets(wave(60), 3)) {
      session.move(packet);
      for (const each of packet) reference.add(each);
      const expected = reference.paintOf();
      expect(draws[draws.length - 1].path).toEqual(expected.path);
      expect(draws[draws.length - 1].paint).toEqual(expected.paint);
    }
    // No pressure: a stroked line at half the thickness.
    const last = draws[draws.length - 1].paint;
    expect(last.fill).toBeNull();
    expect(last.stroke?.width).toBeCloseTo(2, 10);
    expect(last.stroke).toMatchObject({ cap: "round", join: "round" });
  });

  it("makes the width pressure x thickness when pressure is on", () => {
    const { sink, draws } = recordingSink();
    const pressureAt = (index: number) => 0.4 + 0.4 * Math.sin(index / 6) ** 2;
    const session = new InkStrokeSession({
      tool: penTool({ pressure: true, thickness: 6 }),
      mapping: MAPPING,
      sink,
      first: sample(100, 200, 0, 0.5),
    });
    const reference = new ReferencePen(sample(100, 200, 0, 0.5), { thickness: 6, pressure: true, settings: NO_HOLD });
    for (const packet of packets(wave(60, pressureAt), 4)) {
      session.move(packet);
      for (const each of packet) reference.add(each);
    }
    const expected = reference.paintOf();
    expect(draws[draws.length - 1].path).toEqual(expected.path);
    // Pressure that varies is drawn as the stroke's own outline.
    expect(draws[draws.length - 1].paint.fill).toEqual(BLACK);
  });

  it("floors the pressure at 0.3", () => {
    const { sink, draws } = recordingSink();
    // 0.12 is above the lift-off ceiling (0.08), so the gate lets it through.
    const first = sample(100, 200, 0, 0.12);
    const session = new InkStrokeSession({ tool: penTool({ pressure: true, thickness: 10 }), mapping: MAPPING, sink, first });
    const body = wave(30, () => 0.12);
    for (const packet of packets(body, 5)) session.move(packet);
    // The reference pen floors at 0.3 itself: drawing the same path is drawing at 0.3 of the nib.
    const reference = new ReferencePen(first, { thickness: 10, pressure: true, settings: NO_HOLD });
    for (const each of body) reference.add(each);
    expect(draws[draws.length - 1].path).toEqual(reference.paintOf().path);
    // Pressured, it is the tapered outline even though the pressure never varied.
    expect(draws[draws.length - 1].paint.fill).toEqual(BLACK);
  });

  it("draws a pressured stroke tapered from its first packet, so its start never changes shape", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({
      tool: penTool({ pressure: true, thickness: 6 }),
      mapping: MAPPING,
      sink,
      first: sample(100, 200, 0, 0.5),
    });
    for (const packet of packets(wave(12, (index) => 0.4 + index * 0.02), 2)) session.move(packet);
    for (const draw of draws) expect(draw.paint.fill).toEqual(BLACK);
  });

  it("draws one width when pressure is turned down to nothing, whatever the pencil reports", () => {
    const { sink, draws } = recordingSink();
    const settings = { ...NO_HOLD, pressurePercent: 0 };
    const session = new InkStrokeSession({
      tool: penTool({ pressure: true, thickness: 6, settings }),
      mapping: MAPPING,
      sink,
      first: sample(100, 200, 0, 0.9),
    });
    session.move(wave(20, (index) => 0.2 + 0.7 * ((index * 7) % 10) / 10));
    const paint = draws[draws.length - 1].paint;
    expect(paint.fill).toBeNull();
    expect(paint.stroke?.width).toBeCloseTo(3, 10);
  });

  it("ignores pressure when it is off, whatever the pen reports", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool({ thickness: 6 }), mapping: MAPPING, sink, first: FIRST });
    session.move(wave(20, (index) => 0.2 + 0.7 * ((index * 7) % 10) / 10));
    expect(draws[draws.length - 1].paint.stroke?.width).toBeCloseTo(3, 10);
  });

  it("skips samples that are not numbers", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: NO_HOLD });
    const good = wave(10);
    session.move([...good.slice(0, 5), sample(Number.NaN, 5, 30), ...good.slice(5)]);
    for (const each of good) reference.add(each);
    expect(draws[draws.length - 1].path).toEqual(reference.paintOf().path);
  });
});

describe("lifting a pen stroke", () => {
  it("returns exactly what live ink last drew, with no point added at the lift", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: NO_HOLD });
    for (const packet of packets(wave(40), 2)) {
      session.move(packet);
      for (const each of packet) reference.add(each);
    }
    const drawsBefore = draws.length;
    const result = session.lift();
    // Nothing more is drawn: there was no tip, and the lift adds nothing.
    expect(draws).toHaveLength(drawsBefore);
    const last = draws[draws.length - 1];
    expect(result).not.toBeNull();
    expect(result?.layer).toBe("pen");
    expect(result?.path).toBe(last.path);
    expect(result?.paint).toBe(last.paint);
    // And it is the stroke js-draw's builder makes from the samples alone.
    expect(result?.path).toEqual(reference.paintOf().path);
  });

  it("keeps a tap as its dot", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    const result = session.lift();
    expect(result?.path).toBe(draws[0].path);
    expect(result?.paint.fill).toEqual(BLACK);
  });

  it("does not draw the tail the pen sends as it leaves the glass", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    const body = wave(14);
    session.move(body);
    const drawsBefore = draws.length;
    const pathBefore = draws[draws.length - 1].path;
    // Pressure collapsing against the stroke's own, under the ceiling: held.
    const tail = [sample(190, 210, 80, 0.02), sample(193, 212, 84, 0.01)];
    session.move(tail);
    expect(draws).toHaveLength(drawsBefore);
    const result = session.lift();
    expect(draws).toHaveLength(drawsBefore);
    expect(result?.path).toBe(pathBefore);
  });

  it("draws the held samples, in order, when the pressure comes back", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool(), mapping: MAPPING, sink, first: FIRST });
    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: NO_HOLD });
    const body = wave(14);
    session.move(body);
    for (const each of body) reference.add(each);
    const dip = sample(190, 210, 80, 0.02);
    const back = sample(194, 212, 84, 0.5);
    session.move([dip]);
    session.move([back]);
    reference.add(dip);
    reference.add(back);
    expect(draws[draws.length - 1].path).toEqual(reference.paintOf().path);
  });

  it("returns null and cancels the live stroke when there is nothing worth keeping", () => {
    const { sink, events } = recordingSink();
    const session = new InkStrokeSession({
      tool: penTool(),
      mapping: MAPPING,
      sink,
      first: sample(Number.NaN, 200, 0),
    });
    expect(session.lift()).toBeNull();
    expect(events[events.length - 1]).toBe("cancel");
  });
});

describe("the highlighter", () => {
  it("draws footprints at its whole thickness while it is written, not half of it as js-draw did", () => {
    const { sink, events, draws } = recordingSink();
    const tool = highlighterTool();
    const session = new InkStrokeSession({ tool, mapping: MAPPING, sink, first: FIRST, timers: new InkFakeClock().timers });
    expect(events.slice(0, 2)).toEqual(["begin:highlighter", "draw"]);
    const chisel = createInkChiselBuilder(
      { x: 40, y: 80, width: 30 },
      { pixelSize: 0.5, nibAngle: () => 0.5 }
    );
    expect(draws[0].path).toEqual(chisel.preview().path);

    const smoother = new NotebookInkSmoother(
      { x: FIRST.clientX, y: FIRST.clientY, time: 0 },
      getNotebookInkSmoothingOptions(clampNotebookPenSettings(NO_HOLD))
    );
    for (const packet of packets(wave(40), 4)) {
      session.move(packet);
      for (const each of packet) {
        const settled = smoother.next({ x: each.clientX, y: each.clientY, time: each.timeStamp });
        chisel.addPoint({
          x: (settled.x - MAPPING.left) / MAPPING.scale,
          y: (settled.y - MAPPING.top) / MAPPING.scale,
          width: 30,
        });
      }
      expect(draws[draws.length - 1].path).toEqual(chisel.preview().path);
    }
    expect(draws[draws.length - 1].paint).toEqual({ fill: YELLOW, stroke: null, opacity: 1 });
  });

  it("draws the traced outline at the lift when the pen was still moving, and returns exactly that", () => {
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: highlighterTool(), mapping: MAPPING, sink, first: FIRST, timers: new InkFakeClock().timers });
    const body = wave(40);
    session.move(body);
    const previewDraws = draws.length;
    const previewPath = draws[draws.length - 1].path;

    const result = session.lift();
    // One more packet, the outline, and it is what is returned.
    expect(draws).toHaveLength(previewDraws + 1);
    const last = draws[draws.length - 1];
    expect(last.tip).toBeNull();
    expect(last.path).not.toEqual(previewPath);
    expect(result?.layer).toBe("highlighter");
    expect(result?.path).toBe(last.path);
    expect(result?.paint).toBe(last.paint);
    expect(result?.paint).toEqual({ fill: YELLOW, stroke: null, opacity: 1 });
  });

  it("never reads pressure", () => {
    const run = (pressure: number) => {
      const { sink, draws } = recordingSink();
      const session = new InkStrokeSession({ tool: highlighterTool(), mapping: MAPPING, sink, first: FIRST, timers: new InkFakeClock().timers });
      session.move(wave(20, () => pressure));
      return draws[draws.length - 1].path;
    };
    expect(run(0.9)).toEqual(run(0.2));
  });
});

describe("the highlighter's last live movement", () => {
  function start() {
    const clock = new InkFakeClock();
    const recorded = recordingSink();
    const session = new InkStrokeSession({ tool: highlighterTool(), mapping: MAPPING, sink: recorded.sink, first: FIRST, timers: clock.timers });
    return { clock, session, ...recorded };
  }

  /** What a flick (a lift with the footprints still showing) draws and returns: the outline of these samples. */
  function flickOutline(samples: InkPointerSample[]) {
    const { session, draws } = start();
    session.move(samples);
    session.lift();
    return draws[draws.length - 1].path;
  }

  it("draws the traced outline once the pen has stopped, and the lift then draws nothing", () => {
    const { clock, session, draws } = start();
    const body = wave(40);
    session.move(body);
    const footprints = draws[draws.length - 1].path;
    const drawn = draws.length;

    clock.advanceTo(HIGHLIGHTER_SETTLE_MS - 1);
    expect(draws).toHaveLength(drawn);
    clock.advanceTo(HIGHLIGHTER_SETTLE_MS);
    expect(draws).toHaveLength(drawn + 1);
    const outline = draws[draws.length - 1];
    expect(outline.path).not.toEqual(footprints);
    expect(outline.path).toEqual(flickOutline(body));

    const result = session.lift();
    expect(draws).toHaveLength(drawn + 1);
    // The very objects live ink drew, so the renderer finds the live ink to be exactly what is committed.
    expect(result?.path).toBe(outline.path);
    expect(result?.paint).toBe(outline.paint);
    expect(clock.pendingCount).toBe(0);
  });

  it("waits for the pen to stop from its last packet, not its first", () => {
    const { clock, session, draws } = start();
    const body = wave(40);
    session.move(body.slice(0, 20));
    clock.advanceTo(HIGHLIGHTER_SETTLE_MS - 10);
    session.move(body.slice(20));
    const drawn = draws.length;
    clock.advanceTo(HIGHLIGHTER_SETTLE_MS + 10);
    expect(draws).toHaveLength(drawn);
    clock.advanceTo(2 * HIGHLIGHTER_SETTLE_MS - 10);
    expect(draws).toHaveLength(drawn + 1);
  });

  it("draws the outline at once when the gate holds the samples of a pen that is leaving the glass", () => {
    const { clock, session, draws } = start();
    const body = wave(14);
    session.move(body);
    const footprints = draws[draws.length - 1].path;
    const drawn = draws.length;

    // Pressure collapsing against the stroke's own, under the ceiling: held, and the lift.
    session.move([sample(190, 210, 80, 0.02)]);
    expect(draws).toHaveLength(drawn + 1);
    const outline = draws[draws.length - 1];
    expect(outline.path).not.toEqual(footprints);
    expect(outline.path).toEqual(flickOutline(body));

    const result = session.lift();
    expect(draws).toHaveLength(drawn + 1);
    expect(result?.path).toBe(outline.path);
    expect(clock.pendingCount).toBe(0);
  });

  it("draws the outline with the packet when it also adds the samples before the held ones", () => {
    const { session, draws } = start();
    session.move(wave(14));
    const drawn = draws.length;
    const more = [sample(140, 220, 70, 0.5), sample(145, 224, 74, 0.02)];
    session.move(more);
    expect(draws).toHaveLength(drawn + 1);
    const outline = draws[draws.length - 1];
    expect(outline.path).toEqual(flickOutline([...wave(14), more[0]]));
    expect(session.lift()?.path).toBe(outline.path);
    expect(draws).toHaveLength(drawn + 1);
  });

  it("goes back to footprints when the pen moves again, and a flick then draws the outline at the lift", () => {
    const { clock, session, draws } = start();
    const body = wave(40);
    session.move(body.slice(0, 30));
    clock.advanceTo(HIGHLIGHTER_SETTLE_MS);
    const settled = draws[draws.length - 1];
    session.move(body.slice(30));
    const moving = draws[draws.length - 1];
    expect(moving.path).not.toEqual(settled.path);
    expect(moving.path.length).toBeGreaterThan(settled.path.length);

    const drawn = draws.length;
    const result = session.lift();
    expect(draws).toHaveLength(drawn + 1);
    expect(result?.path).toBe(draws[draws.length - 1].path);
    expect(result?.path).toEqual(flickOutline(body));
    expect(clock.pendingCount).toBe(0);
  });

  it("shows a tap held on the page as its outline too", () => {
    const { clock, session, draws } = start();
    const drawn = draws.length;
    clock.advanceTo(HIGHLIGHTER_SETTLE_MS);
    expect(draws).toHaveLength(drawn + 1);
    const result = session.lift();
    expect(draws).toHaveLength(drawn + 1);
    expect(result?.path).toBe(draws[draws.length - 1].path);
  });

  it("stops waiting when the stroke is cancelled", () => {
    const { clock, session, draws } = start();
    session.move(wave(10));
    session.cancel();
    expect(clock.pendingCount).toBe(0);
    const drawn = draws.length;
    clock.advanceTo(1000);
    expect(draws).toHaveLength(drawn);
  });
});

describe("the predicted tip", () => {
  /** A straight run, 2 px every 4 ms, for the tracker to measure a speed from. */
  const run = (count: number) =>
    Array.from({ length: count }, (_unused, index) => sample(100 + (index + 1) * 2, 200, (index + 1) * 4));
  const ahead = (from: number) => [sample(from + 2, 200, 0), sample(from + 4, 200, 0)].map((point, index) => ({
    ...point,
    timeStamp: 40 + 4 * (index + 1),
  }));

  function stylus(overrides: Partial<Extract<InkStrokeTool, { kind: "pen" }>> = {}) {
    const recorded = recordingSink();
    const session = new InkStrokeSession({
      tool: penTool({ predictTip: true, ...overrides }),
      mapping: MAPPING,
      sink: recorded.sink,
      first: FIRST,
    });
    return { session, ...recorded };
  }

  it("is a round-capped line from the end of the stroke through the predicted points", () => {
    const { session, draws } = stylus();
    const body = run(10); // ends at client (120, 200), at 40 ms
    const reach = session.move(body, ahead(120));
    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: NO_HOLD });
    for (const each of body) reference.add(each);
    reference.pen.geometry();
    const end = reference.pen.liveTip();

    const tip = draws[draws.length - 1].tip;
    expect(end).not.toBeNull();
    expect(tip).not.toBeNull();
    expect(tip?.path).toEqual([
      { op: "M", x: end?.x, y: end?.y },
      { op: "L", x: (122 - 20) / 2, y: (200 - 40) / 2 },
      { op: "L", x: (124 - 20) / 2, y: (200 - 40) / 2 },
    ]);
    expect(tip?.paint).toEqual({
      fill: null,
      stroke: { color: BLACK, width: end?.width, cap: "round", join: "round" },
      opacity: 1,
    });
    // The stroke itself is untouched by the tip.
    expect(draws[draws.length - 1].path).toEqual(reference.paintOf().path);
    // How far ahead of the line it reached, in CSS pixels, for the readout.
    expect(reach).toBeCloseTo(Math.hypot(52 - (end?.x ?? 0), 80 - (end?.y ?? 0)) * MAPPING.scale, 6);
  });

  it("is taken off the live layer by one more draw at the lift, and is not part of the result", () => {
    const { session, draws } = stylus();
    session.move(run(10), ahead(120));
    const withTip = draws[draws.length - 1];
    expect(withTip.tip).not.toBeNull();
    const drawsBefore = draws.length;

    const result = session.lift();
    expect(draws).toHaveLength(drawsBefore + 1);
    const wiped = draws[draws.length - 1];
    expect(wiped.tip).toBeNull();
    expect(wiped.path).toBe(withTip.path);
    expect(result?.path).toBe(withTip.path);
    expect(result?.paint).toBe(withTip.paint);
  });

  it("is not shown as the pressure falls away, nor without predictions, nor for another tool", () => {
    const fading = stylus();
    fading.session.move([...run(9), sample(120, 200, 40, 0.05)], ahead(120));
    expect(fading.draws[fading.draws.length - 1].tip).toBeNull();

    const none = stylus();
    expect(none.session.move(run(10), [])).toBe(0);
    expect(none.draws[none.draws.length - 1].tip).toBeNull();

    const mouse = stylus({ predictTip: false });
    mouse.session.move(run(10), ahead(120));
    expect(mouse.draws[mouse.draws.length - 1].tip).toBeNull();

    const seeThrough = stylus({ color: { r: 17, g: 24, b: 39, a: 0.5 } });
    seeThrough.session.move(run(10), ahead(120));
    expect(seeThrough.draws[seeThrough.draws.length - 1].tip).toBeNull();
  });

  it("moves on with the line, or goes, when the gate holds a whole packet", () => {
    const { session, draws } = stylus();
    session.move(run(10), ahead(120));
    const standing = draws[draws.length - 1];
    expect(standing.tip).not.toBeNull();
    const standingCount = draws.length;

    // The pen is leaving the glass: pressure collapses and the packet is held.
    session.move([sample(122, 200, 44, 0.02)], ahead(122));
    expect(draws).toHaveLength(standingCount + 1);
    const after = draws[draws.length - 1];
    expect(after.tip).toBeNull();
    expect(after.path).toBe(standing.path);

    // With no tip standing, a held packet draws nothing at all.
    const drawsBefore = draws.length;
    session.move([sample(124, 200, 48, 0.01)], ahead(124));
    expect(draws).toHaveLength(drawsBefore);
  });
});

describe("straightening on hold", () => {
  /** A fast, dead straight run to the right: 5 px every 4.2 ms. */
  const line = Array.from({ length: 20 }, (_unused, index) =>
    sample(100 + (index + 1) * 5, 200, (index + 1) * 4.2)
  );
  const lastTime = line[line.length - 1].timeStamp;

  function guidedPen(settings: NotebookPenSettings = GUIDED) {
    const clock = new InkFakeClock();
    const recorded = recordingSink();
    const session = new InkStrokeSession({
      tool: penTool({ settings }),
      mapping: MAPPING,
      sink: recorded.sink,
      first: FIRST,
      timers: clock.timers,
    });
    for (const each of line) {
      clock.advanceTo(each.timeStamp);
      session.move([each]);
    }
    return { session, clock, ...recorded };
  }

  it("snaps a line half a second after the pen stops, and draws it at once", () => {
    const { clock, draws } = guidedPen();
    const drawsBefore = draws.length;
    clock.advanceTo(lastTime + 499);
    expect(draws).toHaveLength(drawsBefore);
    clock.advanceTo(lastTime + 501);
    expect(draws).toHaveLength(drawsBefore + 1);

    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: GUIDED });
    for (const each of line) reference.add(each);
    const snapped = reference.pen.straighten();
    expect(snapped).not.toBeNull();
    const shown = draws[draws.length - 1];
    expect(shown.path).toEqual(snapped?.path);
    expect(shown.path).toHaveLength(2);
    expect(shown.paint).toEqual(penInkPaint(snapped!.paint, BLACK));
    expect(shown.tip).toBeNull();
  });

  it("goes on aiming the snapped line, and the lift keeps the aimed line", () => {
    const { session, clock, draws } = guidedPen();
    clock.advanceTo(lastTime + 501);
    const aim = sample(200, 230, lastTime + 600);
    clock.advanceTo(aim.timeStamp);
    session.move([aim]);

    const reference = new ReferencePen(FIRST, { thickness: 4, pressure: false, settings: GUIDED });
    for (const each of line) reference.add(each);
    reference.pen.straighten();
    // The smoother steps for the aiming sample just as it does for any other.
    reference.add(aim);
    const aimed = reference.pen.geometry();
    expect(aimed.path).toHaveLength(2);

    const last = draws[draws.length - 1];
    expect(last.path).toEqual(aimed.path);
    const result = session.lift();
    expect(result?.path).toBe(last.path);
    expect(result?.path).toEqual(aimed.path);
    // And a stroke that was snapped but never aimed lifts as the snapped line.
    expect(result?.paint.stroke).not.toBeNull();
  });

  it("lifts a snapped line that was never moved as that line", () => {
    const { session, clock, draws } = guidedPen();
    clock.advanceTo(lastTime + 501);
    const snapped = draws[draws.length - 1];
    const result = session.lift();
    expect(result?.path).toBe(snapped.path);
    expect(result?.paint).toBe(snapped.paint);
  });

  it("does not add the moves of a pen that is being held", () => {
    const { session, clock, draws } = guidedPen();
    // Tremor every 100 ms after the stroke. The average speed of the stroke
    // takes a few samples to die away, then a second of stillness is needed.
    const tremor = (step: number) => sample(200 + (step % 2 === 0 ? 0 : 0.2), 200, lastTime + step * 100);
    let step = 1;
    for (; step < 15; step += 1) {
      clock.advanceTo(tremor(step).timeStamp);
      session.move([tremor(step)]);
    }
    // The hold fires on the 15th sample; from then on moves are not added.
    clock.advanceTo(tremor(15).timeStamp);
    const snappedAt = draws.length;
    expect(draws[snappedAt - 1].path).toHaveLength(2);
    for (step = 15; step < 19; step += 1) {
      clock.advanceTo(tremor(step).timeStamp);
      session.move([tremor(step)]);
    }
    expect(draws).toHaveLength(snappedAt);
  });

  it("never straightens the highlighter", () => {
    const clock = new InkFakeClock();
    const { sink, draws } = recordingSink();
    new InkStrokeSession({
      tool: { ...highlighterTool(), settings: GUIDED } as InkStrokeTool,
      mapping: MAPPING,
      sink,
      first: FIRST,
      timers: clock.timers,
    });
    // Its one timer is the wait for the pen to stop, which draws the traced
    // outline (the same filled shape), never a straightened line.
    expect(clock.pendingCount).toBe(1);
    clock.advanceTo(5000);
    expect(draws).toHaveLength(2);
    expect(draws[1].paint).toEqual(draws[0].paint);
    expect(clock.pendingCount).toBe(0);
  });

  it("does nothing when the setting is off", () => {
    const { clock, draws } = guidedPen(NO_HOLD);
    expect(clock.pendingCount).toBe(0);
    const drawsBefore = draws.length;
    clock.advanceTo(lastTime + 5000);
    expect(draws).toHaveLength(drawsBefore);
  });

  it("leaves a stroke that is not a line as it was drawn", () => {
    const clock = new InkFakeClock();
    const { sink, draws } = recordingSink();
    const session = new InkStrokeSession({
      tool: penTool({ settings: GUIDED }),
      mapping: MAPPING,
      sink,
      first: FIRST,
      timers: clock.timers,
    });
    // Three quarters of a circle: far from any line.
    const arc = Array.from({ length: 30 }, (_unused, index) => {
      const angle = Math.PI + (index / 29) * 1.5 * Math.PI;
      return sample(150 + 50 * Math.cos(angle), 200 + 50 * Math.sin(angle), (index + 1) * 4.2);
    });
    for (const each of arc) {
      clock.advanceTo(each.timeStamp);
      session.move([each]);
    }
    const drawsBefore = draws.length;
    clock.advanceTo(2000);
    expect(draws).toHaveLength(drawsBefore);
  });
});

describe("ending a session", () => {
  it("clears the hold timer at the lift", () => {
    const clock = new InkFakeClock();
    const { sink } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool({ settings: GUIDED }), mapping: MAPPING, sink, first: FIRST, timers: clock.timers });
    expect(clock.pendingCount).toBe(1);
    session.lift();
    expect(clock.pendingCount).toBe(0);
  });

  it("cancels the live stroke and the timer, and ignores everything after", () => {
    const clock = new InkFakeClock();
    const { sink, events, draws } = recordingSink();
    const session = new InkStrokeSession({ tool: penTool({ settings: GUIDED }), mapping: MAPPING, sink, first: FIRST, timers: clock.timers });
    session.move(wave(5));
    session.cancel();
    expect(clock.pendingCount).toBe(0);
    expect(events.filter((event) => event === "cancel")).toHaveLength(1);

    const drawsBefore = draws.length;
    session.move(wave(5));
    clock.advanceTo(5000);
    expect(draws).toHaveLength(drawsBefore);
    expect(session.lift()).toBeNull();
    session.cancel();
    expect(events.filter((event) => event === "cancel")).toHaveLength(1);
  });
});

describe("inkColorForTool", () => {
  const fixture = (name: string) =>
    readFileSync(path.join(process.cwd(), "tests", "fixtures", "ink", "js-draw", name), "utf8");
  const firstOutline = (name: string, layer: "pen" | "highlighter" = "pen") => {
    const item = importJsDrawSvg(fixture(name))?.document.items.find((each) => inkItemLayer(each) === layer);
    if (item?.kind !== "outline") throw new Error(`${name} has no ${layer} outline`);
    return item;
  };

  it("gives the pen the colour js-draw saved for it", () => {
    expect(BLACK).toEqual({ r: 0x11, g: 0x18, b: 0x27, a: 1 });
    expect(firstOutline("pen-thin.svg").paint.stroke?.color).toEqual(BLACK);
    expect(firstOutline("pen-pressure.svg").paint.fill).toEqual(BLACK);
  });

  it("gives the highlighter the colour and translucency js-draw saved for it", () => {
    // 0.42 of 255 saves as 0x6b; live ink draws the 8-bit value it will reopen with.
    expect(YELLOW).toEqual({ r: 0xfd, g: 0xe0, b: 0x47, a: 0x6b / 255 });
    expect(firstOutline("highlighter.svg", "highlighter").paint.fill).toEqual(YELLOW);
  });

  it("resolves custom colours and the other names the same way the toolbar does", () => {
    expect(inkColorForTool("#123abc", "pen")).toEqual({ r: 0x12, g: 0x3a, b: 0xbc, a: 1 });
    expect(inkColorForTool("#123abc", "highlighter")).toEqual({ r: 0x12, g: 0x3a, b: 0xbc, a: 0x6b / 255 });
    expect(inkColorForTool("red", "pen")).toEqual({ r: 0xef, g: 0x44, b: 0x44, a: 1 });
  });
});
