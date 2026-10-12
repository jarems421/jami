import type { NotebookInkTool } from "@/lib/workspace/notebook-ink-types";

export function installNotebookNativeInkGuards(
  surface: HTMLElement,
  shouldSuppress: (event: PointerEvent) => boolean
) {
  const suppressNativeGesture = (event: PointerEvent) => {
    if (event.cancelable && shouldSuppress(event)) {
      event.preventDefault();
    }
  };
  const listenerOptions: AddEventListenerOptions = {
    capture: true,
    passive: false,
  };

  surface.addEventListener(
    "pointerdown",
    suppressNativeGesture,
    listenerOptions
  );
  surface.addEventListener(
    "pointermove",
    suppressNativeGesture,
    listenerOptions
  );

  return () => {
    surface.removeEventListener(
      "pointerdown",
      suppressNativeGesture,
      listenerOptions
    );
    surface.removeEventListener(
      "pointermove",
      suppressNativeGesture,
      listenerOptions
    );
  };
}

export type NotebookInkPointerEventType =
  | "pointerdown"
  | "pointermove"
  | "pointerup"
  | "pointercancel";

export function shouldContinueNotebookPrecisionGesture(input: {
  activePointerId?: number;
  pointerId: number;
  type: NotebookInkPointerEventType;
}) {
  return (
    input.type !== "pointerdown" && input.activePointerId === input.pointerId
  );
}

/**
 * The `buttons` bit a pen sets while its eraser is in contact.
 *
 * From the Pointer Events spec, and what Windows reports for the eraser end
 * of a Surface Pen or a Wacom stylus, and for the eraser button some pens
 * carry on the barrel instead.
 */
export const NOTEBOOK_PEN_ERASER_BUTTONS = 32;

/**
 * The tool a new contact works with.
 *
 * The selected one, unless the pen has been turned over: its eraser end
 * erases whatever is selected, as it does on paper and in every note app on
 * the machines these pens come with. Turned back, the pen writes again with
 * nothing to reselect -- the choice is made per contact, never saved.
 */
export function getNotebookContactTool(input: {
  activeTool: NotebookInkTool;
  buttons: number;
  pointerType: string;
}): NotebookInkTool {
  return input.pointerType === "pen" &&
    (input.buttons & NOTEBOOK_PEN_ERASER_BUTTONS) !== 0
    ? "eraser"
    : input.activeTool;
}

export function shouldUseNotebookPrecisionGesture(input: {
  continuing: boolean;
  precisionEraserSelected: boolean;
}) {
  return input.continuing || input.precisionEraserSelected;
}

export function shouldExpectNotebookCaptureLoss(
  type: NotebookInkPointerEventType,
  hadPointerCapture: boolean
) {
  return hadPointerCapture || type === "pointercancel";
}

/**
 * The two origins an eraser pointer has to be measured from.
 *
 * They are the same element on a fitted page and different ones as soon as it
 * is zoomed, which is why they cannot stay a single offset.
 *
 * `surface` places the cursor ring, a DOM element inside the ink surface, so it
 * has to be measured from that surface. `region` feeds js-draw's
 * `screenToCanvas`, which measures from js-draw's own rendering region -- and
 * on a zoomed page the ink canvas is given only the visible slice of the sheet
 * and positioned at that slice's origin. Measuring erase geometry from the
 * full-sheet surface counted the slice offset twice and rubbed out ink a window
 * away from the nib.
 */
export type NotebookInkPointerOrigins = {
  surface: { left: number; top: number };
  region: { left: number; top: number };
};

export function getNotebookInkPointerOrigins(
  surface: HTMLElement,
  region: HTMLElement | null
): NotebookInkPointerOrigins {
  const surfaceRect = surface.getBoundingClientRect();
  const regionRect = region ? region.getBoundingClientRect() : surfaceRect;
  return {
    surface: { left: surfaceRect.left, top: surfaceRect.top },
    region: { left: regionRect.left, top: regionRect.top },
  };
}

export function positionNotebookEraserCursor(input: {
  clientX: number;
  clientY: number;
  cursor: HTMLElement;
  cursorDiameter: number;
  previousDiameter: number | null;
  surfaceLeft: number;
  surfaceTop: number;
}) {
  if (input.previousDiameter !== input.cursorDiameter) {
    input.cursor.style.width = `${input.cursorDiameter}px`;
    input.cursor.style.height = `${input.cursorDiameter}px`;
  }
  const left =
    input.clientX - input.surfaceLeft - input.cursorDiameter / 2;
  const top = input.clientY - input.surfaceTop - input.cursorDiameter / 2;
  input.cursor.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  input.cursor.style.opacity = "1";
  return input.cursorDiameter;
}

/**
 * How still a hand actually is, and how long it has to stay that way, before a
 * stroke snaps straight (`InkHoldDetector`, and js-draw's detector behind the
 * fallback).
 *
 * Four tenths of a second, held within six screen pixels. A full second was
 * tried and felt broken on the iPad: the snap seemed to come when it wanted
 * to, and mostly not at all; half a second was right but slow to come once a
 * hand knew it, and 13 October took it to 0.4. What stops a snap in the middle
 * of a word is not a long wait but the shape tests (`straightenedShape`,
 * `recognizeInkShape`): a stroke that has doubled back on itself, as
 * handwriting does, is never taken for a line, and nothing letter-sized is
 * taken for a shape.
 */
export const NOTEBOOK_STRAIGHTEN_HOLD = {
  /**
   * Screen pixels a second, averaged: js-draw's own test, for the fallback
   * editor only. Jami Ink's detector judges drift alone (see
   * `lib/ink-dom/hold-detector.ts` for why).
   */
  maxSpeed: 25,
  /**
   * How far the tip may drift from where it stopped, in screen pixels: room for
   * a hand pressing down on the glass, not for a stroke. Writing slower than
   * fifteen pixels a second for the hold's 0.4 seconds is a pause, not
   * writing; a shorter hold had to take a smaller radius to keep that true.
   */
  maxRadius: 6,
  minTimeSeconds: 0.4,
};
