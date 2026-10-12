import { GUIDE_ANGLE_STEP, GUIDE_ANGLE_WINDOW } from "@/lib/ink/geometry/pen-tuning";
import { Vec } from "@/lib/ink/geometry/vector";

/**
 * Where the aimed end of a snapped line actually goes: a straightened line's
 * far end, and the head of a snapped arrow.
 *
 * Once a line has snapped, swinging it is how the angle gets chosen, and
 * the angles people are reaching for are almost always the same eight:
 * upright, flat, and the diagonals between. Free aiming makes those the
 * hardest to land, because they are the only ones where being a degree out
 * is visible -- a line meant to be vertical and sitting at 89 looks wrong in
 * a way that one at 34 does not.
 *
 * So near one of the eight, the line leans towards it -- by a share of how
 * far off it is, not all the way. Close by, that share is nearly all of it
 * and the line reads as exactly upright; further out it is a nudge; at the
 * edge of the window it is nothing. The angle asked for is always still the
 * angle being drawn, just flattered.
 *
 * The length comes from how far along that direction the pen has reached
 * rather than from the raw distance, so the far end stays level with the
 * hand instead of running past it.
 */
export function aimAlongGuides(from: Vec, to: Vec, minimumStep: number): Vec {
  const reach = to.minus(from);
  const length = reach.magnitude();
  if (length < minimumStep) return to;

  const angle = Math.atan2(reach.y, reach.x);
  const nearest = Math.round(angle / GUIDE_ANGLE_STEP) * GUIDE_ANGLE_STEP;
  const error = angle - nearest;
  const offBy = Math.abs(error) / GUIDE_ANGLE_WINDOW;
  if (offBy >= 1) return to;

  /*
   * Squared twice over, so the well around a guide is deep and its rim is
   * flat. Measured on a 300px line: two degrees off a guide leaves the far
   * end 1.3px from true, which nobody can see, while the line never travels
   * more than 1.8 times as fast as the hand moving it -- fast enough to feel
   * like help, slow enough that there is nothing to catch on.
   *
   * A plain (1 - t) squared was gentler still at 1.3x, but left two degrees
   * sitting 4.6px out, which is visible on a line meant to be upright: soft
   * to the point of not doing the job.
   */
  const pull = (1 - offBy * offBy) * (1 - offBy * offBy);
  const aimed = angle - error * pull;
  const direction = Vec.of(Math.cos(aimed), Math.sin(aimed));
  return from.plus(direction.times(reach.dot(direction)));
}
