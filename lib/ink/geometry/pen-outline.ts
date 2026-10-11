import { arcToCubics } from "@/lib/ink/arc";
import type { InkPathCommand } from "@/lib/ink/model";
import {
  armReach,
  QUARTER_ARC_HANDLE,
  REVERSAL_BISECTOR_FLOOR,
} from "@/lib/ink/geometry/pen-tuning";
import { Vec } from "@/lib/ink/geometry/vector";

/**
 * The outline of a pen stroke drawn at varying width: out along one edge,
 * round the end, back along the other, round the start. One closed loop: a
 * stroke made of separate subpaths is welded into a zig-zag by everything
 * downstream that closes a path.
 *
 * Each edge is the centreline pushed out sideways by half the width, which is
 * only the shape a round nib leaves while the line bends more gently than that
 * half width. Where it turns tighter, the inside edge has less room than the
 * nib and runs backwards through the stroke, and the two edges can swap sides
 * altogether at a turn back on itself. Filled, those came out as the pen's
 * malformed ends: a pinched bow-tie where the Pencil slid back a pixel as it
 * landed, a spike where it slipped sideways, a fish tail where it hooked as it
 * lifted -- and a notch inside every sharp corner.
 *
 * So the edges are drawn in runs, and joined at the points where the line turns
 * too sharply for them, the way a stroked path is joined: round on the outside
 * of the turn, and through the point itself on the inside. Going through the
 * point is what a stroker does too (Skia does it at every inner join); the
 * inside edges overlap there, winding the same way as the rest of the stroke,
 * so a nonzero fill keeps every bit of the overlap.
 */

export const move = (at: Vec): InkPathCommand => ({ op: "M", x: at.x, y: at.y });
export const line = (to: Vec): InkPathCommand => ({ op: "L", x: to.x, y: to.y });
export const cubic = (control1: Vec, control2: Vec, to: Vec): InkPathCommand => ({
  op: "C",
  x1: control1.x,
  y1: control1.y,
  x2: control2.x,
  y2: control2.y,
  x: to.x,
  y: to.y,
});

export type PenOutlineInput = {
  /** The centreline's points, at least two. */
  shape: readonly Vec[];
  /** Half the stroke's width at each point. */
  halfWidths: readonly number[];
  /** Where the centreline comes to a point. Never the ends. */
  corners: readonly boolean[];
  /** The way the centreline runs through each point, where it does not come to a point. */
  along: readonly Vec[];
};

/**
 * Passes at finding where the edges fold. Each join found changes the edges
 * either side of it, so the next pass checks those; the count only bounds the
 * work on a stroke that keeps finding more.
 */
const FOLD_PASSES = 3;

/**
 * How far the points either side of a corner may turn, as a share of the
 * corner's own turn, for the corner to be joined.
 *
 * A corner with straight arms -- the point of a 'v', a hook at the end of a
 * stroke -- is joined, and its outside comes out round about the point and its
 * inside sharp, as a nib draws it. But the centreline also calls points corners
 * on a small loop, where thinning keeps so few points that each turns seventy
 * degrees or more. Joined there, the outside of every loop went round the
 * sampled points instead of the loop, and small cursive came out lumpy -- 37
 * more square units missing from four small 'e's than the plain edges left.
 * On a loop every point turns about as far as the next, which a corner with
 * straight arms never does.
 */
const JOIN_NEIGHBOUR_TURN_SHARE = 0.5;

/** Square to a direction, to its left: the side `left` edges are pushed to. */
const square = (direction: Vec) => Vec.of(-direction.y, direction.x);

/**
 * How the edges meet at a point: carried straight through it, joined round the
 * outside and through the point on the inside, or through the point on the
 * inside alone.
 *
 * The last is for a smooth turn tighter than the half width, which folds only
 * the inside edge. The outside of a curve is still the curve pushed outwards,
 * whatever its size, and rounding it about the one point bent it into a lump:
 * a thick pen zoomed in on its own handwriting came out knobbly.
 */
type Join = "none" | "round" | "inside";

export function penOutline({ shape, halfWidths, corners, along }: PenOutlineInput): InkPathCommand[] {
  const last = shape.length - 1;

  /** The way the line arrives at a point, from the nearest point before it that is somewhere else. */
  const directionInto = (index: number) => {
    for (let back = index - 1; back >= 0; back -= 1) {
      const step = shape[index].minus(shape[back]);
      if (step.magnitude() > 0) return step.normalized();
    }
    return null;
  };
  const directionOutOf = (index: number) => {
    for (let ahead = index + 1; ahead <= last; ahead += 1) {
      const step = shape[ahead].minus(shape[index]);
      if (step.magnitude() > 0) return step.normalized();
    }
    return null;
  };
  /** How far the line turns at each point, in radians; the ends count as straight. */
  const turns = shape.map((_, index) => {
    if (index === 0 || index === last) return 0;
    const into = directionInto(index);
    const outOf = directionOutOf(index);
    return into && outOf ? Math.acos(Math.max(-1, Math.min(1, into.dot(outOf)))) : 0;
  });
  /** Whether the line turns towards its left edge -- or straight back, which counts as left. */
  const turnsLeft = shape.map((_, index) => {
    const into = directionInto(index);
    const outOf = directionOutOf(index);
    return !into || !outOf || into.x * outOf.y - into.y * outOf.x >= 0;
  });
  const joins = shape.map(
    (_, index): Join =>
      index > 0 &&
      index < last &&
      corners[index] &&
      Math.max(turns[index - 1], turns[index + 1]) <= turns[index] * JOIN_NEIGHBOUR_TURN_SHARE
        ? "round"
        : "none"
  );
  /** Whether an edge leaves its run at a point: at every round join, and on the inside of an inside one. */
  const breaks = (index: number, left: boolean) =>
    joins[index] === "round" || (joins[index] === "inside" && turnsLeft[index] === left);

  /*
   * Which way each end faces.
   *
   * From the end to the first point at least a half width along, not to the
   * nearest: a Pencil's first and last samples can sit a fraction of a pixel
   * apart in any direction, and the cap faced wherever that fraction pointed --
   * sideways or back into the stroke, leaving the end looking cut off. Within
   * the end's own run, so a hook the joins have kept still ends where it went.
   */
  const endDirections = () => {
    let ahead = 1;
    while (ahead < last && joins[ahead] === "none" && shape[ahead].distanceTo(shape[0]) < halfWidths[0]) ahead += 1;
    let back = last - 1;
    while (back > 0 && joins[back] === "none" && shape[back].distanceTo(shape[last]) < halfWidths[last]) back -= 1;
    const fallback = directionOutOf(0) ?? Vec.of(1, 0);
    const start = shape[ahead].minus(shape[0]);
    const end = shape[last].minus(shape[back]);
    return {
      start: start.magnitude() > 0 ? start.normalized() : fallback,
      end: end.magnitude() > 0 ? end.normalized() : fallback,
    };
  };

  /**
   * Which way each edge point is pushed, arriving at a point and leaving it:
   * square to the line through it, or where the edge leaves its run there,
   * square to the step either side.
   */
  const normalsAlong = () => {
    const { start, end } = endDirections();
    const through: Vec[] = [];
    const into: Vec[] = [];
    const outOf: Vec[] = [];
    for (let index = 0; index <= last; index += 1) {
      if (index === 0 || index === last) {
        const normal = square(index === 0 ? start : end);
        through.push(normal);
        into.push(normal);
        outOf.push(normal);
        continue;
      }
      const direction = along[index];
      through.push(
        square(direction.magnitude() > 0 ? direction.normalized() : (directionOutOf(index) ?? start))
      );
      into.push(square(directionInto(index) ?? start));
      outOf.push(square(directionOutOf(index) ?? end));
    }
    const pushed = (left: boolean) => ({
      into: through.map((normal, index) => (breaks(index, left) ? into[index] : normal)),
      outOf: through.map((normal, index) => (breaks(index, left) ? outOf[index] : normal)),
    });
    return { left: pushed(true), right: pushed(false), start, end };
  };

  /*
   * Where the edges fold, wherever the centreline does not come to a point.
   *
   * A turn tight against the width -- a slip a pixel long, a hairpin in a small
   * loop -- folds the inside edge backwards over the step beside it, or swaps
   * the edges' sides outright. Either is caught on the step itself, at the
   * sharper turn of its two ends: an inside edge folding alone is mended on the
   * inside, and anything more is joined in full.
   */
  let normals = normalsAlong();
  for (let pass = 0; pass < FOLD_PASSES; pass += 1) {
    const { left, right } = normals;
    // A fold shows on the steps either side of the turn that makes it. Joined
    // from one, it is mended on both, which only the next pass can see.
    const joinedNow = new Set<number>();
    for (let index = 0; index < last; index += 1) {
      const step = shape[index + 1].minus(shape[index]);
      const from = halfWidths[index];
      const to = halfWidths[index + 1];
      const leftFolds =
        step.plus(left.into[index + 1].times(to)).minus(left.outOf[index].times(from)).dot(step) < 0;
      const rightFolds =
        step.minus(right.into[index + 1].times(to)).plus(right.outOf[index].times(from)).dot(step) < 0;
      const twisted =
        left.outOf[index].dot(left.into[index + 1]) < 0 ||
        right.outOf[index].dot(right.into[index + 1]) < 0;
      if (!twisted && !leftFolds && !rightFolds) continue;
      if (joinedNow.has(index) || joinedNow.has(index + 1)) continue;
      const candidates = [index, index + 1].filter((at) => at > 0 && at < last && joins[at] !== "round");
      if (candidates.length === 0) continue;
      const sharper = candidates.reduce((best, at) => (turns[at] > turns[best] ? at : best));
      const inside = !twisted && leftFolds !== rightFolds && turnsLeft[sharper] === leftFolds;
      joins[sharper] = joins[sharper] === "none" && inside ? "inside" : "round";
      joinedNow.add(sharper);
    }
    if (joinedNow.size === 0) break;
    normals = normalsAlong();
  }

  const { left, right, start, end } = normals;
  const leftIn = (index: number) => shape[index].plus(left.into[index].times(halfWidths[index]));
  const leftOut = (index: number) => shape[index].plus(left.outOf[index].times(halfWidths[index]));
  const rightIn = (index: number) => shape[index].minus(right.into[index].times(halfWidths[index]));
  const rightOut = (index: number) => shape[index].minus(right.outOf[index].times(halfWidths[index]));

  /**
   * Where an edge leaves its run: through the point on the inside of the turn,
   * round about it on the outside. A turn straight back on itself goes round on
   * the right.
   */
  const joinOn = (index: number, side: "left" | "right"): InkPathCommand[] => {
    const from = side === "left" ? leftIn(index) : rightOut(index);
    const to = side === "left" ? leftOut(index) : rightIn(index);
    if (turnsLeft[index] === (side === "left")) return [line(shape[index]), line(to)];
    const arriving = directionInto(index) ?? start;
    const leaving = directionOutOf(index) ?? end;
    return roundAbout(shape[index], from, to, arriving.minus(leaving), halfWidths[index]);
  };

  const path: InkPathCommand[] = [move(leftOut(0))];
  let runStart = 0;
  for (let index = 1; index <= last; index += 1) {
    if (index < last && !breaks(index, true)) continue;
    const run = [leftOut(runStart)];
    for (let inner = runStart + 1; inner < index; inner += 1) run.push(leftIn(inner));
    run.push(leftIn(index));
    path.push(...cubicsThrough(run));
    if (index < last) path.push(...joinOn(index, "left"));
    runStart = index;
  }
  path.push(...semicircle(shape[last], leftIn(last), end, halfWidths[last]));
  let runEnd = last;
  for (let index = last - 1; index >= 0; index -= 1) {
    if (index > 0 && !breaks(index, false)) continue;
    const run = [rightIn(runEnd)];
    for (let inner = runEnd - 1; inner > index; inner -= 1) run.push(rightIn(inner));
    run.push(rightOut(index));
    path.push(...cubicsThrough(run));
    if (index > 0) path.push(...joinOn(index, "right"));
    runEnd = index;
  }
  path.push(...semicircle(shape[0], rightOut(0), start.times(-1), halfWidths[0]));
  return path;
}

const FULL_TURN = 2 * Math.PI;
const wrapAngle = (angle: number) => ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;

/** An arc about `centre` from one point to another, going round by way of `outward`. */
function roundAbout(centre: Vec, from: Vec, to: Vec, outward: Vec, radius: number): InkPathCommand[] {
  const start = Math.atan2(from.y - centre.y, from.x - centre.x);
  const anticlockwise = wrapAngle(Math.atan2(to.y - centre.y, to.x - centre.x) - start);
  const sweep =
    wrapAngle(Math.atan2(outward.y, outward.x) - start) <= anticlockwise
      ? anticlockwise
      : anticlockwise - FULL_TURN;
  return arcToCubics(from.x, from.y, radius, radius, 0, Math.abs(sweep) > Math.PI, sweep > 0, to.x, to.y);
}

/**
 * Cubic Beziers through every point, C1 by construction.
 *
 * The same Catmull-Rom the centreline is drawn with, in a form the two edges
 * of a tapered stroke can also use. Their tangents come from their own
 * neighbours rather than the centreline's, because an offset edge turns
 * through a different angle than the line it was offset from -- sharper on
 * the inside of a bend, gentler on the outside.
 */
function cubicsThrough(pts: Vec[]): InkPathCommand[] {
  const at = (index: number) => pts[Math.min(Math.max(index, 0), pts.length - 1)];
  const direction = (index: number) => {
    const arriving = at(index).minus(at(index - 1));
    const leaving = at(index + 1).minus(at(index));
    if (arriving.magnitude() === 0) return leaving;
    if (leaving.magnitude() === 0) return arriving;
    const bisector = arriving.normalized().plus(leaving.normalized());
    return bisector.magnitude() < REVERSAL_BISECTOR_FLOOR ? leaving : bisector;
  };

  const commands: InkPathCommand[] = [];
  for (let index = 0; index < pts.length - 1; index += 1) {
    const from = at(index);
    const to = at(index + 1);
    const length = to.distanceTo(from);
    const reachOut = armReach(
      length,
      index > 0 ? from.distanceTo(at(index - 1)) : null
    );
    const reachIn = armReach(
      length,
      index + 2 < pts.length ? at(index + 2).distanceTo(to) : null
    );
    const armOut = direction(index);
    const armIn = direction(index + 1);
    commands.push(
      cubic(
        armOut.magnitude() > 0
          ? from.plus(armOut.normalized().times(reachOut))
          : from,
        armIn.magnitude() > 0 ? to.minus(armIn.normalized().times(reachIn)) : to,
        to
      )
    );
  }
  return commands;
}

/**
 * The round end of a stroke: a half circle from one edge to the other, as two
 * quarter-circle cubics.
 *
 * Drawn rather than left to a line cap because a tapered stroke is a filled
 * outline, and an outline has no caps to set -- the ends are simply part of
 * the shape.
 */
function semicircle(
  centre: Vec,
  from: Vec,
  outward: Vec,
  radius: number
): InkPathCommand[] {
  const spoke = from.minus(centre);
  if (radius <= 0 || spoke.magnitude() === 0 || outward.magnitude() === 0) {
    return [];
  }
  const unit = spoke.normalized();
  const away = outward.normalized();
  const handle = radius * QUARTER_ARC_HANDLE;
  const mid = centre.plus(away.times(radius));
  const to = centre.minus(unit.times(radius));
  return [
    cubic(from.plus(away.times(handle)), mid.plus(unit.times(handle)), mid),
    cubic(mid.minus(unit.times(handle)), to.plus(away.times(handle)), to),
  ];
}
