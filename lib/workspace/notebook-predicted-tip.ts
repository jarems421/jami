/**
 * The tip of the line, drawn a moment ahead of the pen.
 *
 * Between the glass and a lit pixel sit the digitiser, the browser handing the
 * event over, the frame the canvas waits for and the frame the screen waits
 * for. In Safari on an iPad that adds up to a few frames, and it is most of
 * what makes ink feel as if it trails the Pencil. None of it is Jami's to
 * remove: `notebook-ink-latency.ts` measures the part that is, and the
 * smoothing filter's share of it is under a pixel.
 *
 * What native note apps do about the rest is draw the next few milliseconds of
 * the line before they arrive, from the system's own prediction of where the
 * pen is going, and replace them with the real samples a frame later. Web
 * pages get the same prediction from `PointerEvent.getPredictedEvents()`:
 * Chrome has had it for years, and Safari since 18.2 (iPadOS 18.2), which is
 * what makes it worth doing here. On an iPad it is the very same prediction:
 * WebKit hands on UIKit's predicted touches for the Pencil
 * (`predictedTouchesForTouch:` in `WKTouchEventsGestureRecognizer.mm`), which
 * is what Apple's own apps draw ahead with.
 *
 * Two earlier attempts at closing this gap were removed, and this is shaped by
 * what sank each:
 *
 *  - Lag correction (`notebook-ink-prediction.ts`) wrote its lead into the
 *    stroke, so wherever the pen slowed or wobbled the line stepped back along
 *    itself. This tip is never part of the stroke. It is painted on the live
 *    layer after the stroke, wiped with it every frame, and never reaches
 *    js-draw's geometry, the saved page or undo.
 *  - The Web Ink API trail was drawn by the compositor, outside anything the
 *    app renders, and could linger a frame or two past the lift. This tip
 *    goes in the same task that commits the stroke, and is withheld as soon as
 *    pressure falls away at the lift.
 *
 * A prediction is still a guess, and a guess goes wrong at a turn or when the
 * browser is fed uneven timestamps -- Chrome was seen predicting hundreds of
 * pixels ahead, and backwards, from a burst of samples. So it is used only
 * inside an envelope built from what the pen has really just done: no further
 * ahead than `maxAheadMs`, no faster than a little over the pen's own recent
 * speed, never off to the side of or back against the way it is moving, never
 * longer than `maxLengthPx`, and less and then not at all while the pen is
 * turning. Handwriting is mostly turns, so in a word the tip mostly stands
 * down; it does its work on the straighter strokes, where it can be trusted.
 */

export type NotebookPredictedTipSample = {
  /** Client (CSS pixel) coordinates. */
  x: number;
  y: number;
  /** Event timestamp in milliseconds, as `PointerEvent.timeStamp`. */
  time: number;
};

export type NotebookPredictedTipPoint = { x: number; y: number };

export type NotebookPredictedTipOptions = {
  /**
   * The furthest ahead of the newest real sample a prediction is used, in ms.
   *
   * The further out a prediction reaches, the faster its error grows, and the
   * error that shows is at the turns. Replayed through 'm's -- two reversals
   * and two arches -- with a naive straight-line predictor, 16ms put the tip
   * up to 8px off the path for a frame at the top of a fast retrace; 10ms kept
   * it under 3.5px, and under 2px at ordinary speeds. With an accurate
   * predictor the tip stays within half a pixel of the path either way, so
   * this only decides how badly a poor one can show.
   *
   * It was 10, chosen against that naive predictor. Safari's is UIKit's, and
   * 10 threw away the half of it the owner could feel: writing fast, the ink
   * was seen to trail far behind the Pencil. Replayed with a prediction true
   * to 24ms and the frame on screen 30ms after the newest sample, 20ms brought
   * the end of the ink from 18px behind a fast line (1300px/s at its peak) to
   * 12, from 8 to 4 behind a line at 600px/s and through loops, with the tip
   * never more than 0.3px off the path. A predictor that reaches only 10ms
   * gains nothing from it and loses nothing.
   */
  maxAheadMs: number;
  /**
   * The longest the tip may reach past the newest real sample, in CSS pixels,
   * whatever the speed. Screen pixels on purpose: a wrong guess is seen at
   * the size it is drawn, at any zoom.
   */
  maxLengthPx: number;
  /**
   * How much faster than the pen's recent speed a prediction may move before
   * it is cut back to that. Room for a stroke that is speeding up, and none
   * for a predictor that has run away.
   */
  speedAllowance: number;
  /**
   * Below this speed, in px per ms, the pen is all but still and gets no tip.
   * A resting nib has nothing to lead, and its tremor would only make a tip
   * flicker around the end of the line.
   */
  minSpeedPxPerMs: number;
  /**
   * How far back the pen's recent speed is measured from, in ms.
   *
   * Adjacent Pencil samples are about 4ms apart, and over 4ms half a pixel of
   * sensor noise is as big as ordinary writing's movement. A frame or so back
   * is far enough for the direction and speed to mean something.
   */
  velocityWindowMs: number;
  /**
   * How far a prediction may point away from the way the pen is going, in
   * degrees, before it is not used. A predictor that has guessed a turn wrong
   * is most visible as a tip flicking off to the side.
   */
  maxSwerveDegrees: number;
  /**
   * How sharply the pen may be turning, in degrees between one velocity window
   * and the one before it, before the tip is withdrawn altogether. The reach
   * shrinks in proportion on the way there.
   *
   * Handwriting is made of turns -- an 'm' is two reversals and two arches in
   * a couple of centimetres -- and a turn is exactly where any prediction is
   * worst, because it is extrapolating a direction the pen is leaving. On a
   * straight run the tip covers the delay; in a turn it stands down.
   */
  maxTurnDegrees: number;
};

/**
 * Chosen for handwriting, which is mostly turns, over straight lines.
 *
 * Through an 'm' the tip mostly stands down. The tip is on for every stylus
 * stroke with no way to turn it off, so a poor predictor showing as a flick at
 * every turn would be the worse failure than a tip that could have reached a
 * little further -- which is why the turn and swerve limits stay where they
 * were when the reach doubled (see `maxAheadMs`).
 */
export const NOTEBOOK_PREDICTED_TIP: NotebookPredictedTipOptions = {
  maxAheadMs: 20,
  maxLengthPx: 16,
  speedAllowance: 1.5,
  minSpeedPxPerMs: 0.03,
  velocityWindowMs: 10,
  maxSwerveDegrees: 20,
  maxTurnDegrees: 30,
};

/** Enough history to reach back two velocity windows at any sample rate. */
const HISTORY_LIMIT = 16;

function isFiniteSample(sample: NotebookPredictedTipSample) {
  return (
    Number.isFinite(sample.x) &&
    Number.isFinite(sample.y) &&
    Number.isFinite(sample.time)
  );
}

/**
 * One contact's predicted tip: what the pen has really done lately, and where
 * the browser's predictions may safely take the line next.
 */
export class NotebookPredictedTip {
  private history: NotebookPredictedTipSample[] = [];

  constructor(
    private readonly options: NotebookPredictedTipOptions = NOTEBOOK_PREDICTED_TIP
  ) {}

  /** A new contact: nothing it did before is evidence for this one. */
  reset() {
    this.history = [];
  }

  /** Real samples, oldest first, as they arrive. */
  observe(samples: readonly NotebookPredictedTipSample[]) {
    for (const sample of samples) {
      if (!isFiniteSample(sample)) continue;
      const newest = this.history[this.history.length - 1];
      // A packet overlapping the last one would replay old movement as new.
      if (newest && sample.time < newest.time) continue;
      this.history.push({ x: sample.x, y: sample.y, time: sample.time });
    }
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
  }

  /**
   * The points the tip runs through after the newest real sample, in the same
   * client coordinates, in order. Empty when nothing is safe to draw.
   */
  ahead(
    predicted: readonly NotebookPredictedTipSample[]
  ): NotebookPredictedTipPoint[] {
    const newestIndex = this.history.length - 1;
    const newest = this.history[newestIndex];
    if (!newest || predicted.length === 0) return [];

    const baselineIndex = this.windowStart(newestIndex);
    if (baselineIndex === null) return [];
    const baseline = this.history[baselineIndex];
    const elapsed = newest.time - baseline.time;
    if (!(elapsed > 0)) return [];

    const velocityX = (newest.x - baseline.x) / elapsed;
    const velocityY = (newest.y - baseline.y) / elapsed;
    const speed = Math.hypot(velocityX, velocityY);
    if (!Number.isFinite(speed) || speed < this.options.minSpeedPxPerMs) {
      return [];
    }
    const directionX = velocityX / speed;
    const directionY = velocityY / speed;

    // How far the pen has turned between the window before and this one. With
    // too little history to say -- the first moments of a stroke -- nothing is
    // held back for it.
    let turnShare = 0;
    const earlierIndex = this.windowStart(baselineIndex);
    if (
      earlierIndex !== null &&
      baseline.time - this.history[earlierIndex].time >=
        this.options.velocityWindowMs / 2
    ) {
      const earlier = this.history[earlierIndex];
      const earlierX = baseline.x - earlier.x;
      const earlierY = baseline.y - earlier.y;
      const earlierLength = Math.hypot(earlierX, earlierY);
      if (earlierLength > 0) {
        const cosine =
          (earlierX * directionX + earlierY * directionY) / earlierLength;
        const turn = Math.acos(Math.max(-1, Math.min(1, cosine)));
        turnShare = turn / ((this.options.maxTurnDegrees * Math.PI) / 180);
      }
    }
    if (turnShare >= 1) return [];

    const reach =
      Math.min(
        this.options.maxLengthPx,
        speed * this.options.maxAheadMs * this.options.speedAllowance
      ) *
      (1 - turnShare);
    const swerveCosine = Math.cos((this.options.maxSwerveDegrees * Math.PI) / 180);
    const tip: NotebookPredictedTipPoint[] = [];
    for (const point of predicted) {
      if (!isFiniteSample(point)) break;
      if (point.time - newest.time > this.options.maxAheadMs) break;
      const offsetX = point.x - newest.x;
      const offsetY = point.y - newest.y;
      const length = Math.hypot(offsetX, offsetY);
      if (length === 0) continue;
      // Off to the side of, or back against, the way the pen is moving: a turn
      // or a reversal it has not made yet, or a predictor that has lost the
      // thread. Either way, stop here.
      const along = (offsetX * directionX + offsetY * directionY) / length;
      if (along <= 0 || along < swerveCosine) break;
      if (length > reach) {
        const scale = reach / length;
        tip.push({
          x: newest.x + offsetX * scale,
          y: newest.y + offsetY * scale,
        });
        break;
      }
      tip.push({ x: point.x, y: point.y });
    }
    return tip;
  }

  /**
   * The sample a velocity window ending at `end` starts from: the newest one
   * at least `velocityWindowMs` older, or the oldest there is.
   */
  private windowStart(end: number): number | null {
    if (end <= 0) return null;
    const endTime = this.history[end].time;
    let start = end - 1;
    while (
      start > 0 &&
      endTime - this.history[start].time < this.options.velocityWindowMs
    ) {
      start -= 1;
    }
    return start;
  }
}
