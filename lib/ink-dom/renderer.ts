/**
 * Jami Ink's renderer: draws an {@link InkDocument} on a notebook sheet, and
 * the stroke being written on top of it. Imperative and outside React; it has
 * no pointer input and reads no layout. Whoever drives it (`InkSurface`, in
 * stage 4) tells it where the sheet is, what changed, and what the pen did.
 *
 * - Dry ink is drawn into tiles (`tile-store.ts`) at the settled zoom: what is
 *   on screen first, nearest the middle first, then a ring around it, in
 *   slices of at most 4 ms (`scheduler.ts`), never during a stroke or gesture.
 * - Live ink (`live-layer.ts`) is drawn synchronously on every packet, the
 *   whole stroke painted again in every tile where it changed: the pen's shape
 *   depends on the whole stroke, so nothing of it is taken as final.
 * - At the lift the live tiles holding the stroke become the dry tiles, in the
 *   same call, so nothing on screen changes. Items that are not exactly what
 *   live ink drew (a highlighter traced into one outline) are painted afresh.
 * - A new zoom is drawn behind the old one, which stays up scaled until every
 *   tile on screen is ready, then replaces it in one go. Never blank.
 * - A document change redraws only the tiles it touches: those on screen at
 *   once, the rest when they are next needed.
 * - The predicted tip is drawn after the stroke in the same live tiles. The
 *   lift repaints the tiles it touched with the stroke alone, then lifts as
 *   usual, so the tip never reaches a dry tile.
 *
 * The plan of which tiles, at what size and in what order is pure, in
 * `lib/ink/render-plan.ts`.
 */

import type { InkChange } from "@/lib/ink/history";
import {
  inkBoxGrow,
  inkItemBounds,
  inkItemLayer,
  inkStrokeReach,
  type InkBox,
  type InkDocument,
  type InkItem,
  type InkLayer,
  type InkPaint,
  type InkPathCommand,
} from "@/lib/ink/model";
import { inkPathChange, sameInkPath } from "@/lib/ink/path-change";
import {
  INK_CANVAS_BUDGET_BYTES,
  INK_DEFAULT_PAGE,
  INK_PREFETCH_RING_TILES,
  inkBoxDeviceRect,
  inkDevicePixelSnap,
  inkDeviceRectUnion,
  inkLevelStandInScale,
  inkLiveTileCount,
  inkPrefetchTiles,
  inkRenderLevel,
  inkTileCapacity,
  inkTileDeviceRect,
  inkTilesForBox,
  inkVisibleAtLevel,
  inkVisibleTiles,
  type InkDeviceRect,
  type InkPageSize,
  type InkRenderLevel,
  type InkSheetRect,
  type InkTile,
} from "@/lib/ink/render-plan";
import { InkCanvasLedger } from "@/lib/ink-dom/canvas";
import { InkDocumentIndex } from "@/lib/ink-dom/document-index";
import { isInkLiveStroke, sameInkPaint } from "@/lib/ink-dom/lift";
import { INK_LAYER_Z, InkLiveLayer, type InkLiveTileRegion, type InkLiveTipPath } from "@/lib/ink-dom/live-layer";
import {
  browserPathFactory,
  buildInkPath,
  InkDrawableCache,
  type InkPath2D,
  type InkPathFactory,
} from "@/lib/ink-dom/rasterizer";
import {
  createInkMessagePoster,
  createInkScheduler,
  INK_PRIORITY_IDLE,
  INK_PRIORITY_PREFETCH,
  INK_PRIORITY_VISIBLE,
} from "@/lib/ink-dom/scheduler";
import { emptyInkRendererStats, resetInkRendererStats, type InkRendererStats } from "@/lib/ink-dom/stats";
import { InkLevelTiles, InkTileStore } from "@/lib/ink-dom/tile-store";
import { InkWarmUp } from "@/lib/ink-dom/warm-up";

export type { InkPageSize };

export type InkViewport = {
  /** CSS pixels per page unit at the settled zoom. */
  scale: number;
  devicePixelRatio: number;
  /** The part of the sheet on screen, in sheet CSS pixels. */
  visible: InkSheetRect;
  /**
   * Where the sheet's top-left corner is on screen, in CSS pixels. When
   * given, the ink is nudged by under a pixel so its canvases sit on whole
   * device pixels; a canvas between pixels is resampled and looks soft.
   */
  screenOrigin?: { x: number; y: number };
};

export type InkRendererOptions = {
  /** The size of the page in page units. Default 900 x 1240, the notebook page. */
  page?: InkPageSize;
  budgetBytes?: number;
  prefetchRing?: number;
  /**
   * Spare tile canvases kept ready for live ink, so a stroke need not
   * allocate. A screenful by default.
   */
  spareCanvases?: number;
  /** For tests: the clock, how slices are posted, and how paths are built. */
  now?: () => number;
  post?: (callback: () => void) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  pathFactory?: InkPathFactory;
};

/**
 * The predicted tip: a short round-capped stroked path, drawn after the
 * stroke in the same live tiles. It is never part of what the lift keeps.
 */
export type InkLiveTip = { path: InkPathCommand[]; paint: InkPaint };

export type InkRenderer = {
  /** Shows a new document (opening a page). Everything drawn before is let go. */
  setDocument(doc: InkDocument): void;
  /** Shows `doc`, which is `change` applied to the current document. */
  applyChange(doc: InkDocument, change: InkChange): void;
  /** Where the sheet is and how it is zoomed, once a gesture has settled. */
  setViewport(viewport: InkViewport): void;
  /** Holds background drawing while a pinch or pan moves the sheet. */
  beginGesture(): void;
  endGesture(): void;
  /** A stroke starts on `layer`. Background drawing waits until it ends. */
  beginLive(layer: InkLayer): void;
  /**
   * The whole stroke as it now stands, drawn before this returns, and the
   * predicted `tip` (if any) after it. Pass no tip, or null, to take it away.
   */
  drawLive(path: InkPathCommand[], paint: InkPaint, tip?: InkLiveTip | null): void;
  /**
   * The lift: `doc` is `change` applied to the current document, adding the
   * stroke. On its tiles, and the live layer cleared, before this returns. A
   * tip showing from the last packet is wiped first, from the tiles it
   * touched; with no tip showing the lift is exactly as it always was.
   */
  commitLive(doc: InkDocument, change: InkChange): void;
  cancelLive(): void;
  readonly stats: InkRendererStats;
  resetStats(): void;
  /**
   * The tiles of the level on screen that the screen needs, and how many of
   * them are drawn: equal means nothing on screen is waiting to be drawn.
   */
  coverage(): { visible: number; drawn: number };
  /**
   * Calls `callback` once, when every visible tile of the level on screen is
   * drawn and no new zoom waits to replace it: after `setDocument` and
   * `setViewport`, the page is showing all its ink. If that is already so,
   * on the next microtask. Returns a function that cancels it.
   */
  whenVisibleDrawn(callback: () => void): () => void;
  /**
   * Compiles the GPU's shaders for every drawing path live ink uses, so the
   * first stroke does not stall on them. Runs once, in the background after
   * the page's ink is drawn, and never during a stroke or gesture.
   */
  warmUp(): void;
  /** Nothing queued (a warm-up in progress included) and no zoom level waiting to replace the one on screen. */
  readonly idle: boolean;
  destroy(): void;
};

/** The tip a packet showed: as given, built, and where it can paint. */
type LiveTip = InkLiveTipPath & { commands: InkPathCommand[] };

type Live = {
  layer: InkLayer;
  /**
   * The last packet: its commands and paint as given, the path built from
   * them, where the stroke alone can paint, and the tip shown with it.
   */
  last: {
    commands: InkPathCommand[];
    paint: InkPaint;
    path: InkPath2D;
    area: InkDeviceRect | null;
    tip: LiveTip | null;
  } | null;
};

function sameLiveTip(a: LiveTip | null, b: LiveTip | null): boolean {
  if (!a || !b) return a === b;
  return sameInkPaint(a.paint, b.paint) && sameInkPath(a.commands, b.commands);
}

/** The stroke being lifted, and the live tiles holding its pixels, by tile key. */
type Lift = { item: InkItem; layer: InkLayer; tiles: Map<string, InkLiveTileRegion> };

/** The tip as a packet shows it: built, with the device area it can paint; null when it paints nothing. */
function liveTipOf(
  tip: InkLiveTip,
  reach: (box: InkBox, stroke: InkPaint["stroke"]) => InkDeviceRect | null,
  factory: InkPathFactory
): LiveTip | null {
  const built = buildInkPath(tip.path, factory);
  const area = built.hull ? reach(built.hull, tip.paint.stroke) : null;
  return area ? { commands: tip.path, paint: tip.paint, path: built.path, area } : null;
}

export function createInkRenderer(host: HTMLElement, options: InkRendererOptions = {}): InkRenderer {
  const doc = host.ownerDocument;
  const now = options.now ?? (() => performance.now());
  const budgetBytes = options.budgetBytes ?? INK_CANVAS_BUDGET_BYTES;
  const prefetchRing = options.prefetchRing ?? INK_PREFETCH_RING_TILES;
  const spares = options.spareCanvases;
  const poster = options.post ? null : createInkMessagePoster();
  const pathFactory = options.pathFactory ?? browserPathFactory;
  const page = options.page ?? INK_DEFAULT_PAGE;

  const stats = emptyInkRendererStats();
  const ledger = new InkCanvasLedger(doc, stats);
  const drawables = new InkDrawableCache(pathFactory);
  const index = new InkDocumentIndex();
  const scheduler = createInkScheduler({
    now,
    post: options.post ?? poster!.post,
    onSlice(durationMs) {
      stats.slices += 1;
      stats.sliceMsMax = Math.max(stats.sliceMsMax, durationMs);
      notifyVisible();
    },
  });

  const root = doc.createElement("div");
  root.setAttribute("data-ink-renderer", "");
  Object.assign(root.style, {
    position: "absolute",
    left: "0",
    top: "0",
    pointerEvents: "none",
    isolation: "isolate",
  });
  const layerRoot = (z: number) => {
    const element = doc.createElement("div");
    Object.assign(element.style, { position: "absolute", left: "0", top: "0", zIndex: String(z) });
    root.appendChild(element);
    return element;
  };
  const parents: Record<InkLayer, HTMLDivElement> = {
    highlighter: layerRoot(INK_LAYER_Z.dryHighlighter),
    pen: layerRoot(INK_LAYER_Z.dryPen),
  };
  const liveLayer = new InkLiveLayer(layerRoot(INK_LAYER_Z.livePen));
  host.appendChild(root);

  let store: InkTileStore | null = null;
  let viewport: { level: InkRenderLevel; visible: InkSheetRect } | null = null;
  let displayed: InkLevelTiles | null = null;
  let pending: InkLevelTiles | null = null;
  /** Visible tiles of the displayed level, as last planned. */
  let displayedVisible = new Set<string>();
  let live: Live | null = null;
  let warmWanted = false;
  let deferredViewport: InkViewport | null = null;
  /** Document changes that arrived during a stroke, applied when it ends. */
  const deferredDocument: Array<
    { kind: "document"; doc: InkDocument } | { kind: "change"; doc: InkDocument; change: InkChange }
  > = [];
  let documentStart: number | null = null;
  let destroyed = false;

  const query = (layer: InkLayer, box: InkBox) => index.query(layer, box);

  /** Waiting for every visible tile to be drawn (`whenVisibleDrawn`). */
  const visibleWaiters = new Set<() => void>();

  /** The level on screen shows every tile the screen needs, for the page and viewport as last given. */
  const visibleDrawn = () => {
    if (destroyed || !displayed || !viewport || pending) return false;
    if (deferredDocument.length > 0 || deferredViewport) return false;
    const level = displayed;
    return inkVisibleTiles(level.level, viewport.visible).every((tile) => level.isDrawn(tile));
  };

  const notifyVisible = () => {
    if (visibleWaiters.size === 0 || !visibleDrawn()) return;
    for (const waiter of Array.from(visibleWaiters)) waiter();
  };

  /** Tiles on screen whose draw found no canvas to spare, waiting for one. */
  const starved = new Map<string, { level: InkLevelTiles; tile: InkTile }>();
  /** Set while a tile draws: canvases it gives back on failing are no reason to retry. */
  let drawing = false;
  /**
   * A canvas came back to the pool (or the budget grew): retry the starved
   * tiles, in the background, so never during a stroke or gesture. Nothing
   * freed, nothing retried, so a tile that cannot fit does not spin.
   */
  const onCanvasFreed = () => {
    if (drawing || starved.size === 0) return;
    scheduler.enqueue("retry", INK_PRIORITY_IDLE, () => {
      for (const { level, tile } of starved.values()) {
        if ((level === displayed || level === pending) && !level.isDrawn(tile)) queueTile(level, tile, INK_PRIORITY_VISIBLE);
      }
      starved.clear();
    });
  };

  const newLevel = (level: InkRenderLevel) => {
    const tiles = new InkLevelTiles(level, parents, doc);
    store!.addLevel(tiles);
    return tiles;
  };

  /** What `displayed` must show: the screen, as laid out at its own zoom. */
  const displayedVisibleRect = (): InkSheetRect | null => {
    if (!viewport || !displayed) return null;
    return pending ? inkVisibleAtLevel(viewport.visible, displayed.level, pending.level) : viewport.visible;
  };

  const placeLive = () => {
    const visible = displayedVisibleRect();
    if (!displayed || !visible || !viewport) return;
    // While a new zoom draws, the live layer follows the old level so a lift
    // lands on the pixels it was drawn on.
    const scale = pending ? inkLevelStandInScale(displayed.level, pending.level) : 1;
    liveLayer.place(displayed.level, inkVisibleTiles(displayed.level, visible), scale);
    // Live ink borrows from the same pool as the dry tiles, so nothing is
    // reserved. 96 MB is 91 tiles of 512 pixels: two layers on up to 45 tiles
    // on screen (a 1180 x 820 screen at 2x meets at most 30, an iPad Pro 35).
    // Past that, tiles draw their pen layer first and wait for a canvas.
    store!.setCapacity(inkTileCapacity({ tilePx: displayed.level.tilePx, reservedBytes: 0, budgetBytes }));
  };

  const warm = new InkWarmUp({
    lend: () => store?.lendSpare() ?? null,
    takeBack: (canvas) => store?.takeBack(canvas),
    pathFactory,
    requestFrame: options.requestFrame,
    cancelFrame: options.cancelFrame,
    site: () => {
      if (!displayed || !viewport || !store || pending || live) return null;
      const tile = inkVisibleTiles(displayed.level, viewport.visible)[0];
      if (!tile) return null;
      return {
        container: liveLayer.container,
        rect: inkTileDeviceRect(displayed.level, tile.col, tile.row),
        devicePixelRatio: displayed.level.devicePixelRatio,
        unitPx: displayed.level.unitPx,
      };
    },
  });

  /** One step of the warm-up in a slice; a second, if wanted, is queued first in the next. */
  const runWarmUp = (): void | "yield" => {
    const start = now();
    const more = warm.step();
    stats.warmUpMsMax = Math.max(stats.warmUpMsMax, now() - start);
    if (!more) return;
    scheduler.enqueue("warm-up", INK_PRIORITY_IDLE, runWarmUp, true);
    return "yield";
  };

  /** Queues the warm-up behind everything else (idle priority), if it is wanted and not yet done. */
  const queueWarmUp = () => {
    if (warmWanted && !warm.completed) scheduler.enqueue("warm-up", INK_PRIORITY_IDLE, runWarmUp);
  };

  const noteDrawn = (level: InkLevelTiles) => {
    if (documentStart === null || level !== displayed) return;
    const elapsed = now() - documentStart;
    if (stats.firstInkMs === null && hasInkOnScreen(level)) stats.firstInkMs = elapsed;
    if (stats.visibleReadyMs === null && Array.from(displayedVisible).every((key) => level.cells.get(key)?.drawn)) {
      stats.visibleReadyMs = elapsed;
      if (stats.firstInkMs === null) stats.firstInkMs = elapsed;
    }
  };

  const hasInkOnScreen = (level: InkLevelTiles) => {
    for (const key of displayedVisible) {
      const cell = level.cells.get(key);
      if (cell?.drawn && (cell.canvases.highlighter || cell.canvases.pen)) return true;
    }
    return false;
  };

  /** Queues a tile to be drawn in the background, at the priority of what it is for. */
  const queueTile = (
    level: InkLevelTiles,
    tile: InkTile,
    priority: typeof INK_PRIORITY_VISIBLE | typeof INK_PRIORITY_PREFETCH,
    front = false
  ) => {
    const key = `${priority === INK_PRIORITY_VISIBLE ? "v" : "p"}${tile.key}`;
    scheduler.enqueue(key, priority, (deadline, first) => drawTile(level, tile, priority, deadline, first), front);
  };

  const drawTile = (
    level: InkLevelTiles,
    tile: InkTile,
    priority: typeof INK_PRIORITY_VISIBLE | typeof INK_PRIORITY_PREFETCH,
    deadline: number,
    first: boolean
  ): void | "yield" => {
    if (destroyed || !store || (level !== displayed && level !== pending)) return;
    if (level.isDrawn(tile)) return;
    drawing = true;
    const result = store.draw(level, tile, query, deadline, first);
    drawing = false;
    if (result === "partial") {
      // To the front, so a started tile finishes before others start.
      queueTile(level, tile, priority, true);
      return "yield";
    }
    if (result === "failed") {
      // Every canvas the budget allows is pinned. A new zoom that cannot fit
      // beside the old one replaces it now, partly drawn, rather than never;
      // the old level's canvases then come free for the rest. A tile of the
      // level on screen waits (with its pen layer drawn, which goes first)
      // until a canvas comes back to the pool.
      if (level === pending) swapLevels();
      else starved.set(tile.key, { level, tile });
      return;
    }
    if (level === pending && viewport && inkVisibleTiles(pending.level, viewport.visible).every((t) => pending!.isDrawn(t))) {
      swapLevels();
      return;
    }
    noteDrawn(level);
  };

  /** The new zoom is ready on screen: it replaces the stand-in in one step. */
  const swapLevels = () => {
    if (!pending || !displayed || !store) return;
    const old = displayed;
    displayed = pending;
    pending = null;
    displayed.present(1, true);
    store.disposeLevel(old);
    stats.levelSwaps += 1;
    placeLive();
    plan();
    noteDrawn(displayed);
  };

  /**
   * Tops the spare canvases back up to a screenful, when the page is next idle.
   * After every stroke as well as every new view: writing on blank paper keeps
   * the canvases it was lent, so the spares run down as a page fills.
   */
  const queueSpares = () => {
    const target = pending ?? displayed;
    if (!viewport || !target || !store) return;
    const screenful = inkLiveTileCount(target.level, viewport.visible);
    scheduler.enqueue("spares", INK_PRIORITY_IDLE, () => store?.warmSpares(spares ?? screenful));
  };

  /** Queues what is missing: the visible tiles of the level being drawn, then the ring, then spares. */
  const plan = () => {
    warm.abort();
    scheduler.clear();
    if (!viewport || !displayed || !store) return;
    const target = pending ?? displayed;
    const visible = inkVisibleTiles(target.level, viewport.visible);
    target.pinned = new Set(visible.map((tile) => tile.key));
    const standIn = displayedVisibleRect();
    const displayedTiles = pending && standIn ? inkVisibleTiles(displayed.level, standIn) : visible;
    displayedVisible = new Set(displayedTiles.map((tile) => tile.key));
    if (pending) displayed.pinned = displayedVisible;
    for (const tile of visible) {
      store.touch(target, tile);
      if (!target.isDrawn(tile)) queueTile(target, tile, INK_PRIORITY_VISIBLE);
    }
    if (!pending) {
      for (const tile of inkPrefetchTiles(target.level, viewport.visible, prefetchRing)) {
        if (!target.isDrawn(tile)) queueTile(target, tile, INK_PRIORITY_PREFETCH);
      }
    }
    queueSpares();
    queueWarmUp();
    if (pending && visible.every((tile) => pending!.isDrawn(tile))) swapLevels();
    notifyVisible();
  };

  const applyViewport = (next: InkViewport) => {
    // Before the pool changes size: the warm-up's canvas goes back as it is.
    warm.abort();
    const level = inkRenderLevel(next.scale, next.devicePixelRatio, page);
    if (!level) return;
    if (!store) {
      store = new InkTileStore(ledger, drawables, stats, now, level.tilePx, onCanvasFreed);
    } else if (store.tileSize !== level.tilePx) {
      store.setTileSize(level.tilePx);
      displayed = null;
      pending = null;
    }
    viewport = { level, visible: next.visible };
    const ratio = next.devicePixelRatio;
    const snapX = next.screenOrigin ? inkDevicePixelSnap(next.screenOrigin.x, ratio) : 0;
    const snapY = next.screenOrigin ? inkDevicePixelSnap(next.screenOrigin.y, ratio) : 0;
    root.style.transform = snapX || snapY ? `translate(${snapX}px, ${snapY}px)` : "";

    if (!displayed) {
      displayed = newLevel(level);
    } else if (displayed.level.key === level.key) {
      if (pending) store.disposeLevel(pending);
      pending = null;
    } else if (!pending || pending.level.key !== level.key) {
      if (pending) store.disposeLevel(pending);
      pending = newLevel(level);
      pending.present(1, false);
    }
    displayed.present(pending ? inkLevelStandInScale(displayed.level, level) : 1, true);
    placeLive();
    plan();
  };

  /**
   * Paints items added on top of a drawn tile. Where a live tile holds the
   * lifted stroke, that live tile becomes the dry tile instead (see
   * `InkTileStore.adopt`): nothing is painted, so no pixel can change.
   */
  const appendTo = (level: InkLevelTiles, tile: InkTile, items: Record<InkLayer, InkItem[]>, lift: Lift | null) => {
    if (lift && level === displayed) {
      const source = lift.tiles.get(tile.key);
      if (source) {
        if (store!.adopt(level, tile, lift.layer, source.canvas)) {
          liveLayer.handOver(tile);
          return true;
        }
      } else if (liveLayer.missedTile(tile)) {
        // The stroke reached this tile with no canvas to draw it live: paint it now.
        return store!.append(level, tile, items);
      } else if (liveLayer.covers(tile)) {
        // Live ink drew every tile on screen its stroke reached (or noted it
        // missed); it did not reach this one, so there is nothing to add.
        return true;
      } else {
        // Off screen: not worth holding up the lift for.
        store!.invalidate(level, tile);
        queueTile(level, tile, INK_PRIORITY_PREFETCH);
        return true;
      }
    }
    return store!.append(level, tile, items);
  };

  /** Brings the tiles a change touches up to date: on screen now, the rest later. */
  const redrawChanged = (change: InkChange, onTop: boolean, lift: Lift | null) => {
    if (!store) return 0;
    const changed: InkItem[] = [];
    for (const { item } of change.removed) if (item.kind !== "unknown") changed.push(item);
    for (const { item } of change.added) if (item.kind !== "unknown") changed.push(item);
    let redrawn = 0;
    let replan = false;
    for (const level of [displayed, pending]) {
      if (!level) continue;
      const touched = new Map<string, { tile: InkTile; items: Record<InkLayer, InkItem[]> }>();
      for (const item of changed) {
        for (const tile of inkTilesForBox(level.level, inkItemBounds(item))) {
          let entry = touched.get(tile.key);
          if (!entry) {
            entry = { tile, items: { highlighter: [], pen: [] } };
            touched.set(tile.key, entry);
          }
          entry.items[inkItemLayer(item)].push(item);
        }
      }
      for (const { tile, items } of touched.values()) {
        if (!level.isDrawn(tile)) {
          // Not drawn yet, or partly: whatever draws it next must start again.
          store.invalidate(level, tile);
          continue;
        }
        if (level === displayed && onTop) {
          if (appendTo(level, tile, items, lift)) redrawn += 1;
          else replan = true;
        } else if (level === displayed && displayedVisible.has(tile.key)) {
          if (store.draw(level, tile, query) === "done") redrawn += 1;
          else replan = true;
        } else {
          store.invalidate(level, tile);
          replan = true;
        }
      }
    }
    if (replan) plan();
    return redrawn;
  };

  const change = (next: InkDocument, inkChange: InkChange, lift: Lift | null = null) => {
    const start = now();
    const { onTop } = index.apply(next, inkChange);
    const redrawn = redrawChanged(inkChange, onTop, lift);
    const elapsed = now() - start;
    stats.changes += 1;
    stats.changeTiles += redrawn;
    stats.changeMsMax = Math.max(stats.changeMsMax, elapsed);
    notifyVisible();
    return elapsed;
  };

  /** Repaints the tiles the tip touched with the stroke alone. */
  const wipeTip = (last: NonNullable<Live["last"]>) => {
    const tip = last.tip;
    last.tip = null;
    if (tip) liveLayer.draw(last.path, last.paint, last.area, tip.area);
  };

  const endLive = () => {
    liveLayer.end();
    live = null;
    scheduler.resume("live");
    queueSpares();
    queueWarmUp();
    // Document changes that arrived mid-stroke, in order, then the viewport.
    for (const work of deferredDocument.splice(0)) {
      if (work.kind === "document") showDocument(work.doc);
      else change(work.doc, work.change);
    }
    const deferred = deferredViewport;
    deferredViewport = null;
    if (deferred) applyViewport(deferred);
  };

  const showDocument = (next: InkDocument) => {
    index.reset(next);
    store?.releaseAll();
    if (pending && displayed && store) {
      // Nothing of the old page stands in for the new one.
      store.disposeLevel(displayed);
      displayed = pending;
      pending = null;
      displayed.present(1, true);
      placeLive();
    }
    stats.firstInkMs = null;
    stats.visibleReadyMs = null;
    documentStart = now();
    plan();
  };

  return {
    setDocument(next) {
      // Mid-stroke, live tiles hold copies of the dry tiles: change those
      // under them and the lift would keep the stale copies. It waits.
      if (live) deferredDocument.push({ kind: "document", doc: next });
      else showDocument(next);
    },
    applyChange(next, inkChange) {
      if (live) deferredDocument.push({ kind: "change", doc: next, change: inkChange });
      else change(next, inkChange);
    },
    setViewport(next) {
      if (destroyed) return;
      if (live) {
        deferredViewport = next;
        return;
      }
      applyViewport(next);
    },
    beginGesture() {
      warm.abort();
      scheduler.pause("gesture");
    },
    endGesture() {
      scheduler.resume("gesture");
      queueWarmUp();
    },
    beginLive(layer) {
      warm.retire();
      if (live) endLive();
      scheduler.pause("live");
      liveLayer.begin(layer, {
        lend: () => store?.lend() ?? null,
        takeBack: (canvas) => store?.takeBack(canvas),
        dryCanvas: (tile) => (displayed && store ? store.canvasAt(displayed, tile, layer) : null),
      });
      live = { layer, last: null };
    },
    drawLive(path, paint, tip = null) {
      if (!live || !displayed) return;
      const start = now();
      const built = buildInkPath(path, pathFactory);
      const level = displayed.level;
      const reach = (box: InkBox, stroke: InkPaint["stroke"]) =>
        inkBoxDeviceRect(level, inkBoxGrow(box, inkStrokeReach(stroke)));
      const area = built.hull ? reach(built.hull, paint.stroke) : null;
      const shown = tip ? liveTipOf(tip, reach, pathFactory) : null;
      const last = live.last;
      // Everywhere this packet can paint, and the last one could.
      const painted = inkDeviceRectUnion(area, shown?.area ?? null);
      const paintedBefore = last ? inkDeviceRectUnion(last.area, last.tip?.area ?? null) : null;
      let dirty: InkDeviceRect | null;
      if (!last || !sameInkPaint(last.paint, paint)) {
        dirty = inkDeviceRectUnion(paintedBefore, painted);
      } else {
        const changed = inkPathChange(last.commands, path, paint.fill !== null);
        dirty =
          changed.kind === "none"
            ? null
            : changed.kind === "box"
              ? reach(changed.box, paint.stroke)
              : inkDeviceRectUnion(paintedBefore, painted);
        // The tip moved: where it was and where it is are repainted too. (A
        // tile the stroke's change reaches repaints its tip with it.)
        if (!sameLiveTip(last.tip, shown)) {
          dirty = inkDeviceRectUnion(dirty, inkDeviceRectUnion(last.tip?.area ?? null, shown?.area ?? null));
        }
      }
      if (dirty) liveLayer.draw(built.path, paint, area, dirty, shown);
      live.last = { commands: path, paint, path: built.path, area, tip: shown };
      const elapsed = now() - start;
      stats.liveDraws += 1;
      stats.liveDrawMsTotal += elapsed;
      stats.liveDrawMsMax = Math.max(stats.liveDrawMsMax, elapsed);
    },
    commitLive(next, inkChange) {
      const start = now();
      const last = live?.last;
      const added = inkChange.added.length === 1 ? inkChange.added[0].item : null;
      if (deferredDocument.length > 0) {
        // The page changed under the stroke: the live tiles' copies of the dry
        // tiles are stale, so the stroke is painted afresh after the changes.
        endLive();
        change(next, inkChange);
      } else {
        let lift: Lift | null = null;
        if (live && last && added && isInkLiveStroke(added, live.layer, last)) {
          // A tip showing is wiped first, from the tiles it touched, so the
          // live tiles that become the dry tiles hold the stroke alone. (When
          // the stroke is painted afresh instead, the tip goes with the live tiles.)
          if (last.tip) wipeTip(last);
          drawables.seed(added, last.path);
          const tiles = new Map(liveLayer.painted().map((region) => [region.tile.key, region]));
          lift = { item: added, layer: live.layer, tiles };
        }
        change(next, inkChange, lift);
        endLive();
      }
      const elapsed = now() - start;
      stats.commits += 1;
      stats.commitMsMax = Math.max(stats.commitMsMax, elapsed);
    },
    cancelLive() {
      if (live) endLive();
    },
    stats,
    resetStats() {
      resetInkRendererStats(stats);
    },
    coverage() {
      const visible = displayedVisibleRect();
      if (!displayed || !visible) return { visible: 0, drawn: 0 };
      const level = displayed;
      const tiles = inkVisibleTiles(level.level, visible);
      return { visible: tiles.length, drawn: tiles.filter((tile) => level.isDrawn(tile)).length };
    },
    whenVisibleDrawn(callback) {
      let state: "waiting" | "queued" | "done" = "waiting";
      const waiter = () => {
        if (state !== "waiting") return;
        state = "queued";
        visibleWaiters.delete(waiter);
        // Never inside a slice or a call of the renderer's: a callback that
        // throws or calls back in must not stop the queue.
        queueMicrotask(() => {
          if (state !== "queued") return;
          if (!visibleDrawn()) {
            // The page changed in between: wait for it again.
            state = "waiting";
            visibleWaiters.add(waiter);
            return;
          }
          state = "done";
          callback();
        });
      };
      visibleWaiters.add(waiter);
      if (visibleDrawn()) waiter();
      return () => {
        state = "done";
        visibleWaiters.delete(waiter);
      };
    },
    warmUp() {
      if (destroyed || warmWanted) return;
      warmWanted = true;
      queueWarmUp();
    },
    get idle() {
      return scheduler.pending === 0 && pending === null && !warm.active;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      warm.abort();
      visibleWaiters.clear();
      scheduler.dispose();
      poster?.close();
      // Live ink first: it gives its lent canvases back to the store, which
      // then frees them with the rest.
      liveLayer.dispose();
      store?.dispose();
      root.remove();
    },
  };
}
