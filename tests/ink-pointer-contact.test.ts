import { describe, expect, it } from "vitest";
import {
  createScribbleTrack,
  inkStrokeToolFor,
  MAX_SCRIBBLE_SAMPLES,
  noteScribbleSample,
  scribbleSamplesOf,
  startScribbleTrack,
} from "@/lib/ink-dom/pointer-contact";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";

const style = {
  penColor: "black" as const,
  penThickness: 3,
  penSettings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
  highlighterColor: "yellow" as const,
  highlighterThickness: 18,
};
const ipad = { maxTouchPoints: 5, platform: "iPad", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X)" };
const desktop = { maxTouchPoints: 0, platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const nibAngle = () => 1.2;

describe("inkStrokeToolFor", () => {
  it("builds the pen from the selected colour, width and settings, as the stylus it is drawn with", () => {
    const tool = inkStrokeToolFor({ tool: "pen", pointerType: "pen", style, device: ipad, nibAngle, shapesOnHold: true });
    expect(tool).toEqual({
      kind: "pen",
      color: { r: 0x11, g: 0x18, b: 0x27, a: 1 },
      thickness: 3,
      pressure: true,
      settings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
      predictTip: true,
      shapes: true,
    });
  });

  it("snaps shapes on a hold only where the page allows them and the settings ask for them", () => {
    const pen = (shapesOnHold: boolean, straightenOnHold: "off" | "lines" | "shapes") =>
      inkStrokeToolFor({
        tool: "pen",
        pointerType: "pen",
        style: { ...style, penSettings: { ...NOTEBOOK_PEN_SETTINGS_DEFAULT, straightenOnHold } },
        device: ipad,
        nibAngle,
        shapesOnHold,
      });
    expect(pen(true, "shapes")).toMatchObject({ shapes: true });
    // The exam working sheet: lines straighten, nothing becomes a shape.
    expect(pen(false, "shapes")).toMatchObject({ shapes: false });
    expect(pen(true, "lines")).toMatchObject({ shapes: false });
    expect(pen(true, "off")).toMatchObject({ shapes: false });
  });

  it("reads no pressure from a mouse, and predicts no tip for it", () => {
    const tool = inkStrokeToolFor({ tool: "pen", pointerType: "mouse", style, device: desktop, nibAngle, shapesOnHold: true });
    expect(tool).toMatchObject({ kind: "pen", pressure: false, predictTip: false });
  });

  it("builds the highlighter translucent, with the live nib angle", () => {
    const tool = inkStrokeToolFor({ tool: "highlighter", pointerType: "pen", style, device: ipad, nibAngle, shapesOnHold: true });
    expect(tool).toMatchObject({
      kind: "highlighter",
      thickness: 18,
      settings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
    });
    if (tool.kind !== "highlighter") throw new Error("expected a highlighter");
    expect(tool.color.a).toBeCloseTo(107 / 255, 6);
    expect(tool.nibAngle()).toBe(1.2);
  });
});

describe("the scribble record", () => {
  it("keeps x, y and time for each sample and reads them back in order", () => {
    const track = createScribbleTrack();
    const stroke = { scribble: true };
    startScribbleTrack(track, 10, 20, 100);
    noteScribbleSample(track, stroke, 11, 21, 108);
    noteScribbleSample(track, stroke, 12, 22, 116);
    expect(scribbleSamplesOf(track)).toEqual([
      { x: 10, y: 20, time: 100 },
      { x: 11, y: 21, time: 108 },
      { x: 12, y: 22, time: 116 },
    ]);
  });

  it("starts again from nothing for the next stroke", () => {
    const track = createScribbleTrack();
    startScribbleTrack(track, 1, 2, 3);
    noteScribbleSample(track, { scribble: true }, 4, 5, 6);
    startScribbleTrack(track, 7, 8, 9);
    expect(scribbleSamplesOf(track)).toEqual([{ x: 7, y: 8, time: 9 }]);
  });

  it("records nothing for a stroke that is not being watched", () => {
    const track = createScribbleTrack();
    startScribbleTrack(track, 1, 2, 3);
    noteScribbleSample(track, { scribble: false }, 4, 5, 6);
    noteScribbleSample(null, { scribble: true }, 4, 5, 6);
    expect(track.count).toBe(1);
  });

  it("stops watching a stroke that runs past any scribble's length, and keeps what it had", () => {
    const track = createScribbleTrack();
    const stroke = { scribble: true };
    startScribbleTrack(track, 0, 0, 0);
    for (let index = 1; index < MAX_SCRIBBLE_SAMPLES; index += 1) {
      noteScribbleSample(track, stroke, index, index, index);
    }
    expect(track.count).toBe(MAX_SCRIBBLE_SAMPLES);
    expect(stroke.scribble).toBe(true);

    noteScribbleSample(track, stroke, -1, -1, -1);
    expect(stroke.scribble).toBe(false);
    expect(track.count).toBe(MAX_SCRIBBLE_SAMPLES);
  });
});
