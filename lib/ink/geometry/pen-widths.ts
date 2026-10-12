import { WIDTH_SMOOTHING_RADIUS, WIDTH_VARIATION_FLOOR } from "@/lib/ink/geometry/pen-tuning";

/**
 * Each sample's width, pulled towards the stroke's own average so far.
 *
 * This is what `pressureResponse` does, and it has to happen before anything
 * else looks at the widths: at zero every point comes out at the mean, so the
 * variation test then correctly reports a stroke of one width and the cheaper
 * stroked path is taken. Flooring the widths instead -- which is all
 * `minimumWidthFraction` can do -- cannot produce that, because a floor only
 * lifts the light points and leaves the heavy ones heavy.
 *
 * Above one it pushes the other way, so a light touch reads lighter and a
 * heavy one heavier than the digitiser reported.
 *
 * The average is the one up to each sample, not the whole stroke's: against
 * the whole stroke, every sample written changed every width already drawn,
 * and the ink behind the pen swelled and thinned as the stroke went on.
 *
 * Except at zero, which is one width for the whole stroke and so has to be the
 * whole stroke's average. Jami Ink never asks for it: with pressure turned
 * down to nothing it does not read pressure at all (`InkStrokeSession`).
 */
export function shapePenPressure(raw: number[], pressureResponse: number) {
  if (pressureResponse === 1) return raw;
  if (pressureResponse === 0) {
    const mean = raw.reduce((sum, value) => sum + value, 0) / Math.max(raw.length, 1);
    return raw.map(() => Math.max(0.1, mean));
  }
  let total = 0;
  return raw.map((value, index) => {
    total += value;
    return shapedPenPressureAt(value, total, index + 1, pressureResponse);
  });
}

/**
 * One sample's width as `shapePenPressure` shapes it: `total` is the sum of
 * the widths up to and including it, `count` how many there are. For a
 * caller keeping the running sum itself.
 */
export function shapedPenPressureAt(value: number, total: number, count: number, pressureResponse: number) {
  const mean = total / count;
  return Math.max(0.1, mean + (value - mean) * pressureResponse);
}

/** Whether a stroke was drawn with enough varying weight to be worth tapering. */
export function penWidthVaries(raw: number[]) {
  if (raw.length < 3) return false;
  let smallest = raw[0];
  let largest = raw[0];
  let total = 0;
  for (const value of raw) {
    if (value < smallest) smallest = value;
    if (value > largest) largest = value;
    total += value;
  }
  const mean = total / raw.length;
  return mean > 0 && (largest - smallest) / mean >= WIDTH_VARIATION_FLOOR;
}

/**
 * Half the width at each point, averaged along the stroke and floored.
 *
 * The floor is a share of the stroke's average width up to that point, for
 * the reason `shapePenPressure` gives: a width settles once the samples
 * either side of it are in, and nothing written later moves it.
 */
export function penHalfWidthsAlong(raw: number[], count: number, minimumWidthFraction: number) {
  const result: number[] = [];
  let seen = 0;
  let seenTotal = 0;

  for (let index = 0; index < count; index += 1) {
    if (index < raw.length) {
      seen += 1;
      seenTotal += raw[index];
    }
    result.push(penHalfWidthAt(raw, index, seen, seenTotal, minimumWidthFraction));
  }
  return result;
}

/**
 * Half the width at one point, as `penHalfWidthsAlong` works it out: `seen`
 * widths up to and including it, summing to `seenTotal`. It reads
 * `WIDTH_SMOOTHING_RADIUS` widths either side, so it is settled once those
 * are in.
 */
export function penHalfWidthAt(
  raw: readonly number[],
  index: number,
  seen: number,
  seenTotal: number,
  minimumWidthFraction: number
) {
  const mean = seen ? seenTotal / seen : 0;
  const floor = mean * minimumWidthFraction;
  let total = 0;
  let samples = 0;
  for (let offset = -WIDTH_SMOOTHING_RADIUS; offset <= WIDTH_SMOOTHING_RADIUS; offset += 1) {
    const source = index + offset;
    if (source < 0 || source >= raw.length) continue;
    total += raw[source];
    samples += 1;
  }
  return Math.max(samples ? total / samples : mean, floor) / 2;
}
