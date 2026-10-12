import { describe, expect, it } from "vitest";
import {
  initialInkRuler,
  inkRulerDegrees,
  inkRulerEdgeNear,
  isOnInkRuler,
  projectOntoInkRulerEdge,
  settleInkRulerAngle,
  slideInkRuler,
  twistInkRuler,
  type InkRuler,
} from "@/lib/ink/tools/ruler";
import { InkStrokeSession, inkColorForTool, type InkLiveSink } from "@/lib/ink-dom/stroke-session";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";

const FLAT: InkRuler = { cx: 400, cy: 300, angle: 0, length: 600, width: 60 };
const degrees = (value: number) => (value * Math.PI) / 180;

describe("the ruler's geometry", () => {
  it("starts flat across the middle of the page", () => {
    const ruler = initialInkRuler({ width: 900, height: 1240 });
    expect(ruler).toMatchObject({ cx: 450, cy: 620, angle: 0 });
    expect(ruler.length).toBeLessThan(900);
  });

  it("finds the edge a stroke lands by, and none beyond its reach or its ends", () => {
    // The top edge is at y 270, the bottom at 330.
    expect(inkRulerEdgeNear(FLAT, { x: 400, y: 262 }, 16)?.y).toBeCloseTo(270);
    expect(inkRulerEdgeNear(FLAT, { x: 400, y: 336 }, 16)?.y).toBeCloseTo(330);
    expect(inkRulerEdgeNear(FLAT, { x: 400, y: 240 }, 16)).toBeNull();
    expect(inkRulerEdgeNear(FLAT, { x: 750, y: 268 }, 16)).toBeNull();
  });

  it("puts a point on the edge, straight across it", () => {
    const edge = inkRulerEdgeNear(FLAT, { x: 400, y: 262 }, 16)!;
    expect(projectOntoInkRulerEdge(edge, { x: 523, y: 259 })).toEqual({ x: 523, y: 270 });
  });

  it("knows its own body", () => {
    expect(isOnInkRuler(FLAT, { x: 690, y: 300 })).toBe(true);
    expect(isOnInkRuler(FLAT, { x: 710, y: 300 })).toBe(false);
    expect(isOnInkRuler(FLAT, { x: 400, y: 340 }, 12)).toBe(true);
  });

  it("slides with one finger and turns about two, settling on every 15 degrees", () => {
    expect(slideInkRuler(FLAT, { x: 0, y: 0 }, { x: 30, y: -10 })).toMatchObject({ cx: 430, cy: 290, angle: 0 });

    const before: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 300, y: 300 }, { x: 500, y: 300 }];
    const turn = (angle: number) => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return [
        { x: 400 - 100 * c, y: 300 - 100 * s },
        { x: 400 + 100 * c, y: 300 + 100 * s },
      ] as [{ x: number; y: number }, { x: number; y: number }];
    };
    const free = twistInkRuler(FLAT, before, turn(degrees(37)));
    expect(inkRulerDegrees(free.angle)).toBe(37);
    expect(free.cx).toBeCloseTo(400);
    expect(free.cy).toBeCloseTo(300);
    expect(twistInkRuler(FLAT, before, turn(degrees(44))).angle).toBeCloseTo(degrees(45));
    expect(settleInkRulerAngle(degrees(31))).toBeCloseTo(degrees(30));
    expect(settleInkRulerAngle(degrees(33))).toBeCloseTo(degrees(33));
    expect(inkRulerDegrees(degrees(-30))).toBe(150);
  });
});

describe("drawing along the ruler", () => {
  const sink = (): InkLiveSink & { paths: unknown[] } => {
    const paths: unknown[] = [];
    return { paths, beginLive: () => undefined, drawLive: (path) => paths.push(path), cancelLive: () => undefined };
  };
  const pen = {
    kind: "pen" as const,
    color: inkColorForTool("black", "pen"),
    thickness: 4,
    pressure: false,
    settings: { ...NOTEBOOK_PEN_SETTINGS_DEFAULT, straightenOnHold: "off" as const },
    predictTip: false,
    shapes: false,
  };
  const wobblyAlong = (y: number) =>
    Array.from({ length: 40 }, (_, index) => ({
      clientX: 120 + index * 8,
      clientY: y + Math.sin(index) * 5,
      pressure: 0.5,
      timeStamp: 4 + index * 4,
    }));
  const mapping = { left: 0, top: 0, scale: 1 };
  const ys = (path: unknown) =>
    (path as Array<{ op: string; y?: number; y1?: number; y2?: number }>).flatMap((command) =>
      command.op === "Z" ? [] : [command.y, command.y1, command.y2].filter((value): value is number => value !== undefined)
    );

  it("holds a stroke landing by an edge to that edge, however the hand wanders", () => {
    const live = sink();
    const session = new InkStrokeSession({
      tool: pen,
      mapping,
      sink: live,
      first: { clientX: 112, clientY: 262, pressure: 0.5, timeStamp: 0 },
      ruler: FLAT,
    });
    session.move(wobblyAlong(262));
    const result = session.lift();
    for (const y of ys(result?.path)) expect(y).toBeCloseTo(270, 6);
  });

  it("leaves a stroke that lands away from the ruler as drawn", () => {
    const session = new InkStrokeSession({
      tool: pen,
      mapping,
      sink: sink(),
      first: { clientX: 112, clientY: 200, pressure: 0.5, timeStamp: 0 },
      ruler: FLAT,
    });
    session.move(wobblyAlong(200));
    const spread = ys(session.lift()?.path);
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(3);
  });
});
