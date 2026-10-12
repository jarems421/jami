import { createInkChiselBuilder, type InkChiselBuilder } from "@/lib/ink/geometry/chisel";
import { createInkPenBuilder, type InkPenBuilder } from "@/lib/ink/geometry/pen";
import type { InkColor, InkLayer, InkPaint, InkPathCommand, InkPoint, InkShapeGeometry } from "@/lib/ink/model";
import { inkShapePath } from "@/lib/ink/shapes";
import {
  inkRulerEdgeNear,
  projectOntoInkRulerEdge,
  type InkRuler,
  type InkRulerEdge,
} from "@/lib/ink/tools/ruler";
import {
  adjustInkShape,
  inkShapeTraceDistance,
  recognizeInkShape,
  type InkRecognizedShape,
} from "@/lib/ink/tools/shape-recognition";
import { browserInkTimers, InkHoldDetector, type InkTimers } from "@/lib/ink-dom/hold-detector";
import type { InkLiveTip, InkRenderer } from "@/lib/ink-dom/renderer";
import { inkColorForTool } from "@/lib/ink-dom/stroke-color";
import { penInkPaint } from "@/lib/ink-dom/stroke-paint";
import { NotebookInkSmoother, type NotebookInkSample } from "@/lib/workspace/notebook-ink-smoothing";
import { NOTEBOOK_LIFT_OFF, NotebookLiftOffGate } from "@/lib/workspace/notebook-lift-off";
import {
  clampNotebookPenSettings,
  getNotebookInkSmoothingOptions,
  getNotebookPenFeelFromSettings,
  type NotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";
import {
  NotebookPredictedTip,
  type NotebookPredictedTipPoint,
  type NotebookPredictedTipSample,
} from "@/lib/workspace/notebook-predicted-tip";

/**
 * One pen or highlighter stroke, from the pen landing to it lifting: the input
 * pipeline of Jami Ink, outside React and outside js-draw.
 *
 * It reproduces what the js-draw pen does with the same pointer samples, so a
 * stroke written here has the geometry js-draw would have given it:
 *
 * 1. the lift-off gate holds back the samples a pen sends as it leaves the
 *    glass (`notebook-lift-off.ts`);
 * 2. the One Euro smoother filters what the gate lets through, in screen
 *    pixels (`notebook-ink-smoothing.ts`);
 * 3. the filtered point becomes a page position, and a width in page units:
 *    `pressure * thickness` with the pressure floored at 0.3 when pressure is
 *    on, otherwise `0.5 * thickness` (js-draw's `Pen.toStrokePoint`); the
 *    highlighter is its whole thickness (`HIGHLIGHTER_PRESSURE`);
 * 4. the pen or chisel builder (`lib/ink/geometry/`) shapes the path;
 * 5. the path is drawn on the live layer, synchronously, once per packet.
 *
 * The lift adds no point (js-draw adds one at the lift position, which is why
 * its stroke can change as the pen leaves), and holds the smoother where it is:
 * the stroke ends exactly on the ink live ink last drew, and `lift()` returns
 * that very path and paint. Committing it is the surface's job.
 *
 * A pen held still at the end of a stroke snaps it: to a straight line, which
 * the pen builder judges and then aims at the pen (`straighten` in `pen.ts`),
 * or, when the tool allows shapes, to a circle, an oval, a polygon or an arrow
 * (`shape-recognition.ts`), which the pen then sizes and turns until it lifts
 * -- unless, after a closed shape, it goes on along it, going round again
 * (`followHeld`). The lift keeps what was snapped and the stroke as it was
 * drawn before, which undoing the snap brings back.
 *
 * With the ruler out, a stroke that lands within `RULER_REACH_PX` of one of its
 * long edges is held to that edge for its whole length, pen or highlighter.
 *
 * The highlighter shows its footprints while it moves, but what is saved is
 * their traced outline (`build()`), whose edge pixels differ from the
 * footprints'. So its last live movement draws the outline: as soon as the pen
 * has stopped (no packet for `HIGHLIGHTER_SETTLE_MS`) or is leaving the glass
 * (the lift-off gate is holding samples). The lift then commits what is already
 * on screen and draws nothing. Movement after that goes back to footprints.
 *
 * Nothing here reads layout or allocates a canvas; the only allocations per
 * sample are the small objects the smoother and the builders take.
 */

/** Client px of the page's corner, and client px per page unit. Fixed for a stroke. */
export type InkScreenMapping = { left: number; top: number; scale: number };

export type InkPointerSample = {
  clientX: number;
  clientY: number;
  pressure: number;
  /** `PointerEvent.timeStamp`, in milliseconds. */
  timeStamp: number;
};

export type InkStrokeTool =
  | {
      kind: "pen";
      color: InkColor;
      /** The nib width in page units. */
      thickness: number;
      /** Whether pressure varies the width: only a pencil on an iPad does. */
      pressure: boolean;
      settings: NotebookPenSettings;
      /** Whether to draw a tip ahead of the pen: only a stylus does. */
      predictTip: boolean;
      /**
       * Whether holding still may snap a stroke that is not a line to a shape.
       * Lines snap whenever the settings' hold does.
       */
      shapes: boolean;
    }
  | {
      kind: "highlighter";
      color: InkColor;
      thickness: number;
      settings: NotebookPenSettings;
      /** Which way the flat edge faces, asked once per accepted sample. */
      nibAngle: () => number;
    };

export type InkLiveSink = Pick<InkRenderer, "beginLive" | "drawLive" | "cancelLive">;

export type InkStrokeResult = {
  layer: InkLayer;
  path: InkPathCommand[];
  paint: InkPaint;
  /**
   * Set when holding still snapped the stroke: the line or shape it became,
   * which `path` and `paint` draw, and the stroke as it was drawn before.
   */
  snapped?: {
    shape: InkShapeGeometry;
    color: InkColor;
    width: number;
    drawn: { path: InkPathCommand[]; paint: InkPaint };
  };
};

export type InkStrokeSessionInput = {
  tool: InkStrokeTool;
  mapping: InkScreenMapping;
  sink: InkLiveSink;
  /** The pen landing. */
  first: InkPointerSample;
  /** For the hold that straightens a line; the window's by default. */
  timers?: InkTimers;
  /** The ruler, when it is out. */
  ruler?: InkRuler | null;
};

export { inkColorForTool, penInkPaint };

/**
 * How long a highlighter goes without a packet before it counts as stopped and
 * draws its traced outline. An Apple Pencil reports every 4 ms and Safari
 * delivers a packet each frame (17 ms at 60 Hz) while the pen moves, so 50 ms
 * is three frames of stillness: a dropped frame or two does not trip it, and
 * a pause to look at the page does.
 */
export const HIGHLIGHTER_SETTLE_MS = 50;

/** How near a ruler's edge, in screen pixels, a stroke has to land to be drawn along it. */
export const RULER_REACH_PX = 16;

/** js-draw's `Pen.toStrokePoint`: the least pressure a width is made from, and the width without pressure. */
const PRESSURE_FLOOR = 0.3;
const DEFAULT_PRESSURE = 0.5;
/**
 * The highlighter's nib is its whole setting, not half of it as js-draw drew
 * it. Its range (`NOTEBOOK_HIGHLIGHTER_MIN_WIDTH` to `_MAX_WIDTH`) is meant in
 * page units, from under a ruled line to more than one, and halved it never
 * covered a line of writing.
 */
const HIGHLIGHTER_PRESSURE = 1;

const NO_SAMPLES: readonly InkPointerSample[] = [];
/**
 * Screen pixels the pen may be from a closed shape it has snapped to, or from
 * the stroke drawn for it, and still be going over it again.
 */
const TRACE_REACH_PX = 12;
/** How far it goes on along it, after the snap, to be going over it rather than sizing it. */
const TRACE_DECIDE_PX = 24;

/**
 * A shape holding still snapped the stroke to, as the pen has sized and
 * turned it since. `follow` is what the pen is doing with it: not yet clear,
 * going over it again (which changes nothing), or sizing it from `at`.
 */
type Held = {
  shape: InkRecognizedShape;
  at: InkPoint;
  geometry: InkShapeGeometry;
  width: number;
  /** The stroke as drawn when it snapped, in page units. */
  drawnPoints: readonly InkPoint[];
  follow: "deciding" | "tracing" | "sizing";
  /** Screen pixels the pen has gone since the snap, while deciding, and where it last was. */
  travelled: number;
  last: InkPoint;
};

/** Whether a path draws anything: it starts at a finite point and goes somewhere. */
function hasGeometry(path: readonly InkPathCommand[]): boolean {
  const start = path[0];
  return path.length > 1 && start.op === "M" && Number.isFinite(start.x) && Number.isFinite(start.y);
}

/** A straightened line, from the two-point path the pen draws it as. */
function lineOf(path: readonly InkPathCommand[]): InkShapeGeometry | null {
  const [from, to] = path;
  return path.length === 2 && from.op === "M" && to.op === "L"
    ? { type: "line", from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }
    : null;
}

export class InkStrokeSession {
  private readonly layer: InkLayer;
  private readonly color: InkColor;
  private readonly sink: InkLiveSink;
  private readonly left: number;
  private readonly top: number;
  private readonly scale: number;
  private readonly thickness: number;
  private readonly usePressure: boolean;
  private readonly pen: InkPenBuilder | null = null;
  private readonly chisel: InkChiselBuilder | null = null;
  private readonly smoother: NotebookInkSmoother;
  private readonly gate: NotebookLiftOffGate<InkPointerSample>;
  /** Handed to the smoother for every sample; it reads it at once and keeps nothing. */
  private readonly seed: NotebookInkSample = { x: 0, y: 0, time: 0 };
  /** The predicted tip's record of what the pen really did, for a stylus. */
  private readonly tracker: NotebookPredictedTip | null;
  private readonly trackerSample: NotebookPredictedTipSample = { x: 0, y: 0, time: 0 };
  private readonly trackerSamples: readonly NotebookPredictedTipSample[] = [this.trackerSample];
  private hold: InkHoldDetector | null = null;
  /** Holding still may make the stroke a shape, not only a line. */
  private readonly shapes: boolean;
  /** One screen pixel, in page units. */
  private readonly pixelSize: number;
  /** The shape holding still made the stroke, as the pen has sized and turned it since. */
  private held: Held | null = null;
  /** The stroke as drawn when holding still snapped it: what undoing the snap brings back. */
  private drawn: { path: InkPathCommand[]; paint: InkPaint } | null = null;
  /** The ruler edge this stroke is held to, if it landed by one. */
  private readonly edge: InkRulerEdge | null;
  /** The newest point of the stroke, in page units: where the pen is when it holds still. */
  private penX: number;
  private penY: number;
  private readonly timers: InkTimers;
  /** The highlighter's wait for the pen to stop, if one is pending. */
  private settleTimer: number | null = null;
  /** The traced outline of the highlighter as it stands: made once, until a sample is added. */
  private outline: InkPathCommand[] | null = null;
  /** The highlighter's outline is what live ink last drew. */
  private outlineShown = false;
  /** What live ink last drew, which is what the lift keeps. */
  private lastPath: InkPathCommand[];
  private lastPaint: InkPaint;
  private tipShown = false;
  private finished = false;
  private cancelled = false;

  constructor({ tool, mapping, sink, first, timers, ruler = null }: InkStrokeSessionInput) {
    this.layer = tool.kind;
    this.color = tool.color;
    this.sink = sink;
    this.timers = timers ?? browserInkTimers();
    this.left = mapping.left;
    this.top = mapping.top;
    this.scale = Number.isFinite(mapping.scale) && mapping.scale > 0 ? mapping.scale : 1;
    this.thickness = tool.thickness;
    const settings = clampNotebookPenSettings(tool.settings);
    this.smoother = new NotebookInkSmoother(
      { x: first.clientX, y: first.clientY, time: first.timeStamp },
      getNotebookInkSmoothingOptions(settings)
    );
    this.gate = new NotebookLiftOffGate<InkPointerSample>(
      (sample) => sample.pressure,
      (sample) => sample.timeStamp
    );

    // Pressure turned down to nothing in the pen's settings is one width, not
    // pressure averaged into one: the stroke is a plain line from its start.
    this.usePressure =
      tool.kind === "pen" && tool.pressure && getNotebookPenFeelFromSettings(settings).pressureResponse > 0;
    // One screen pixel in page units, as js-draw's `getSizeOfPixelOnCanvas`.
    const pixelSize = 1 / this.scale;
    this.pixelSize = pixelSize;
    this.shapes = tool.kind === "pen" && tool.shapes;
    const landed = { x: (first.clientX - this.left) / this.scale, y: (first.clientY - this.top) / this.scale };
    this.edge = ruler ? inkRulerEdgeNear(ruler, landed, RULER_REACH_PX * pixelSize) : null;
    const onEdge = this.edge ? projectOntoInkRulerEdge(this.edge, landed) : landed;
    const start = { x: onEdge.x, y: onEdge.y, width: this.widthOf(first.pressure) };
    this.penX = start.x;
    this.penY = start.y;

    if (tool.kind === "pen") {
      this.pen = createInkPenBuilder(
        { ...start, time: first.timeStamp },
        // A pencil writing with pressure is drawn tapered from its first
        // sample, so the stroke does not change shape a moment after it starts.
        { feel: getNotebookPenFeelFromSettings(settings), pixelSize, tapered: this.usePressure }
      );
      // A see-through colour would darken where the tip and the line overlap.
      this.tracker = tool.predictTip && tool.color.a >= 1 ? new NotebookPredictedTip() : null;
      this.tracker?.observe([{ x: first.clientX, y: first.clientY, time: first.timeStamp }]);
      const geometry = this.pen.geometry();
      this.lastPath = geometry.path;
      this.lastPaint = penInkPaint(geometry.paint, tool.color);
      if (settings.straightenOnHold !== "off") {
        this.hold = new InkHoldDetector(
          first.clientX,
          first.clientY,
          first.timeStamp,
          () => this.holdStill(),
          this.timers
        );
      }
    } else {
      this.chisel = createInkChiselBuilder(start, { pixelSize, nibAngle: tool.nibAngle });
      this.tracker = null;
      this.lastPath = this.chisel.preview().path;
      this.lastPaint = { fill: tool.color, stroke: null, opacity: 1 };
    }

    // The contact itself shows at once: a tap leaves its dot.
    this.sink.beginLive(this.layer);
    this.sink.drawLive(this.lastPath, this.lastPaint);
    if (this.chisel) this.armSettle();
  }

  /**
   * One packet of pointer samples (a pointermove's coalesced events, oldest
   * first), and the browser's predictions of where the pen goes next. The stroke
   * is drawn before this returns. Returns how far ahead of the line the
   * predicted tip was drawn, in CSS pixels, or 0 for none: a figure for the ink
   * readout (`input-trace.ts`).
   */
  move(samples: readonly InkPointerSample[], predicted: readonly InkPointerSample[] = NO_SAMPLES): number {
    if (this.finished || samples.length === 0) return 0;

    // A shape is being sized and turned, not drawn: there is no line to lead.
    const tipPoints = this.tracker && !this.held ? this.predictTipPoints(this.tracker, samples, predicted) : null;

    let added = false;
    for (let index = 0; index < samples.length; index += 1) {
      const ready = this.gate.next(samples[index]);
      for (let at = 0; at < ready.length; at += 1) {
        if (this.addSample(ready[at])) added = true;
      }
    }

    if (added) {
      if (this.held) {
        this.followHeld(this.held);
      } else if (this.pen) {
        const geometry = this.pen.geometry();
        this.lastPath = geometry.path;
        this.lastPaint = penInkPaint(geometry.paint, this.color);
      } else if (this.chisel) {
        // A pen the gate is holding is leaving the glass: this is the last live
        // movement, so it draws the outline. Otherwise, footprints, and the
        // wait for the pen to stop starts again.
        this.outline = null;
        this.outlineShown = this.gate.holding;
        this.lastPath = this.outlineShown ? this.tracedOutline() : this.chisel.preview().path;
        this.armSettle();
      }
    } else if (!this.tipShown) {
      // Nothing was added (the gate held the packet, or the pen is resting) and
      // no tip is standing: there is nothing to move or to take away, unless the
      // gate has just begun to hold a highlighter's samples.
      if (this.chisel && this.gate.holding) this.showOutline();
      return 0;
    }
    const tip = tipPoints ? this.tipThrough(tipPoints) : null;
    this.sink.drawLive(this.lastPath, this.lastPaint, tip);
    this.tipShown = tip !== null;
    if (!tip) return 0;
    const from = tip.path[0];
    const to = tip.path[tip.path.length - 1];
    return from.op === "M" && to.op === "L" ? Math.hypot(to.x - from.x, to.y - from.y) * this.scale : 0;
  }

  /**
   * The pen has left the glass. Returns what live ink last drew, to be kept as
   * the stroke, or null if there is nothing worth keeping (the live stroke is
   * then cancelled). The sink is not committed: the surface does that.
   */
  lift(): InkStrokeResult | null {
    if (this.finished) return null;
    this.finished = true;
    this.hold?.destroy();
    // Whatever the gate holds was the lift itself, and is dropped. The smoother
    // is not stepped: the stroke ends on the point already drawn.
    this.gate.lift();

    if (this.chisel) {
      this.clearSettle();
      // The outline is already on screen when the pen stopped or was leaving
      // the glass: nothing is drawn, so no pixel changes. Only a flick that
      // lifts mid-motion, with the footprints still showing, draws it here, and
      // only then can edge pixels change, by no more than the few levels of
      // antialiasing between the footprints and their outline (docs/notebook-ink.md).
      if (!this.outlineShown) {
        this.lastPath = this.tracedOutline();
        if (!hasGeometry(this.lastPath)) return this.discard();
        this.sink.drawLive(this.lastPath, this.lastPaint);
        this.outlineShown = true;
      }
    } else {
      if (!hasGeometry(this.lastPath)) return this.discard();
      // The predicted tip is never part of the stroke: take it off the live
      // layer, so the commit finds the stroke alone.
      if (this.tipShown) {
        this.sink.drawLive(this.lastPath, this.lastPaint);
        this.tipShown = false;
      }
    }
    const snapped = this.snapped();
    return snapped
      ? { layer: this.layer, path: this.lastPath, paint: this.lastPaint, snapped }
      : { layer: this.layer, path: this.lastPath, paint: this.lastPaint };
  }

  /**
   * Holding still has made the stroke a line or a shape. Where the pen goes
   * after that is aiming or sizing it, not writing: none of it is a scribble.
   */
  get snappedOnHold(): boolean {
    return this.drawn !== null;
  }

  /** What holding still made the stroke, as the lift keeps it, or null if it was never snapped. */
  private snapped(): NonNullable<InkStrokeResult["snapped"]> | null {
    const stroke = this.lastPaint.stroke;
    if (!this.drawn || !stroke) return null;
    const shape = this.held ? this.held.geometry : lineOf(this.lastPath);
    return shape ? { shape, color: stroke.color, width: stroke.width, drawn: this.drawn } : null;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.finished = true;
    this.hold?.destroy();
    this.clearSettle();
    this.sink.cancelLive();
  }

  /** The highlighter's traced outline, made once until a sample is added; kept off the per-packet path. */
  private tracedOutline(): InkPathCommand[] {
    return (this.outline ??= this.chisel!.build().path);
  }

  /** Draws the highlighter's traced outline in place of its footprints, once. */
  private showOutline(): void {
    if (this.finished || !this.chisel || this.outlineShown) return;
    const path = this.tracedOutline();
    // A stroke with nothing to trace keeps its footprints; the lift discards it.
    if (!hasGeometry(path)) return;
    this.lastPath = path;
    this.outlineShown = true;
    this.sink.drawLive(this.lastPath, this.lastPaint);
  }

  /** Starts the highlighter's wait for the pen to stop again from now. */
  private armSettle(): void {
    this.clearSettle();
    this.settleTimer = this.timers.setTimeout(() => {
      this.settleTimer = null;
      this.showOutline();
    }, HIGHLIGHTER_SETTLE_MS);
  }

  private clearSettle(): void {
    if (this.settleTimer === null) return;
    this.timers.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private discard(): null {
    this.sink.cancelLive();
    return null;
  }

  /** js-draw's `Pen.toStrokePoint`, in page units. */
  private widthOf(pressure: number): number {
    if (this.layer === "highlighter") return HIGHLIGHTER_PRESSURE * this.thickness;
    if (!this.usePressure) return DEFAULT_PRESSURE * this.thickness;
    const floored = Math.max(pressure, PRESSURE_FLOOR);
    return (Number.isFinite(floored) ? floored : PRESSURE_FLOOR) * this.thickness;
  }

  /**
   * Takes a sample the gate released. True when it reached the stroke: the
   * smoother steps for every sample, but a pen judged to be resting adds none.
   */
  private addSample(sample: InkPointerSample): boolean {
    const { clientX, clientY, timeStamp } = sample;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(timeStamp)) {
      return false;
    }
    const seed = this.seed;
    seed.x = clientX;
    seed.y = clientY;
    seed.time = timeStamp;
    const settled = this.smoother.next(seed);
    if (this.hold !== null && this.hold.move(settled.x, settled.y, timeStamp)) return false;

    let x = (settled.x - this.left) / this.scale;
    let y = (settled.y - this.top) / this.scale;
    if (this.edge) ({ x, y } = projectOntoInkRulerEdge(this.edge, { x, y }));
    this.penX = x;
    this.penY = y;
    // A shape follows the pen now; the stroke under it is finished.
    if (this.held) return true;
    const width = this.widthOf(sample.pressure);
    if (this.pen) this.pen.addPoint({ x, y, width, time: timeStamp });
    else if (this.chisel) this.chisel.addPoint({ x, y, width });
    return true;
  }

  /**
   * The pen has been held still: snap the stroke to a line if it is one, or
   * else to a shape if it is one and shapes are allowed, and show it at once.
   * Once only: holding still again later changes nothing.
   */
  private holdStill(): void {
    if (this.finished || !this.pen || this.drawn) return;
    const drawn = { path: this.lastPath, paint: this.lastPaint };
    const line = this.pen.straighten();
    if (line) {
      this.lastPath = line.path;
      this.lastPaint = penInkPaint(line.paint, this.color);
    } else {
      const width = this.pen.width();
      const points = this.pen.extent().points;
      const shape = this.shapes ? recognizeInkShape(points, { width, pixelSize: this.pixelSize }) : null;
      if (!shape) return;
      const at = { x: this.penX, y: this.penY };
      const closed = shape.geometry.type === "polygon" || shape.geometry.type === "ellipse";
      this.held = {
        shape,
        at,
        geometry: shape.geometry,
        width,
        drawnPoints: closed ? [...points] : [],
        follow: closed ? "deciding" : "sizing",
        travelled: 0,
        last: at,
      };
      this.lastPath = inkShapePath(shape.geometry, width);
      this.lastPaint = penInkPaint({ kind: "stroke", width }, this.color);
    }
    this.drawn = drawn;
    // From here the pen is aiming or sizing what snapped, and every move counts:
    // left on, the hold would swallow the first few pixels and then jump.
    this.hold?.destroy();
    this.hold = null;
    this.sink.drawLive(this.lastPath, this.lastPaint);
    this.tipShown = false;
  }

  /**
   * The pen moving on with a shape snapped. After a closed one, its first
   * pixels say what it is doing: going on along the shape, or along the stroke
   * drawn for it -- going round again, as a hand often does past where it
   * closed -- leaves the shape as it snapped; leaving them sizes and turns
   * it, from where the pen left, so nothing jumps.
   */
  private followHeld(held: Held): void {
    const pen = { x: this.penX, y: this.penY };
    if (held.follow === "deciding") {
      held.travelled += Math.hypot(pen.x - held.last.x, pen.y - held.last.y) / this.pixelSize;
      held.last = pen;
      if (inkShapeTraceDistance(held.shape.geometry, held.drawnPoints, pen) > TRACE_REACH_PX * this.pixelSize) {
        held.follow = "sizing";
        held.at = pen;
      } else if (held.travelled >= TRACE_DECIDE_PX) {
        held.follow = "tracing";
      }
    }
    if (held.follow !== "sizing") return;
    held.geometry = adjustInkShape(held.shape, held.at, pen, this.pixelSize);
    this.lastPath = inkShapePath(held.geometry, held.width);
  }

  /**
   * Where this packet's predicted tip runs to, in client px, or null for none.
   * The tracker sees every real sample, drawn or not; the tip is withheld as
   * the pressure falls away at the lift.
   */
  private predictTipPoints(
    tracker: NotebookPredictedTip,
    samples: readonly InkPointerSample[],
    predicted: readonly InkPointerSample[]
  ): NotebookPredictedTipPoint[] | null {
    const record = this.trackerSample;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      record.x = sample.clientX;
      record.y = sample.clientY;
      record.time = sample.timeStamp;
      tracker.observe(this.trackerSamples);
    }
    if (predicted.length === 0) return null;
    if (!(samples[samples.length - 1].pressure >= NOTEBOOK_LIFT_OFF.ceiling)) return null;
    const ahead = tracker.ahead(
      predicted.map((point) => ({ x: point.clientX, y: point.clientY, time: point.timeStamp }))
    );
    return ahead.length === 0 ? null : ahead;
  }

  /**
   * The tip: a round-capped line from the end of the stroke as last drawn,
   * through the predicted points, in the pen's colour. None once the stroke
   * has snapped straight, as its far end is then being aimed, not drawn.
   */
  private tipThrough(points: readonly NotebookPredictedTipPoint[]): InkLiveTip | null {
    const end = this.pen?.liveTip();
    if (!end || !(end.width > 0)) return null;
    const path: InkPathCommand[] = [{ op: "M", x: end.x, y: end.y }];
    for (let index = 0; index < points.length; index += 1) {
      const ahead = { x: (points[index].x - this.left) / this.scale, y: (points[index].y - this.top) / this.scale };
      // Along a ruler the guess is held to the edge too, as the line will be.
      const { x, y } = this.edge ? projectOntoInkRulerEdge(this.edge, ahead) : ahead;
      path.push({ op: "L", x, y });
    }
    return {
      path,
      paint: {
        fill: null,
        stroke: { color: this.color, width: end.width, cap: "round", join: "round" },
        opacity: 1,
      },
    };
  }
}
