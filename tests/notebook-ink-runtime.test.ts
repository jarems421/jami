import { describe, expect, it } from "vitest";
import { NOTEBOOK_STRAIGHTEN_HOLD } from "@/lib/workspace/notebook-ink-contact";
import { relaxNotebookStraightenHold } from "@/lib/workspace/notebook-ink-runtime";

/**
 * The hold that snaps a line straight has to be one a hand can satisfy.
 *
 * js-draw wants an average speed under 8.5 screen pixels a second, which is
 * under a seventh of a pixel per frame and below what a hand resting a stylus
 * on glass does. Every time the tremor crosses it the timer restarts, so the
 * snap arrives late or never -- and it reads as "hold it for longer" rather
 * than as a threshold nobody can meet.
 */
describe("relaxNotebookStraightenHold", () => {
  it("gives the detector a threshold a resting hand can meet", () => {
    expect(NOTEBOOK_STRAIGHTEN_HOLD.maxSpeed).toBeGreaterThan(8.5);

    /*
     * Quick enough to feel like a response, and still a pause.
     *
     * A second was tried and felt broken on the iPad. The drift allowance over
     * the hold decides how slowly somebody can be writing and still snap: only
     * below `maxRadius / minTimeSeconds` pixels a second, which at sixteen is a
     * pen stopped rather than one writing slowly. What keeps a pause in the
     * middle of a word from snapping is the shape test, which never takes a
     * stroke that has doubled back on itself for a line.
     */
    const accidentalBelow =
      NOTEBOOK_STRAIGHTEN_HOLD.maxRadius / NOTEBOOK_STRAIGHTEN_HOLD.minTimeSeconds;
    expect(accidentalBelow).toBeLessThanOrEqual(16);
    expect(NOTEBOOK_STRAIGHTEN_HOLD.minTimeSeconds).toBeGreaterThanOrEqual(0.4);
    expect(NOTEBOOK_STRAIGHTEN_HOLD.minTimeSeconds).toBeLessThanOrEqual(0.6);
  });

  it("replaces the config once the stroke has begun", () => {
    const detector = { config: { maxSpeed: 8.5, maxRadius: 11, minTimeSeconds: 0.5 } };
    const pen = {
      stationaryDetector: null as typeof detector | null,
      onPointerDown() {
        this.stationaryDetector = detector;
        return true;
      },
    };

    expect(relaxNotebookStraightenHold(pen)).toBe(true);
    expect(pen.onPointerDown()).toBe(true);
    expect(pen.stationaryDetector!.config.maxSpeed).toBe(
      NOTEBOOK_STRAIGHTEN_HOLD.maxSpeed
    );
    expect(pen.stationaryDetector!.config.minTimeSeconds).toBe(
      NOTEBOOK_STRAIGHTEN_HOLD.minTimeSeconds
    );
  });

  it("says so rather than throwing when js-draw has moved on", () => {
    // A patch on somebody else's internals should fail loudly at the seam, not
    // silently leave the hold unreachable.
    expect(relaxNotebookStraightenHold({})).toBe(false);
  });

  it("leaves a stroke that never starts one alone", () => {
    const pen = { stationaryDetector: null, onPointerDown: () => undefined };
    expect(relaxNotebookStraightenHold(pen)).toBe(true);
    expect(() => pen.onPointerDown()).not.toThrow();
  });
});
