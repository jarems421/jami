/**
 * Dry tiles: the committed ink of a page, drawn into fixed-size canvases on
 * the level's tile grid, in two layers. A highlighter canvas exists only where
 * there is highlighter ink, a pen canvas only where there is pen ink, and the
 * highlighter layer sits under the pen layer whatever order the ink was drawn
 * in.
 *
 * Canvases come from one pool, all the same size (a tile's side in device
 * pixels), and are moved between tiles and levels rather than resized or
 * remade. The pool never holds more than the memory budget allows; when it is
 * full, the least recently used tile that is not pinned gives up its canvases
 * (`inkTilesToEvict`).
 */

import type { InkBox, InkItem, InkLayer } from "@/lib/ink/model";
import {
  inkTileDeviceRect,
  inkTilePageBox,
  inkTilesToEvict,
  type InkLruEntry,
  type InkRenderLevel,
  type InkTile,
} from "@/lib/ink/render-plan";
import {
  clearInkCanvas,
  placeInkCanvas,
  type InkCanvas,
  type InkCanvasLedger,
} from "@/lib/ink-dom/canvas";
import {
  paintInkItems,
  paintInkPath,
  setInkDeviceTransform,
  type InkDrawableCache,
} from "@/lib/ink-dom/rasterizer";
import type { InkRendererStats } from "@/lib/ink-dom/stats";

export const INK_LAYERS: readonly InkLayer[] = ["highlighter", "pen"];

/**
 * The order a tile's layers are drawn in: pen first, so when the budget runs
 * out part way through a tile, writing shows and the highlighter waits.
 */
const DRAW_ORDER: readonly InkLayer[] = ["pen", "highlighter"];

/** How quickly the running cost of painting a path command follows new measurements. */
const COMMAND_COST_SMOOTHING = 0.25;
/**
 * A draw stops while twice an item's expected cost would still fit: items
 * vary (a word against a page-wide highlight), and an item's path is built
 * the first time it is painted.
 */
const ITEM_COST_HEADROOM = 2;

/** How much painting an item costs, roughly: its path's length. */
function itemWeight(item: InkItem): number {
  return item.kind === "outline" ? Math.max(1, item.path.length) : 8;
}

/** Items of one layer meeting a page box, in drawing order. */
export type InkLayerQuery = (layer: InkLayer, box: InkBox) => InkItem[];

/**
 * A tile being drawn over several slices: per layer, its items, how far it
 * has got, and the canvas it paints into. A layer still showing older ink is
 * drawn into a spare canvas (`replacing`), swapped in only when the whole
 * tile is done, so a tile on screen never shows half drawn.
 */
type DrawPart = {
  layer: InkLayer;
  items: InkItem[];
  next: number;
  started: boolean;
  target: InkCanvas | null;
  replacing: boolean;
};
type DrawJob = DrawPart[];

type Cell = {
  tile: InkTile;
  /** True once the tile shows every item that meets it. */
  drawn: boolean;
  canvases: Record<InkLayer, InkCanvas | null>;
  lastUsed: number;
  /** A draw stopped at a slice's end, to carry on from. */
  job: DrawJob | null;
};

/** How a draw went: finished, stopped at the deadline to carry on later, or out of canvases. */
export type InkTileDrawResult = "done" | "partial" | "failed";

/** One level's tiles, and the two layer groups they are placed in. */
export class InkLevelTiles {
  readonly cells = new Map<string, Cell>();
  /** Tiles that must not be evicted: on screen, or standing in for a new level. */
  pinned = new Set<string>();
  readonly groups: Record<InkLayer, HTMLDivElement>;

  constructor(
    readonly level: InkRenderLevel,
    parents: Record<InkLayer, HTMLElement>,
    doc: Document
  ) {
    const make = (parent: HTMLElement) => {
      const group = doc.createElement("div");
      group.style.position = "absolute";
      group.style.left = "0";
      group.style.top = "0";
      group.style.transformOrigin = "0 0";
      parent.appendChild(group);
      return group;
    };
    this.groups = { highlighter: make(parents.highlighter), pen: make(parents.pen) };
  }

  /**
   * Shows the level at its own zoom (`scale` 1), or scaled to stand in for a
   * newer one, or hides it while it is drawn behind the one on screen.
   */
  present(scale: number, visible: boolean): void {
    for (const layer of INK_LAYERS) {
      const style = this.groups[layer].style;
      style.transform = scale === 1 ? "" : `scale(${scale})`;
      style.visibility = visible ? "" : "hidden";
    }
  }

  cell(tile: InkTile): Cell {
    let cell = this.cells.get(tile.key);
    if (!cell) {
      cell = { tile, drawn: false, canvases: { highlighter: null, pen: null }, lastUsed: 0, job: null };
      this.cells.set(tile.key, cell);
    }
    return cell;
  }

  isDrawn(tile: InkTile): boolean {
    return this.cells.get(tile.key)?.drawn ?? false;
  }
}

export class InkTileStore {
  private readonly free: InkCanvas[] = [];
  private alive = 0;
  private clock = 0;
  /** What painting one path command has cost lately, in ms: a running average. */
  private commandCost = 0;
  private capacity = 0;
  private readonly levels = new Set<InkLevelTiles>();

  constructor(
    private readonly ledger: InkCanvasLedger,
    private readonly drawables: InkDrawableCache,
    private readonly stats: InkRendererStats,
    private readonly now: () => number,
    private tilePx: number,
    /** Told when a canvas comes back to the pool or the budget grows: room to retry a failed draw. */
    private readonly onFreed: () => void = () => {}
  ) {}

  /**
   * How many canvases may exist at once: in tiles, spare, or lent to live ink.
   * Lowering it frees spares first, then the least recently used tiles that
   * are not pinned.
   */
  setCapacity(capacity: number): void {
    const grew = capacity > this.capacity;
    this.capacity = Math.max(0, capacity);
    if (grew) this.onFreed();
    while (this.alive > this.capacity && this.free.length > 0) this.destroy(this.free.pop()!);
    if (this.alive > this.capacity) this.evict(null, 0);
  }

  /** Canvases alive now, in tiles, spare or lent. */
  get canvasCount(): number {
    return this.alive;
  }

  get tileSize(): number {
    return this.tilePx;
  }

  /**
   * A new tile size (the screen's density changed) makes every pooled canvas
   * the wrong size; they are all let go, with the levels using them.
   */
  setTileSize(tilePx: number): void {
    if (tilePx === this.tilePx) return;
    for (const level of Array.from(this.levels)) this.disposeLevel(level);
    while (this.free.length > 0) this.destroy(this.free.pop()!);
    this.tilePx = tilePx;
  }

  addLevel(level: InkLevelTiles): void {
    this.levels.add(level);
  }

  /** Returns a level's canvases to the pool and removes its groups. */
  disposeLevel(level: InkLevelTiles): void {
    for (const cell of level.cells.values()) this.releaseCell(cell);
    level.cells.clear();
    for (const layer of INK_LAYERS) level.groups[layer].remove();
    this.levels.delete(level);
  }

  /** Forgets everything drawn on every level (a new document), giving the canvases back. */
  releaseAll(): void {
    for (const level of this.levels) {
      for (const cell of level.cells.values()) this.releaseCell(cell);
      level.cells.clear();
    }
  }

  /**
   * Marks a tile out of date, and drops a draw in progress (its list of items
   * is stale). Its canvases keep showing the old ink until it is redrawn.
   */
  invalidate(level: InkLevelTiles, tile: InkTile): void {
    const cell = level.cells.get(tile.key);
    if (!cell) return;
    cell.drawn = false;
    this.dropJob(cell);
  }

  /** The canvas showing one layer of a tile, if that layer has ink there. */
  canvasAt(level: InkLevelTiles, tile: InkTile, layer: InkLayer): InkCanvas | null {
    return level.cells.get(tile.key)?.canvases[layer] ?? null;
  }

  touch(level: InkLevelTiles, tile: InkTile): void {
    const cell = level.cells.get(tile.key);
    if (cell) cell.lastUsed = ++this.clock;
  }

  /**
   * Draws a tile from scratch: each layer cleared and every item meeting it
   * painted in order. A layer with nothing on it gives its canvas back.
   *
   * With a `deadline` (on the store's clock) it stops before an item that
   * would probably run past it (judged by what items have cost so far) and
   * says "partial"; the next call carries on where it stopped. When it
   * `mustProgress` it paints at least one item, so it always gets somewhere.
   * A blank layer is drawn in place, so it fills in as it goes. A layer still
   * showing older ink is drawn into a spare canvas and swapped in when the
   * whole tile is done; with no spare to be had, or no deadline, it is drawn
   * in place in one go. "failed" means the budget had no canvas to spare; the
   * tile stays undrawn.
   */
  draw(
    level: InkLevelTiles,
    tile: InkTile,
    query: InkLayerQuery,
    deadline = Infinity,
    mustProgress = true
  ): InkTileDrawResult {
    const start = this.now();
    const cell = level.cell(tile);
    cell.lastUsed = ++this.clock;
    const box = inkTilePageBox(level.level, tile.col, tile.row);
    const job = (cell.job ??= DRAW_ORDER.map((layer) => ({
      layer,
      items: query(layer, box),
      next: 0,
      started: false,
      target: null,
      replacing: false,
    })));
    const rect = inkTileDeviceRect(level.level, tile.col, tile.row);
    // Work done in this call: items painted, or a canvas readied (a new one
    // costs its first clear, when the browser makes its backing store).
    let progress = 0;
    const stopped = () => {
      this.stats.tileRenderMsMax = Math.max(this.stats.tileRenderMsMax, this.now() - start);
      return "partial" as const;
    };
    for (const part of job) {
      if (part.items.length === 0) continue;
      if (!part.started || !part.target) {
        const shown = cell.canvases[part.layer];
        let target = shown && deadline !== Infinity ? this.obtain(cell) : null;
        part.replacing = target !== null;
        if (!target) {
          target = shown ?? this.take(level, cell, part.layer);
          // Painting over ink on screen: finish now rather than show it half drawn.
          if (shown) deadline = Infinity;
        }
        if (!target) {
          this.dropJob(cell);
          cell.drawn = false;
          return "failed";
        }
        clearInkCanvas(target);
        part.target = target;
        part.next = 0;
        part.started = true;
        progress += 1;
      }
      const canvas = part.target;
      setInkDeviceTransform(canvas.ctx, level.level.unitPx, rect.x, rect.y);
      while (part.next < part.items.length) {
        const item = part.items[part.next];
        const weight = itemWeight(item);
        const before = this.now();
        const expected = ITEM_COST_HEADROOM * weight * this.commandCost;
        if ((progress > 0 || !mustProgress) && before + expected >= deadline) return stopped();
        const drawable = this.drawables.get(item);
        if (drawable) paintInkPath(canvas.ctx, drawable.path, drawable.paint);
        part.next += 1;
        progress += 1;
        this.commandCost += ((this.now() - before) / weight - this.commandCost) * COMMAND_COST_SMOOTHING;
      }
    }
    // Done: replacements go up together, and layers with no ink give their canvas back.
    for (const part of job) {
      const shown = cell.canvases[part.layer];
      if (part.items.length === 0) {
        if (shown) this.giveBack(shown);
        cell.canvases[part.layer] = null;
      } else if (part.replacing && part.target) {
        placeInkCanvas(part.target, rect.x, rect.y, level.level.devicePixelRatio);
        level.groups[part.layer].appendChild(part.target.element);
        cell.canvases[part.layer] = part.target;
        if (shown && shown !== part.target) this.giveBack(shown);
      }
    }
    cell.job = null;
    cell.drawn = true;
    this.stats.tileRenders += 1;
    this.stats.tileRenderMsMax = Math.max(this.stats.tileRenderMsMax, this.now() - start);
    return "done";
  }

  /**
   * Paints items onto a drawn tile, over what it already shows. Only right
   * for items on top of everything else in their layer (a stroke just lifted,
   * or one added back on top by redo); anything else needs `draw`. A layer
   * with no canvas yet gets one, which then shows only these items, as it
   * should: the tile was drawn and had no ink of that layer.
   */
  append(level: InkLevelTiles, tile: InkTile, items: Record<InkLayer, InkItem[]>): boolean {
    const cell = level.cells.get(tile.key);
    if (!cell || !cell.drawn) return false;
    cell.lastUsed = ++this.clock;
    for (const layer of INK_LAYERS) {
      if (items[layer].length === 0) continue;
      let canvas = cell.canvases[layer];
      if (!canvas) {
        canvas = this.take(level, cell, layer);
        if (!canvas) {
          cell.drawn = false;
          return false;
        }
        clearInkCanvas(canvas);
      }
      this.paint(level, tile, canvas, items[layer]);
    }
    this.stats.tileAppends += 1;
    return true;
  }

  /**
   * The lift: `incoming`, a canvas lent to live ink that holds this tile's
   * `layer` with the stroke painted over it (see `live-layer.ts`), becomes
   * that layer's canvas, so the screen keeps exactly the pixels it showed with
   * the pen down. The canvas it replaces goes back to the spares. False,
   * changing nothing, when the tile is not drawn.
   */
  adopt(level: InkLevelTiles, tile: InkTile, layer: InkLayer, incoming: InkCanvas): boolean {
    const cell = level.cells.get(tile.key);
    if (!cell || !cell.drawn) return false;
    cell.lastUsed = ++this.clock;
    const replaced = cell.canvases[layer];
    // A live tile is already placed exactly over this tile.
    level.groups[layer].appendChild(incoming.element);
    cell.canvases[layer] = incoming;
    if (replaced && replaced !== incoming) this.giveBack(replaced);
    this.stats.tileAppends += 1;
    return true;
  }

  /**
   * A canvas for live ink, detached: a spare, else one freed from a tile out
   * of sight, else a new one within the budget. Null only when the budget is
   * spent on tiles that are all on screen.
   *
   * It used to stop at the tile out of sight, so a stroke made no canvas. But
   * writing on blank paper uses a spare up for good -- the live canvas becomes
   * the tile, with no dry one to hand back -- and with the whole page on
   * screen there is no tile out of sight to take. A screenful of writing in,
   * every new stroke went unseen until its lift: on iPad the pen simply
   * stopped writing, on one page and not the next, until the page was
   * scrolled or zoomed and the spares warmed again (19 Oct 2026). Making one
   * canvas when a stroke first reaches a tile costs far less than ink that
   * does not appear.
   */
  lend(): InkCanvas | null {
    return this.free.pop() ?? this.evict(null, 1, true) ?? this.create();
  }

  /** A spare canvas, if one is waiting: no tile gives one up and none is made. */
  lendSpare(): InkCanvas | null {
    return this.free.pop() ?? null;
  }

  /** A lent canvas back to the spares. */
  takeBack(canvas: InkCanvas): void {
    this.giveBack(canvas);
  }

  /** Keeps up to `count` spare canvases ready, within the budget, so a lift rarely allocates. */
  warmSpares(count: number): void {
    while (this.free.length < count && this.alive < this.capacity) {
      const canvas = this.ledger.create(this.tilePx, this.tilePx);
      if (!canvas) return;
      this.alive += 1;
      this.free.push(canvas);
    }
  }

  dispose(): void {
    for (const level of Array.from(this.levels)) this.disposeLevel(level);
    while (this.free.length > 0) this.destroy(this.free.pop()!);
  }

  private paint(level: InkLevelTiles, tile: InkTile, canvas: InkCanvas, items: readonly InkItem[]): void {
    const rect = inkTileDeviceRect(level.level, tile.col, tile.row);
    setInkDeviceTransform(canvas.ctx, level.level.unitPx, rect.x, rect.y);
    paintInkItems(canvas.ctx, items, this.drawables);
  }

  /** A detached canvas: a spare, else a new one, else one freed from the least recently used tile. */
  private obtain(keep: Cell | null): InkCanvas | null {
    const canvas = this.free.pop() ?? this.create() ?? this.evict(keep, 1);
    if (!canvas) this.stats.budgetMisses += 1;
    return canvas;
  }

  /** A canvas for one layer of a tile, placed in its level's group. */
  private take(level: InkLevelTiles, cell: Cell, layer: InkLayer): InkCanvas | null {
    const canvas = this.obtain(cell);
    if (!canvas) return null;
    const rect = inkTileDeviceRect(level.level, cell.tile.col, cell.tile.row);
    placeInkCanvas(canvas, rect.x, rect.y, level.level.devicePixelRatio);
    level.groups[layer].appendChild(canvas.element);
    cell.canvases[layer] = canvas;
    return canvas;
  }

  private create(): InkCanvas | null {
    if (this.alive >= this.capacity) return null;
    const canvas = this.ledger.create(this.tilePx, this.tilePx);
    if (canvas) this.alive += 1;
    return canvas;
  }

  /**
   * Frees the least recently used tiles that are not pinned (and never
   * `keep`, being drawn) until `needed` more canvases fit in the budget, and
   * returns a spare if that left one. `always` frees at least one tile's
   * canvases even with the budget not full: live ink takes from a tile out
   * of sight rather than make a canvas in the middle of a stroke.
   */
  private evict(keep: Cell | null, needed: number, always = false): InkCanvas | null {
    const entries: InkLruEntry[] = [];
    const owners = new Map<string, { level: InkLevelTiles; cell: Cell }>();
    let held = 0;
    for (const level of this.levels) {
      for (const cell of level.cells.values()) {
        const key = `${level.level.key}#${cell.tile.key}`;
        const canvases = (cell.canvases.highlighter ? 1 : 0) + (cell.canvases.pen ? 1 : 0);
        held += canvases;
        entries.push({ key, lastUsed: cell.lastUsed, pinned: cell === keep || level.pinned.has(cell.tile.key), canvases });
        owners.set(key, { level, cell });
      }
    }
    // Canvases outside tiles (spare, lent, mid-draw) count against the budget too.
    const room = this.capacity - (this.alive - held);
    for (const key of inkTilesToEvict(entries, always ? Math.min(room, held) : room, needed)) {
      const owner = owners.get(key);
      if (!owner) continue;
      this.releaseCell(owner.cell);
      owner.level.cells.delete(owner.cell.tile.key);
      this.stats.evictions += 1;
    }
    return needed > 0 ? (this.free.pop() ?? null) : null;
  }

  /** Drops a draw in progress, giving back the spare canvases it was painting. */
  private dropJob(cell: Cell): void {
    for (const part of cell.job ?? []) if (part.replacing && part.target) this.giveBack(part.target);
    cell.job = null;
  }

  private releaseCell(cell: Cell): void {
    this.dropJob(cell);
    for (const layer of INK_LAYERS) {
      const canvas = cell.canvases[layer];
      if (canvas) this.giveBack(canvas);
      cell.canvases[layer] = null;
    }
    cell.drawn = false;
  }

  private giveBack(canvas: InkCanvas): void {
    canvas.element.remove();
    if (this.alive > this.capacity) {
      this.destroy(canvas);
      return;
    }
    this.free.push(canvas);
    this.onFreed();
  }

  private destroy(canvas: InkCanvas): void {
    this.ledger.destroy(canvas);
    this.alive -= 1;
  }
}
