/**
 * Recognising a scribble-out.
 *
 * Scribbling over a word to delete it is a gesture people already know, but it
 * is destructive and it lives on the pen -- the tool used for everything else.
 * A false positive deletes work nobody asked to delete, so the question is not
 * "could this be a scribble?" but "could this be anything else?".
 *
 * Several signals have to agree. Individually each has a plausible innocent
 * explanation: `w` and `m` reverse direction, shading retraces a band, a fast
 * flick covers ground quickly. Together they describe a motion that handwriting
 * mostly does not make.
 *
 * Mostly, not entirely -- and that boundary is where this used to go wrong. The
 * shape of a small scribble and the shape of a small `w` are genuinely close,
 * and every rule added to separate them broke something people actually do:
 * requiring a thin band stopped whole words, blocks of lines and scribbles-over-
 * scribbles from registering, and requiring a word's worth of length stopped
 * single letters. The gates here are therefore deliberately permissive about
 * shape and size.
 *
 * The safety is that recognising a scribble deletes nothing on its own. Ink has
 * to be *decisively covered* by it -- see `NOTEBOOK_SCRIBBLE_MIN_COVERAGE` and
 * `planNotebookScribbleErase`. A `w` written on blank paper covers nothing and
 * is simply drawn, whatever this function thinks of it. What is left is writing
 * a letter directly on top of existing work, which is not a thing people do by
 * accident, and which one press of undo reverses.
 *
 * Samples arrive in **screen pixels**, in whatever frame the caller is using.
 * Every measurement here is translation-invariant, so the origin does not
 * matter -- which is what lets the editor collect raw pointer coordinates
 * during a stroke and work out where the page is only once a scribble has
 * actually been found. Locating the page costs a layout flush, and doing that
 * at the start of every stroke was enough to make writing feel like it dragged.
 *
 * The thresholds split by what they measure. Size belongs to the content --
 * "about as wide as a word" means a word on the page, whatever the zoom -- so
 * its threshold is scaled by `viewportScale` to meet the samples where they
 * are. Speed and tremor belong to the hand, which does not know what the zoom
 * is, and are compared directly. Measuring everything one way or the other
 * makes the gesture trivial to trigger at one end of the zoom range and
 * impossible at the other. The page is 900 units across.
 */

export type NotebookScribblePoint = { x: number; y: number };
export type NotebookScribbleSample = NotebookScribblePoint & { time: number };

/**
 * Two reversals is three passes, the smallest gesture anyone means as a
 * scribble. A word crossed out with two passes reverses once and is left alone:
 * a cross-out is a mark people keep.
 *
 * Measured against scribbles as a hand actually makes them, the original four
 * reversals -- five passes -- was simply more than people do, and is why the
 * gesture did not fire. Most scribble-outs are three or four passes.
 */
const MIN_REVERSALS = 2;
/**
 * How far the pen must travel back before a reversal counts.
 *
 * Without hysteresis, tremor at the turn of each leg registers as a flurry of
 * reversals and any slow deliberate stroke can reach four.
 */
const REVERSAL_HYSTERESIS_ON_SCREEN = 8;
/**
 * Legs roughly share a direction rather than wandering.
 *
 * Generous, because a scribble over something small is nearly as tall as it is
 * long and its legs rise steeply as a result -- scribbling out a single letter
 * measures about 30 degrees. This only has to exclude motion with no common
 * direction at all.
 */
const MAX_LEG_DEVIATION_DEGREES = 50;
/**
 * Path length against bounding-box diagonal: retracing, not progressing.
 *
 * A floor rather than a discriminator; overlap is what actually separates
 * retracing from advancing. Four passes over a word measure 3.7, four over a
 * single letter 2.3.
 */
const MIN_RETRACE_RATIO = 2.2;
/**
 * Consecutive legs must cover each other, which shading and hatching do not.
 *
 * With leg deviation, one of the two load-bearing signals: a real scribble
 * measures ~1.0 against this and ~4 degrees against that, while `www` written
 * quickly fails both by a wide margin. The looser thresholds above lean on it.
 */
const MIN_LEG_OVERLAP = 0.6;
/**
 * About one letter across. Below this there is not enough gesture to read.
 *
 * Deliberately small. Scribbling out a single letter is a real thing to want,
 * and a letter is narrow: a few passes across a `t` or an `f` span barely more
 * than the stem. The earlier 48 was sized for scribbling out whole words, which
 * is why single letters worked only when the scribble happened to run *along*
 * the letter rather than across it -- fine for a `j`, useless for a `t`.
 */
const MIN_MAJOR_EXTENT_ON_PAGE = 26;
/**
 * Scribbles are brisk. Deliberate drawing is not.
 *
 * The weakest of the six, and deliberately kept low. Ordinary scribble-outs
 * measure 0.5 to 0.9 and the original 1.2 rejected nearly all of them; a
 * relaxed one is still a scribble. Shading, which this was originally meant to
 * catch, is excluded far more convincingly by overlap and band aspect. What is
 * left for speed is the genuinely slow movement of someone drawing rather than
 * striking something out.
 */
const MIN_MEAN_SPEED_ON_SCREEN_PER_MS = 0.35;
/**
 * A loop drawn around something is not a scribble.
 *
 * A quick circle passes every test above: it reverses twice along its axis,
 * its legs overlap, and its path is about 2.22 times its diagonal. A circle
 * keeps turning the same way, about 360 degrees in all, where a zigzag's turns
 * alternate and cancel -- but a hand scribbling fast curls its turns the same
 * way too, so three passes of a loopy scribble turn just as far as a circle.
 * Turning was the whole test at first, and it threw those scribbles out.
 *
 * What tells them apart is the passes. A scribble's run most of its length,
 * three or more of them; a circle has two, and the overshoot past where it
 * began is short. So a stroke that has turned one way through about one loop
 * is a scribble only with three passes of at least `LOOP_LONG_LEG_SHARE` of
 * its length, and only when it is clearly longer than it is tall: a round
 * loop is a circle (`LOOP_ROUND_ASPECT`). Past `LOOP_MAX_TURN_DEGREES` it has
 * looped round more than anyone circles a word, and is judged as any scribble
 * is.
 *
 * Measured on hand-shaped strokes (looping and zigzag scribbles of three to
 * six passes, uneven passes, drifting; circles and ellipses from every
 * starting point): every scribble of four passes or more and four in five of
 * three passes are recognised, and no circle drawn once round with up to a
 * fifth of a turn's overshoot is.
 */
const LOOP_MIN_TURN_DEGREES = 300;
const LOOP_MAX_TURN_DEGREES = 630;
const LOOP_LONG_LEG_SHARE = 0.75;
const LOOP_MIN_LONG_LEGS = 3;
const LOOP_ROUND_ASPECT = 0.6;
/**
 * Turning is read between points this far apart, so hand tremor cannot add
 * to it, and a turn sharper than this in one step is a reversal, whose sign
 * says nothing: a straight back-and-forth turns 180 degrees either way.
 */
const TURN_SAMPLE_SPACING_ON_SCREEN = 6;
const REVERSAL_TURN_DEGREES = 150;
/** Below this a stroke has too little shape to judge. */
const MIN_SAMPLES = 8;
/** Samples closer together than this are the same place. */
const MIN_SAMPLE_SPACING_ON_SCREEN = 1;

export type NotebookScribbleBand = {
  /**
   * Convex hull of the gesture, grown by the nib, wound counter-clockwise, in
   * the same frame the samples arrived in.
   */
  hull: NotebookScribblePoint[];
  bounds: { maxX: number; maxY: number; minX: number; minY: number };
};

export type NotebookScribble = {
  band: NotebookScribbleBand;
  legs: number;
  /** Length along the legs, in page units. Sets how much cover is demanded. */
  majorExtent: number;
  reversals: number;
};

function distance(first: NotebookScribblePoint, second: NotebookScribblePoint) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function thinned(
  samples: readonly NotebookScribbleSample[],
  minSpacing: number
) {
  const kept: NotebookScribbleSample[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    const previous = kept[kept.length - 1];
    if (previous && distance(previous, sample) < minSpacing) continue;
    kept.push(sample);
  }
  return kept;
}

/**
 * The direction the gesture's legs run in.
 *
 * Taken from how the pen *travelled*, not from where the points ended up.
 * Those differ exactly when it matters: a scribble filling a square block has
 * as much spread down the page as across it, so the spread of the points picks
 * an axis arbitrarily -- and picking the direction the gesture advances rather
 * than the direction its legs run makes every leg read as perpendicular to the
 * axis, which is what stopped area-covering scribbles being recognised.
 *
 * Travel does not have that ambiguity. Nearly all of it is along the legs.
 * Each step contributes its outer product, which is blind to the sign of the
 * direction, so legs running opposite ways reinforce the same axis instead of
 * cancelling; weighting by length lets the long sweeps outvote the turns.
 */
function principalAxis(points: readonly NotebookScribblePoint[]) {
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    // Unit direction, weighted by how far the pen went that way.
    xx += (dx * dx) / length;
    xy += (dx * dy) / length;
    yy += (dy * dy) / length;
  }
  // Leading eigenvector of the 2x2 covariance matrix.
  const trace = xx + yy;
  const determinant = xx * yy - xy * xy;
  const discriminant = Math.sqrt(
    Math.max(0, (trace * trace) / 4 - determinant)
  );
  const eigenvalue = trace / 2 + discriminant;
  const axisX = Math.abs(xy) > 1e-9 ? eigenvalue - yy : xx >= yy ? 1 : 0;
  const axisY = Math.abs(xy) > 1e-9 ? xy : xx >= yy ? 0 : 1;
  const length = Math.hypot(axisX, axisY);
  if (length < 1e-9) return { x: 1, y: 0 };
  return { x: axisX / length, y: axisY / length };
}

/** How far the path turns in all, in degrees, signed (see `LOOP_MIN_TURN_DEGREES`). */
function netTurningDegrees(samples: readonly NotebookScribblePoint[]) {
  let net = 0;
  let heading: number | null = null;
  let from = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    const to = samples[index];
    if (distance(from, to) < TURN_SAMPLE_SPACING_ON_SCREEN) continue;
    const next = Math.atan2(to.y - from.y, to.x - from.x);
    if (heading !== null) {
      let turn = next - heading;
      if (turn > Math.PI) turn -= 2 * Math.PI;
      if (turn < -Math.PI) turn += 2 * Math.PI;
      if (Math.abs(turn) < (REVERSAL_TURN_DEGREES * Math.PI) / 180) net += turn;
    }
    heading = next;
    from = to;
  }
  return (net * 180) / Math.PI;
}

/** Runs of travel between direction changes, as index ranges. */
function legsAlongAxis(along: readonly number[], hysteresis: number) {
  const legs: Array<{ end: number; start: number }> = [];
  let legStart = 0;
  let direction = 0;
  let extreme = along[0];

  for (let index = 1; index < along.length; index += 1) {
    const value = along[index];
    if (direction === 0) {
      if (Math.abs(value - extreme) >= hysteresis) {
        direction = Math.sign(value - extreme);
        extreme = value;
      }
      continue;
    }
    if (Math.sign(value - extreme) === direction) {
      extreme = value;
      continue;
    }
    // Moving against the run. Only a real retreat ends the leg.
    if (Math.abs(value - extreme) < hysteresis) continue;
    legs.push({ start: legStart, end: index - 1 });
    legStart = index - 1;
    direction = -direction;
    extreme = value;
  }

  legs.push({ start: legStart, end: along.length - 1 });
  return legs;
}

/** Monotone chain, counter-clockwise. */
function convexHull(points: readonly NotebookScribblePoint[]) {
  const sorted = [...points].sort((left, right) =>
    left.x === right.x ? left.y - right.y : left.x - right.x
  );
  const turn = (
    origin: NotebookScribblePoint,
    from: NotebookScribblePoint,
    to: NotebookScribblePoint
  ) =>
    (from.x - origin.x) * (to.y - origin.y) -
    (from.y - origin.y) * (to.x - origin.x);

  const chain = (ordered: NotebookScribblePoint[]) => {
    const side: NotebookScribblePoint[] = [];
    for (const candidate of ordered) {
      while (
        side.length >= 2 &&
        turn(side[side.length - 2], side[side.length - 1], candidate) <= 0
      ) {
        side.pop();
      }
      side.push(candidate);
    }
    side.pop();
    return side;
  };

  return [...chain(sorted), ...chain([...sorted].reverse())];
}

/**
 * Grows a hull outward from its centroid.
 *
 * The band has to cover the ink the scribble was drawn over, and the pen's own
 * width is the honest allowance. Scaling from the centroid is approximate where
 * a true offset would be exact, but the coverage threshold is a proportion of a
 * stroke's length, not a hairline decision.
 */
function grownHull(hull: NotebookScribblePoint[], margin: number) {
  if (hull.length < 3 || margin <= 0) return hull;
  const centroidX = hull.reduce((total, point) => total + point.x, 0) / hull.length;
  const centroidY = hull.reduce((total, point) => total + point.y, 0) / hull.length;

  return hull.map((point) => {
    const dx = point.x - centroidX;
    const dy = point.y - centroidY;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return point;
    return {
      x: point.x + (dx / length) * margin,
      y: point.y + (dy / length) * margin,
    };
  });
}

/**
 * One pass, no intermediates.
 *
 * Spreading four mapped copies of the samples reads better, but this runs at
 * the end of every pen stroke and a stroke can carry a couple of thousand
 * samples.
 */
function boundsOf(points: readonly NotebookScribblePoint[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

function extentOf(values: readonly number[]) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

export function detectNotebookScribble(
  rawSamples: readonly NotebookScribbleSample[],
  options: { strokeWidth?: number; viewportScale?: number } = {}
): NotebookScribble | null {
  // Screen pixels per page unit, for the one threshold that belongs to the page.
  const scale =
    Number.isFinite(options.viewportScale) && (options.viewportScale ?? 0) > 0
      ? (options.viewportScale as number)
      : 1;
  const samples = thinned(rawSamples, MIN_SAMPLE_SPACING_ON_SCREEN);
  if (samples.length < MIN_SAMPLES) return null;

  const axis = principalAxis(samples);
  const along = samples.map((sample) => sample.x * axis.x + sample.y * axis.y);
  const majorExtent = extentOf(along);
  if (majorExtent < MIN_MAJOR_EXTENT_ON_PAGE * scale) return null;

  const legs = legsAlongAxis(along, REVERSAL_HYSTERESIS_ON_SCREEN);
  const reversals = legs.length - 1;
  if (reversals < MIN_REVERSALS) return null;


  let pathLength = 0;
  for (let index = 1; index < samples.length; index += 1) {
    pathLength += distance(samples[index - 1], samples[index]);
  }
  const bounds = boundsOf(samples);
  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (diagonal < 1e-9 || pathLength / diagonal < MIN_RETRACE_RATIO) return null;

  const elapsed = samples[samples.length - 1].time - samples[0].time;
  if (elapsed <= 0 || pathLength / elapsed < MIN_MEAN_SPEED_ON_SCREEN_PER_MS) {
    return null;
  }

  // Legs of a scribble lie along the same line. Folded to a quarter turn,
  // because a leg running backwards along the axis is just as parallel.
  const deviations = legs.map((leg) => {
    const from = samples[leg.start];
    const to = samples[leg.end];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return 90;
    const cosine = Math.abs((dx * axis.x + dy * axis.y) / length);
    return (Math.acos(Math.min(1, cosine)) * 180) / Math.PI;
  });
  const meanDeviation =
    deviations.reduce((total, value) => total + value, 0) / deviations.length;
  if (meanDeviation > MAX_LEG_DEVIATION_DEGREES) return null;

  // Consecutive legs must retrace each other. Hatching advances instead, so
  // its legs share little of their extent with the leg before.
  const overlaps: number[] = [];
  for (let index = 1; index < legs.length; index += 1) {
    const previous = legs[index - 1];
    const current = legs[index];
    const previousRange = [along[previous.start], along[previous.end]].sort(
      (left, right) => left - right
    );
    const currentRange = [along[current.start], along[current.end]].sort(
      (left, right) => left - right
    );
    const shared =
      Math.min(previousRange[1], currentRange[1]) -
      Math.max(previousRange[0], currentRange[0]);
    const shorter = Math.min(
      previousRange[1] - previousRange[0],
      currentRange[1] - currentRange[0]
    );
    overlaps.push(shorter < 1e-9 ? 0 : Math.max(0, shared) / shorter);
  }
  const meanOverlap =
    overlaps.reduce((total, value) => total + value, 0) / overlaps.length;
  if (meanOverlap < MIN_LEG_OVERLAP) return null;

  // About one loop: a circle round something, or a scribble whose turns curl
  // the same way. A scribble's passes each run most of its length; a circle
  // has two such passes, and the overshoot past where it began is short.
  const turned = Math.abs(netTurningDegrees(samples));
  if (turned >= LOOP_MIN_TURN_DEGREES && turned < LOOP_MAX_TURN_DEGREES) {
    // A round loop has no long way: along whichever axis fits it best, a
    // circle with some overshoot shows three long passes too.
    const minorExtent = extentOf(samples.map((sample) => sample.y * axis.x - sample.x * axis.y));
    if (minorExtent >= majorExtent * LOOP_ROUND_ASPECT) return null;
    let longLegs = 0;
    for (const leg of legs) {
      if (Math.abs(along[leg.end] - along[leg.start]) >= majorExtent * LOOP_LONG_LEG_SHARE) longLegs += 1;
    }
    if (longLegs < LOOP_MIN_LONG_LEGS) return null;
  }

  const hull = grownHull(
    convexHull(samples),
    Math.max(0, options.strokeWidth ?? 0) / 2
  );
  if (hull.length < 3) return null;

  return {
    band: { hull, bounds: boundsOf(hull) },
    legs: legs.length,
    // Reported on the page, because that is what the coverage rule compares
    // against: how much of a word this gesture is, not how many pixels it drew.
    majorExtent: majorExtent / scale,
    reversals,
  };
}

/**
 * The portion of a segment inside a convex band, as parameters along it.
 *
 * Cyrus-Beck: clip the interval against each edge's outward half-plane.
 */
function clipSegmentToBand(
  from: NotebookScribblePoint,
  to: NotebookScribblePoint,
  hull: readonly NotebookScribblePoint[]
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let entering = 0;
  let leaving = 1;

  for (let index = 0; index < hull.length; index += 1) {
    const edgeFrom = hull[index];
    const edgeTo = hull[(index + 1) % hull.length];
    // Counter-clockwise winding puts the interior on the left of each edge, so
    // the outward normal is the right normal.
    const normalX = edgeTo.y - edgeFrom.y;
    const normalY = -(edgeTo.x - edgeFrom.x);
    const denominator = normalX * dx + normalY * dy;
    const numerator =
      normalX * (from.x - edgeFrom.x) + normalY * (from.y - edgeFrom.y);

    if (Math.abs(denominator) < 1e-12) {
      if (numerator > 0) return null;
      continue;
    }
    const parameter = -numerator / denominator;
    if (denominator < 0) {
      entering = Math.max(entering, parameter);
    } else {
      leaving = Math.min(leaving, parameter);
    }
    if (entering > leaving) return null;
  }

  return { entering, leaving };
}

/**
 * How much of a polyline the scribble actually covers, by length.
 *
 * Whole strokes are deleted, so this is what stops a scribble over one word
 * taking the underline running beneath it as well.
 */
export function getNotebookScribbleCoverage(
  band: NotebookScribbleBand,
  points: readonly NotebookScribblePoint[]
) {
  if (points.length === 0) return 0;
  if (points.length === 1) {
    return clipSegmentToBand(points[0], points[0], band.hull) ? 1 : 0;
  }

  let totalLength = 0;
  let coveredLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const length = distance(from, to);
    if (length < 1e-12) continue;
    totalLength += length;
    const clipped = clipSegmentToBand(from, to, band.hull);
    if (clipped) coveredLength += (clipped.leaving - clipped.entering) * length;
  }

  if (totalLength < 1e-12) {
    // A stroke with no length at all is a dot: covered if its point is inside.
    return clipSegmentToBand(points[0], points[0], band.hull) ? 1 : 0;
  }
  return coveredLength / totalLength;
}

/**
 * A stroke this thoroughly covered is one the scribble was aimed at.
 *
 * Half rather than most: the ends of a word, and the outer reaches of an
 * earlier scribble being scribbled away, sit outside the hull and drag the
 * ratio down even when the gesture plainly meant to take the lot. What this
 * still has to exclude is a long rule or underline merely crossing the band,
 * and that measures around 0.2.
 */
export const NOTEBOOK_SCRIBBLE_MIN_COVERAGE = 0.5;
/**
 * Below this length a gesture is letter-sized, and has to cover nearly all of
 * whatever it takes.
 */
export const NOTEBOOK_SCRIBBLE_SMALL_EXTENT = 90;
/**
 * What a letter-sized gesture has to cover before anything is deleted.
 *
 * This is where the safety went when shape stopped being able to carry it. At
 * this size a scribble and a `w`, `m` or `z` are the same motion, so the test
 * has to be what the gesture *did* rather than what it looked like: scribbling
 * a letter out swallows it whole and measures about 1.0, while writing a letter
 * over existing work leaves that work mostly outside and comes nowhere near.
 */
export const NOTEBOOK_SCRIBBLE_SMALL_MIN_COVERAGE = 0.8;
