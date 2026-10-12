import { inkColorForTool } from "@/lib/ink-dom/stroke-color";
import type { InkScreenMapping, InkStrokeTool } from "@/lib/ink-dom/stroke-session";
import type { NotebookEraserPointerSample } from "@/lib/workspace/notebook-eraser";
import { shouldUseNotebookPenPressure } from "@/lib/workspace/notebook-inking";
import type { NotebookInkStyle } from "@/lib/workspace/notebook-ink-types";
import type { NotebookScribbleSample } from "@/lib/workspace/notebook-scribble-erase";

/**
 * What the editor holds for the one pen contact in progress, and the small
 * pieces of it that are not about React: the tool a stroke is drawn with and
 * the raw path kept to recognise a scribble-out at the lift.
 */

type ContactBase = { pointerId: number; mapping: InkScreenMapping };

export type StrokeContact = ContactBase & {
  kind: "stroke";
  /** The last event drawn, so the next packet holds only newer samples. */
  last: PointerEvent;
  /** A stylus: ask the browser where the pen is heading. */
  predict: boolean;
  /** The nib, in page units, for judging a scribble. */
  nibWidth: number;
  /** Still recording the raw path for a scribble. */
  scribble: boolean;
};

export type EraseContact = ContactBase & {
  kind: "erase";
  /** The ring's size when the erase began, which it keeps. */
  cursorDiameter: number;
  lastSample: NotebookEraserPointerSample;
};

/** The one contact in progress. The surface holds one stroke or erase at a time. */
export type ActiveContact = StrokeContact | EraseContact;

/**
 * The tool for a pen contact, fixed when the pen lands: a style change while it
 * is down never reaches the stroke being drawn.
 */
export function inkStrokeToolFor(input: {
  tool: "pen" | "highlighter";
  pointerType: string;
  style: Pick<
    NotebookInkStyle,
    "penColor" | "penThickness" | "penSettings" | "highlighterColor" | "highlighterThickness"
  >;
  /** The browser, which decides whether a pencil sends real pressure. */
  device: { maxTouchPoints: number; platform: string; userAgent: string };
  /** Which way the highlighter's flat edge faces, asked once per accepted sample. */
  nibAngle: () => number;
  /** The page lets holding still snap shapes, not only lines (`shapesOnHold`). */
  shapesOnHold: boolean;
}): InkStrokeTool {
  const { style } = input;
  if (input.tool === "pen") {
    return {
      kind: "pen",
      color: inkColorForTool(style.penColor, "pen"),
      thickness: style.penThickness,
      pressure: shouldUseNotebookPenPressure({
        maxTouchPoints: input.device.maxTouchPoints,
        platform: input.device.platform,
        pointerType: input.pointerType,
        userAgent: input.device.userAgent,
      }),
      settings: style.penSettings,
      // A stylus only. A mouse is not writing, and touch never draws.
      predictTip: input.pointerType === "pen",
      shapes: input.shapesOnHold && style.penSettings.straightenOnHold === "shapes",
    };
  }
  return {
    kind: "highlighter",
    color: inkColorForTool(style.highlighterColor, "highlighter"),
    thickness: style.highlighterThickness,
    settings: style.penSettings,
    nibAngle: input.nibAngle,
  };
}

/**
 * Enough samples for any scribble, and a bound on the buffer.
 *
 * At roughly one per frame this is about half a minute of continuous drawing.
 * Past it the gesture has run far longer than any scribble, and a truncated
 * path cannot be judged honestly, so the stroke is simply no longer watched.
 */
export const MAX_SCRIBBLE_SAMPLES = 2048;

/**
 * A pen stroke's raw path, as x, y and time for each sample. One buffer is
 * made once and reused for every stroke, so recording a sample in a pointer
 * handler allocates nothing.
 */
export type ScribbleTrack = { data: Float64Array; count: number };

export function createScribbleTrack(): ScribbleTrack {
  return { data: new Float64Array(MAX_SCRIBBLE_SAMPLES * 3), count: 0 };
}

/** Starts a new record with the position the pen landed at. */
export function startScribbleTrack(track: ScribbleTrack, clientX: number, clientY: number, timeStamp: number) {
  track.data[0] = clientX;
  track.data[1] = clientY;
  track.data[2] = timeStamp;
  track.count = 1;
}

/** Adds a position to the record of a stroke being watched, or stops watching it once it is too long. */
export function noteScribbleSample(
  track: ScribbleTrack | null,
  stroke: { scribble: boolean },
  clientX: number,
  clientY: number,
  timeStamp: number
) {
  if (!stroke.scribble || !track) return;
  if (track.count >= MAX_SCRIBBLE_SAMPLES) {
    stroke.scribble = false;
    return;
  }
  const offset = track.count * 3;
  track.data[offset] = clientX;
  track.data[offset + 1] = clientY;
  track.data[offset + 2] = timeStamp;
  track.count += 1;
}

/** The record as the samples the scribble detector reads. Made once, at the lift. */
export function scribbleSamplesOf(track: ScribbleTrack): NotebookScribbleSample[] {
  const samples = new Array<NotebookScribbleSample>(track.count);
  for (let index = 0; index < track.count; index += 1) {
    samples[index] = {
      x: track.data[index * 3],
      y: track.data[index * 3 + 1],
      time: track.data[index * 3 + 2],
    };
  }
  return samples;
}
