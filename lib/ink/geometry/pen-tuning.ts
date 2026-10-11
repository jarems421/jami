/*
 * The numbers that decide how the notebook pen feels, each beside the reason
 * it is what it is. Measured against real handwriting, so a change here is a
 * change in feel and wants the same measuring.
 */

/**
 * How far the pen must travel before a sample is considered at all, as a
 * fraction of a screen pixel. Stops a resting pen filling the path with
 * duplicates.
 */
export const MINIMUM_STEP_RATIO = 0.6;

/**
 * How far a sample may sit from the line between its neighbours before it is
 * worth keeping, in screen pixels.
 *
 * A spline through every sample is smooth but enormous -- a long stroke came
 * out at 300 curves against the fitter's 11, and every one of those is stored
 * and reparsed on every load. Being C1, the spline is exactly as smooth
 * through sparse points as dense ones, so the samples that sit on the line
 * their neighbours already describe carry no shape and can go. Curvature is
 * where the points are kept.
 *
 * This was a quarter of a pixel, which is below the digitiser's own noise, so
 * the test was reading jitter rather than shape and almost nothing was thinned.
 * Measured against a hand wobbling half a pixel, a slow ruled line kept 150
 * curves and the drawn line still sat 0.64px off true -- it was faithfully
 * reproducing the wobble. Just above the noise it keeps 35 and sits 0.99px off:
 * a quarter of the work for a tenth of a pixel, and a visibly steadier line.
 *
 * The ceiling is the small round letter. At half a pixel an 'o' loses its shape
 * (0.85px off true here, 2.52px there), which is the flattening the span rule
 * below also guards against. This sits under that.
 */
export const SHAPE_TOLERANCE_RATIO = 0.4;

/**
 * The furthest apart two kept points may be, in screen pixels.
 *
 * The test above only ever compares one held sample against the chord it sits
 * on, so on a long gentle curve the error accumulates unchecked: each sample
 * looks near enough to the line, and the line quietly grows. Small round
 * letters are what suffer -- an 'o' is a long gentle curve at that scale, and
 * it comes back flattened. Forcing a point at least this often bounds how far
 * that can run.
 */
export const MAXIMUM_SPAN_RATIO = 24;

/**
 * How much of a segment each control arm takes, as a fraction of that
 * segment's own length.
 *
 * A third either side is the classic Catmull-Rom arm for evenly spaced points,
 * and it keeps a cubic inside the two points it joins. The arm has to be
 * measured against *this* segment: thinning leaves points very unevenly
 * spaced, so an arm sized from the span between a point's neighbours can come
 * out longer than the short segment it belongs to, and the curve then bulges
 * past where the pen went.
 */
const TANGENT_SCALE = 1 / 3;

/**
 * How much longer a control arm may be than the arm meeting it at the same
 * point, on the next piece of the curve.
 *
 * Thinning keeps the ends of a straight run and drops its middle, so the long
 * leg of an 'n' arrives at the round top as one 23px piece meeting a 4px one.
 * Both arms at that join point along the turn's bisector -- that is what keeps
 * the join smooth -- but the long piece's arm, a third of 23px, swung its whole
 * straight leg out the other way first: 1.3px of ink on the wrong side of the
 * line just before every fast turn, which read as the turn poking out.
 *
 * Capping the long arm keeps the direction, so the join is as smooth as
 * before, and lets the leg stay straight until the turn actually starts. Arms
 * on evenly spaced points are never touched.
 *
 * Measured in `notebook-smooth-turn-poke.test.ts`: 2 halved the worst poke on
 * a fast 'n', 1.5 halved it again (0.9px to 0.48px at 8px between samples)
 * for a few hundredths of a pixel on densely sampled turns; 1.25 bought
 * nothing more.
 */
const ARM_NEIGHBOUR_RATIO = 1.5;

/** One control arm's length: a share of its own piece, capped by the neighbour's. */
export function armReach(piece: number, neighbouringPiece: number | null) {
  const own = piece * TANGENT_SCALE;
  if (neighbouringPiece === null) return own;
  return Math.min(own, neighbouringPiece * TANGENT_SCALE * ARM_NEIGHBOUR_RATIO);
}

/**
 * Easing is deliberately spatial rather than temporal. Smoothing the input
 * harder would ease curves too, but by holding the ink back in time -- which is
 * felt immediately as the pen being dragged, and was the magnetic complaint.
 * Nudging the shape instead costs nothing in time: the ink is still drawn the
 * instant the sample arrives, just a fraction kinder about where the hand
 * wobbled.
 *
 * Two points are exempt however far it is turned up: the newest, so the line
 * always ends exactly under the pen, and any corner, so a deliberate point
 * stays a point. How far the rest are eased, and how sharp a turn has to be
 * before it counts as one of those corners, are the reader's to set --
 * see `getNotebookPenFeel`.
 */

/**
 * The furthest easing may move a point, in screen pixels.
 *
 * About the size of the digitiser's own wobble, which is what easing is for.
 * Without a ceiling, easing moved points in proportion to how far they sat
 * from their neighbours' line -- and on a fast turn sampled a few pixels apart
 * that is far, so it was flattening turns rather than steadying them.
 */
export const MAXIMUM_EASE_RATIO = 0.4;

/**
 * How far a stroke may wander from the straight line between its ends and
 * still be taken as an attempt at one, as a fraction of that line's length.
 *
 * Holding still at the end of a stroke snaps it straight. This used to be
 * strict, on the reasoning that straightening something the hand did not mean
 * as a line overwrites a finished drawing -- but it was strict enough that only
 * an already-straight line qualified, which is the one case that needs no help.
 * A ruled line drawn freehand wanders, and a rough one is exactly what somebody
 * holding their pen still is asking to have tidied.
 *
 * What guards this is not the tolerance but the gesture: nobody stops dead at
 * the end of ordinary writing, they lift. And the result can now be adjusted
 * before it commits, so a snap that came out wrong is redirected rather than
 * redrawn.
 */
export const STRAIGHTEN_TOLERANCE = 0.38;

/**
 * How far a stroke may run backwards along its own line and still be taken as
 * an attempt at one, as a fraction of that line's length.
 *
 * Sideways wandering is what a rough line does; coming back on itself is what a
 * `v`, an `n` or a zigzag does. Allowing the first generously while still
 * refusing the second is what stops the loose tolerance above straightening
 * shapes that only happen to start and end far apart.
 */
export const STRAIGHTEN_MAXIMUM_BACKTRACK = 0.12;

/**
 * How one-sided the wander may be before it is a curve rather than a wobble.
 *
 * Distance from the line was doing two jobs and could only do one. Loose enough
 * to accept a genuinely squiggly line -- which is the whole gesture, since
 * nobody who could draw it straight would be holding still to have it fixed --
 * and it also accepted a deliberate arc, which is the one shape a person is
 * least likely to want replaced by a chord.
 *
 * Measured on a 300px stroke: a 50px squiggle scores about 0.06 here, a 40px
 * arc about 0.63. Nothing sits near the middle, so the threshold has room to be
 * wrong by a lot and still be right.
 *
 * Only asked of a stroke that strays far enough to be a curve at all
 * (`STRAIGHTEN_MINIMUM_ARC`): the score is the same for a bend of any depth.
 */
export const STRAIGHTEN_MAXIMUM_BOW = 0.32;

/**
 * How far from its line, as a fraction of its length, a stroke must bow before
 * it can be a deliberate curve rather than a line drawn by hand.
 *
 * The bow test cannot see depth: a line bent two pixels one way scores like an
 * arc. And a line drawn freehand does bend one way, the wrist swinging it
 * round -- a flat line most of all, which is the one people draw most -- so
 * holding still at the end of nearly every horizontal line was refused. A
 * shallow bend is a line; past this, a curve is left alone.
 */
export const STRAIGHTEN_MINIMUM_ARC = 0.08;

/**
 * The eight angles a snapped line is drawn towards, and how near it has to be.
 *
 * Every 45 degrees: upright, flat, and the four diagonals.
 *
 * The pull fades to nothing at the edge of the window rather than stopping
 * there. Switching it on at a threshold means the far end of the line jumps the
 * moment the angle crosses it -- twenty-odd pixels on a long line -- and since a
 * held hand wanders either side of any threshold you care to pick, it jumps
 * back and forth. That is not an assist, it is a flicker, and it is worst
 * exactly where the assist was supposed to help.
 *
 * So the correction is a fraction of the error, and the fraction falls away
 * with distance from the guide: full attention right beside it, none at all at
 * the edge, and no step anywhere in between. Squaring the falloff means it also
 * arrives at the edge flat, so there is no seam where the pull stops.
 *
 * The window can be wider than a hard one could be, because being inside it no
 * longer commits to anything.
 */
/**
 * Below this, the two directions through a point have cancelled.
 *
 * The sum of two unit vectors is twice the cosine of half the turn between
 * them, so this is a turn of about 179.5 degrees -- a reversal by any reading,
 * and far past the hundred at which the corner rule stops asking questions.
 */
export const REVERSAL_BISECTOR_FLOOR = 0.01;

/**
 * The circle-to-Bezier constant, for a quarter turn.
 *
 * Used for the round caps on a tapered stroke and for the dot, which is the
 * same shape with no length.
 */
export const QUARTER_ARC_HANDLE = 0.5522847498;

/**
 * How many samples either side are averaged into a point's width.
 *
 * Pressure off a digitiser is noisy at a scale the eye reads as a ragged edge
 * rather than as pressure, and the outline shows every bit of it: the centreline
 * is smoothed by the spline, but the distance out to the edge is not smoothed by
 * anything. Averaging over a short run keeps the swell of a stroke while losing
 * the tremble in it.
 */
export const WIDTH_SMOOTHING_RADIUS = 2;

/*
 * The thinnest a tapered stroke goes is `feel.minimumWidthFraction`, and the
 * floor exists because Apple Pencil reports very little pressure for the first
 * sample or two of a contact: a taper that honoured it exactly would start
 * every stroke from nothing, which reads as the pen failing to catch rather
 * than as a calligraphic entry. How deep the taper runs is the reader's --
 * see `pressurePercent`.
 */

/**
 * How much a stroke's width must vary before it is worth drawing as an outline.
 *
 * A mouse, a desktop stylus, and an Apple Pencil held at a steady weight all
 * report one width, and for those the old uniform stroked path is the better
 * answer: half the geometry, and identical on screen. The outline is spent only
 * where there is something for it to show.
 */
export const WIDTH_VARIATION_FLOOR = 0.08;

export const GUIDE_ANGLE_STEP = Math.PI / 4;
export const GUIDE_ANGLE_WINDOW = (8 * Math.PI) / 180;

/** Shorter than this and there is not enough of a line to be sure. */
export const STRAIGHTEN_MINIMUM_SPAN_RATIO = 8;

/**
 * The corner threshold is the reader's setting, but this is what it does.
 *
 * A Catmull-Rom spline is smooth *everywhere*, which sounds like what a pen
 * wants until you write joined-up. Handwriting is full of deliberate corners
 * -- the point of a 'v', the cusp where one letter joins the next, the turn
 * back down at the top of an 'a' -- and a curve that cannot make a corner
 * rounds every one of them off. That reads as the pen being magnetic: it
 * refuses to go exactly where it was taken.
 *
 * At a corner the two tangents are taken from the strokes either side instead
 * of from the line through them, which lets the join come to a point. Curves
 * below the threshold are untouched, so a genuine curve stays seamless.
 *
 * Set it too low and the opposite complaint appears, which is the one this
 * setting exists for: a small letter is a tight curve, tight enough that the
 * line turns several degrees between one kept point and the next, and every one
 * of those plain curves is then drawn as a point. Two corners in a row are
 * joined by a straight chord, so a run of them is a run of chords -- writing
 * that reads as joining up dots rather than flowing.
 */

/**
 * The shortest run the corner angle may be measured over, in screen pixels.
 *
 * An angle between two segments a pixel long is mostly the digitiser's noise:
 * half a pixel of wobble either side swings it through tens of degrees, so a
 * slowly drawn straight line arrives full of corners that were never made. That
 * is expensive twice over -- a corner is kept rather than thinned, and corners
 * are exempt from easing, so the wobble that invented it is then preserved on
 * purpose. Measured on a small 'o', ignoring these took it from 79 curves to 44
 * *and* moved the drawn line closer to the true shape.
 *
 * A step and a half of travel, so it can only ever suppress an angle there was
 * not enough movement to measure. A corner drawn deliberately clears it
 * immediately, and one drawn slowly is kept by the offset test regardless,
 * since sitting far off the line between its neighbours is what a corner is.
 */
export const MINIMUM_CORNER_ARM_RATIO = MINIMUM_STEP_RATIO * 1.5;

/*
 * Why a turn has to stand out from its neighbours before it is a corner, and
 * why that is a setting rather than a rule -- see `cornerDominance`.
 *
 * The angle alone cannot tell a corner from a curve, because it depends on how
 * far apart the points are, and thinning spaces points by curvature: the
 * tighter the curve the further it turns between one kept point and the next. A
 * small 'o' turns about fifty degrees a step, which is over any threshold low
 * enough to catch the cusp between two letters, so every point on it was drawn
 * as a corner -- and two corners in a row put both control arms on the chord
 * between them, so the piece came out as a literal straight line.
 *
 * What separates them is that a corner is local: turning is concentrated at one
 * point and its neighbours are comparatively straight, where on a curve every
 * point turns about the same amount.
 *
 * But that is smoothing, and it does not belong at the faithful end of the
 * slider. Applied there it rounded off turns somebody had explicitly asked to
 * keep, which is what "even on 0 smoothness the ink is forced into a curve" was.
 */

/**
 * The run each side of a point that its turn is measured over, in screen
 * pixels.
 *
 * Longer than the arm that decides which points to keep, and for a second
 * reason. There, a short arm only had to be long enough that the angle was not
 * pure noise. Here the angle is also the yardstick every neighbouring angle is
 * judged against, so noise in it does damage twice: measured over a single
 * step, a straight stroke wobbling half a pixel turns thirty or forty degrees
 * at every point, and a deliberate sixty-degree corner sitting among those no
 * longer stands out from them. It was being rounded off -- the exact opposite
 * of the complaint. Over a couple of pixels the wobble averages out and the
 * corner is again the only thing turning.
 */
export const TURN_ARM_RATIO = 2.5;

/**
 * How many points the reach above may cross to find that run.
 *
 * Reaching is meant to step over samples that landed on top of each other, not
 * to step over shape. Where a curve turns hard the points bunch up, and a walk
 * with no limit hops clean across the turn and reports the whole of it as one
 * angle -- a smooth sine wave came back with 114-degree corners at its peaks,
 * which is the fault this was supposed to be fixing.
 */
export const TURN_ARM_MAXIMUM_REACH = 2;

/**
 * A turn this sharp is a corner whatever its neighbours are doing, in degrees.
 *
 * The rule above needs somewhere to stand, and a zigzag denies it one: in a 'w'
 * every vertex is a corner, so each has another corner either side and none of
 * them is locally dominant. Nothing in ordinary writing turns this far without
 * meaning to, so past this the question does not need asking.
 */
export const UNMISTAKABLE_CORNER_DEGREES = 100;

/**
 * How far the pen must have slowed at a point, against the fastest it moved on
 * the stretches either side, before that point may be a corner.
 *
 * Every rule above reads the shape of the samples, and at speed the samples
 * cannot describe a round turn: at 120Hz a pen sweeping the bottom of a fast
 * 'u' is sampled 13px apart around a curve 6px across, so between two samples
 * the line really does turn past a hundred degrees. Judged on shape alone,
 * every such turn was drawn as a point, and a fast word came out as a chain of
 * straight stubs.
 *
 * What the samples do still say is how fast the pen was going. A hand cannot
 * change direction sharply at speed: the point of a 'v', the reversal at the
 * top of an 'l', the cusp between letters are all made by slowing into them,
 * where a round turn is swept through. Replayed with sampling jitter, a fast
 * wave's peaks kept about half their flank speed; a deliberate corner drops to
 * a small fraction of it. Samples without time leave this undecided, and the
 * corner rule then stands as it was.
 *
 * Moderate turns only. A turn past `UNMISTAKABLE_CORNER_DEGREES` is kept as a
 * corner however fast it was drawn: the shoulder of an 'r', the retrace up an
 * 'n', the cusp where joined-up letters meet are all that sharp, and fast
 * cursive does not slow into them enough to pass this -- so they were rounded,
 * and the ink looked pulled inwards into a curve. Replayed as a fast 'rn',
 * that put ink more than 1.5px off the path in 56 of 80 strokes at the
 * faithful setting, against 22 with sharp turns exempt. The false kinks this
 * was written for came from turns under that, up to about 90 degrees.
 */
export const CORNER_SLOWDOWN = 0.35;
