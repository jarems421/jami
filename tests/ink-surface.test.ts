import { describe, expect, it } from "vitest";
import type { InkChange } from "@/lib/ink/history";
import type { InkDocument, InkItem, InkOutlineItem, InkPaint, InkPathCommand } from "@/lib/ink/model";
import { inkShapePaint, inkShapePath } from "@/lib/ink/shapes";
import type { InkLiveTip, InkRenderer } from "@/lib/ink-dom/renderer";
import { inkColorForTool, type InkPointerSample, type InkStrokeTool } from "@/lib/ink-dom/stroke-session";
import { createInkSurface, type InkSurface } from "@/lib/ink-dom/surface";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";
import { InkFakeClock } from "./support/ink-fake-timers";
import { docOf, outline } from "./support/ink-fixtures";

const PAGE = { width: 900, height: 1240 };
const MAPPING = { left: 0, top: 0, scale: 1 };

type Draw = { path: InkPathCommand[]; paint: InkPaint; tip: InkLiveTip | null };

/** A renderer that only records what the surface asks of it. */
function fakeRenderer() {
  const calls: string[] = [];
  const draws: Draw[] = [];
  const applied: Array<{ doc: InkDocument; change: InkChange }> = [];
  const committed: Array<{ doc: InkDocument; change: InkChange }> = [];
  let shown: InkDocument = { version: 3, items: [] };
  let visibleCallback: (() => void) | null = null;
  const visibleCancels: string[] = [];
  const renderer = {
    setDocument(doc: InkDocument) {
      calls.push("setDocument");
      shown = doc;
    },
    applyChange(doc: InkDocument, change: InkChange) {
      calls.push("applyChange");
      applied.push({ doc, change });
      shown = doc;
    },
    setViewport: () => calls.push("setViewport"),
    beginGesture: () => calls.push("beginGesture"),
    endGesture: () => calls.push("endGesture"),
    beginLive: (layer: string) => calls.push(`beginLive:${layer}`),
    drawLive(path: InkPathCommand[], paint: InkPaint, tip?: InkLiveTip | null) {
      calls.push("drawLive");
      draws.push({ path, paint, tip: tip ?? null });
    },
    commitLive(doc: InkDocument, change: InkChange) {
      calls.push("commitLive");
      committed.push({ doc, change });
      shown = doc;
    },
    cancelLive: () => calls.push("cancelLive"),
    stats: {},
    resetStats: () => undefined,
    coverage: () => ({ visible: 0, drawn: 0 }),
    whenVisibleDrawn(callback: () => void) {
      visibleCallback = callback;
      return () => {
        visibleCancels.push("cancel");
        visibleCallback = null;
      };
    },
    warmUp: () => calls.push("warmUp"),
    idle: true,
    destroy: () => calls.push("destroy"),
  } as unknown as InkRenderer;
  return {
    renderer,
    calls,
    draws,
    applied,
    committed,
    visibleCancels,
    get shown() {
      return shown;
    },
    fireVisible() {
      visibleCallback?.();
    },
  };
}

function setup() {
  const fake = fakeRenderer();
  const clock = new InkFakeClock();
  const changes = { count: 0 };
  const history: Array<[number, number]> = [];
  const surface = createInkSurface({} as HTMLElement, {
    page: PAGE,
    onChange: () => {
      changes.count += 1;
    },
    onHistoryChange: (undo, redo) => history.push([undo, redo]),
    createRenderer: () => fake.renderer,
    timers: clock.timers,
  });
  return { surface, fake, changes, history, clock };
}

function load(surface: InkSurface, ...items: InkItem[]): void {
  surface.load(docOf(...items));
}

function sample(x: number, y: number, time: number): InkPointerSample {
  return { clientX: x, clientY: y, pressure: 0.5, timeStamp: time };
}

const PEN: InkStrokeTool = {
  kind: "pen",
  color: inkColorForTool("black", "pen"),
  thickness: 4,
  pressure: false,
  settings: { ...NOTEBOOK_PEN_SETTINGS_DEFAULT, straightenOnHold: "off" },
  predictTip: false,
  shapes: false,
};

/** A short wavy stroke along the page. */
function writeStroke(surface: InkSurface, y = 300): void {
  surface.beginStroke({ tool: PEN, mapping: MAPPING, first: sample(100, y, 0) });
  const samples = Array.from({ length: 20 }, (_unused, index) =>
    sample(100 + index * 5, y + 10 * Math.sin(index / 3), 4 + index * 4)
  );
  surface.moveStroke(samples.slice(0, 10));
  surface.moveStroke(samples.slice(10));
}

/** A filled rectangle outline. */
function rect(id: string, x0: number, y0: number, x1: number, y1: number): InkOutlineItem {
  return outline(id, [
    { op: "M", x: x0, y: y0 },
    { op: "L", x: x1, y: y0 },
    { op: "L", x: x1, y: y1 },
    { op: "L", x: x0, y: y1 },
    { op: "Z" },
  ]);
}

const WORD: InkOutlineItem = outline("word", [
  { op: "M", x: 110, y: 50 },
  { op: "L", x: 190, y: 50 },
  { op: "L", x: 150, y: 57 },
  { op: "Z" },
]);

function bandAt(minX: number, minY: number, maxX: number, maxY: number) {
  return {
    hull: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    bounds: { minX, minY, maxX, maxY },
  };
}

describe("load", () => {
  it("shows the page, clears history and does not call onChange", () => {
    const { surface, fake, changes, history } = setup();
    load(surface, rect("a", 100, 100, 140, 140));
    expect(fake.calls).toContain("setDocument");
    expect(fake.shown.items).toHaveLength(1);
    expect(surface.hasInk()).toBe(true);
    expect(changes.count).toBe(0);
    expect(history[history.length - 1]).toEqual([0, 0]);

    writeStroke(surface);
    expect(surface.endStroke()).toBe("committed");
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });
    load(surface, rect("b", 0, 0, 10, 10));
    expect(surface.historyState()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(history[history.length - 1]).toEqual([0, 0]);
  });

  it("warms the GPU once the visible ink is drawn", () => {
    const { surface, fake } = setup();
    load(surface);
    expect(fake.calls).not.toContain("warmUp");
    fake.fireVisible();
    expect(fake.calls.filter((call) => call === "warmUp")).toHaveLength(1);
  });

  it("stops a pending warm-up when destroyed, and destroys the renderer", () => {
    const { surface, fake } = setup();
    load(surface);
    surface.destroy();
    expect(fake.visibleCancels).toHaveLength(1);
    expect(fake.calls).toContain("destroy");
    fake.fireVisible();
    expect(fake.calls).not.toContain("warmUp");
    surface.destroy();
    expect(fake.calls.filter((call) => call === "destroy")).toHaveLength(1);
  });
});

describe("pen strokes", () => {
  it("commits exactly what live ink last drew, as one history step", () => {
    const { surface, fake, changes, history } = setup();
    load(surface);
    writeStroke(surface);
    expect(surface.busy).toBe(true);
    expect(surface.endStroke()).toBe("committed");
    expect(surface.busy).toBe(false);

    const last = fake.draws[fake.draws.length - 1];
    expect(fake.committed).toHaveLength(1);
    const added = fake.committed[0].change.added;
    expect(added).toHaveLength(1);
    const item = added[0].item;
    expect(item.kind).toBe("outline");
    if (item.kind !== "outline") return;
    expect(item.path).toBe(last.path);
    expect(item.paint).toBe(last.paint);
    expect(item.layer).toBe("pen");
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(changes.count).toBe(1);
    expect(history[history.length - 1]).toEqual([1, 0]);
  });

  it("undoes and redoes the same item", () => {
    const { surface, fake, changes } = setup();
    load(surface);
    writeStroke(surface);
    surface.endStroke();
    const item = fake.shown.items[0];

    surface.undo();
    expect(fake.shown.items).toHaveLength(0);
    expect(surface.hasInk()).toBe(false);
    expect(surface.historyState()).toEqual({ undoDepth: 0, redoDepth: 1 });
    surface.redo();
    expect(fake.shown.items[0]).toBe(item);
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(changes.count).toBe(3);
  });

  it("keeps nothing from a stroke with nothing to keep", () => {
    const { surface, fake, changes } = setup();
    load(surface);
    surface.beginStroke({ tool: PEN, mapping: MAPPING, first: sample(Number.NaN, 200, 0) });
    expect(surface.endStroke()).toBe("empty");
    expect(fake.committed).toHaveLength(0);
    expect(surface.historyState().undoDepth).toBe(0);
    expect(changes.count).toBe(0);
    expect(surface.busy).toBe(false);
  });

  it("cancels the old stroke when a new one begins, and on cancelStroke", () => {
    const { surface, fake } = setup();
    load(surface);
    writeStroke(surface);
    writeStroke(surface, 500);
    expect(fake.calls.filter((call) => call === "cancelLive")).toHaveLength(1);
    surface.cancelStroke();
    expect(fake.calls.filter((call) => call === "cancelLive")).toHaveLength(2);
    expect(surface.busy).toBe(false);
    expect(surface.endStroke()).toBe("empty");
    expect(surface.hasInk()).toBe(false);
  });

  it("blocks undo, redo and clear while busy", () => {
    const { surface, fake } = setup();
    load(surface);
    writeStroke(surface);
    surface.endStroke();
    writeStroke(surface, 500);
    const before = fake.calls.length;
    surface.undo();
    surface.clear();
    expect(fake.calls.length).toBe(before);
    expect(surface.historyState().undoDepth).toBe(1);
    surface.cancelStroke();
    surface.undo();
    expect(surface.historyState()).toEqual({ undoDepth: 0, redoDepth: 1 });
  });
});

describe("strokes snapped on a hold", () => {
  const SHAPES: InkStrokeTool = { ...PEN, settings: NOTEBOOK_PEN_SETTINGS_DEFAULT, shapes: true };

  /** A circle round (300, 300), held still at its end until it snaps. */
  function drawHeldCircle(surface: InkSurface, clock: InkFakeClock): void {
    surface.beginStroke({ tool: SHAPES, mapping: MAPPING, first: sample(400, 300, 0) });
    for (let index = 1; index <= 48; index += 1) {
      const angle = (index / 46) * 2 * Math.PI;
      const each = sample(300 + 100 * Math.cos(angle), 300 + 100 * Math.sin(angle), index * 4.2);
      clock.advanceTo(each.timeStamp);
      surface.moveStroke([each]);
    }
    clock.advanceTo(48 * 4.2 + 501);
  }

  it("goes on the page as the shape live ink drew, in one commit and two undo steps", () => {
    const { surface, fake, changes, clock } = setup();
    load(surface);
    drawHeldCircle(surface, clock);
    const shown = fake.draws[fake.draws.length - 1];
    expect(surface.endStroke()).toBe("committed");

    expect(fake.committed).toHaveLength(1);
    const { change } = fake.committed[0];
    expect(change.removed).toHaveLength(0);
    expect(change.added).toHaveLength(1);
    const item = change.added[0].item;
    expect(item.kind).toBe("shape");
    if (item.kind !== "shape") return;
    expect(item.shape.type).toBe("ellipse");
    expect(inkShapePath(item.shape, item.width)).toEqual(shown.path);
    expect(inkShapePaint(item)).toEqual(shown.paint);
    expect(changes.count).toBe(1);
    expect(surface.historyState()).toEqual({ undoDepth: 2, redoDepth: 0 });
  });

  it("keeps what snapped, and erases nothing, however the pen moved while sizing it", () => {
    const { surface, fake, clock } = setup();
    load(surface, WORD);
    drawHeldCircle(surface, clock);
    // Sizing it back and forth over the word looks like a scribble out.
    expect(surface.endStroke({ band: bandAt(100, 40, 200, 70), majorExtent: 200 })).toBe("committed");
    expect(fake.shown.items.map((item) => item.kind)).toEqual(["outline", "shape"]);
    expect(fake.shown.items[0].id).toBe(WORD.id);
  });

  it("undoes back to the stroke as it was drawn, then away, and redoes both", () => {
    const { surface, fake, clock } = setup();
    load(surface);
    drawHeldCircle(surface, clock);
    // The last freehand draw, before the snap replaced it.
    const drawn = fake.draws[fake.draws.length - 2];
    surface.endStroke();
    const shape = fake.shown.items[0];

    surface.undo();
    expect(fake.shown.items).toHaveLength(1);
    const back = fake.shown.items[0];
    expect(back.kind).toBe("outline");
    if (back.kind !== "outline") return;
    expect(back.path).toBe(drawn.path);
    expect(back.paint).toBe(drawn.paint);

    surface.undo();
    expect(fake.shown.items).toHaveLength(0);
    surface.redo();
    expect(fake.shown.items[0]).toBe(back);
    surface.redo();
    expect(fake.shown.items[0]).toBe(shape);
    expect(surface.historyState()).toEqual({ undoDepth: 2, redoDepth: 0 });
  });
});

describe("lasso edits", () => {
  const loopAround = (minX: number, minY: number, maxX: number, maxY: number) => [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  it("finds the ink a loop goes round, and hands it back", () => {
    const { surface } = setup();
    load(surface, rect("a", 100, 100, 140, 140), rect("b", 400, 400, 440, 440));
    expect(surface.inkInLoop(loopAround(80, 80, 200, 200))).toEqual(["a"]);
    expect(surface.items(["b", "a"]).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("shows every step of a drag at once, and records the whole drag as one undo step", () => {
    const { surface, changes } = setup();
    const original = rect("a", 100, 100, 140, 140);
    load(surface, original);
    surface.beginEdit();
    expect(surface.busy).toBe(true);
    surface.showEdit([rect("a", 110, 100, 150, 140)]);
    surface.showEdit([rect("a", 120, 100, 160, 140)]);
    expect(surface.historyState().undoDepth).toBe(0);
    surface.endEdit();
    expect(surface.busy).toBe(false);
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(changes.count).toBe(1);
    surface.undo();
    expect(surface.document().items[0]).toBe(original);
  });

  it("lifts ink off the page for a drag and puts it down where the drag ended, as one undo step", () => {
    const { surface, changes } = setup();
    const original = rect("a", 100, 100, 140, 140);
    const other = rect("b", 400, 400, 440, 440);
    load(surface, original, other);
    const before = surface.document();
    surface.beginEdit();
    surface.hideItems(["a"]);
    expect(surface.items(["a"])).toEqual([]);
    // A save while it is lifted still finds it where it was.
    expect(surface.document()).toBe(before);
    expect(surface.hasInk()).toBe(true);
    const moved = rect("a", 300, 100, 340, 140);
    surface.endEdit([moved]);
    expect(surface.document().items).toEqual([moved, other]);
    expect(surface.historyState().undoDepth).toBe(1);
    expect(changes.count).toBe(1);
    surface.undo();
    expect(surface.document().items).toEqual([original, other]);
  });

  it("records nothing when lifted ink is put down where it was", () => {
    const { surface, changes } = setup();
    const original = rect("a", 100, 100, 140, 140);
    load(surface, original);
    const before = surface.document();
    surface.beginEdit();
    surface.hideItems(["a"]);
    surface.endEdit([original]);
    expect(surface.document().items).toEqual(before.items);
    expect(surface.historyState().undoDepth).toBe(0);
    expect(changes.count).toBe(0);
  });

  it("drops an edit in progress when another page loads", () => {
    const { surface, changes } = setup();
    load(surface, rect("a", 100, 100, 140, 140));
    surface.beginEdit();
    surface.hideItems(["a"]);
    const next = rect("z", 500, 500, 540, 540);
    load(surface, next);
    expect(surface.busy).toBe(false);
    surface.endEdit([rect("a", 300, 100, 340, 140)]);
    expect(surface.document().items).toEqual([next]);
    expect(changes.count).toBe(0);
  });

  it("deletes what was picked up as one step", () => {
    const { surface } = setup();
    load(surface, rect("a", 100, 100, 140, 140), rect("b", 400, 400, 440, 440));
    surface.removeItems(["a"]);
    expect(surface.document().items.map((item) => item.id)).toEqual(["b"]);
    surface.undo();
    expect(surface.document().items.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("scribbling", () => {
  it("erases the word it covers as one step and keeps the scribble out of the page", () => {
    const { surface, fake, changes } = setup();
    load(surface, WORD, rect("far", 600, 600, 640, 640));
    const word = fake.shown.items[0];
    writeStroke(surface, 50);
    expect(surface.endStroke({ band: bandAt(100, 40, 200, 70), majorExtent: 200 })).toBe("scribbled");
    expect(fake.committed).toHaveLength(0);
    expect(fake.calls).toContain("cancelLive");
    expect(fake.shown.items).toHaveLength(1);
    expect(fake.shown.items[0].id).not.toBe(word.id);
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(changes.count).toBe(1);

    surface.undo();
    expect(fake.shown.items).toHaveLength(2);
    expect(fake.shown.items[0]).toBe(word);
  });

  it("commits as ink when it covers blank paper", () => {
    const { surface, fake } = setup();
    load(surface, WORD);
    writeStroke(surface, 700);
    expect(surface.endStroke({ band: bandAt(100, 690, 300, 730), majorExtent: 200 })).toBe("committed");
    expect(fake.committed).toHaveLength(1);
    expect(fake.shown.items).toHaveLength(2);
  });

  it("never takes ink for a highlighter stroke", () => {
    const { surface, fake } = setup();
    load(surface, WORD);
    surface.beginStroke({
      tool: {
        kind: "highlighter",
        color: inkColorForTool("yellow", "highlighter"),
        thickness: 30,
        settings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
        nibAngle: () => 0.5,
      },
      mapping: MAPPING,
      first: sample(100, 50, 0),
    });
    surface.moveStroke([sample(150, 50, 10), sample(200, 50, 20)]);
    expect(surface.endStroke({ band: bandAt(100, 40, 200, 70), majorExtent: 200 })).toBe("committed");
    expect(fake.shown.items).toHaveLength(2);
  });
});

describe("the stroke eraser", () => {
  it("removes ink as the eraser moves, in one undo step", () => {
    const { surface, fake, changes } = setup();
    load(surface, rect("a", 100, 100, 140, 140), rect("b", 100, 200, 140, 240), rect("c", 500, 500, 540, 540));
    const [a, b, c] = fake.shown.items;

    surface.beginErase({ mode: "stroke", radius: 5, at: { x: 50, y: 120 } });
    expect(surface.busy).toBe(true);
    surface.moveErase([{ x: 120, y: 120 }]);
    expect(fake.shown.items).toEqual([b, c]);
    surface.moveErase([{ x: 120, y: 220 }]);
    expect(fake.shown.items).toEqual([c]);
    // Nothing is recorded until the eraser lifts.
    expect(surface.historyState().undoDepth).toBe(0);
    expect(changes.count).toBe(0);

    surface.endErase();
    expect(surface.busy).toBe(false);
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(changes.count).toBe(1);

    surface.undo();
    expect(fake.shown.items).toEqual([a, b, c]);
    expect(fake.shown.items[0]).toBe(a);
    surface.redo();
    expect(fake.shown.items).toEqual([c]);
  });

  it("erases ink under the eraser where it lands", () => {
    const { surface, fake } = setup();
    load(surface, rect("a", 100, 100, 140, 140));
    surface.beginErase({ mode: "stroke", radius: 5, at: { x: 120, y: 120 } });
    expect(fake.shown.items).toHaveLength(0);
    surface.endErase();
    expect(surface.historyState().undoDepth).toBe(1);
  });

  it("records nothing when nothing was erased", () => {
    const { surface, changes } = setup();
    load(surface, rect("a", 100, 100, 140, 140));
    surface.beginErase({ mode: "stroke", radius: 5, at: { x: 700, y: 700 } });
    surface.moveErase([{ x: 710, y: 710 }]);
    surface.endErase();
    expect(surface.historyState().undoDepth).toBe(0);
    expect(changes.count).toBe(0);
  });

  it("puts the page back when cancelled, with no history", () => {
    const { surface, fake, changes } = setup();
    load(surface, rect("a", 100, 100, 140, 140), rect("b", 100, 200, 140, 240));
    const before = fake.shown.items.slice();
    surface.beginErase({ mode: "stroke", radius: 5, at: { x: 50, y: 120 } });
    surface.moveErase([{ x: 120, y: 120 }, { x: 120, y: 220 }]);
    expect(fake.shown.items).toHaveLength(0);
    surface.cancelErase();
    expect(fake.shown.items).toEqual(before);
    expect(fake.shown.items[0]).toBe(before[0]);
    expect(surface.busy).toBe(false);
    expect(surface.historyState().undoDepth).toBe(0);
    expect(changes.count).toBe(0);
    // The index is back in step: erasing again finds the ink.
    surface.beginErase({ mode: "stroke", radius: 5, at: { x: 120, y: 120 } });
    expect(fake.shown.items).toHaveLength(1);
  });
});

describe("the precision eraser", () => {
  it("splits a stroke in one step, and undo restores the original item", () => {
    const { surface, fake } = setup();
    load(surface, rect("bar", 100, 100, 300, 120));
    const original = fake.shown.items[0];

    surface.beginErase({ mode: "precision", radius: 10, at: { x: 200, y: 110 } });
    expect(fake.shown.items.length).toBeGreaterThanOrEqual(2);
    expect(fake.shown.items).not.toContain(original);
    surface.moveErase([{ x: 205, y: 110 }]);
    surface.endErase();
    expect(surface.historyState()).toEqual({ undoDepth: 1, redoDepth: 0 });

    surface.undo();
    expect(fake.shown.items).toHaveLength(1);
    expect(fake.shown.items[0]).toBe(original);
  });
});

describe("clear and serialize", () => {
  it("does nothing on an empty page", () => {
    const { surface, changes } = setup();
    load(surface);
    surface.clear();
    expect(changes.count).toBe(0);
    expect(surface.historyState().undoDepth).toBe(0);
  });

  it("clears the page as one step that undo brings back", () => {
    const { surface, fake, changes } = setup();
    load(surface, rect("a", 100, 100, 140, 140), rect("b", 100, 200, 140, 240));
    surface.clear();
    expect(surface.hasInk()).toBe(false);
    expect(fake.shown.items).toHaveLength(0);
    expect(changes.count).toBe(1);
    surface.undo();
    expect(fake.shown.items).toHaveLength(2);
  });

  it("hands over the committed document, the same one until it changes", () => {
    const { surface, fake } = setup();
    load(surface, rect("a", 100, 100, 140, 140));
    const first = surface.document();
    expect(first).toBe(fake.shown);
    expect(surface.document()).toBe(first);

    writeStroke(surface);
    // A stroke in progress is not part of it.
    expect(surface.document()).toBe(first);
    surface.endStroke();
    const second = surface.document();
    expect(second).not.toBe(first);
    expect(second).toBe(fake.shown);
    expect(second.items).toHaveLength(2);
    surface.undo();
    expect(surface.document().items).toEqual(first.items);
  });
});
