export const NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY = "jami:notebook-toolbar-dock";
export const NOTEBOOK_TOOLBAR_DRAG_THRESHOLD = 4;
export const NOTEBOOK_TOOLBAR_ACTION_DRAG_THRESHOLD = 8;
export const NOTEBOOK_TOOLBAR_DOCK_HYSTERESIS = 24;
export const NOTEBOOK_TOOLBAR_VELOCITY_WINDOW_MS = 100;

export const NOTEBOOK_TOOLBAR_DOCKS = [
  "top",
  "right",
  "bottom",
  "left",
] as const;

export type NotebookToolbarDock = (typeof NOTEBOOK_TOOLBAR_DOCKS)[number];
export type NotebookToolbarPointerSample = {
  x: number;
  y: number;
  timeStamp: number;
};

export function isNotebookToolbarDock(
  value: unknown
): value is NotebookToolbarDock {
  return (
    typeof value === "string" &&
    NOTEBOOK_TOOLBAR_DOCKS.includes(value as NotebookToolbarDock)
  );
}

/**
 * Where the toolbar is until it is dragged somewhere else: `top`, in the
 * notebook's top bar beside the title, which never covers the page. The other
 * docks float over the page at its left, right or bottom edge.
 */
export const NOTEBOOK_TOOLBAR_DEFAULT_DOCK: NotebookToolbarDock = "top";

export function readNotebookToolbarDockPreference(): NotebookToolbarDock {
  if (typeof window === "undefined") return NOTEBOOK_TOOLBAR_DEFAULT_DOCK;

  try {
    const storedValue = window.localStorage.getItem(
      NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY
    );
    return isNotebookToolbarDock(storedValue) ? storedValue : NOTEBOOK_TOOLBAR_DEFAULT_DOCK;
  } catch {
    // Storage can be unavailable in privacy modes; the top bar is safe.
    return NOTEBOOK_TOOLBAR_DEFAULT_DOCK;
  }
}

export function saveNotebookToolbarDockPreference(
  dock: NotebookToolbarDock
) {
  try {
    window.localStorage.setItem(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY, dock);
  } catch {
    // This is a non-critical, device-local layout preference.
  }
}

export const NOTEBOOK_SCRIBBLE_ERASE_STORAGE_KEY =
  "jami:notebook-scribble-erase";

/**
 * Scribbling out is on unless it has been turned off.
 *
 * It is the behaviour people arrive expecting, and the detection is built to
 * need six independent signals before it acts. The switch exists because it is
 * still a destructive gesture on the tool used for everything else.
 */
export function readNotebookScribbleErasePreference() {
  if (typeof window === "undefined") return true;

  try {
    return window.localStorage.getItem(NOTEBOOK_SCRIBBLE_ERASE_STORAGE_KEY) !==
      "off";
  } catch {
    // Storage can be unavailable in privacy modes; the default stands.
    return true;
  }
}

export function saveNotebookScribbleErasePreference(enabled: boolean) {
  try {
    window.localStorage.setItem(
      NOTEBOOK_SCRIBBLE_ERASE_STORAGE_KEY,
      enabled ? "on" : "off"
    );
  } catch {
    // This is a non-critical, device-local preference.
  }
}

/**
 * How close together two presses of the same tool are to count as a double
 * press, which puts the tool down.
 *
 * One press of the tool already in hand opens its settings, which left
 * nothing on the toolbar that let go of a tool: only the text box button
 * toggled, and the pen, highlighter and eraser opened and closed their
 * settings for ever. A double press puts any of them down.
 */
export const NOTEBOOK_TOOL_DOUBLE_PRESS_MS = 400;

export type NotebookToolPress = { tool: string; at: number };

/**
 * Which toolbar menu is open, if any: a tool's options popover, or the Insert
 * menu (a picture or a graph). Never two at once.
 */
export type NotebookToolMenu = "pen" | "highlighter" | "eraser" | "insert" | null;

/** Whether this press, following the last one, completes a double press. */
export function isNotebookToolDoublePress(
  previous: NotebookToolPress | null,
  next: NotebookToolPress,
  windowMs = NOTEBOOK_TOOL_DOUBLE_PRESS_MS
) {
  if (!previous || previous.tool !== next.tool) return false;
  const elapsed = next.at - previous.at;
  return elapsed >= 0 && elapsed <= windowMs;
}

export function isNotebookToolbarSideDock(dock: NotebookToolbarDock) {
  return dock === "left" || dock === "right";
}

/**
 * Where a menu opened from a toolbar button goes, in viewport pixels for a
 * fixed-position menu: beside the button, on the side away from the edge the
 * toolbar is docked to, `gap` clear of it. A menu cannot hang inside the
 * toolbar itself, whose paint containment clips anything outside its box.
 */
export function notebookToolbarMenuPosition(
  dock: NotebookToolbarDock,
  anchor: { left: number; top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  gap = 8
): { left?: number; top?: number; right?: number; bottom?: number; transform: string } {
  const middleX = (anchor.left + anchor.right) / 2;
  const middleY = (anchor.top + anchor.bottom) / 2;
  switch (dock) {
    case "top":
      return { left: middleX, top: anchor.bottom + gap, transform: "translateX(-50%)" };
    case "bottom":
      return { left: middleX, bottom: viewport.height - anchor.top + gap, transform: "translateX(-50%)" };
    case "left":
      return { left: anchor.right + gap, top: middleY, transform: "translateY(-50%)" };
    case "right":
      return { right: viewport.width - anchor.left + gap, top: middleY, transform: "translateY(-50%)" };
  }
}

export function hasNotebookToolbarDragStarted(input: {
  deltaX: number;
  deltaY: number;
  threshold?: number;
}) {
  const threshold = Math.max(
    0,
    input.threshold ?? NOTEBOOK_TOOLBAR_DRAG_THRESHOLD
  );
  return Math.hypot(input.deltaX, input.deltaY) >= threshold;
}

export function getNotebookToolbarDragThreshold(input: {
  pointerType: string;
  startedOnAction: boolean;
}) {
  return input.startedOnAction && input.pointerType !== "mouse"
    ? NOTEBOOK_TOOLBAR_ACTION_DRAG_THRESHOLD
    : NOTEBOOK_TOOLBAR_DRAG_THRESHOLD;
}

export function getNotebookToolbarDragVelocity(
  samples: readonly NotebookToolbarPointerSample[],
  windowMs = NOTEBOOK_TOOLBAR_VELOCITY_WINDOW_MS
) {
  if (samples.length < 2) return 0;

  const last = samples[samples.length - 1];
  const cutoff = last.timeStamp - Math.max(0, windowMs);
  const first =
    samples.find((sample) => sample.timeStamp >= cutoff) ?? samples[0];
  const elapsed = last.timeStamp - first.timeStamp;
  if (elapsed <= 0) return 0;

  return Math.hypot(last.x - first.x, last.y - first.y) / elapsed;
}

export function getNotebookToolbarSettleDuration(input: {
  distance: number;
  velocity: number;
}) {
  const distance = Math.max(0, input.distance);
  const velocity = Math.max(0, input.velocity);
  const duration =
    110 + Math.min(130, distance * 0.18) - Math.min(70, velocity * 30);
  return Math.round(Math.min(240, Math.max(120, duration)));
}

export function clampNotebookToolbarDragOffset(input: {
  deltaX: number;
  deltaY: number;
  originLeft: number;
  originTop: number;
  toolbarWidth: number;
  toolbarHeight: number;
  frameWidth: number;
  frameHeight: number;
  inset?: number;
  /**
   * How far above the frame the toolbar may go: the top bar's height, so a
   * toolbar can be carried out of the top bar and back into it.
   */
  topReach?: number;
}) {
  const inset = Math.max(0, input.inset ?? 8);
  const minLeft = Math.min(inset, Math.max(0, input.frameWidth - input.toolbarWidth));
  const minTop =
    Math.min(inset, Math.max(0, input.frameHeight - input.toolbarHeight)) - Math.max(0, input.topReach ?? 0);
  const maxLeft = Math.max(
    minLeft,
    input.frameWidth - input.toolbarWidth - inset
  );
  const maxTop = Math.max(
    minTop,
    input.frameHeight - input.toolbarHeight - inset
  );
  const nextLeft = Math.min(
    maxLeft,
    Math.max(minLeft, input.originLeft + input.deltaX)
  );
  const nextTop = Math.min(
    maxTop,
    Math.max(minTop, input.originTop + input.deltaY)
  );

  return {
    x: nextLeft - input.originLeft,
    y: nextTop - input.originTop,
  };
}

export function snapNotebookToolbarOffsetToDevicePixels(
  offset: { x: number; y: number },
  devicePixelRatio: number
) {
  const scale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return {
    x: Math.round(offset.x * scale) / scale,
    y: Math.round(offset.y * scale) / scale,
  };
}

export function getNearestNotebookToolbarDock(input: {
  x: number;
  y: number;
  frameWidth: number;
  frameHeight: number;
  currentDock: NotebookToolbarDock;
  hysteresis?: number;
}): NotebookToolbarDock {
  const x = Math.min(Math.max(input.x, 0), Math.max(0, input.frameWidth));
  const y = Math.min(Math.max(input.y, 0), Math.max(0, input.frameHeight));
  const distances: Record<NotebookToolbarDock, number> = {
    top: y,
    right: Math.max(0, input.frameWidth - x),
    bottom: Math.max(0, input.frameHeight - y),
    left: x,
  };
  const nearestDistance = Math.min(...Object.values(distances));
  const hysteresis = Math.max(
    0,
    input.hysteresis ?? NOTEBOOK_TOOLBAR_DOCK_HYSTERESIS
  );

  if (distances[input.currentDock] <= nearestDistance + hysteresis) {
    return input.currentDock;
  }

  return NOTEBOOK_TOOLBAR_DOCKS.reduce<NotebookToolbarDock>(
    (nearestDock, dock) =>
      distances[dock] < distances[nearestDock] ? dock : nearestDock,
    "top"
  );
}
