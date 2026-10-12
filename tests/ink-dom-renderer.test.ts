// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInkChange, inkAddChange, inkRemoveChange } from "@/lib/ink/history";
import type { InkDocument, InkItem, InkLayer, InkPaint, InkPathCommand } from "@/lib/ink/model";
import { inkShapePaint, inkShapePath } from "@/lib/ink/shapes";
import { createInkRenderer, type InkLiveTip, type InkRenderer, type InkViewport } from "@/lib/ink-dom/renderer";
import { callsOf, FakePath2D, installFakeCanvas, type FakeCanvasEnvironment } from "./support/fake-canvas";

const black = { r: 17, g: 24, b: 39, a: 1 };
const yellow = { r: 253, g: 224, b: 71, a: 0.42 };
const penPaint: InkPaint = { fill: null, stroke: { color: black, width: 3, cap: "round", join: "round" }, opacity: 1 };
const highlighterPaint: InkPaint = { fill: yellow, stroke: null, opacity: 1 };

function line(id: string, layer: InkLayer, x: number, y: number, length = 40): InkItem {
  const path: InkPathCommand[] =
    layer === "pen"
      ? [
          { op: "M", x, y },
          { op: "L", x: x + length, y },
        ]
      : [
          { op: "M", x, y },
          { op: "L", x: x + length, y },
          { op: "L", x: x + length, y: y + 10 },
          { op: "L", x, y: y + 10 },
          { op: "Z" },
        ];
  return { kind: "outline", id, layer, path, paint: layer === "pen" ? penPaint : highlighterPaint };
}

function pathOf(item: InkItem): InkPathCommand[] {
  if (item.kind !== "outline") throw new Error("expected an outline");
  return item.path;
}

/** 0.6 CSS px a page unit at 2x: the whole sheet is 3 x 3 tiles of 512 device pixels. */
const FITTED: InkViewport = { scale: 0.6, devicePixelRatio: 2, visible: { left: 0, top: 0, width: 540, height: 744 } };
/** 2.5 at 2x, a screenful in the middle. */
const ZOOMED: InkViewport = { scale: 2.5, devicePixelRatio: 2, visible: { left: 500, top: 800, width: 1180, height: 820 } };

let canvas: FakeCanvasEnvironment;
let posted: Array<() => void>;
/** Animation frames asked for and not yet run (the warm-up waits on two). */
let frameCallbacks: Map<number, () => void>;
let frameCount: number;
let host: HTMLDivElement;
let renderer: InkRenderer;

/** Lets the frames asked for so far happen; those they ask for wait for the next. */
function runFrame() {
  const due = Array.from(frameCallbacks.values());
  frameCallbacks.clear();
  for (const callback of due) callback();
}

function pump() {
  for (let guard = 0; guard < 10_000 && posted.length > 0; guard += 1) posted.shift()!();
}

function make(options: { budgetBytes?: number; page?: { width: number; height: number } } = {}) {
  renderer = createInkRenderer(host, {
    now: canvas.now,
    post: (callback) => posted.push(callback),
    requestFrame: (callback) => {
      frameCount += 1;
      frameCallbacks.set(frameCount, callback);
      return frameCount;
    },
    cancelFrame: (id) => {
      frameCallbacks.delete(id);
    },
    pathFactory: () => new FakePath2D(),
    ...options,
  });
  return renderer;
}

/** Canvases in a dry layer group of the renderer (layer root index 0 = highlighter, 1 = pen). */
function dryCanvases(layer: InkLayer): HTMLCanvasElement[] {
  const root = host.querySelector("[data-ink-renderer]")!;
  const layerRoot = root.children[layer === "highlighter" ? 0 : 1];
  return Array.from(layerRoot.querySelectorAll("canvas"));
}

/** The live canvases (the layer root after the two dry ones). */
function liveCanvases(): HTMLCanvasElement[] {
  const root = host.querySelector("[data-ink-renderer]")!;
  return Array.from(root.children[2].querySelectorAll("canvas"));
}

/** A canvas by its tile, on the 512 pixel tiles of a 2x screen: left and top in CSS pixels. */
function atTile(list: HTMLCanvasElement[], col: number, row: number) {
  return list.find((element) => element.style.left === `${col * 256}px` && element.style.top === `${row * 256}px`);
}

const strokesOf = (element: HTMLCanvasElement) =>
  callsOf(canvas, element, "stroke").map((call) => (call.args[0] as FakePath2D).commands);

/** Microtasks queued so far have run. */
const microtasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  canvas = installFakeCanvas();
  posted = [];
  frameCallbacks = new Map();
  frameCount = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  renderer?.destroy();
  host.remove();
  canvas.restore();
});

describe("createInkRenderer", () => {
  it("draws only tiles with ink, and highlighter tiles only where there is highlighter", () => {
    make();
    renderer.setViewport(FITTED);
    // Pen in the top-left tile; a highlighter in the top-left tile only.
    const doc: InkDocument = { version: 3, items: [line("h", "highlighter", 20, 20), line("p", "pen", 30, 30)] };
    renderer.setDocument(doc);
    pump();
    expect(renderer.idle).toBe(true);
    expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
    expect(dryCanvases("pen")).toHaveLength(1);
    expect(dryCanvases("highlighter")).toHaveLength(1);
    expect(renderer.stats.tileRenders).toBe(9);
    expect(renderer.stats.firstInkMs).not.toBeNull();
    expect(renderer.stats.visibleReadyMs).not.toBeNull();
    // Each tile is painted in page units through one transform: 1.2 device pixels a unit.
    const pen = dryCanvases("pen")[0];
    expect(callsOf(canvas, pen, "setTransform").at(-1)?.args).toEqual([1.2, 0, 0, 1.2, -0, -0]);
    expect(callsOf(canvas, pen, "stroke")).toHaveLength(1);
  });

  it("allocates no canvas and draws no tile while a stroke is written, and keeps its pixels at the lift", () => {
    make();
    renderer.setViewport(FITTED);
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };
    renderer.setDocument(doc);
    pump();
    renderer.resetStats();

    renderer.beginLive("pen");
    const path: InkPathCommand[] = [{ op: "M", x: 25, y: 35 }];
    for (let i = 1; i <= 20; i += 1) {
      path.push({ op: "L", x: 25 + i * 5, y: 35 + (i % 3) });
      renderer.drawLive(path.slice(), penPaint);
    }
    // A zoom settling mid-stroke waits for the lift, and background work is held.
    renderer.setViewport(ZOOMED);
    pump();
    expect(renderer.stats.canvasAllocations).toBe(0);
    expect(renderer.stats.tileRenders + renderer.stats.tileAppends).toBe(0);
    expect(renderer.stats.liveDraws).toBe(20);
    renderer.cancelLive();
    pump();
    expect(renderer.stats.levelSwaps).toBe(1);
  });

  it("hands the live tile to the dry layer at the lift, painting nothing again", () => {
    make();
    renderer.setViewport(FITTED);
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };
    renderer.setDocument(doc);
    pump();
    renderer.resetStats();

    renderer.beginLive("pen");
    const path: InkPathCommand[] = [
      { op: "M", x: 20, y: 60 },
      { op: "L", x: 120, y: 60 },
    ];
    renderer.drawLive(path, penPaint);
    const strokesBefore = dryCanvases("pen").map((element) => callsOf(canvas, element, "stroke").length);
    const item: InkItem = { kind: "outline", id: "new", layer: "pen", path, paint: penPaint };
    renderer.commitLive(applyInkChange(doc, inkAddChange(doc, [item])), inkAddChange(doc, [item]));

    expect(renderer.stats.commits).toBe(1);
    expect(renderer.stats.canvasAllocations).toBe(0);
    // The dry pen tile is now the canvas live ink painted; the old one was not painted again.
    const after = dryCanvases("pen");
    expect(after).toHaveLength(1);
    expect(callsOf(canvas, after[0], "stroke").length).toBeGreaterThan(0);
    expect(strokesBefore.every((count) => count === 1)).toBe(true);
    expect(after[0].style.visibility).toBe("");
  });

  it("stacks live tiles in tile order, whatever order the stroke reached them in, and the lift keeps that order", () => {
    make();
    renderer.setViewport(FITTED);
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };
    renderer.setDocument(doc);
    pump();

    // Canvases that abut meet in a seam row where each covers a hair of the other, so
    // the order they stack in is part of what is on screen: the lift must not change it.
    renderer.beginLive("pen");
    const start: InkPathCommand[] = [
      { op: "M", x: 500, y: 600 },
      { op: "L", x: 520, y: 600 },
    ];
    renderer.drawLive(start, penPaint);
    const path: InkPathCommand[] = [
      ...start,
      { op: "L", x: 520, y: 300 },
      { op: "L", x: 100, y: 300 },
      { op: "L", x: 100, y: 600 },
    ];
    renderer.drawLive(path, penPaint);

    const live = liveCanvases();
    const placeOf = (element: HTMLCanvasElement) => [parseFloat(element.style.top), parseFloat(element.style.left)];
    expect(live).toHaveLength(4);
    expect(live.map(placeOf)).toEqual([[0, 0], [0, 256], [256, 0], [256, 256]]);

    const item: InkItem = { kind: "outline", id: "new", layer: "pen", path, paint: penPaint };
    renderer.commitLive(applyInkChange(doc, inkAddChange(doc, [item])), inkAddChange(doc, [item]));
    const adopted = dryCanvases("pen").filter((element) => live.includes(element));
    expect(adopted).toHaveLength(live.length);
    adopted.forEach((element, index) => expect(element).toBe(live[index]));
  });

  it("hands the live tiles over for a stroke snapped to a shape, as for any stroke", () => {
    make();
    renderer.setViewport(FITTED);
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };
    renderer.setDocument(doc);
    pump();
    renderer.resetStats();

    const shape: InkItem = {
      kind: "shape",
      id: "circle",
      layer: "pen",
      color: black,
      width: 3,
      shape: { type: "ellipse", cx: 300, cy: 300, rx: 120, ry: 120, rotation: 0 },
    };
    renderer.beginLive("pen");
    renderer.drawLive(inkShapePath(shape.shape, shape.width), inkShapePaint(shape));
    const live = liveCanvases();
    expect(live.length).toBeGreaterThan(0);
    renderer.commitLive(applyInkChange(doc, inkAddChange(doc, [shape])), inkAddChange(doc, [shape]));

    expect(renderer.stats.canvasAllocations).toBe(0);
    const adopted = dryCanvases("pen").filter((element) => live.includes(element));
    expect(adopted).toHaveLength(live.length);
  });

  it("paints the committed item afresh when it is not what live ink drew", () => {
    make();
    renderer.setViewport(FITTED);
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };
    renderer.setDocument(doc);
    pump();
    renderer.beginLive("highlighter");
    renderer.drawLive(pathOf(line("live", "highlighter", 10, 100)), highlighterPaint);
    const traced = line("traced", "highlighter", 10, 100, 41);
    const change = inkAddChange(doc, [traced]);
    renderer.commitLive(applyInkChange(doc, change), change);
    const highlighter = dryCanvases("highlighter");
    expect(highlighter).toHaveLength(1);
    expect(callsOf(canvas, highlighter[0], "fill")).toHaveLength(1);
  });

  it("redraws only the tiles a change touches", () => {
    make();
    renderer.setViewport(ZOOMED);
    // Strokes across the screen, a stroke in one corner of it.
    const items: InkItem[] = [];
    for (let row = 0; row < 8; row += 1) items.push(line(`r${row}`, "pen", 200, 330 + row * 40, 480));
    items.push(line("corner", "pen", 210, 335, 10));
    const doc: InkDocument = { version: 3, items };
    renderer.setDocument(doc);
    pump();
    const onScreen = renderer.coverage().visible;
    renderer.resetStats();
    const change = inkRemoveChange(doc, ["corner"]);
    renderer.applyChange(applyInkChange(doc, change), change);
    expect(renderer.stats.changeTiles).toBeGreaterThan(0);
    expect(renderer.stats.changeTiles).toBeLessThan(onScreen);
    expect(renderer.stats.tileRenders).toBe(renderer.stats.changeTiles);
  });

  it("keeps the old zoom on screen, scaled, until the new one is drawn, then swaps", () => {
    make();
    renderer.setViewport(FITTED);
    renderer.setDocument({ version: 3, items: [line("p", "pen", 400, 500)] });
    pump();
    renderer.setViewport(ZOOMED);
    const groups = (layer: InkLayer) =>
      Array.from(host.querySelector("[data-ink-renderer]")!.children[layer === "highlighter" ? 0 : 1].children) as HTMLElement[];
    expect(groups("pen")).toHaveLength(2);
    const [old, pending] = groups("pen");
    expect(old.style.transform).toBe(`scale(${2.5 / 0.6})`);
    expect(pending.style.visibility).toBe("hidden");
    expect(renderer.idle).toBe(false);
    pump();
    expect(renderer.stats.levelSwaps).toBe(1);
    expect(groups("pen")).toHaveLength(1);
    expect(groups("pen")[0].style.transform).toBe("");
    expect(groups("pen")[0].style.visibility).toBe("");
  });

  it("draws a dense tile over several slices, and none runs far past its budget", () => {
    make();
    renderer.setViewport(FITTED);
    const items: InkItem[] = [];
    for (let i = 0; i < 40; i += 1) items.push(line(`p${i}`, "pen", 20 + i, 20 + i * 4));
    canvas.paintCost = 1;
    renderer.setDocument({ version: 3, items });
    pump();
    expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
    expect(renderer.stats.slices).toBeGreaterThan(5);
    expect(renderer.stats.sliceMsMax).toBeLessThanOrEqual(4);
  });

  it("stays inside a small memory budget by evicting tiles off screen", () => {
    const tileBytes = 512 * 512 * 4;
    // Room for a screenful (24 to 30 tiles) and a little of the ring.
    make({ budgetBytes: tileBytes * 40 });
    renderer.setViewport(ZOOMED);
    const items: InkItem[] = [];
    for (let y = 0; y < 1240; y += 60) for (let x = 0; x < 900; x += 100) items.push(line(`${x}-${y}`, "pen", x, y, 90));
    renderer.setDocument({ version: 3, items });
    pump();
    // Pan across the sheet so the ring keeps reaching new tiles.
    for (let left = 0; left <= 1000; left += 250) {
      renderer.setViewport({ ...ZOOMED, visible: { ...ZOOMED.visible, left } });
      pump();
    }
    expect(renderer.stats.evictions).toBeGreaterThan(0);
    expect(renderer.stats.peakCanvasBytes).toBeLessThanOrEqual(tileBytes * 40);
    expect(renderer.stats.budgetMisses).toBe(0);
    expect(renderer.coverage().drawn).toBe(renderer.coverage().visible);
  });
  it("swaps to a new zoom even when two layers on every tile cannot sit beside the old level", () => {
    // An iPad Pro 12.9 in portrait at 2x, in the default 96 MB budget.
    make();
    const screen = { left: 0, top: 0, width: 1024, height: 1366 };
    renderer.setViewport({ scale: 1.1, devicePixelRatio: 2, visible: { left: 0, top: 0, width: 990, height: 1364 } });
    const items: InkItem[] = [];
    for (let y = 10; y < 1230; y += 40) {
      for (let x = 10; x < 890; x += 60) {
        items.push(line(`h${x}-${y}`, "highlighter", x, y, 50));
        items.push(line(`p${x}-${y}`, "pen", x, y + 15, 50));
      }
    }
    renderer.setDocument({ version: 3, items });
    pump();
    renderer.setViewport({ scale: 2.2, devicePixelRatio: 2, visible: { ...screen, left: 300, top: 700 } });
    pump();
    // 35 tiles on screen with two layers each, beside the old level's stand-ins,
    // is more than the budget holds: the new level ran short, replaced the old
    // one anyway, and then had room to finish.
    expect(renderer.stats.budgetMisses).toBeGreaterThan(0);
    expect(renderer.stats.levelSwaps).toBe(1);
    expect(renderer.idle).toBe(true);
    expect(renderer.coverage().drawn).toBe(renderer.coverage().visible);
    expect(renderer.stats.peakCanvasBytes).toBeLessThanOrEqual(96_000_000);
    // A stroke afterwards still finds canvases without making any.
    renderer.resetStats();
    renderer.beginLive("pen");
    renderer.drawLive(pathOf(line("live", "pen", 300, 400, 300)), penPaint);
    expect(renderer.stats.canvasAllocations).toBe(0);
    renderer.cancelLive();
  });

  it("holds a change made mid-stroke until the lift, then paints the stroke afresh over the changed page", () => {
    make();
    renderer.setViewport(FITTED);
    const under = line("under", "pen", 30, 60);
    const doc: InkDocument = { version: 3, items: [under] };
    renderer.setDocument(doc);
    pump();
    renderer.beginLive("pen");
    const path: InkPathCommand[] = [
      { op: "M", x: 20, y: 60 },
      { op: "L", x: 120, y: 62 },
    ];
    renderer.drawLive(path, penPaint);
    // An undo with the pen down takes the stroke under it away.
    const erase = inkRemoveChange(doc, ["under"]);
    const erased = applyInkChange(doc, erase);
    const before = dryCanvases("pen")[0];
    renderer.applyChange(erased, erase);
    expect(dryCanvases("pen")[0]).toBe(before);
    expect(callsOf(canvas, before, "clearRect")).toHaveLength(1);
    const item: InkItem = { kind: "outline", id: "new", layer: "pen", path, paint: penPaint };
    const add = inkAddChange(erased, [item]);
    renderer.commitLive(applyInkChange(erased, add), add);
    pump();
    const pen = dryCanvases("pen");
    expect(pen).toHaveLength(1);
    // Whatever canvas shows the tile, what it last drew holds the new stroke and not the erased one.
    const calls = canvas.contexts.get(pen[0])!.calls;
    const lastClear = calls.map((call) => call.op).lastIndexOf("clearRect");
    const painted = calls.slice(lastClear).filter((call) => call.op === "stroke").map((call) => (call.args[0] as FakePath2D).commands);
    expect(painted).toContainEqual([
      ["M", 20, 60],
      ["L", 120, 62],
    ]);
    expect(painted).not.toContainEqual([
      ["M", 30, 60],
      ["L", 70, 60],
    ]);
  });

  it("holds a new document until the stroke ends", () => {
    make();
    renderer.setViewport(FITTED);
    renderer.setDocument({ version: 3, items: [line("old", "pen", 30, 60)] });
    pump();
    renderer.beginLive("pen");
    renderer.drawLive(pathOf(line("live", "pen", 20, 62)), penPaint);
    const shown = dryCanvases("pen");
    renderer.setDocument({ version: 3, items: [line("next", "pen", 600, 900)] });
    expect(dryCanvases("pen")).toEqual(shown);
    renderer.cancelLive();
    pump();
    expect(renderer.stats.visibleReadyMs).not.toBeNull();
    expect(dryCanvases("pen")).toHaveLength(1);
    expect(dryCanvases("pen")[0].style.left).toBe("256px");
  });

  it("redraws a tile that comes on screen showing older ink without ever showing it half drawn", () => {
    make();
    renderer.setViewport(ZOOMED);
    // Tile (7, 4) is in the ring just right of the screen: page x 716.8 to 819.2, y 409.6 to 512.
    const items: InkItem[] = [];
    for (let i = 0; i < 30; i += 1) items.push(line(`t${i}`, "pen", 730, 420 + i * 3, 60));
    const doc: InkDocument = { version: 3, items };
    renderer.setDocument(doc);
    pump();
    const tileCanvas = () => dryCanvases("pen").find((element) => element.style.left === `${(7 * 512) / 2}px` && element.style.top === `${(4 * 512) / 2}px`);
    const old = tileCanvas();
    expect(old).toBeDefined();
    const clears = callsOf(canvas, old!, "clearRect").length;
    const erase = inkRemoveChange(doc, ["t0"]);
    renderer.applyChange(applyInkChange(doc, erase), erase);
    canvas.paintCost = 1;
    renderer.setViewport({ ...ZOOMED, visible: { ...ZOOMED.visible, left: 1000 } });
    let swappedAt = -1;
    for (let step = 0; posted.length > 0 && step < 1000; step += 1) {
      posted.shift()!();
      if (old!.isConnected) expect(callsOf(canvas, old!, "clearRect")).toHaveLength(clears);
      else if (swappedAt < 0) swappedAt = step;
    }
    expect(swappedAt).toBeGreaterThan(0);
    expect(renderer.stats.slices).toBeGreaterThan(2);
    expect(tileCanvas()).not.toBe(old);
    expect(renderer.coverage().drawn).toBe(renderer.coverage().visible);
  });
  describe("with every canvas the budget allows in use", () => {
    const tileBytes = 512 * 512 * 4;
    /** A short line in the middle of each of the 9 fitted tiles (427 page units a side). */
    const everyTile = (layer: InkLayer) => {
      const items: InkItem[] = [];
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) items.push(line(`${layer}${col}${row}`, layer, col * 427 + 150, row * 427 + 150));
      }
      return items;
    };

    it("draws a tile's pen layer before its highlighter, and retries the rest when a canvas comes back", () => {
      make({ budgetBytes: tileBytes * 9 });
      renderer.setViewport(FITTED);
      const doc: InkDocument = { version: 3, items: [...everyTile("highlighter"), ...everyTile("pen")] };
      renderer.setDocument(doc);
      pump();
      // 18 canvases wanted, 9 to be had: every tile that got any got its pen layer.
      expect(renderer.coverage().drawn).toBeLessThan(9);
      expect(dryCanvases("pen").length).toBeGreaterThan(dryCanvases("highlighter").length);
      expect(renderer.stats.budgetMisses).toBeGreaterThan(0);

      // Taking the highlighter off gives canvases back; the waiting tiles are retried.
      const erase = inkRemoveChange(doc, everyTile("highlighter").map((item) => item.id));
      renderer.applyChange(applyInkChange(doc, erase), erase);
      pump();
      expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
      expect(dryCanvases("pen")).toHaveLength(9);
      expect(dryCanvases("highlighter")).toHaveLength(0);
    });

    it("paints the stroke at the lift into a tile live ink had no canvas for, and allocates nothing", () => {
      make({ budgetBytes: tileBytes * 9 });
      renderer.setViewport(FITTED);
      const doc: InkDocument = { version: 3, items: everyTile("pen") };
      renderer.setDocument(doc);
      pump();
      expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
      renderer.resetStats();
      renderer.beginLive("pen");
      const path: InkPathCommand[] = [
        { op: "M", x: 40, y: 60 },
        { op: "L", x: 120, y: 64 },
      ];
      renderer.drawLive(path, penPaint);
      expect(renderer.stats.canvasAllocations).toBe(0);
      const item: InkItem = { kind: "outline", id: "new", layer: "pen", path, paint: penPaint };
      const add = inkAddChange(doc, [item]);
      renderer.commitLive(applyInkChange(doc, add), add);
      const corner = dryCanvases("pen").find((element) => element.style.left === "0px" && element.style.top === "0px")!;
      const painted = callsOf(canvas, corner, "stroke").map((call) => (call.args[0] as FakePath2D).commands);
      expect(painted).toContainEqual([
        ["M", 40, 60],
        ["L", 120, 64],
      ]);
      expect(renderer.stats.canvasAllocations).toBe(0);
    });
  });

  it("frees every canvas, those lent to a stroke included, when destroyed with the pen down", () => {
    make();
    renderer.setViewport(FITTED);
    renderer.setDocument({ version: 3, items: [line("p", "pen", 30, 30)] });
    pump();
    renderer.beginLive("pen");
    renderer.drawLive(pathOf(line("live", "pen", 20, 40, 300)), penPaint);
    expect(renderer.stats.canvasBytes).toBeGreaterThan(0);
    renderer.destroy();
    expect(renderer.stats.canvasBytes).toBe(0);
  });

  describe("with a page of its own size", () => {
    const tall = { left: 0, top: 0, width: 540, height: 1200 };

    it("draws the tiles of a taller page than the notebook's, ink at its foot included", () => {
      make({ page: { width: 900, height: 2000 } });
      renderer.setViewport({ ...FITTED, visible: tall });
      // 2000 units at 1.2 device pixels a unit is five tiles of 512 down; the notebook's page is three.
      renderer.setDocument({ version: 3, items: [line("foot", "pen", 100, 1900)] });
      pump();
      expect(renderer.coverage()).toEqual({ visible: 15, drawn: 15 });
      expect(atTile(dryCanvases("pen"), 0, 4)).toBeDefined();
    });

    it("keeps the notebook's 900 x 1240 page when none is given", () => {
      make();
      renderer.setViewport({ ...FITTED, visible: tall });
      renderer.setDocument({ version: 3, items: [] });
      pump();
      expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
    });
  });

  describe("the predicted tip", () => {
    // 1.2 device pixels a unit: tile (0,0) ends at page x 426.7.
    const stroke: InkPathCommand[] = [
      { op: "M", x: 380, y: 100 },
      { op: "L", x: 400, y: 100 },
    ];
    const strokeCommands = [
      ["M", 380, 100],
      ["L", 400, 100],
    ];
    const tipFrom = (x: number, to: number): InkLiveTip => ({
      path: [
        { op: "M", x, y: 100 },
        { op: "L", x: to, y: 100 },
      ],
      paint: penPaint,
    });
    const tipCommands = (x: number, to: number) => [
      ["M", x, 100],
      ["L", to, 100],
    ];

    function start() {
      make();
      renderer.setViewport(FITTED);
      const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 300)] };
      renderer.setDocument(doc);
      pump();
      renderer.resetStats();
      renderer.beginLive("pen");
      return doc;
    }

    it("draws the tip after the stroke, in every tile either reaches and no other", () => {
      start();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      expect(liveCanvases()).toHaveLength(2);
      expect(strokesOf(atTile(liveCanvases(), 0, 0)!)).toEqual([strokeCommands, tipCommands(400, 440)]);
      // The stroke does not reach the next tile; its tip does.
      expect(strokesOf(atTile(liveCanvases(), 1, 0)!)).toEqual([tipCommands(400, 440)]);
      expect(renderer.stats.canvasAllocations).toBe(0);
    });

    it("repaints where the tip was and where it is, and nothing when neither moved", () => {
      start();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 415));
      expect(liveCanvases()).toHaveLength(1);
      const first = atTile(liveCanvases(), 0, 0)!;
      // The tip grows into the next tile; the stroke is as it was.
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      const second = atTile(liveCanvases(), 1, 0)!;
      expect(strokesOf(second)).toEqual([tipCommands(400, 440)]);
      // The same packet again changes nothing, in either tile.
      const calls = () => [canvas.contexts.get(first)!.calls.length, canvas.contexts.get(second)!.calls.length];
      const before = calls();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      expect(calls()).toEqual(before);
      // The tip leaves that tile: it is repainted without it.
      renderer.drawLive(stroke, penPaint, tipFrom(400, 415));
      const after = canvas.contexts.get(second)!.calls;
      const lastClear = after.map((call) => call.op).lastIndexOf("clearRect");
      expect(lastClear).toBeGreaterThanOrEqual(0);
      expect(after.slice(lastClear).filter((call) => call.op === "stroke")).toHaveLength(0);
      expect(strokesOf(first).at(-1)).toEqual(tipCommands(400, 415));
    });

    it("takes the tip away at the lift, from every tile it touched, and lifts the stroke as it would have", () => {
      const doc = start();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      const item: InkItem = { kind: "outline", id: "new", layer: "pen", path: stroke, paint: penPaint };
      const add = inkAddChange(doc, [item]);
      renderer.commitLive(applyInkChange(doc, add), add);
      expect(renderer.stats.canvasAllocations).toBe(0);
      // The tip's tile has no ink of its own: nothing of the tip is left in the dry layer.
      expect(atTile(dryCanvases("pen"), 1, 0)).toBeUndefined();
      const lifted = atTile(dryCanvases("pen"), 0, 0)!;
      const calls = canvas.contexts.get(lifted)!.calls;
      const lastClear = calls.map((call) => call.op).lastIndexOf("clearRect");
      const painted = calls
        .slice(lastClear)
        .filter((call) => call.op === "stroke")
        .map((call) => (call.args[0] as FakePath2D).commands);
      expect(painted).toEqual([strokeCommands]);
      expect(liveCanvases()).toHaveLength(0);
    });

    it("paints the committed item afresh when it is not what live ink drew, and the tip stays with the live tiles", () => {
      const doc = start();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      const traced: InkItem = {
        kind: "outline",
        id: "traced",
        layer: "pen",
        path: [
          { op: "M", x: 380, y: 100 },
          { op: "L", x: 401, y: 100 },
        ],
        paint: penPaint,
      };
      const add = inkAddChange(doc, [traced]);
      renderer.commitLive(applyInkChange(doc, add), add);
      expect(atTile(dryCanvases("pen"), 1, 0)).toBeUndefined();
      const calls = canvas.contexts.get(atTile(dryCanvases("pen"), 0, 0)!)!.calls;
      const painted = calls
        .slice(calls.map((call) => call.op).lastIndexOf("clearRect"))
        .filter((call) => call.op === "stroke")
        .map((call) => (call.args[0] as FakePath2D).commands);
      // The page's own line, then the committed item painted onto the dry tile: nothing of the tip.
      expect(painted).toEqual([
        [
          ["M", 30, 300],
          ["L", 70, 300],
        ],
        [
          ["M", 380, 100],
          ["L", 401, 100],
        ],
      ]);
      expect(liveCanvases()).toHaveLength(0);
    });

    it("lifts a stroke with no tip as before: the live tile is handed over and nothing is painted", () => {
      const doc = start();
      renderer.drawLive(stroke, penPaint);
      const live = atTile(liveCanvases(), 0, 0)!;
      const before = canvas.contexts.get(live)!.calls.length;
      const item: InkItem = { kind: "outline", id: "new", layer: "pen", path: stroke, paint: penPaint };
      const add = inkAddChange(doc, [item]);
      renderer.commitLive(applyInkChange(doc, add), add);
      expect(atTile(dryCanvases("pen"), 0, 0)).toBe(live);
      expect(canvas.contexts.get(live)!.calls).toHaveLength(before);
    });

    it("lifts a stroke whose tip was taken away just as one that never had a tip", () => {
      const doc = start();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      renderer.drawLive(stroke, penPaint, null);
      const live = atTile(liveCanvases(), 0, 0)!;
      const before = canvas.contexts.get(live)!.calls.length;
      const item: InkItem = { kind: "outline", id: "new", layer: "pen", path: stroke, paint: penPaint };
      const add = inkAddChange(doc, [item]);
      renderer.commitLive(applyInkChange(doc, add), add);
      expect(atTile(dryCanvases("pen"), 0, 0)).toBe(live);
      expect(canvas.contexts.get(live)!.calls).toHaveLength(before);
    });

    it("is gone when the stroke is cancelled, and the dry tiles show again", () => {
      start();
      renderer.drawLive(stroke, penPaint, tipFrom(400, 440));
      expect(dryCanvases("pen").some((element) => element.style.visibility === "hidden")).toBe(true);
      renderer.cancelLive();
      expect(liveCanvases()).toHaveLength(0);
      expect(dryCanvases("pen").every((element) => element.style.visibility === "")).toBe(true);
      expect(renderer.stats.canvasAllocations).toBe(0);
    });

    it("draws no tip that paints nothing", () => {
      start();
      renderer.drawLive(stroke, penPaint, { path: [], paint: penPaint });
      expect(strokesOf(atTile(liveCanvases(), 0, 0)!)).toEqual([strokeCommands]);
    });
  });

  describe("whenVisibleDrawn", () => {
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };

    it("calls back once, after every visible tile is drawn, and not before", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      const done = vi.fn();
      renderer.whenVisibleDrawn(done);
      await microtasks();
      expect(done).not.toHaveBeenCalled();
      pump();
      expect(done).not.toHaveBeenCalled();
      await microtasks();
      expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
      expect(done).toHaveBeenCalledTimes(1);
      // Later draws do not call it again.
      renderer.setViewport({ ...FITTED, visible: { ...FITTED.visible, left: 100 } });
      pump();
      await microtasks();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("calls back on the next microtask when the page is already drawn", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      pump();
      const done = vi.fn();
      renderer.whenVisibleDrawn(done);
      expect(done).not.toHaveBeenCalled();
      await microtasks();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("can be cancelled, before and after it is due", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      const early = vi.fn();
      renderer.whenVisibleDrawn(early)();
      pump();
      const queued = vi.fn();
      const cancel = renderer.whenVisibleDrawn(queued);
      cancel();
      await microtasks();
      expect(early).not.toHaveBeenCalled();
      expect(queued).not.toHaveBeenCalled();
    });

    it("waits while a new zoom is drawn behind the old one, then calls back", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      pump();
      renderer.setViewport(ZOOMED);
      const done = vi.fn();
      renderer.whenVisibleDrawn(done);
      await microtasks();
      expect(done).not.toHaveBeenCalled();
      pump();
      await microtasks();
      expect(renderer.stats.levelSwaps).toBe(1);
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("waits for a new page set just after it was asked", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      pump();
      const done = vi.fn();
      renderer.whenVisibleDrawn(done);
      renderer.setDocument({ version: 3, items: [line("next", "pen", 600, 900)] });
      await microtasks();
      expect(done).not.toHaveBeenCalled();
      pump();
      await microtasks();
      expect(done).toHaveBeenCalledTimes(1);
      expect(renderer.coverage()).toEqual({ visible: 9, drawn: 9 });
    });

    it("calls back for a page with no ink, once its empty tiles are drawn", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument({ version: 3, items: [] });
      const done = vi.fn();
      renderer.whenVisibleDrawn(done);
      pump();
      await microtasks();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("never calls back once destroyed", async () => {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      const done = vi.fn();
      renderer.whenVisibleDrawn(done);
      renderer.destroy();
      pump();
      await microtasks();
      expect(done).not.toHaveBeenCalled();
    });
  });

  describe("the GPU warm-up", () => {
    const doc: InkDocument = { version: 3, items: [line("p", "pen", 30, 30)] };

    function open() {
      make();
      renderer.setViewport(FITTED);
      renderer.setDocument(doc);
      pump();
      renderer.resetStats();
    }

    it("does nothing until asked", () => {
      open();
      expect(liveCanvases()).toHaveLength(0);
      expect(frameCallbacks.size).toBe(0);
      expect(renderer.idle).toBe(true);
    });

    it("puts a spare canvas on screen over a visible tile, draws every live-ink path on it, and ends after two frames", () => {
      open();
      const bytes = renderer.stats.canvasBytes;
      renderer.warmUp();
      renderer.warmUp();
      expect(renderer.idle).toBe(false);
      pump();
      // One canvas, over the tile nearest the middle (tile 1:1 of the fitted sheet).
      const [overlay, ...others] = liveCanvases();
      expect(others).toHaveLength(0);
      expect([overlay.style.left, overlay.style.top]).toEqual(["256px", "256px"]);
      const ops = canvas.contexts.get(overlay)!.calls.map((call) => call.op);
      expect(ops.filter((op) => op === "drawImage")).toHaveLength(2);
      expect(ops.filter((op) => op === "fill")).toHaveLength(2);
      expect(ops.filter((op) => op === "stroke")).toHaveLength(1);
      expect(frameCallbacks.size).toBe(1);
      // It is drawn on and left: wiped in the task it was drawn in, the drawing would be thrown away unseen.
      const clearsWhileUp = ops.filter((op) => op === "clearRect").length;
      expect(canvas.contexts.get(overlay)!.calls.at(-1)).toMatchObject({ op: "clearRect", args: [40, 40, 200, 160] });
      runFrame();
      expect(overlay.isConnected).toBe(true);
      expect(renderer.idle).toBe(false);
      runFrame();
      expect(overlay.isConnected).toBe(false);
      expect(renderer.idle).toBe(true);
      // Wiped after the frames that showed it, and nothing was made or kept for it.
      const after = canvas.contexts.get(overlay)!.calls;
      expect(after.filter((call) => call.op === "clearRect").length).toBeGreaterThan(clearsWhileUp);
      expect(after.at(-1)).toMatchObject({ op: "clearRect", args: [0, 0, 512, 512] });
      expect(renderer.stats.canvasAllocations).toBe(0);
      expect(renderer.stats.canvasBytes).toBe(bytes);
      // Once is enough.
      renderer.warmUp();
      pump();
      expect(liveCanvases()).toHaveLength(0);
    });

    it("draws in three steps, each in a slice of its own, and waits for frames only when all is drawn", () => {
      open();
      renderer.warmUp();
      // On a canvas drawn in software, drawing costs its time at once: the canvas goes up, then the whole copy, then the rest.
      posted.shift()!();
      const [overlay] = liveCanvases();
      const ops = () => canvas.contexts.get(overlay)!.calls.map((call) => call.op);
      expect(ops()).toEqual([]);
      expect(renderer.idle).toBe(false);
      posted.shift()!();
      expect(ops().filter((op) => op === "drawImage")).toHaveLength(1);
      expect(ops()).not.toContain("fill");
      expect(frameCallbacks.size).toBe(0);
      posted.shift()!();
      expect(ops().filter((op) => op === "drawImage")).toHaveLength(2);
      expect(ops().filter((op) => op === "fill")).toHaveLength(2);
      expect(frameCallbacks.size).toBe(1);
    });

    it("runs in the background, after the page's tiles are drawn", () => {
      make();
      renderer.setViewport(FITTED);
      // Ink in every tile, each costing a slice's worth, so the tiles take several slices.
      const items: InkItem[] = [];
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) items.push(line(`t${col}${row}`, "pen", col * 427 + 150, row * 427 + 150));
      }
      canvas.paintCost = 2;
      renderer.setDocument({ version: 3, items });
      renderer.warmUp();
      expect(liveCanvases()).toHaveLength(0);
      let slices = 0;
      while (posted.length > 0 && renderer.coverage().drawn < renderer.coverage().visible) {
        posted.shift()!();
        slices += 1;
        // Not until every visible tile is drawn.
        if (renderer.coverage().drawn < renderer.coverage().visible) expect(liveCanvases()).toHaveLength(0);
      }
      expect(slices).toBeGreaterThan(2);
      pump();
      expect(liveCanvases()).toHaveLength(1);
    });

    it("makes no canvas and takes none from a tile: with none spare it does nothing", () => {
      const tileBytes = 512 * 512 * 4;
      make({ budgetBytes: tileBytes * 9 });
      renderer.setViewport(FITTED);
      const items: InkItem[] = [];
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) items.push(line(`t${col}${row}`, "pen", col * 427 + 150, row * 427 + 150));
      }
      renderer.setDocument({ version: 3, items });
      pump();
      renderer.resetStats();
      renderer.warmUp();
      pump();
      expect(liveCanvases()).toHaveLength(0);
      expect(renderer.stats.canvasAllocations).toBe(0);
      expect(renderer.stats.evictions).toBe(0);
      expect(dryCanvases("pen")).toHaveLength(9);
    });

    it("gives the canvas back at once when a stroke begins, and does not start again", () => {
      open();
      renderer.warmUp();
      pump();
      const [overlay] = liveCanvases();
      expect(overlay).toBeDefined();
      renderer.beginLive("pen");
      expect(overlay.isConnected).toBe(false);
      expect(frameCallbacks.size).toBe(0);
      renderer.drawLive(pathOf(line("live", "pen", 20, 40, 100)), penPaint);
      expect(renderer.stats.canvasAllocations).toBe(0);
      expect(liveCanvases().every((element) => element !== overlay)).toBe(true);
      renderer.cancelLive();
      pump();
      expect(liveCanvases()).toHaveLength(0);
      expect(frameCallbacks.size).toBe(0);
      expect(renderer.idle).toBe(true);
    });

    it("never starts during a stroke", () => {
      open();
      renderer.beginLive("pen");
      renderer.drawLive(pathOf(line("live", "pen", 20, 40, 100)), penPaint);
      const during = liveCanvases().length;
      renderer.warmUp();
      pump();
      expect(liveCanvases()).toHaveLength(during);
      expect(frameCallbacks.size).toBe(0);
      renderer.cancelLive();
      pump();
      expect(liveCanvases()).toHaveLength(0);
    });

    it("gives the canvas back when a gesture begins, and tries again after it", () => {
      open();
      renderer.warmUp();
      pump();
      const [overlay] = liveCanvases();
      renderer.beginGesture();
      expect(overlay.isConnected).toBe(false);
      expect(frameCallbacks.size).toBe(0);
      pump();
      expect(liveCanvases()).toHaveLength(0);
      renderer.endGesture();
      pump();
      expect(liveCanvases()).toHaveLength(1);
      runFrame();
      runFrame();
      expect(liveCanvases()).toHaveLength(0);
      expect(renderer.idle).toBe(true);
    });

    it("gives the canvas back before the sheet changes under it, a new density included", () => {
      open();
      renderer.warmUp();
      pump();
      const [overlay] = liveCanvases();
      // A different density makes every pooled canvas the wrong size: the overlay must not rejoin the pool.
      renderer.setViewport({ ...FITTED, devicePixelRatio: 1 });
      expect(overlay.isConnected).toBe(false);
      pump();
      runFrame();
      runFrame();
      expect(renderer.idle).toBe(true);
      for (const element of liveCanvases()) expect(element.width).toBe(256);
    });

    it("frees every canvas when destroyed with the warm-up up", () => {
      open();
      renderer.warmUp();
      pump();
      expect(liveCanvases()).toHaveLength(1);
      renderer.destroy();
      expect(renderer.stats.canvasBytes).toBe(0);
      expect(frameCallbacks.size).toBe(0);
    });
  });
});
