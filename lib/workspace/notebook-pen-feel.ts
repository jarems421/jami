/**
 * How much the pen tidies up what the hand did.
 *
 * Two separate questions, and two separate settings:
 *
 * - Smoothing is how much wobble is taken out of the line: the tremor filter
 *   on the input, and the light easing of the curve drawn through it.
 * - Corner sharpness is whether a turn is drawn as a point or carried through
 *   as a curve.
 *
 * They used to be one slider, which moved both at once. That is why turning
 * Smoothing down to keep a line faithful also turned every curve in it into a
 * run of corners, and why nothing could round the corners off without also
 * dragging the line away from the pen. There is no single right answer to
 * either -- a fast joined-up hand wants its turns carried through, and a
 * careful printed one wants every deliberate point kept -- so each is a
 * setting rather than a constant.
 */

import {
  NOTEBOOK_INK_SMOOTHING,
  type NotebookInkSmoothingOptions,
} from "@/lib/workspace/notebook-ink-smoothing";

export const NOTEBOOK_PEN_SMOOTHING_STORAGE_KEY = "jami:notebook-pen-smoothing";

/**
 * Toward the flowing end, because the previous fixed behaviour sat lower and
 * read as joining up dots: on a small letter the samples turn far enough
 * between one kept point and the next that a plain curve was being taken for a
 * deliberate corner, and a run of those is drawn as a run of chords.
 */
export const NOTEBOOK_PEN_SMOOTHING_DEFAULT = 62;

export type NotebookPenFeel = {
  /**
   * How sharply the line must turn at a point before it is drawn as a corner
   * rather than carried through as a curve, in degrees.
   */
  cornerDegrees: number;
  /**
   * How far an interior point may be eased towards the line between its
   * neighbours, as a fraction of the way there.
   */
  easeTowardsNeighbours: number;
  /**
   * How much sharper than the turns either side of it a turn must be before it
   * is drawn as a corner.
   *
   * One is no requirement at all: any turn past `cornerDegrees` is a point,
   * which is what "None" has to mean. Above one, a turn also has to stand out
   * from its neighbours, which is what stops a tightly drawn curve being read
   * as a run of corners -- but it is smoothing, and applying it at the faithful
   * end quietly rounded off turns somebody had asked to keep.
   */
  cornerDominance: number;
  /**
   * The thinnest a tapered stroke goes, as a fraction of its own average.
   *
   * A floor, not an amount: it stops a light entry stroke starting from
   * nothing, and lowering it lets the taper run further down. Turning pressure
   * off is `pressureResponse` below, not this. See `pressurePercent`.
   */
  minimumWidthFraction: number;
  /**
   * How much of the reported pressure variation is drawn, as a multiplier.
   *
   * One draws it as reported, which is what the pen always did. Zero draws the
   * stroke at one width throughout -- not a flattened taper but no taper at
   * all, which is also the cheaper shape, since a stroke of one width is drawn
   * as a stroked path rather than as its own outline. Above one exaggerates.
   */
  pressureResponse: number;
  /**
   * Whether a snapped line is also pulled towards the nearest 45 degrees.
   *
   * Straightening and levelling are two favours, and only the first is asked
   * for by holding still. See `straightenOnHold`.
   */
  snapToGuides: boolean;
};

/** What the taper did before it was settable, and what 50% still gives. */
export const NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT = 0.35;

/**
 * No smoothing. Corners are taken at the slightest turn and nothing is eased,
 * so the line goes exactly where it was taken -- wobble included.
 */
const NO_SMOOTHING: NotebookPenFeel = {
  /*
   * Low enough that an ordinary turn is a turn.
   *
   * This was 18, which sounds faithful and is not: the threshold is what a
   * turn has to exceed to survive as a point, and the turns handwriting is
   * made of -- the shoulder of an 'n', the corner of a 'z', the change of
   * direction at the top of a stem -- run from about twenty degrees up. At 18
   * they only just cleared it, and at any setting above None they did not,
   * which is why turning still felt assisted however far the slider came down.
   */
  cornerDegrees: 8,
  easeTowardsNeighbours: 0,
  cornerDominance: 1,
  minimumWidthFraction: NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT,
  pressureResponse: 1,
  snapToGuides: true,
};

/**
 * Full smoothing. Only a turn that is unmistakably a point is drawn as one.
 *
 * The corner ceiling used to stop short of a right angle, because nothing else
 * protected the point of a `v` or the cusp between two joined letters: raise
 * the threshold past those and the pen starts refusing to go where it was
 * taken, which is a worse complaint than a slightly angular curve. The pen now
 * treats a turn past a hundred degrees as a corner whatever this says, so those
 * are safe on their own account and the ceiling is free to sit where it is
 * useful -- which is above the tightest turn a small letter makes, since that
 * was being drawn as a point at every setting.
 *
 * The easing ceiling is low, and it is the one that was got wrong first time
 * round. Easing is the only part of this that moves the line off the points the
 * pen visited, and it does so in proportion: measured on cursive at a 34px
 * x-height, the line sits 0.11px off with none of it and 0.55px off at 0.62,
 * which is felt as the pen resisting at every turn. What answers the
 * joined-up-dots complaint is the corner threshold, and that costs no deviation
 * at all -- so the corner threshold carries the range and easing stops at the
 * light touch it has always had.
 */
const FULL_SMOOTHING: NotebookPenFeel = {
  cornerDegrees: 82,
  easeTowardsNeighbours: 0.34,
  cornerDominance: 1.7,
  minimumWidthFraction: NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT,
  pressureResponse: 1,
  snapToGuides: true,
};

export function clampNotebookPenSmoothing(value: number) {
  if (!Number.isFinite(value)) return NOTEBOOK_PEN_SMOOTHING_DEFAULT;
  return Math.round(Math.max(0, Math.min(100, value)));
}

/**
 * The measured shaping curve, from a line drawn exactly as taken (0) to one
 * carried through all but its unmistakable points (100).
 *
 * This is what the one Smoothing slider used to drive whole, corners and
 * easing together. It is still the curve both halves are read from -- it was
 * measured against real handwriting at three sizes, and a second mapping would
 * throw that away -- but nothing drives it whole any more: Corner sharpness
 * reads the corner half of it backwards, and Smoothing reads the easing half.
 * See `getNotebookPenFeelFromSettings`.
 */
export function getNotebookPenFeel(smoothingPercent: number): NotebookPenFeel {
  const towards = clampNotebookPenSmoothing(smoothingPercent) / 100;
  const between = (from: number, to: number) => from + (to - from) * towards;

  /*
   * The corner threshold rises slowly at first and steeply at the end.
   *
   * Straight interpolation put it at 34 degrees a quarter of the way along and
   * 50 at the halfway point -- and handwriting turns are twenty to fifty
   * degrees, so from Light upwards nearly every one of them was already being
   * carried through as a curve. The slider had a faithful end and a smoothed
   * end with almost nothing between: turning felt assisted wherever it was set.
   *
   * So the threshold now climbs slowly through the first half of the travel and
   * quickly through the second, which gives the low settings to the range a
   * hand actually turns in.
   *
   * Squaring it outright was the first attempt and went too far the other way:
   * it dropped the default from 58 degrees to 36, and cursive at a small
   * x-height went straight back to being drawn as a run of chords -- the
   * complaint the default exists to answer. This leaves the default where it
   * was and takes the slack out of the bottom instead.
   */
  const easedTowards = towards * towards * (3 - 2 * towards);

  return {
    cornerDegrees:
      NO_SMOOTHING.cornerDegrees +
      (FULL_SMOOTHING.cornerDegrees - NO_SMOOTHING.cornerDegrees) *
        easedTowards,
    easeTowardsNeighbours: between(
      NO_SMOOTHING.easeTowardsNeighbours,
      FULL_SMOOTHING.easeTowardsNeighbours
    ),
    cornerDominance: between(
      NO_SMOOTHING.cornerDominance,
      FULL_SMOOTHING.cornerDominance
    ),
    minimumWidthFraction: NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT,
    pressureResponse: 1,
    snapToGuides: true,
  };
}

export type NotebookPenSmoothingLabel = {
  name: string;
  description: string;
};

/**
 * What the current setting is called, and what it does, in the panel.
 *
 * Named for how much smoothing is being applied, because that is what the
 * control is called. Naming the resulting line instead put the word and the
 * label in different terms, which is a thing to work out rather than read.
 *
 * Every description is about wobble and none of them about corners: those have
 * their own control now, and a label promising points or curves here would be
 * describing a slider that no longer does that.
 */
export function getNotebookPenSmoothingLabel(
  smoothingPercent: number
): NotebookPenSmoothingLabel {
  const percent = clampNotebookPenSmoothing(smoothingPercent);
  if (percent < 25) {
    return {
      name: "None",
      description: "Your line exactly as the pen reports it, tremor and all",
    };
  }
  if (percent < 50) {
    return {
      name: "Light",
      description: "Takes out fine tremor; ink stays right under the nib",
    };
  }
  if (percent < 75) {
    return {
      name: "Medium",
      description: "Steadies the line without holding the ink back",
    };
  }
  return {
    name: "Strong",
    description: "Irons out shaky lines; slow strokes may trail slightly",
  };
}

export function readNotebookPenSmoothingPreference() {
  if (typeof window === "undefined") return NOTEBOOK_PEN_SMOOTHING_DEFAULT;

  try {
    const stored = window.localStorage.getItem(
      NOTEBOOK_PEN_SMOOTHING_STORAGE_KEY
    );
    if (stored === null) return NOTEBOOK_PEN_SMOOTHING_DEFAULT;
    const parsed = Number(stored);
    return Number.isFinite(parsed)
      ? clampNotebookPenSmoothing(parsed)
      : NOTEBOOK_PEN_SMOOTHING_DEFAULT;
  } catch {
    // Storage can be unavailable in privacy modes; the default stands.
    return NOTEBOOK_PEN_SMOOTHING_DEFAULT;
  }
}

export function saveNotebookPenSmoothingPreference(percent: number) {
  try {
    window.localStorage.setItem(
      NOTEBOOK_PEN_SMOOTHING_STORAGE_KEY,
      String(clampNotebookPenSmoothing(percent))
    );
  } catch {
    // This is a non-critical, device-local preference.
  }
}

/* ------------------------------------------------------------------------ *
 * Advanced settings
 *
 * The constants behind the pen, each settable on its own behind a disclosure.
 * Every one of them is defined so that its default reproduces exactly what the
 * pen did before it existed -- these widen the range, they do not move the
 * default.
 * ------------------------------------------------------------------------ */

/**
 * What happens when the pen is held still at the end of a stroke.
 *
 * `shapes` snaps a line straight and pulls it towards the nearest 45 degrees,
 * and snaps a circle, an oval, a polygon or an arrow to its shape, levelled the
 * same way -- where shapes are allowed: the exam working sheet only straightens
 * lines. `lines` snaps lines alone and leaves their angle exactly as drawn, for
 * anyone who wants a tidied line without it also being levelled. `off` never
 * replaces what was drawn.
 */
export const NOTEBOOK_STRAIGHTEN_MODES = ["off", "lines", "shapes"] as const;
export type NotebookStraightenOnHold =
  (typeof NOTEBOOK_STRAIGHTEN_MODES)[number];

export type NotebookPenSettings = {
  /**
   * How much wobble is taken out of the line: the tremor filter on the input,
   * and the light easing of the curve drawn through it. Nothing to do with
   * corners -- see `cornerSharpnessPercent`.
   */
  smoothingPercent: number;
  /**
   * How readily a turn is kept as a point rather than carried through as a
   * curve.
   *
   * Its own setting, always. It used to follow Smoothing until it was unlinked
   * from it, which is how it read: a greyed-out control beside a Smoothing
   * slider that was really moving the corners. A hand that wants its wobble
   * filtered hard does not necessarily want its corners rounded off too.
   */
  cornerSharpnessPercent: number;
  /** How tightly the ink follows the nib, against how much noise survives. */
  trackingPercent: number;
  /** How much pen pressure is allowed to vary the width of the line. */
  pressurePercent: number;
  /*
   * There is no live-ink setting. Fast live ink (`notebook-live-ink.ts`) is
   * always on; the `fastLiveInk` and `liveInk` fields older devices saved are
   * ignored when settings are read.
   */
  straightenOnHold: NotebookStraightenOnHold;
};

/**
 * Where the corners sat while Smoothing drove them: its default read
 * backwards, so the default pen draws exactly the corners it always drew.
 */
export const NOTEBOOK_CORNER_SHARPNESS_DEFAULT =
  100 - NOTEBOOK_PEN_SMOOTHING_DEFAULT;

export const NOTEBOOK_PEN_SETTINGS_DEFAULT: NotebookPenSettings = {
  smoothingPercent: NOTEBOOK_PEN_SMOOTHING_DEFAULT,
  cornerSharpnessPercent: NOTEBOOK_CORNER_SHARPNESS_DEFAULT,
  trackingPercent: 50,
  pressurePercent: 50,
  straightenOnHold: "shapes",
};

export const NOTEBOOK_PEN_SETTINGS_STORAGE_KEY = "jami:notebook-pen-settings";

/**
 * A percentage read onto a value whose default is already spoken for.
 *
 * Each control has to pass through the measured constant at its default, or
 * the pen would change under anyone who never touched it -- so none of them is
 * a plain interpolation between two ends. Two straight runs meeting at the
 * default is the honest shape for that: no hidden curve, and the number there
 * is exactly the one the comments above it were measured against.
 */
function throughTheDefault(
  percent: number,
  at: { zero: number; atDefault: number; hundred: number },
  defaultPercent = 50
) {
  const towards = Math.max(0, Math.min(100, percent));
  return towards <= defaultPercent
    ? at.zero + (at.atDefault - at.zero) * (towards / defaultPercent)
    : at.atDefault +
        (at.hundred - at.atDefault) *
          ((towards - defaultPercent) / (100 - defaultPercent));
}

export function isNotebookStraightenOnHold(
  value: unknown
): value is NotebookStraightenOnHold {
  return (
    typeof value === "string" &&
    NOTEBOOK_STRAIGHTEN_MODES.includes(value as NotebookStraightenOnHold)
  );
}

/**
 * Every field forced back into range, whatever storage or a caller handed over.
 *
 * Takes the stored shape as well as the current one: a store written before
 * corners were separated says `null` there, meaning "follow Smoothing".
 */
export function clampNotebookPenSettings(
  settings:
    | (Partial<Omit<NotebookPenSettings, "cornerSharpnessPercent">> & {
        cornerSharpnessPercent?: number | null;
      })
    | null
    | undefined
): NotebookPenSettings {
  const percent = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.max(0, Math.min(100, value)))
      : fallback;
  const smoothingPercent = clampNotebookPenSmoothing(
    settings?.smoothingPercent ?? NOTEBOOK_PEN_SMOOTHING_DEFAULT
  );
  const hold: unknown = settings?.straightenOnHold;

  return {
    smoothingPercent,
    /*
     * Missing, or the null that used to mean "follow Smoothing", becomes the
     * number Smoothing was giving it. Anyone who never unlinked the two keeps
     * exactly the corners they had; they are simply theirs to move now.
     */
    cornerSharpnessPercent: percent(
      settings?.cornerSharpnessPercent,
      100 - smoothingPercent
    ),
    trackingPercent: percent(settings?.trackingPercent, 50),
    pressurePercent: percent(settings?.pressurePercent, 50),
    /*
     * `guided`, lines straightened and levelled, was the default before shapes
     * came, and every device that saved its settings saved it. Shapes is what
     * it grew into, and it reads as that.
     */
    straightenOnHold: isNotebookStraightenOnHold(hold)
      ? hold
      : hold === "guided"
        ? "shapes"
        : NOTEBOOK_PEN_SETTINGS_DEFAULT.straightenOnHold,
  };
}

/** Whether anything under the disclosure has been moved off its default. */
export function hasNotebookPenAdvancedChanges(settings: NotebookPenSettings) {
  return (
    settings.cornerSharpnessPercent !== NOTEBOOK_CORNER_SHARPNESS_DEFAULT ||
    settings.trackingPercent !== 50 ||
    settings.pressurePercent !== 50 ||
    settings.straightenOnHold !== NOTEBOOK_PEN_SETTINGS_DEFAULT.straightenOnHold
  );
}

/** The advanced controls back to default, leaving Smoothing where it was set. */
export function resetNotebookPenAdvancedSettings(
  settings: NotebookPenSettings
): NotebookPenSettings {
  return {
    ...NOTEBOOK_PEN_SETTINGS_DEFAULT,
    smoothingPercent: clampNotebookPenSmoothing(settings.smoothingPercent),
  };
}

/**
 * The full shaping feel, advanced settings included.
 *
 * Corner sharpness borrows the measured shaping curve read backwards rather
 * than inventing a second mapping: that curve was measured against real
 * handwriting at three sizes, and the corner threshold is the part of it those
 * measurements were mostly about. Easing comes from Smoothing, because easing
 * is what smoothing means once corners have been taken out of it.
 */
export function getNotebookPenFeelFromSettings(
  settings: NotebookPenSettings
): NotebookPenFeel {
  const safe = clampNotebookPenSettings(settings);
  const fromSmoothing = getNotebookPenFeel(safe.smoothingPercent);
  const fromCorners = getNotebookPenFeel(100 - safe.cornerSharpnessPercent);

  return {
    cornerDegrees: fromCorners.cornerDegrees,
    cornerDominance: fromCorners.cornerDominance,
    easeTowardsNeighbours: fromSmoothing.easeTowardsNeighbours,
    /*
     * Pressure is two constants, and they divide at the default.
     *
     * Below it, the variation itself is damped towards the stroke's average,
     * down to none of it at all -- which is a cheaper shape as well as a
     * steadier edge, since a stroke of one width takes the stroked path rather
     * than its own outline. Above it, the variation is pushed the other way
     * and the taper is allowed to run thinner, which is the calligraphic end.
     *
     * Splitting them is what lets the middle of the travel be exactly the pen
     * as it was: at 50 the response is 1 and the floor is where it has always
     * been, so neither half is doing anything yet.
     */
    minimumWidthFraction: throughTheDefault(safe.pressurePercent, {
      zero: NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT,
      atDefault: NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT,
      hundred: 0.12,
    }),
    pressureResponse: throughTheDefault(safe.pressurePercent, {
      zero: 0,
      atDefault: 1,
      hundred: 1.6,
    }),
    snapToGuides: safe.straightenOnHold === "shapes",
  };
}

/**
 * The input filter's settings, which are a different thing from the shaping
 * above and are worth keeping apart.
 *
 * Everything in `NotebookPenFeel` decides what shape is drawn through the
 * samples. These two decide which samples there are in the first place, before
 * anything has been shaped -- so a hand that shakes and a hand that writes fast
 * are asking for opposite things here and the same thing there.
 *
 * Both ends of both are bounded by what was already measured in
 * `notebook-ink-smoothing.ts`: `minCutoff` runs down to where the ink starts to
 * feel magnetic and no further, and `trackingPercent` runs up through the
 * measured wobble/trail table rather than past the end of it.
 */
export function getNotebookInkSmoothingOptions(
  settings: NotebookPenSettings
): NotebookInkSmoothingOptions {
  const safe = clampNotebookPenSettings(settings);

  return {
    ...NOTEBOOK_INK_SMOOTHING,
    /*
     * Smoothing is, first of all, how hard hand tremor is filtered: that is
     * the wobble a hand sees and means by the word. It was a separate "Line
     * steadiness" control while Smoothing was busy with corners; once it was
     * not, the two were the same question asked twice.
     *
     * More smoothing is a lower cutoff, so this runs backwards, and it passes
     * through the measured constant at Smoothing's own default, so the pen is
     * unchanged for anyone who has not moved it. The floor is 4 Hz rather than
     * the 2 that was tried and rejected: at 2 the ink was reported as magnetic,
     * dragged towards where it had just been, and a setting nobody should
     * choose is not a wider range.
     */
    minCutoff: throughTheDefault(
      safe.smoothingPercent,
      { zero: 20, atDefault: NOTEBOOK_INK_SMOOTHING.minCutoff, hundred: 4 },
      NOTEBOOK_PEN_SMOOTHING_DEFAULT
    ),
    /*
     * The measured trade: 0.04 leaves 0.39px of wobble and a 2.87px trail,
     * 0.25 leaves 0.67px and 0.59px. The default sits at 0.08 because half the
     * surviving wobble is where a line starts to read as grainy -- which is a
     * reason to default under it, not a reason nobody may cross it.
     */
    beta: throughTheDefault(safe.trackingPercent, {
      zero: 0.03,
      atDefault: NOTEBOOK_INK_SMOOTHING.beta,
      hundred: 0.25,
    }),
  };
}

export type NotebookPenAdvancedLabel = {
  name: string;
  description: string;
};

/**
 * What each advanced control is doing where it currently sits.
 *
 * Bare percentages would be worse than nothing here: none of these is a
 * quantity the reader can picture, and the two ends of each trade against each
 * other rather than running from less to more.
 */
export function getNotebookCornerSharpnessLabel(
  percent: number
): NotebookPenAdvancedLabel {
  if (percent < 25) {
    return {
      name: "Flowing",
      description: "Only an unmistakable point is drawn as one",
    };
  }
  if (percent < 50) {
    return { name: "Rounded", description: "Curves carry through most turns" };
  }
  if (percent < 75) {
    return { name: "Crisp", description: "Deliberate turns come to a point" };
  }
  return {
    name: "Sharp",
    description: "Almost every turn is drawn as a corner",
  };
}

export function getNotebookTrackingLabel(
  percent: number
): NotebookPenAdvancedLabel {
  if (percent < 34) {
    return {
      name: "Relaxed",
      description: "Smoothest line; fast strokes trail the nib a little",
    };
  }
  if (percent < 67) {
    return {
      name: "Balanced",
      description: "Follows the nib closely with a steady line",
    };
  }
  return {
    name: "Immediate",
    description: "Ink stays under the nib; fast strokes may look grainier",
  };
}

export function getNotebookPressureLabel(
  percent: number
): NotebookPenAdvancedLabel {
  if (percent < 20) {
    return { name: "Off", description: "One width the whole way, like a biro" };
  }
  if (percent < 45) {
    return { name: "Subtle", description: "A slight swell where you press" };
  }
  if (percent < 75) {
    return {
      name: "Natural",
      description: "Width follows pressure as a pen does",
    };
  }
  return {
    name: "Expressive",
    description: "Wide strokes thin right down, like a brush",
  };
}

export function getNotebookStraightenLabel(
  mode: NotebookStraightenOnHold
): NotebookPenAdvancedLabel {
  if (mode === "off") {
    return { name: "Off", description: "Strokes are always left as drawn" };
  }
  if (mode === "lines") {
    return {
      name: "Lines",
      description: "Hold still to snap a rough line straight, at your own angle",
    };
  }
  return {
    name: "Shapes",
    description:
      "Hold still to snap lines, circles, ovals, rectangles, triangles and arrows, levelled when they are close",
  };
}

export function readNotebookPenSettings(): NotebookPenSettings {
  if (typeof window === "undefined") return NOTEBOOK_PEN_SETTINGS_DEFAULT;

  try {
    // Anyone who set Smoothing before the advanced panel existed keeps it: the
    // old key is still the one that holds that number, and is still written.
    const smoothingPercent = readNotebookPenSmoothingPreference();
    const stored = window.localStorage.getItem(
      NOTEBOOK_PEN_SETTINGS_STORAGE_KEY
    );
    // With nothing else stored, corners were following Smoothing, so they
    // start from where Smoothing had them.
    if (stored === null) return clampNotebookPenSettings({ smoothingPercent });
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) {
      return clampNotebookPenSettings({ smoothingPercent });
    }
    return clampNotebookPenSettings({
      ...(parsed as Parameters<typeof clampNotebookPenSettings>[0]),
      smoothingPercent,
    });
  } catch {
    // Storage can be unavailable, and the stored value can be anything at all.
    return NOTEBOOK_PEN_SETTINGS_DEFAULT;
  }
}

export function saveNotebookPenSettings(settings: NotebookPenSettings) {
  const safe = clampNotebookPenSettings(settings);
  saveNotebookPenSmoothingPreference(safe.smoothingPercent);
  try {
    window.localStorage.setItem(
      NOTEBOOK_PEN_SETTINGS_STORAGE_KEY,
      JSON.stringify(safe)
    );
  } catch {
    // These are non-critical, device-local preferences.
  }
}
