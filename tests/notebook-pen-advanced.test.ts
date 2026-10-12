// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Stroke, StrokeDataPoint } from "js-draw";
import { createNotebookSmoothPenStrokeFactory } from "@/lib/workspace/notebook-smooth-pen";
import { NOTEBOOK_INK_SMOOTHING } from "@/lib/workspace/notebook-ink-smoothing";
import {
  clampNotebookPenSettings,
  getNotebookInkSmoothingOptions,
  getNotebookPenFeel,
  getNotebookPenFeelFromSettings,
  hasNotebookPenAdvancedChanges,
  NOTEBOOK_CORNER_SHARPNESS_DEFAULT,
  NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT,
  NOTEBOOK_PEN_SETTINGS_DEFAULT,
  NOTEBOOK_PEN_SETTINGS_STORAGE_KEY,
  NOTEBOOK_PEN_SMOOTHING_DEFAULT,
  NOTEBOOK_PEN_SMOOTHING_STORAGE_KEY,
  readNotebookPenSettings,
  resetNotebookPenAdvancedSettings,
  saveNotebookPenSettings,
  type NotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";
import { loadJsDraw, type JsDrawModule } from "@/lib/workspace/notebook-js-draw";

let jsDraw: JsDrawModule;

beforeAll(async () => {
  jsDraw = await loadJsDraw();
}, 120_000);

afterEach(() => {
  window.localStorage.clear();
});

const PEN_WIDTH = 3;
const viewport = {
  getSizeOfPixelOnCanvas: () => 1,
  visibleRect: { x: 0, y: 0, w: 1000, h: 1000 },
} as never;

const settings = (
  overrides: Partial<NotebookPenSettings> = {}
): NotebookPenSettings => ({ ...NOTEBOOK_PEN_SETTINGS_DEFAULT, ...overrides });

function point(x: number, y: number, width = PEN_WIDTH): StrokeDataPoint {
  return {
    pos: jsDraw.Vec2.of(x, y),
    width,
    color: jsDraw.Color4.fromString("#101010"),
    time: 0,
  };
}

function build(points: StrokeDataPoint[], from: NotebookPenSettings) {
  const builder = createNotebookSmoothPenStrokeFactory(
    jsDraw,
    getNotebookPenFeelFromSettings(from)
  )(points[0], viewport);
  for (const next of points.slice(1)) builder.addPoint(next);
  return builder.build() as Stroke;
}

/** The turn taken at each join between drawn curves, as in the smoothing tests. */
function joinTurns(stroke: Stroke) {
  const turns: number[] = [];
  let previousEnd: ReturnType<typeof jsDraw.Vec2.of> | null = null;
  let previousControl: ReturnType<typeof jsDraw.Vec2.of> | null = null;

  for (const part of stroke.getParts()[0].path.parts) {
    if (part.kind !== jsDraw.PathCommandType.CubicBezierTo) continue;
    if (previousEnd && previousControl) {
      const incoming = previousEnd.minus(previousControl).normalized();
      const outgoing = part.controlPoint1.minus(previousEnd).normalized();
      const dot = Math.max(-1, Math.min(1, incoming.dot(outgoing)));
      turns.push((Math.acos(dot) * 180) / Math.PI);
    }
    previousEnd = part.endPoint;
    previousControl = part.controlPoint2;
  }
  return turns;
}

/** A bend of the size the corner control is actually about. See the pen-feel tests. */
function bend(degrees: number) {
  const half = (degrees / 2) * (Math.PI / 180);
  return [
    ...Array.from({ length: 40 }, (_, k) =>
      point(100 - Math.cos(half) * (40 - k), 150 - Math.sin(half) * (40 - k))
    ),
    point(100, 150),
    ...Array.from({ length: 40 }, (_, k) =>
      point(100 + Math.cos(half) * (k + 1), 150 - Math.sin(half) * (k + 1))
    ),
  ];
}

describe("advanced pen settings", () => {
  it("draws exactly what it drew before, at the middle of every control", () => {
    /*
     * The whole promise of the section: opening it and closing it again cannot
     * change how the pen writes. Each control is defined to pass through the
     * constant it replaced at 50, so the defaults are not merely close to the
     * old behaviour -- they are it.
     */
    const feel = getNotebookPenFeelFromSettings(NOTEBOOK_PEN_SETTINGS_DEFAULT);
    const before = getNotebookPenFeel(NOTEBOOK_PEN_SMOOTHING_DEFAULT);

    expect(feel.cornerDegrees).toBeCloseTo(before.cornerDegrees, 10);
    expect(feel.cornerDominance).toBeCloseTo(before.cornerDominance, 10);
    expect(feel.easeTowardsNeighbours).toBeCloseTo(
      before.easeTowardsNeighbours,
      10
    );
    expect(feel.minimumWidthFraction).toBe(
      NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT
    );
    expect(feel.pressureResponse).toBe(1);
    expect(feel.snapToGuides).toBe(true);

    const filter = getNotebookInkSmoothingOptions(NOTEBOOK_PEN_SETTINGS_DEFAULT);
    expect(filter.minCutoff).toBeCloseTo(NOTEBOOK_INK_SMOOTHING.minCutoff, 10);
    expect(filter.beta).toBeCloseTo(NOTEBOOK_INK_SMOOTHING.beta, 10);
    expect(filter.derivativeCutoff).toBe(NOTEBOOK_INK_SMOOTHING.derivativeCutoff);
  });

  it("lets corners go without taking the smoothing with them", () => {
    /*
     * The reason this is a separate control. Smoothing moves the corner
     * threshold and the easing together, so a hand that wants its wobble eased
     * could not also keep its corners -- and the other way round, which is the
     * angular-writing complaint: the only way to round the turns off was to
     * turn smoothing up, which also pulls the line off the points it visited.
     */
    const eased = getNotebookPenFeelFromSettings(
      settings({ smoothingPercent: 100, cornerSharpnessPercent: 100 })
    );
    const flowing = getNotebookPenFeelFromSettings(
      settings({ smoothingPercent: 100, cornerSharpnessPercent: 0 })
    );

    // Same easing -- that is Smoothing's, and it has not moved.
    expect(eased.easeTowardsNeighbours).toBeCloseTo(
      flowing.easeTowardsNeighbours,
      10
    );
    // Different corners, which is the entire point of separating them.
    expect(eased.cornerDegrees).toBeLessThan(flowing.cornerDegrees);

    const turned = bend(60);
    expect(Math.max(0, ...joinTurns(build(turned, settings({
      smoothingPercent: 100,
      cornerSharpnessPercent: 100,
    }))))).toBeGreaterThan(50);
    expect(Math.max(0, ...joinTurns(build(turned, settings({
      smoothingPercent: 100,
      cornerSharpnessPercent: 0,
    }))))).toBeLessThan(1);
  });

  it("still keeps a deliberate point however far the corners are let go", () => {
    // A 'v' at handwriting scale. No setting in here may round this off, for
    // the same reason no Smoothing setting may: the pen would be refusing to
    // go where it was taken.
    const vee = [
      ...Array.from({ length: 14 }, (_, s) => point(20 + s * 2, 200 - s * 2)),
      ...Array.from({ length: 14 }, (_, s) => point(46 + s * 2, 174 + s * 2)),
    ];

    for (const cornerSharpnessPercent of [0, 25, 50, 75, 100]) {
      expect(
        Math.max(...joinTurns(build(vee, settings({ cornerSharpnessPercent })))),
        `sharpness ${cornerSharpnessPercent}`
      ).toBeGreaterThan(60);
    }
  });

  it("leaves the corners alone when Smoothing moves", () => {
    /*
     * The complaint this answers: Smoothing was the corner control in all but
     * name, so moving it to steady a shaky line rounded every turn off too.
     * Now it moves the tremor filter and the easing, and the corners stay
     * wherever their own control has them.
     */
    const faithful = settings({ smoothingPercent: 0 });
    const steady = settings({ smoothingPercent: 100 });

    expect(getNotebookPenFeelFromSettings(faithful).cornerDegrees).toBeCloseTo(
      getNotebookPenFeelFromSettings(steady).cornerDegrees,
      10
    );
    expect(getNotebookPenFeelFromSettings(faithful).cornerDominance).toBeCloseTo(
      getNotebookPenFeelFromSettings(steady).cornerDominance,
      10
    );
    expect(getNotebookPenFeelFromSettings(steady).easeTowardsNeighbours).toBeGreaterThan(
      getNotebookPenFeelFromSettings(faithful).easeTowardsNeighbours
    );
    expect(getNotebookInkSmoothingOptions(steady).minCutoff).toBeLessThan(
      getNotebookInkSmoothingOptions(faithful).minCutoff
    );
  });

  it("keeps the corners a store had while they followed Smoothing", () => {
    // Stores written before the split say null -- "follow Smoothing" -- or
    // nothing at all. Either way the pen must not change under its owner: the
    // corners start exactly where Smoothing was putting them.
    for (const stored of [
      { smoothingPercent: 20, cornerSharpnessPercent: null },
      { smoothingPercent: 20 },
    ]) {
      const migrated = clampNotebookPenSettings(stored);
      expect(migrated.cornerSharpnessPercent).toBe(80);
      expect(getNotebookPenFeelFromSettings(migrated).cornerDegrees).toBeCloseTo(
        getNotebookPenFeel(20).cornerDegrees,
        10
      );
    }
  });

  it("turns pressure off into one width rather than a thinner taper", () => {
    /*
     * A floor cannot do this, which is why there are two constants rather than
     * one: flooring the widths at the average only lifts the light points and
     * leaves the heavy ones heavy, so a stroke that was drawn with pressure
     * still comes out with a swell in it. Damping the variation itself is what
     * "off" has to mean.
     */
    const off = getNotebookPenFeelFromSettings(settings({ pressurePercent: 0 }));
    expect(off.pressureResponse).toBe(0);

    const varying = Array.from({ length: 40 }, (_, step) =>
      point(20 + step * 2, 100, 1 + Math.sin((step / 39) * Math.PI) * 5)
    );

    // A stroke of one width takes the stroked path rather than drawing its own
    // outline: identical on screen, and half the geometry to store and reload.
    const uniform = build(varying, settings({ pressurePercent: 0 }));
    expect(uniform.getParts()[0].style.fill.a).toBe(0);

    // With pressure on it is an outline, which is the shape a taper needs.
    const tapered = build(varying, settings({ pressurePercent: 50 }));
    expect(tapered.getParts()[0].style.fill.a).toBeGreaterThan(0);

    // The expressive end pushes both ways: more variation, and a taper allowed
    // to run further down.
    const expressive = getNotebookPenFeelFromSettings(
      settings({ pressurePercent: 100 })
    );
    expect(expressive.pressureResponse).toBeGreaterThan(1);
    expect(expressive.minimumWidthFraction).toBeLessThan(
      NOTEBOOK_MINIMUM_WIDTH_FRACTION_DEFAULT
    );
  });

  it("separates straightening from levelling", () => {
    // Holding still asks for one favour, not two: a line snapped to an angle
    // nobody drew is the part people object to.
    expect(
      getNotebookPenFeelFromSettings(settings({ straightenOnHold: "shapes" }))
        .snapToGuides
    ).toBe(true);
    expect(
      getNotebookPenFeelFromSettings(settings({ straightenOnHold: "lines" }))
        .snapToGuides
    ).toBe(false);
    expect(
      getNotebookPenFeelFromSettings(settings({ straightenOnHold: "off" }))
        .snapToGuides
    ).toBe(false);
  });

  it("moves the input filter in the direction each end promises", () => {
    const raw = getNotebookInkSmoothingOptions(settings({ smoothingPercent: 0 }));
    const steady = getNotebookInkSmoothingOptions(
      settings({ smoothingPercent: 100 })
    );
    // More smoothing is a lower cutoff, so the control reads backwards -- and
    // the floor stops short of where the ink was reported as magnetic.
    expect(raw.minCutoff).toBeGreaterThan(NOTEBOOK_INK_SMOOTHING.minCutoff);
    expect(steady.minCutoff).toBeLessThan(NOTEBOOK_INK_SMOOTHING.minCutoff);
    expect(steady.minCutoff).toBeGreaterThanOrEqual(4);

    const relaxed = getNotebookInkSmoothingOptions(
      settings({ trackingPercent: 0 })
    );
    const immediate = getNotebookInkSmoothingOptions(
      settings({ trackingPercent: 100 })
    );
    expect(relaxed.beta).toBeLessThan(NOTEBOOK_INK_SMOOTHING.beta);
    expect(immediate.beta).toBeGreaterThan(NOTEBOOK_INK_SMOOTHING.beta);
    // Past the measured table is past what anybody measured.
    expect(immediate.beta).toBeLessThanOrEqual(0.25);
  });

  it("says whether anything has been customised, and puts it all back", () => {
    expect(hasNotebookPenAdvancedChanges(NOTEBOOK_PEN_SETTINGS_DEFAULT)).toBe(
      false
    );
    // Smoothing is not an advanced setting, so moving it is not a customisation
    // this section should claim -- or undo.
    const smoothed = settings({ smoothingPercent: 10 });
    expect(hasNotebookPenAdvancedChanges(smoothed)).toBe(false);

    const customised = settings({
      smoothingPercent: 10,
      trackingPercent: 90,
      straightenOnHold: "off",
    });
    expect(hasNotebookPenAdvancedChanges(customised)).toBe(true);

    const reset = resetNotebookPenAdvancedSettings(customised);
    expect(hasNotebookPenAdvancedChanges(reset)).toBe(false);
    expect(reset.smoothingPercent).toBe(10);
  });

  it("has no live-ink setting: older devices' saved choice is ignored", () => {
    expect("liveInk" in NOTEBOOK_PEN_SETTINGS_DEFAULT).toBe(false);
    // What earlier builds saved -- the opt-in boolean, then the mode -- is dropped on read.
    const read = clampNotebookPenSettings({ fastLiveInk: false, liveInk: "classic" } as never);
    expect("liveInk" in read).toBe(false);
    expect("fastLiveInk" in read).toBe(false);
  });

  it("clamps anything storage or a caller could hand it", () => {
    const clamped = clampNotebookPenSettings({
      smoothingPercent: 140,
      cornerSharpnessPercent: -20,
      trackingPercent: Number.NaN,
      pressurePercent: 200,
      straightenOnHold: "sideways" as never,
    });

    expect(clamped.smoothingPercent).toBe(100);
    expect(clamped.cornerSharpnessPercent).toBe(0);
    expect(clamped.trackingPercent).toBe(50);
    expect(clamped.pressurePercent).toBe(100);
    expect(clamped.straightenOnHold).toBe("shapes");

    // Straighten and level, the old default every device saved, grew into shapes.
    expect(clampNotebookPenSettings({ straightenOnHold: "guided" as never }).straightenOnHold).toBe("shapes");
    expect(clampNotebookPenSettings({ straightenOnHold: "lines" }).straightenOnHold).toBe("lines");

    // Nothing stored is the default pen, corners included.
    expect(clampNotebookPenSettings({}).cornerSharpnessPercent).toBe(
      NOTEBOOK_CORNER_SHARPNESS_DEFAULT
    );
  });

  it("remembers the settings and survives a corrupted store", () => {
    expect(readNotebookPenSettings()).toEqual(NOTEBOOK_PEN_SETTINGS_DEFAULT);

    const chosen = settings({
      smoothingPercent: 30,
      cornerSharpnessPercent: 85,
      pressurePercent: 0,
      straightenOnHold: "off",
    });
    saveNotebookPenSettings(chosen);
    expect(readNotebookPenSettings()).toEqual(chosen);

    // Smoothing still lives in its own key, so a notebook opened by anything
    // that only knows about that key reads the same number.
    expect(
      window.localStorage.getItem(NOTEBOOK_PEN_SMOOTHING_STORAGE_KEY)
    ).toBe("30");

    window.localStorage.setItem(NOTEBOOK_PEN_SETTINGS_STORAGE_KEY, "{not json");
    expect(readNotebookPenSettings()).toEqual(NOTEBOOK_PEN_SETTINGS_DEFAULT);
  });

  it("keeps a Smoothing set before this section existed", () => {
    // The advanced key is absent for everybody who set Smoothing before today,
    // and that must not read as a reason to forget what they set.
    window.localStorage.setItem(NOTEBOOK_PEN_SMOOTHING_STORAGE_KEY, "12");
    // Its corners were following that Smoothing, so they start from it.
    expect(readNotebookPenSettings()).toEqual(
      settings({ smoothingPercent: 12, cornerSharpnessPercent: 88 })
    );
  });
});
