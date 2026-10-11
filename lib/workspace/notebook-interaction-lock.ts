export const NOTEBOOK_EDITOR_LOCK_BODY_CLASS = "jami-notebook-editor-active";
/**
 * On the body while a notebook (not a revision session or an exam sheet) is
 * open. A notebook covers the screen with its own opaque surface, so the
 * stylesheet switches off the photo background under it (see app/globals.css).
 */
export const NOTEBOOK_OPEN_BODY_CLASS = "jami-notebook-open";
export const NOTEBOOK_TEXT_EDITOR_SELECTOR =
  ".notebook-text-editor, [data-notebook-text-editor='true']";
export const NOTEBOOK_STYLUS_ACTION_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "label[for]",
  "summary",
  "[role='button']",
  "[role='menuitem']",
  "[role='slider']",
  "[data-notebook-stylus-action='true']",
].join(", ");
/** Controls that are dragged rather than tapped, so a Pencil on them is a gesture. */
export const NOTEBOOK_STYLUS_GESTURE_CONTROL_SELECTOR =
  "[data-text-resize-handle='true'], [data-text-block-move-handle='true']";

type ClosestTarget = {
  closest: (selector: string) => unknown;
};

function hasClosest(value: unknown): value is ClosestTarget {
  return (
    value !== null &&
    typeof value === "object" &&
    "closest" in value &&
    typeof (value as { closest?: unknown }).closest === "function"
  );
}

/** Form fields that are not part of the page itself: a dialog's, the Tutor's, a menu's. */
const NOTEBOOK_FORM_FIELD_SELECTOR = "input, textarea, select, [contenteditable='true']";
const NOTEBOOK_PAGE_SURFACE_SELECTOR = ".notebook-page-surface";

/**
 * Whether typing and selecting here is text editing the notebook must leave alone.
 *
 * Only the page's own text boxes used to count, so a field anywhere else --
 * the graph editor's equation box above all -- was treated as the page: its
 * letters ran the tool shortcuts, typing "tan x" switched to the text tool and
 * then the eraser, and each switch moved focus away from the field mid-word.
 */
export function isNotebookTextEditingTarget(target: EventTarget | null) {
  if (!hasClosest(target)) return false;
  if (target.closest(NOTEBOOK_TEXT_EDITOR_SELECTOR)) return true;
  return Boolean(target.closest(NOTEBOOK_FORM_FIELD_SELECTOR)) && !target.closest(NOTEBOOK_PAGE_SURFACE_SELECTOR);
}

/**
 * Text that is there to be read and copied, off the page: the Tutor's answers.
 *
 * The notebook cancels native selection everywhere that is not a text field, so
 * a stray drag cannot highlight the toolbar or the page. That swept up the
 * Tutor too, and an answer could not be copied into a text box on the very page
 * it was about. Marking the region opts it back in to selecting and copying,
 * without making it count as editing -- its letters still are not typing.
 */
export const NOTEBOOK_SELECTABLE_TEXT_SELECTOR = "[data-notebook-selectable-text='true']";

/** A text node has no `closest`; the element holding it answers for it. */
function toElementTarget(target: unknown) {
  if (
    target !== null &&
    typeof target === "object" &&
    (target as { nodeType?: unknown }).nodeType === 3
  ) {
    return (target as { parentElement?: unknown }).parentElement ?? null;
  }
  return target;
}

export function isNotebookSelectableTextTarget(target: unknown) {
  const element = toElementTarget(target);
  if (!hasClosest(element)) return false;
  return (
    Boolean(element.closest(NOTEBOOK_SELECTABLE_TEXT_SELECTOR)) &&
    !element.closest(NOTEBOOK_PAGE_SURFACE_SELECTOR)
  );
}

/**
 * Controls inside the page should retain native tap/click behavior for Apple
 * Pencil. Resize handles are deliberately excluded: they are continuous page
 * gestures and still need the iPad navigation guard.
 */
export function isNotebookStylusActionTarget(target: EventTarget | null) {
  if (!hasClosest(target)) return false;
  if (target.closest(NOTEBOOK_STYLUS_GESTURE_CONTROL_SELECTOR)) return false;
  return Boolean(target.closest(NOTEBOOK_STYLUS_ACTION_SELECTOR));
}

export function isTextResizeHandleTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-text-resize-handle='true']"))
  );
}

export function safelySetPointerCapture(
  element: HTMLElement,
  pointerId: number
) {
  try {
    if (!element.hasPointerCapture(pointerId)) {
      element.setPointerCapture(pointerId);
    }
    return true;
  } catch {
    // Pointer capture is optional and can be rejected by Safari mid-gesture.
    return false;
  }
}

export function safelyReleasePointerCapture(
  element: HTMLElement,
  pointerId: number
) {
  try {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Safari can drop capture during rapid stylus re-contact; cleanup should continue.
  }
}

export function shouldSuppressNotebookStylusTouch(input: {
  inkInteractionActive: boolean;
  stylusTouch: boolean;
  target: EventTarget | null;
}) {
  if (
    isNotebookTextEditingTarget(input.target) ||
    isNotebookStylusActionTarget(input.target)
  ) {
    return false;
  }
  return input.inkInteractionActive || input.stylusTouch;
}

export function isNotebookStylusTouchEvent(
  event: Pick<TouchEvent, "touches" | "changedTouches">
) {
  const touches =
    event.touches.length > 0 ? event.touches : event.changedTouches;
  for (let index = 0; index < touches.length; index += 1) {
    if ((touches[index] as Touch & { touchType?: string }).touchType === "stylus") {
      return true;
    }
  }
  return false;
}

/**
 * Installs the non-passive capture listeners required to stop iPadOS Safari
 * from turning bare-page Pencil movement into a native navigation gesture.
 * Text editors and interactive controls remain native through
 * shouldSuppressNotebookStylusTouch.
 */
export function installNotebookStylusTouchListeners(input: {
  surface: EventTarget;
  getInkInteractionActive: () => boolean;
}) {
  const suppressStylusGesture: EventListener = (event) => {
    if (
      typeof TouchEvent === "undefined" ||
      !(event instanceof TouchEvent) ||
      !event.cancelable
    ) {
      return;
    }
    if (
      shouldSuppressNotebookStylusTouch({
        inkInteractionActive: input.getInkInteractionActive(),
        stylusTouch: isNotebookStylusTouchEvent(event),
        target: event.target,
      })
    ) {
      event.preventDefault();
    }
  };
  const listenerOptions: AddEventListenerOptions = {
    passive: false,
    capture: true,
  };

  input.surface.addEventListener(
    "touchstart",
    suppressStylusGesture,
    listenerOptions
  );
  input.surface.addEventListener(
    "touchmove",
    suppressStylusGesture,
    listenerOptions
  );

  return () => {
    input.surface.removeEventListener(
      "touchstart",
      suppressStylusGesture,
      listenerOptions
    );
    input.surface.removeEventListener(
      "touchmove",
      suppressStylusGesture,
      listenerOptions
    );
  };
}

/**
 * Refuses the browser's own pinch zoom while the notebook editor is open.
 *
 * iPadOS Safari zooms the visual viewport whenever a pinch starts somewhere the
 * app has not claimed the gesture -- the margin around the sheet, most
 * obviously. That is a second zoom sitting on top of the notebook's own, with
 * its own scale and its own idea of where the page is, so the editor takes the
 * gesture off it entirely and leaves page zoom to the sheet.
 *
 * These `gesture*` events are Safari's own, and they fire for nothing but a
 * pinch or a rotate, so refusing all of them costs no other interaction.
 * Elsewhere `touch-action: none` on the page frame does the same job.
 */
export function installNotebookViewportZoomBlock(surface: EventTarget) {
  const blockPinch: EventListener = (event) => {
    if (!event.cancelable) return;
    event.preventDefault();
  };
  const listenerOptions: AddEventListenerOptions = {
    passive: false,
    capture: true,
  };
  const gestureEvents = ["gesturestart", "gesturechange", "gestureend"];

  for (const type of gestureEvents) {
    surface.addEventListener(type, blockPinch, listenerOptions);
  }
  return () => {
    for (const type of gestureEvents) {
      surface.removeEventListener(type, blockPinch, listenerOptions);
    }
  };
}

export function shouldSuppressNotebookNativeEvent(target: EventTarget | null) {
  const element = toElementTarget(target) as EventTarget | null;
  return !isNotebookTextEditingTarget(element) && !isNotebookSelectableTextTarget(element);
}

export function shouldSuppressNotebookNativeInkPointer(input: {
  activeTool: string;
  pointerType: string;
  readOnly: boolean;
}) {
  return (
    !input.readOnly &&
    input.activeTool !== "text" &&
    input.pointerType === "pen"
  );
}

export function clearNotebookNativeSelection(documentRef: {
  getSelection: () => { rangeCount: number; removeAllRanges: () => void } | null;
}) {
  const selection = documentRef.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  selection.removeAllRanges();
  return true;
}
