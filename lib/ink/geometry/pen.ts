import type { InkPathCommand } from "@/lib/ink/model";
import type { NotebookPenFeel } from "@/lib/workspace/notebook-pen-feel";
import {
  MINIMUM_STEP_RATIO,
  SHAPE_TOLERANCE_RATIO,
  MAXIMUM_SPAN_RATIO,
  armReach,
  MAXIMUM_EASE_RATIO,
  STRAIGHTEN_TOLERANCE,
  STRAIGHTEN_MAXIMUM_BACKTRACK,
  STRAIGHTEN_MAXIMUM_BOW,
  STRAIGHTEN_MINIMUM_ARC,
  REVERSAL_BISECTOR_FLOOR,
  STRAIGHTEN_MINIMUM_SPAN_RATIO,
  MINIMUM_CORNER_ARM_RATIO,
  TURN_ARM_RATIO,
  TURN_ARM_MAXIMUM_REACH,
  UNMISTAKABLE_CORNER_DEGREES,
  CORNER_SLOWDOWN,
} from "@/lib/ink/geometry/pen-tuning";
import { aimAlongGuides } from "@/lib/ink/geometry/aim";
import { cubic, line, move, penOutline } from "@/lib/ink/geometry/pen-outline";
import {
  penHalfWidthsAlong,
  penWidthVaries,
  shapePenPressure,
} from "@/lib/ink/geometry/pen-widths";
import { Vec, type InkExtent } from "@/lib/ink/geometry/vector";

/**
 * A pen that draws the line the hand actually made.
 *
 * js-draw fits a stroke by growing one quadratic at a time and cutting it as
 * soon as a sample falls outside tolerance -- and every new piece starts with
 * a control arm only half a pen width long, so it leaves the join almost
 * straight. On a long curve that reads as a chain of flat chords.
 *
 * Measured on a noisy half-arc, no amount of input smoothing fixes it: from
 * beta 0.3 down to 0.015 (a lag of half a pixel out to ten) the fitter still
 * carved the same curve into 13 pieces down to 8, and the deviation stayed
 * pinned at its 3-pixel ceiling the whole way. The chords are the fitter, not
 * the input.
 *
 * So there is no fitting here. The samples are joined by a Catmull-Rom spline
 * written out as cubic Béziers, which passes through every point and is
 * C1-continuous by construction: consecutive pieces share a tangent, so no
 * join can show. What is drawn is what was sampled, smoothed on the way in.
 *
 * This is the geometry only, in page units and with no colour: the path to
 * draw and whether it is filled or stroked. js-draw's builder
 * (`notebook-smooth-pen.ts`) and Jami's own engine both draw from it, so a
 * stroke looks the same under either.
 */

/** One reading from the pen: where, how heavy, and when (milliseconds). */
export type InkPenSample = {
  x: number;
  y: number;
  width: number;
  time: number;
};

/** The settings of the pen's feel that shape its geometry; described in `notebook-pen-feel.ts`. */
export type InkPenFeel = NotebookPenFeel;

export type InkPenOptions = {
  feel: InkPenFeel;
  /** The size of one screen pixel in page units; the thresholds scale with it. */
  pixelSize: number;
  /**
   * Drawn as its tapered outline from the first sample on, as a pen writing
   * with pressure always is. Without it a stroke is drawn as one plain stroked
   * line until its width is seen to vary, then switches to the outline -- and
   * that switch, a few packets into every pressured stroke, moved the ink
   * already drawn by a pixel or more.
   */
  tapered?: boolean;
};

/** How a pen path is painted: filled as an outline, or stroked at one width. */
export type InkPenPaint = { kind: "fill" } | { kind: "stroke"; width: number };

export type InkPenGeometry = {
  /** Starts with a move to the first point. */
  path: InkPathCommand[];
  paint: InkPenPaint;
};

/** The end of the line being written, as the predicted tip needs it. */
export type InkPenTip = {
  x: number;
  y: number;
  /** In page units. */
  width: number;
};

export type InkPenBuilder = {
  addPoint(sample: InkPenSample): void;
  /**
   * What the stroke looks like as it stands: drawn wet while the pen is down
   * and committed at the lift. Also records where it ends, for `liveTip`.
   */
  geometry(): InkPenGeometry;
  /**
   * Called when the pen is held still. Snaps the stroke to a straight line and
   * returns it, or returns null and leaves the stroke as drawn. After a snap
   * the stroke is the line and `addPoint` aims its far end.
   */
  straighten(): InkPenGeometry | null;
  /**
   * Where the line drawn by the last `geometry()` ends, and its width there:
   * where a predicted tip has to start to join it without a seam. Both ends of
   * a stroke are round, so a round-capped line of that width from that point
   * continues it exactly.
   *
   * Null before anything has been drawn, and while the stroke has snapped
   * straight -- its far end is then being aimed, not drawn.
   */
  liveTip(): InkPenTip | null;
  extent(): InkExtent;
  /**
   * The one width the stroke is drawn at when it is not tapered, in page
   * units: its samples' widths averaged. A straightened line is drawn at it,
   * and so is a shape the stroke snaps to.
   */
  width(): number;
};

export function createInkPenBuilder(
  startPoint: InkPenSample,
  { feel, pixelSize, tapered = false }: InkPenOptions
): InkPenBuilder {
  /**
   * Each sample's width, pulled towards the stroke's own average.
   *
   * This is what `pressureResponse` does, and it has to happen before anything
   * else looks at the widths: at zero every point comes out at the mean, so the
   * variation test below then correctly reports a stroke of one width and the
   * cheaper stroked path is taken. Flooring the widths instead -- which is all
   * `minimumWidthFraction` can do -- cannot produce that, because a floor only
   * lifts the light points and leaves the heavy ones heavy.
   *
   * Above one it pushes the other way, so a light touch reads lighter and a
   * heavy one heavier than the digitiser reported.
   */
  const pressureShaped = (raw: number[]) => shapePenPressure(raw, feel.pressureResponse);

  const halfWidthsAlong = (raw: number[], count: number) =>
    penHalfWidthsAlong(raw, count, feel.minimumWidthFraction);
  const { cornerDegrees, cornerDominance, easeTowardsNeighbours } = feel;

  /*
   * One width for the whole stroke, averaged over its samples.
   *
   * A stroked path cannot taper, so pressure can no longer thin and thicken
   * a line along its length. Averaging keeps what is left of it meaningful:
   * press harder and the whole stroke comes out heavier. Taking the first
   * sample instead would let however lightly the pen happened to land decide
   * the weight of everything after it.
   */
  let widthTotal = Math.max(startPoint.width, 0.1);
  let widthSamples = 1;
  const strokeWidth = () => widthTotal / widthSamples;
  /**
   * The width reported at each kept point, in step with `points`.
   *
   * The average above is still what a uniform stroke is drawn at, and what the
   * bounding box is grown by. This is what lets a stroke that was not drawn at
   * one weight be drawn at the weights it was actually made with.
   */
  const widths: number[] = [Math.max(startPoint.width, 0.1)];
  let pendingWidth = widths[0];
  const minimumStep = Math.max(pixelSize * MINIMUM_STEP_RATIO, 0.01);
  const shapeTolerance = pixelSize * SHAPE_TOLERANCE_RATIO;
  const maximumSpan = pixelSize * MAXIMUM_SPAN_RATIO;
  const minimumCornerArm = pixelSize * MINIMUM_CORNER_ARM_RATIO;
  const turnArm = pixelSize * TURN_ARM_RATIO;
  const maximumEase = pixelSize * MAXIMUM_EASE_RATIO;
  /** Below this, the line has turned far enough to count as a corner. */
  const cornerCosine = Math.cos((cornerDegrees * Math.PI) / 180);
  const cornerRadians = (cornerDegrees * Math.PI) / 180;
  const unmistakableCorner = (UNMISTAKABLE_CORNER_DEGREES * Math.PI) / 180;
  const unmistakableCosine = Math.cos(unmistakableCorner);
  const points: Vec[] = [Vec.of(startPoint.x, startPoint.y)];
  /**
   * The newest sample, held back one step.
   *
   * It is only committed once a further sample proves it carries shape --
   * that it does not simply lie on the line between what came before and
   * what came after. Held rather than decided immediately because that
   * cannot be known until the next sample arrives.
   */
  let pending: Vec | null = null;
  /**
   * Set once the stroke has snapped straight, after which the stroke *is*
   * this line and the pen is aiming it rather than drawing.
   *
   * Snapping used to be the end of it: the line appeared, and any further
   * movement threw it away and went back to the freehand path, so getting the
   * angle right meant drawing it again until it landed. Keeping the line and
   * letting its far end follow the pen turns that into aiming -- swing to
   * pivot, come back along it to shorten, lift when it looks right. The near
   * end stays where the stroke began, which is the end the hand has already
   * committed to.
   */
  let straightened: { from: Vec; to: Vec } | null = null;

  /*
   * How fast the pen was moving, which is what a corner is made of.
   *
   * For each kept point: its speed at that point, and the fastest it went
   * along the stretch arriving at it -- recorded from every sample, including
   * the ones thinning throws away, so a long straight arm still reports how
   * fast it was drawn. In px per millisecond, or null where the samples carry
   * no usable time, which leaves the corner rule exactly as it was.
   */
  const speedsAt: (number | null)[] = [null];
  const arrivalPeaks: (number | null)[] = [null];
  /** The fastest step since the last kept point, up to the held sample. */
  let segmentPeak: number | null = null;
  /** The accepted sample before the held one, for the speed through it. */
  let beforePending: { point: Vec; time: number } | null = null;
  let pendingTime = startPoint.time;
  let lastKeptTime = startPoint.time;
  const speedBetween = (
    from: { point: Vec; time: number },
    to: { point: Vec; time: number }
  ) => {
    const elapsed = to.time - from.time;
    return elapsed > 0 ? to.point.distanceTo(from.point) / elapsed : null;
  };
  const fastestOf = (left: number | null, right: number | null) =>
    left === null ? right : right === null ? left : Math.max(left, right);

  /** Perpendicular distance from `point` to the line `from`-`to`. */
  const strayFromLine = (point: Vec, from: Vec, to: Vec) => {
    const along = to.minus(from);
    const length = along.magnitude();
    if (length === 0) return point.distanceTo(from);
    const offset = point.minus(from);
    return Math.abs(along.x * offset.y - along.y * offset.x) / length;
  };

  /** Every point that shapes the curve, including the one still held. */
  const shapePoints = () => (pending ? [...points, pending] : points);
  const shapeWidths = () => (pending ? [...widths, pendingWidth] : widths);

  /**
   * The neighbours far enough away for a direction through `index` to mean
   * more than one short digitiser wobble.
   *
   * The same reach has to govern both corner detection and curve tangents.
   * Using it only to decide that a short sideways/backwards sample was not a
   * corner, then letting that sample aim the tangent anyway, gives a tiny
   * noisy step control of the much longer cubic beside it. During fast
   * writing that produces an outward lobe for every uneven packet.
   */
  const turnNeighbourIndicesAt = (shape: Vec[], index: number) => {
    const last = shape.length - 1;
    const here = shape[index];
    let back = Math.max(0, index - 1);
    while (
      back > 0 &&
      index - back < TURN_ARM_MAXIMUM_REACH &&
      here.distanceTo(shape[back]) < turnArm
    ) {
      back -= 1;
    }
    let forward = Math.min(last, index + 1);
    while (
      forward < last &&
      forward - index < TURN_ARM_MAXIMUM_REACH &&
      here.distanceTo(shape[forward]) < turnArm
    ) {
      forward += 1;
    }
    return { back, forward };
  };

  /**
   * How far the line turns at each point, in radians. Ends count as none.
   *
   * A turn measured across a run barely longer than the pen's own step is
   * mostly the digitiser's noise -- half a pixel of wobble either side swings
   * it through tens of degrees. The same guard already governs which points
   * are kept; without it here, a plain sine wave at writing scale still came
   * out with one 114-degree corner in it, invented by two kept samples that
   * happened to land a pixel apart.
   *
   * The measurement widens rather than being thrown away. Discarding it
   * silently rounds off any corner that happens to have a kept point sitting
   * close to it -- measured on a deliberate 60-degree bend, the point
   * vanished entirely -- whereas reaching further out for the arm answers the
   * same question over a run long enough for the answer to mean something.
   */
  const turnsAlong = (shape: Vec[]) => {
    const turns = new Array<number>(shape.length).fill(0);
    /** Turn per unit of the run it was measured over -- see `cornersAlong`. */
    const curvatures = new Array<number>(shape.length).fill(0);
    const last = shape.length - 1;
    for (let index = 1; index < last; index += 1) {
      const here = shape[index];
      const { back, forward } = turnNeighbourIndicesAt(shape, index);
      const arriving = here.minus(shape[back]);
      const leaving = shape[forward].minus(here);
      if (arriving.magnitude() === 0 || leaving.magnitude() === 0) continue;
      const straightness = Math.max(
        -1,
        Math.min(1, arriving.normalized().dot(leaving.normalized()))
      );
      turns[index] = Math.acos(straightness);
      curvatures[index] =
        turns[index] / ((arriving.magnitude() + leaving.magnitude()) / 2);
    }
    return { turns, curvatures };
  };

  /**
   * Which points the curve is allowed to come to a point at.
   *
   * Sharp enough on its own settles it. Otherwise the turn has to stand out
   * from the ones either side of it, which is what tells a deliberate point
   * from a curve drawn tightly -- see `cornerDominance`.
   *
   * Standing out is judged on curvature, the turn per unit of line, not on
   * the turn itself. A point's turn grows with how far apart its neighbours
   * are, and a fast curve is sampled unevenly -- packets arrive bunched and
   * then spaced -- so on a perfectly even curve one point would turn half as
   * far again as the next, clear the dominance test, and be drawn as a
   * corner: a sharp kink on a loop that had none. Replayed at 240Hz with
   * sampling jitter, that put a 90-degree kink into small written 'o's, and
   * 73-degree ones into a fast wave at 120Hz. Curvature is even along an even
   * curve however it was sampled, and at a real corner it is still
   * concentrated at the one point, with the straight arms either side near
   * zero.
   */
  /**
   * Corner verdicts already settled, in step with `points`.
   *
   * A verdict reads the turn out to two points ahead and the curvature of the
   * point after, so it can change while those are still arriving. Once they
   * are all kept nothing can change it, and it is kept as it stands: a curve
   * the pen has gone well past never becomes a corner, or a corner a curve,
   * because of what is drawn after it.
   */
  const settledCorners: boolean[] = [];
  const cornersAlong = (shape: Vec[]) => {
    const verdicts = judgeCornersAlong(shape);
    for (let index = settledCorners.length; index + 3 < points.length; index += 1) {
      settledCorners.push(verdicts[index]);
    }
    for (let index = 0; index < settledCorners.length; index += 1) verdicts[index] = settledCorners[index];
    return verdicts;
  };
  const judgeCornersAlong = (shape: Vec[]) => {
    const { turns, curvatures } = turnsAlong(shape);
    const peaks = pending ? [...arrivalPeaks, segmentPeak] : arrivalPeaks;
    /** Whether the pen slowed into this point -- see `CORNER_SLOWDOWN`. */
    const slowedAt = (index: number) => {
      const speed = speedsAt[index] ?? null;
      const around = fastestOf(peaks[index] ?? null, peaks[index + 1] ?? null);
      if (speed === null || around === null || around <= 0) return true;
      return speed <= around * CORNER_SLOWDOWN;
    };
    return turns.map((turn, index) => {
      if (turn >= unmistakableCorner) return true;
      if (turn > 0 && !slowedAt(index)) return false;
      if (turn < cornerRadians) return false;
      const around = Math.max(
        curvatures[index - 1] ?? 0,
        curvatures[index + 1] ?? 0
      );
      return curvatures[index] >= around * cornerDominance;
    });
  };

  /**
   * Eases each interior point a fraction towards the line between its
   * neighbours, so a curve drawn by hand comes out a little rounder.
   *
   * The first and last are left exactly where they were: the last is under
   * the pen right now, and moving it is what would be felt as lag. Corners
   * are left alone too, since easing one is the same as rounding it off.
   */
  const easedShape = (shape: Vec[], corners: boolean[]) => {
    if (shape.length < 3 || easeTowardsNeighbours <= 0) return shape;

    const eased: Vec[] = [shape[0]];
    for (let index = 1; index < shape.length - 1; index += 1) {
      const previous = shape[index - 1];
      const here = shape[index];
      const next = shape[index + 1];
      if (corners[index]) {
        eased.push(here);
        continue;
      }

      /*
       * Towards the point on the line between the neighbours that sits as
       * far along it as this point sits along the stroke -- not towards
       * that line's middle.
       *
       * They are the same when the neighbours are evenly spaced. Pencil
       * packets are not: one lands a pixel away and the next eleven, and the
       * middle of that long line is deep inside a fast turn. Eased towards
       * it, the point was pulled in by a whole pixel, the turn came out
       * dented, and the sample beside the dent read as a little point
       * poking out of a curve -- at every corner setting, since none of
       * them reaches easing.
       */
      const before = here.distanceTo(previous);
      const after = next.distanceTo(here);
      const share = before + after > 0 ? before / (before + after) : 0.5;
      const target = previous.plus(next.minus(previous).times(share));
      const shift = target.minus(here).times(easeTowardsNeighbours);
      // Easing is for the hand's wobble, which is a fraction of a pixel. A
      // larger move is not taking wobble out, it is reshaping the turn.
      const length = shift.magnitude();
      eased.push(
        length > maximumEase
          ? here.plus(shift.times(maximumEase / length))
          : here.plus(shift)
      );
    }
    eased.push(shape[shape.length - 1]);
    return eased;
  };

  /** Whichever straight line the stroke has been aimed at so far. */
  const straightLine = (from: Vec, to: Vec): InkPenGeometry => ({
    path: [move(from), line(to)],
    paint: { kind: "stroke", width: strokeWidth() },
  });

  /**
   * The line this stroke would snap to, or null if it is not a line.
   *
   * Judged on the eased shape rather than the raw samples, so the same points
   * decide it that would have been drawn.
   */
  const straightenedShape = () => {
    const raw = shapePoints();
    const shape = easedShape(raw, cornersAlong(raw));
    if (shape.length < 3) return null;

    const from = shape[0];
    const to = shape[shape.length - 1];
    const span = to.distanceTo(from);
    if (span < strokeWidth() * STRAIGHTEN_MINIMUM_SPAN_RATIO) return null;

    const along = to.minus(from).times(1 / span);
    let worstStray = 0;
    let furthestAlong = 0;
    let worstBacktrack = 0;
    let signedTotal = 0;
    for (const point of shape) {
      const offset = point.minus(from);
      /*
       * Which side of the line, not just how far off it.
       *
       * The distance alone cannot tell a wobble from a curve, and the two
       * want opposite answers: a hand aiming for a line crosses it over and
       * over, so its offsets cancel, while an arc stays out on one side the
       * whole way and its offsets add up. Measured on a 300px stroke, a
       * 50-pixel squiggle and a 40-pixel arc sit within a few pixels of each
       * other on distance and at opposite ends of this.
       */
      signedTotal += along.x * offset.y - along.y * offset.x;
      worstStray = Math.max(worstStray, strayFromLine(point, from, to));
      const travelled = offset.dot(along);
      worstBacktrack = Math.max(worstBacktrack, furthestAlong - travelled);
      furthestAlong = Math.max(furthestAlong, travelled);
    }

    if (worstStray > span * STRAIGHTEN_TOLERANCE) return null;
    if (worstBacktrack > span * STRAIGHTEN_MAXIMUM_BACKTRACK) return null;

    // Averaged over the points, then measured against how far the worst of
    // them strayed: a stroke that never crossed the line scores 1, one that
    // spent equal time either side scores 0.
    const bow = worstStray
      ? Math.abs(signedTotal / shape.length) / worstStray
      : 0;
    if (worstStray > span * STRAIGHTEN_MINIMUM_ARC && bow > STRAIGHTEN_MAXIMUM_BOW) return null;
    return { from, to };
  };

  /**
   * Where the aimed end of a snapped line goes (`aimAlongGuides`).
   * Straightening and levelling are separable, and the second is the one
   * people object to: a line snapped to an angle they did not draw.
   */
  const aimedAt = (from: Vec, to: Vec) =>
    feel.snapToGuides ? aimAlongGuides(from, to, minimumStep) : to;

  /**
   * Where the line most recently drawn ends, and its width there. See
   * `liveTip` below.
   */
  let lastTip: InkPenTip | null = null;

  const geometry = (): InkPenGeometry => {
    if (straightened) {
      lastTip = null;
      return straightLine(straightened.from, straightened.to);
    }

    const width = strokeWidth();

    const raw = shapePoints();
    const corners = cornersAlong(raw);
    const shape = easedShape(raw, corners);

    if (shape.length === 1) {
      // A dot. Round caps make a zero-length stroke visible on canvas but
      // not in exported SVG, so this is drawn as a filled disc instead --
      // four cubics, the usual circle approximation.
      const centre = shape[0];
      const radius = width / 2;
      lastTip = { x: centre.x, y: centre.y, width };
      const handle = radius * 0.5522847498;
      const around = [
        Vec.of(radius, 0),
        Vec.of(0, radius),
        Vec.of(-radius, 0),
        Vec.of(0, -radius),
      ];
      const commands = around.map((_, index): InkPathCommand => {
        const from = around[index];
        const to = around[(index + 1) % 4];
        const fromTangent = Vec.of(-from.y, from.x).times(handle / radius);
        const toTangent = Vec.of(-to.y, to.x).times(handle / radius);
        return cubic(
          centre.plus(from).plus(fromTangent),
          centre.plus(to).minus(toTangent),
          centre.plus(to)
        );
      });
      return {
        path: [move(centre.plus(around[0])), ...commands],
        paint: { kind: "fill" },
      };
    }

    // Catmull-Rom through every sample, as cubic Béziers. The tangent at a
    // point is set by its neighbours, so the curve leaving a point matches
    // the curve arriving at it and the seam is invisible.
    const at = (index: number) =>
      shape[Math.min(Math.max(index, 0), shape.length - 1)];

    /**
     * The direction the curve should leave `index` in.
     *
     * Normally the line through its neighbours, which is what makes the
     * join seamless. At a corner it is the outgoing stroke alone, so the
     * curve arrives and leaves along the two strokes that meet there and
     * the point survives.
     */
    const tangentAt = (index: number, outgoing: boolean) => {
      const here = at(index);
      const immediatePrevious = at(index - 1);
      const immediateNext = at(index + 1);
      if (corners[index]) {
        const arriving = here.minus(immediatePrevious);
        const leaving = immediateNext.minus(here);
        return outgoing ? leaving : arriving;
      }

      /*
       * Match the wider measurement that decided this was a curve. A point
       * too close to carry a trustworthy angle is also too close to aim a
       * long control arm; otherwise sparse fast input grows a row of loops
       * outside the narrow band the pen visited.
       */
      const { back, forward } = turnNeighbourIndicesAt(raw, index);
      const previous = at(back);
      const next = at(forward);
      const arriving = here.minus(previous);
      const leaving = next.minus(here);
      if (arriving.magnitude() === 0 || leaving.magnitude() === 0) {
        return next.minus(previous);
      }
      /*
       * The direction through the point, taken from the two segments as
       * directions rather than as the chord between the outer points.
       *
       * The chord is the textbook Catmull-Rom tangent and it assumes points
       * are evenly spaced, which thinning guarantees they are not: it keeps
       * points where the line bends and drops them where it does not, so a
       * 20px run regularly meets a 2px one. The chord across that pair points
       * almost entirely along the long side, which swings the short segment's
       * curve out and back -- a kink at exactly the tight turns this is meant
       * to be smoothing. Normalising first weighs the two equally, so the
       * tangent bisects the turn however lopsided the spacing.
       */
      const bisector = arriving.normalized().plus(leaving.normalized());
      /*
       * Two opposite directions cancel, and normalising what is left is
       * normalising rounding error -- the arm then points somewhere arbitrary
       * and the curve leaving the point can set off backwards.
       *
       * A turn that sharp is a reversal, so the strokes either side of it are
       * the honest answer anyway. The guard is here rather than left to the
       * corner rule because the two measure the turn over different runs, and
       * a near-reversal between two points a pixel apart can pass one while
       * degenerating the other.
       */
      if (bisector.magnitude() < REVERSAL_BISECTOR_FLOOR) {
        return outgoing ? leaving : arriving;
      }
      return bisector;
    };

    /*
     * A stroke drawn at varying weight is drawn as its own outline.
     *
     * A stroked path has one width for its whole length, so for as long as
     * the pen was one it could not taper: pressure could only be averaged
     * into a single heavier or lighter line, and an Apple Pencil wrote the
     * same flat mark as a mouse. What gives handwriting its life is the
     * modulation along a stroke -- heavy through the downstroke, fine out of
     * the exit -- and the only way to draw that is to draw both edges.
     *
     * Spent only where there is something to show. Anything reporting one
     * steady width still takes the stroked path above: identical on screen,
     * and half the geometry to store and reparse.
     */
    const sampledWidths = pressureShaped(shapeWidths());
    if (tapered || penWidthVaries(sampledWidths)) {
      const halfWidths = halfWidthsAlong(sampledWidths, shape.length);
      const last = shape.length - 1;
      /*
       * The way the centreline runs through each point, which its edge points
       * are pushed square to: the same direction the centreline itself is
       * drawn in.
       *
       * This used the chord between the two immediate neighbours, which is
       * exactly what the centreline stopped using, for two reasons it
       * documents in `tangentAt`: a fast Pencil packet can land two samples
       * a pixel apart, so the chord across them points wherever that pixel
       * of noise did; and with thinning's uneven spacing the chord leans
       * towards the longer side of a turn. Either way one edge point was
       * pushed off sideways and the outline poked out at a smooth turn --
       * by up to 1.6px on a tight u-turn, at every corner setting, because
       * this never consulted the corners at all. A real corner is joined
       * instead (`penOutline`).
       */
      const alongAt = (index: number) => {
        const arriving = tangentAt(index, false);
        const leaving = tangentAt(index, true);
        if (arriving.magnitude() > 0 && leaving.magnitude() > 0) {
          const bisector = arriving.normalized().plus(leaving.normalized());
          return bisector.magnitude() < REVERSAL_BISECTOR_FLOOR ? leaving : bisector;
        }
        return leaving.magnitude() === 0 ? arriving : leaving;
      };

      // The end cap is a half circle of this radius about the last point.
      lastTip = { x: shape[last].x, y: shape[last].y, width: halfWidths[last] * 2 };
      return {
        path: penOutline({
          shape,
          halfWidths,
          corners,
          along: shape.map((_, index) => alongAt(index)),
        }),
        paint: { kind: "fill" },
      };
    }

    const commands: InkPathCommand[] = [];
    for (let index = 0; index < shape.length - 1; index += 1) {
      const from = at(index);
      const to = at(index + 1);
      // Direction from the neighbours, length from this segment -- capped
      // by the piece it meets, see `ARM_NEIGHBOUR_RATIO`.
      const length = to.distanceTo(from);
      const reachOut = armReach(
        length,
        index > 0 ? from.distanceTo(at(index - 1)) : null
      );
      const reachIn = armReach(
        length,
        index + 2 < shape.length ? at(index + 2).distanceTo(to) : null
      );
      const armOut = tangentAt(index, true);
      const armIn = tangentAt(index + 1, false);
      commands.push(
        cubic(
          armOut.magnitude() > 0
            ? from.plus(armOut.normalized().times(reachOut))
            : from,
          armIn.magnitude() > 0
            ? to.minus(armIn.normalized().times(reachIn))
            : to,
          to
        )
      );
    }

    lastTip = { x: shape[shape.length - 1].x, y: shape[shape.length - 1].y, width };
    return { path: [move(shape[0]), ...commands], paint: { kind: "stroke", width } };
  };

  return {
    liveTip() {
      if (straightened || !lastTip) return null;
      return lastTip;
    },
    extent() {
      return {
        points: straightened ? [straightened.from, straightened.to] : shapePoints(),
        margin: strokeWidth() / 2,
      };
    },
    width: strokeWidth,
    addPoint(newPoint) {
      const next = Vec.of(newPoint.x, newPoint.y);
      // Already a line: the pen is aiming its far end, not adding to a path.
      if (straightened) {
        if (next.distanceTo(straightened.to) >= minimumStep) {
          straightened = {
            from: straightened.from,
            to: aimedAt(straightened.from, next),
          };
        }
        return;
      }
      const newest = pending ?? points[points.length - 1];
      if (next.distanceTo(newest) < minimumStep) return;

      const sampleWidth = Math.max(newPoint.width, 0.1);
      widthTotal += sampleWidth;
      widthSamples += 1;
      const incoming = { point: next, time: newPoint.time };
      const step = speedBetween(
        pending
          ? { point: pending, time: pendingTime }
          : { point: points[points.length - 1], time: lastKeptTime },
        incoming
      );

      if (pending === null) {
        beforePending = { point: points[points.length - 1], time: lastKeptTime };
        pending = next;
        pendingWidth = sampleWidth;
        pendingTime = newPoint.time;
        segmentPeak = step;
        return;
      }
      // The held sample earns its place only if dropping it would change
      // the line. Otherwise the newer sample takes its place.
      const lastKept = points[points.length - 1];
      /*
       * How far the line turns at the held sample.
       *
       * Sideways offset alone is not enough to decide this. Where a stroke
       * doubles back -- up the stem of an 'l' and down it again, round the
       * top of an 'e' -- the point before the turn and the point after it
       * lie on the same line, so the far end has no offset from that line
       * whatsoever. Judged on offset it looks like a sample carrying no
       * shape, and dropping it pulls the ink back short of where the pen
       * actually went. Anywhere the line turns enough to be drawn as a
       * corner has to be kept for the same reason.
       */
      const arriving = pending.minus(lastKept);
      const leaving = next.minus(pending);
      const turns =
        arriving.magnitude() > minimumCornerArm &&
        leaving.magnitude() > minimumCornerArm &&
        arriving.normalized().dot(leaving.normalized()) < cornerCosine;
      /*
       * And where it doubles back, however short the step that shows it.
       *
       * The rule above wants both arms longer than `minimumCornerArm`, so
       * that a wobble too small to measure is not taken for a corner. A pen
       * slowing into the bottom of an 'm' leg, though, moves less than that
       * per sample, and once the tremor filter has smoothed the retrace the
       * way back up is all but the same line -- no offset, no long arm,
       * nothing kept. The bottom of the leg was dropped and the line ran
       * from the last point kept, up to 24px higher, straight to the pen on
       * its way back up: the ink just drawn there vanished as the pen turned
       * round, and the leg came out short. Replayed slowly, a 40px 'm' lost
       * 7.6px of each leg.
       *
       * A turn past the unmistakable corner is no wobble, and the step that
       * shows it is never under `minimumStep`, so only the arriving arm has
       * to be long enough to have a direction.
       */
      const doublesBack =
        arriving.magnitude() > minimumCornerArm &&
        arriving.normalized().dot(leaving.normalized()) < unmistakableCosine;

      if (
        turns ||
        doublesBack ||
        strayFromLine(pending, lastKept, next) >= shapeTolerance ||
        next.distanceTo(lastKept) >= maximumSpan
      ) {
        points.push(pending);
        widths.push(pendingWidth);
        // Its speed is taken across it, from the sample before to the one after.
        speedsAt.push(beforePending ? speedBetween(beforePending, incoming) : null);
        arrivalPeaks.push(segmentPeak);
        lastKeptTime = pendingTime;
        segmentPeak = step;
      } else {
        segmentPeak = fastestOf(segmentPeak, step);
      }
      beforePending = { point: pending, time: pendingTime };
      pending = next;
      pendingWidth = sampleWidth;
      pendingTime = newPoint.time;
    },
    geometry,
    straighten() {
      if (straightened) return null;
      const snapped = straightenedShape();
      if (!snapped) return null;

      straightened = snapped;
      return straightLine(snapped.from, snapped.to);
    },
  };
}
