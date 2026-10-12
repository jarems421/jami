import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampNotebookToolbarDragOffset,
  getNotebookToolbarDragThreshold,
  getNotebookToolbarDragVelocity,
  getNotebookToolbarSettleDuration,
  getNearestNotebookToolbarDock,
  hasNotebookToolbarDragStarted,
  isNotebookToolDoublePress,
  isNotebookToolbarDock,
  isNotebookToolbarSideDock,
  notebookToolbarMenuPosition,
  NOTEBOOK_TOOL_DOUBLE_PRESS_MS,
  NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY,
  readNotebookToolbarDockPreference,
  saveNotebookToolbarDockPreference,
  snapNotebookToolbarOffsetToDevicePixels,
} from "@/lib/workspace/notebook-toolbar";

describe("notebook toolbar docking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only the four supported fixed docks", () => {
    expect(isNotebookToolbarDock("top")).toBe(true);
    expect(isNotebookToolbarDock("right")).toBe(true);
    expect(isNotebookToolbarDock("bottom")).toBe(true);
    expect(isNotebookToolbarDock("left")).toBe(true);
    expect(isNotebookToolbarDock("center")).toBe(false);
    expect(isNotebookToolbarDock(null)).toBe(false);
  });

  it("uses a movement threshold so taps do not become drags", () => {
    expect(hasNotebookToolbarDragStarted({ deltaX: 2, deltaY: 3 })).toBe(false);
    expect(hasNotebookToolbarDragStarted({ deltaX: 4, deltaY: 0 })).toBe(true);
  });

  it("gives Pencil action taps more movement tolerance before dragging", () => {
    expect(
      getNotebookToolbarDragThreshold({
        pointerType: "pen",
        startedOnAction: true,
      })
    ).toBe(8);
    expect(
      getNotebookToolbarDragThreshold({
        pointerType: "touch",
        startedOnAction: true,
      })
    ).toBe(8);
    expect(
      getNotebookToolbarDragThreshold({
        pointerType: "mouse",
        startedOnAction: true,
      })
    ).toBe(4);
    expect(
      getNotebookToolbarDragThreshold({
        pointerType: "pen",
        startedOnAction: false,
      })
    ).toBe(4);
    expect(
      hasNotebookToolbarDragStarted({
        deltaX: 6,
        deltaY: 0,
        threshold: 8,
      })
    ).toBe(false);
    expect(
      hasNotebookToolbarDragStarted({
        deltaX: 8,
        deltaY: 0,
        threshold: 8,
      })
    ).toBe(true);
  });

  it("measures release velocity from only the latest 100ms of movement", () => {
    expect(
      getNotebookToolbarDragVelocity([
        { x: 0, y: 0, timeStamp: 0 },
        { x: 100, y: 0, timeStamp: 100 },
        { x: 100, y: 0, timeStamp: 150 },
        { x: 150, y: 0, timeStamp: 200 },
      ])
    ).toBe(0.5);
  });

  it("settles nearby or fast releases more quickly within safe bounds", () => {
    expect(
      getNotebookToolbarSettleDuration({ distance: 20, velocity: 0 })
    ).toBe(120);
    expect(
      getNotebookToolbarSettleDuration({ distance: 600, velocity: 0 })
    ).toBe(218);
    expect(
      getNotebookToolbarSettleDuration({ distance: 600, velocity: 4 })
    ).toBe(148);
    expect(
      getNotebookToolbarSettleDuration({ distance: 4000, velocity: 0 })
    ).toBe(240);
  });

  it("clamps the toolbar inside the notebook workspace while dragging", () => {
    expect(
      clampNotebookToolbarDragOffset({
        deltaX: -200,
        deltaY: 500,
        originLeft: 100,
        originTop: 60,
        toolbarWidth: 300,
        toolbarHeight: 56,
        frameWidth: 800,
        frameHeight: 600,
      })
    ).toEqual({ x: -92, y: 476 });
  });

  it("lets the toolbar be carried up into the top bar, as far as the bar reaches", () => {
    const up = (topReach?: number) =>
      clampNotebookToolbarDragOffset({
        deltaX: 0,
        deltaY: -200,
        originLeft: 100,
        originTop: -52,
        toolbarWidth: 300,
        toolbarHeight: 44,
        frameWidth: 800,
        frameHeight: 600,
        topReach,
      }).y;
    // From the bar, it goes no higher than the bar's top less the inset.
    expect(up(61)).toBe(-1);
    // With no bar to go into, the first move pulls it inside the frame.
    expect(up()).toBe(60);
  });

  it("snaps fractional touch movement to the physical pixel grid", () => {
    expect(
      snapNotebookToolbarOffsetToDevicePixels(
        { x: 10.18, y: -3.42 },
        2
      )
    ).toEqual({ x: 10, y: -3.5 });
    expect(
      snapNotebookToolbarOffsetToDevicePixels(
        { x: 10.18, y: -3.42 },
        Number.NaN
      )
    ).toEqual({ x: 10, y: -3 });
  });

  it.each([
    [{ x: 400, y: 20 }, "top"],
    [{ x: 780, y: 300 }, "right"],
    [{ x: 400, y: 580 }, "bottom"],
    [{ x: 20, y: 300 }, "left"],
  ] as const)("snaps a release near an edge to %s", (point, expectedDock) => {
    expect(
      getNearestNotebookToolbarDock({
        ...point,
        frameWidth: 800,
        frameHeight: 600,
        currentDock: "bottom",
      })
    ).toBe(expectedDock);
  });

  it("keeps the current dock within the hysteresis band", () => {
    expect(
      getNearestNotebookToolbarDock({
        x: 400,
        y: 288,
        frameWidth: 800,
        frameHeight: 600,
        currentDock: "bottom",
      })
    ).toBe("bottom");
  });

  it("opens a toolbar menu beside its button, away from the docked edge", () => {
    const anchor = { left: 600, top: 10, right: 644, bottom: 54 };
    const viewport = { width: 1180, height: 820 };
    expect(notebookToolbarMenuPosition("top", anchor, viewport)).toEqual({
      left: 622,
      top: 62,
      transform: "translateX(-50%)",
    });
    const low = { left: 600, top: 760, right: 644, bottom: 804 };
    expect(notebookToolbarMenuPosition("bottom", low, viewport)).toEqual({
      left: 622,
      bottom: 68,
      transform: "translateX(-50%)",
    });
    const side = { left: 14, top: 400, right: 58, bottom: 444 };
    expect(notebookToolbarMenuPosition("left", side, viewport)).toEqual({
      left: 66,
      top: 422,
      transform: "translateY(-50%)",
    });
    const far = { left: 1122, top: 400, right: 1166, bottom: 444 };
    expect(notebookToolbarMenuPosition("right", far, viewport)).toEqual({
      right: 66,
      top: 422,
      transform: "translateY(-50%)",
    });
  });

  it("uses vertical orientation only for side docks", () => {
    expect(isNotebookToolbarSideDock("left")).toBe(true);
    expect(isNotebookToolbarSideDock("right")).toBe(true);
    expect(isNotebookToolbarSideDock("top")).toBe(false);
    expect(isNotebookToolbarSideDock("bottom")).toBe(false);
  });

  it("stores one device-local dock preference across notebooks", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    saveNotebookToolbarDockPreference("left");
    expect(values.get(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY)).toBe("left");
    expect(readNotebookToolbarDockPreference()).toBe("left");

    // Anything else is the top bar, where the toolbar starts.
    values.set(NOTEBOOK_TOOLBAR_DOCK_STORAGE_KEY, "center");
    expect(readNotebookToolbarDockPreference()).toBe("top");
  });
});

describe("putting a tool down", () => {
  const press = (tool: string, at: number) => ({ tool, at });

  it("takes two quick presses of the same tool as a double press", () => {
    expect(isNotebookToolDoublePress(press("pen", 1000), press("pen", 1250))).toBe(true);
    expect(
      isNotebookToolDoublePress(
        press("pen", 1000),
        press("pen", 1000 + NOTEBOOK_TOOL_DOUBLE_PRESS_MS)
      )
    ).toBe(true);
  });

  it("leaves a slow second press to open the tool's settings", () => {
    expect(
      isNotebookToolDoublePress(
        press("pen", 1000),
        press("pen", 1001 + NOTEBOOK_TOOL_DOUBLE_PRESS_MS)
      )
    ).toBe(false);
  });

  it("never pairs presses of two different tools", () => {
    expect(isNotebookToolDoublePress(press("pen", 1000), press("eraser", 1100))).toBe(false);
    expect(isNotebookToolDoublePress(null, press("pen", 1000))).toBe(false);
  });
});
