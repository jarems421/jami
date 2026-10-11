import { describe, expect, it } from "vitest";
import {
  NOTEBOOK_PREDICTED_TIP,
  NotebookPredictedTip,
  type NotebookPredictedTipSample,
} from "@/lib/workspace/notebook-predicted-tip";

/** A pen moving right at `speed` px per ms, a Pencil sample every 4ms. */
function moving(speed = 0.4, count = 6): NotebookPredictedTipSample[] {
  return Array.from({ length: count }, (_, index) => ({
    x: 100 + speed * index * 4,
    y: 200,
    time: index * 4,
  }));
}

function tracking(samples: NotebookPredictedTipSample[]) {
  const tip = new NotebookPredictedTip();
  tip.observe(samples);
  const newest = samples[samples.length - 1];
  return { tip, newest };
}

describe("the predicted tip", () => {
  it("follows the browser's prediction while it agrees with the pen", () => {
    const { tip, newest } = tracking(moving());
    const ahead = tip.ahead([
      { x: newest.x + 1.6, y: 200.2, time: newest.time + 4 },
      { x: newest.x + 3.2, y: 200.4, time: newest.time + 8 },
    ]);
    expect(ahead).toEqual([
      { x: newest.x + 1.6, y: 200.2 },
      { x: newest.x + 3.2, y: 200.4 },
    ]);
  });

  it("never reaches further than the pen could plausibly have gone", () => {
    // Chrome, fed a burst of unevenly timed samples, was seen predicting the
    // pen 865px ahead within 25ms. Cut back to a little over the pen's own
    // recent speed for the longest a tip may cover.
    const { tip, newest } = tracking(moving(0.4));
    const ahead = tip.ahead([
      { x: newest.x + 865, y: 200, time: newest.time + 10 },
    ]);
    expect(ahead).toHaveLength(1);
    const reach = ahead[0].x - newest.x;
    expect(reach).toBeCloseTo(
      0.4 * NOTEBOOK_PREDICTED_TIP.maxAheadMs * NOTEBOOK_PREDICTED_TIP.speedAllowance,
      6
    );
    expect(ahead[0].y).toBe(200);
  });

  it("caps a fast stroke's tip at a fixed length on screen", () => {
    const { tip, newest } = tracking(moving(2));
    const ahead = tip.ahead([
      { x: newest.x + 30, y: 200, time: newest.time + 9 },
    ]);
    expect(ahead[0].x - newest.x).toBeCloseTo(
      NOTEBOOK_PREDICTED_TIP.maxLengthPx,
      6
    );
  });

  it("stops where a prediction turns back against the pen", () => {
    const { tip, newest } = tracking(moving());
    const ahead = tip.ahead([
      { x: newest.x + 1.6, y: 200, time: newest.time + 4 },
      // A reversal the pen has not made yet: drawing it would put ink where
      // the line has already been, ahead of nothing.
      { x: newest.x - 5, y: 200, time: newest.time + 8 },
      { x: newest.x + 6, y: 200, time: newest.time + 12 },
    ]);
    expect(ahead).toEqual([{ x: newest.x + 1.6, y: 200 }]);
  });

  it("uses no prediction from further ahead than it can trust", () => {
    const { tip, newest } = tracking(moving());
    const ahead = tip.ahead(
      [4, 8, 12, 16, 20, 24].map((ms) => ({
        x: newest.x + 0.4 * ms,
        y: 200,
        time: newest.time + ms,
      }))
    );
    // Up to 20ms ahead is used; 24 is past `maxAheadMs`.
    expect(NOTEBOOK_PREDICTED_TIP.maxAheadMs).toBeLessThan(24);
    const reaches = ahead.map((point) => point.x - newest.x);
    expect(reaches).toHaveLength(5);
    [1.6, 3.2, 4.8, 6.4, 8].forEach((expected, index) =>
      expect(reaches[index]).toBeCloseTo(expected, 6)
    );
  });

  it("ignores a prediction that swerves off the way the pen is going", () => {
    const { tip, newest } = tracking(moving());
    // Gently off the line is the line; a third of a right angle is a turn
    // the pen has not made -- the flick seen at the top of an 'm'.
    expect(
      tip.ahead([
        { x: newest.x + 1.6, y: 200.2, time: newest.time + 4 },
        { x: newest.x + 2.4, y: 201.6, time: newest.time + 8 },
      ])
    ).toEqual([{ x: newest.x + 1.6, y: 200.2 }]);
  });

  it("stands down while the pen is turning, and less in a gentle curve", () => {
    /** Round a circle of `radius` at 0.4 px/ms, a sample every 4ms. */
    const turning = (radius: number) =>
      Array.from({ length: 8 }, (_, index) => {
        const angle = (0.4 * index * 4) / radius;
        return {
          x: 100 + radius * Math.sin(angle),
          y: 200 - radius * Math.cos(angle),
          time: index * 4,
        };
      });
    /** The tip for a prediction well past any reach, straight on along the circle. */
    const ahead = (radius: number) => {
      const samples = turning(radius);
      const { tip, newest } = tracking(samples);
      const angle = (0.4 * 7 * 4) / radius;
      const predicted = {
        x: newest.x + 20 * Math.cos(angle),
        y: newest.y + 20 * Math.sin(angle),
        time: newest.time + 8,
      };
      const points = tip.ahead([predicted]);
      return points.length
        ? Math.hypot(points[0].x - newest.x, points[0].y - newest.y)
        : 0;
    };
    // What a straight run at this speed is allowed.
    const straight = Math.min(
      NOTEBOOK_PREDICTED_TIP.maxLengthPx,
      0.4 * NOTEBOOK_PREDICTED_TIP.maxAheadMs * NOTEBOOK_PREDICTED_TIP.speedAllowance
    );
    // The round of a small letter turns faster than any prediction can be
    // trusted through: about 37 degrees per 10ms here.
    expect(ahead(6)).toBe(0);
    // A wide curve keeps a tip, shortened for the turn it is in.
    const gentle = ahead(60);
    expect(gentle).toBeGreaterThan(straight * 0.5);
    expect(gentle).toBeLessThan(straight * 0.95);
  });

  it("draws nothing for a pen that is all but still", () => {
    // A resting nib has nothing to lead; its tremor would only make a tip
    // flicker round the end of the line.
    const still = Array.from({ length: 6 }, (_, index) => ({
      x: 100 + (index % 2) * 0.05,
      y: 200,
      time: index * 4,
    }));
    const { tip, newest } = tracking(still);
    expect(
      tip.ahead([{ x: newest.x + 3, y: 200, time: newest.time + 8 }])
    ).toEqual([]);
  });

  it("draws nothing without history or without a prediction", () => {
    const fresh = new NotebookPredictedTip();
    fresh.observe([{ x: 100, y: 200, time: 0 }]);
    expect(fresh.ahead([{ x: 104, y: 200, time: 8 }])).toEqual([]);

    const { tip } = tracking(moving());
    expect(tip.ahead([])).toEqual([]);
  });

  it("reads the pen's direction over a frame, not one noisy sample", () => {
    // The newest sample wobbles back half a pixel. Over the last 4ms that
    // reads as the pen reversing; over a frame it is plainly still moving
    // right, which is what it is doing.
    const samples = [...moving(0.4, 5), { x: 106, y: 200, time: 20 }];
    const { tip, newest } = tracking(samples);
    expect(
      tip.ahead([{ x: newest.x + 2, y: 200, time: newest.time + 4 }])
    ).toEqual([{ x: newest.x + 2, y: 200 }]);
  });

  it("starts each contact afresh", () => {
    const { tip } = tracking(moving());
    tip.reset();
    tip.observe([{ x: 400, y: 50, time: 1000 }]);
    expect(tip.ahead([{ x: 410, y: 50, time: 1008 }])).toEqual([]);
  });

  it("ignores samples that arrive out of order", () => {
    const { tip, newest } = tracking(moving());
    // An overlapping packet replaying old movement must not become the
    // newest position, or the tip would jump back to it.
    tip.observe([{ x: 20, y: 600, time: 2 }]);
    expect(
      tip.ahead([{ x: newest.x + 1.6, y: 200, time: newest.time + 4 }])
    ).toEqual([{ x: newest.x + 1.6, y: 200 }]);
  });

  it("drops anything that is not a number", () => {
    const samples = moving();
    const newest = samples[samples.length - 1];
    const { tip } = tracking([...samples, { x: Number.NaN, y: 200, time: 24 }]);
    expect(
      tip.ahead([
        { x: newest.x + 1.6, y: 200, time: newest.time + 4 },
        { x: Number.POSITIVE_INFINITY, y: 200, time: newest.time + 8 },
      ])
    ).toEqual([{ x: newest.x + 1.6, y: 200 }]);
  });
});
