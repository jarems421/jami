/**
 * Live ink: the stroke being written, drawn synchronously on every packet.
 *
 * It is drawn into live tiles: canvases from the same pool as the dry tiles
 * (the same size), placed on the same grid at the same positions, and drawn
 * through the same rasteriser with the same transform. Chrome antialiases
 * differently on canvases of different sizes, and the same path under two
 * translations can land a float rounding apart; one grid rules out both.
 *
 * A live tile also stands in for the dry tile beneath it. The first time a
 * stroke reaches a tile, the dry tile of the stroke's layer is copied into the
 * live tile (one full-tile copy per tile per stroke) and hidden, so what the
 * screen shows there is a composite the canvas made, not one the compositor
 * blends from two layers: the two round a translucent blend differently (by
 * one level in 255 where a stroke crosses ink of its own layer), and the lift
 * must not change a pixel. At the lift the live tile simply becomes the dry
 * tile (`InkTileStore.adopt`), so nothing is drawn or copied.
 *
 * Each packet paints the whole stroke again in every tile where it changed
 * since the last packet (`inkPathChange`): there the dry pixels are put back
 * and the stroke painted over them. A tile the change does not reach already
 * shows exactly this stroke, since a pixel depends only on the geometry
 * crossing it, so it is left alone.
 *
 * The predicted tip rides on the same repaint: a short round-capped path drawn
 * after the stroke in each tile that is repainted. Where the tip was and where
 * it now is count as changed, like the stroke's own change, so a tile it left
 * or reached is repainted; the lift first repaints those tiles with the stroke
 * alone, so the tip never reaches the dry tiles.
 *
 * Canvases are lent by the tile store when a stroke first reaches a tile on
 * screen and given back when it ends. The store keeps a screenful of spares
 * warm, topped up after every stroke; with none spare it takes one from a tile
 * out of sight, and failing that makes one within the budget. Only with the
 * budget spent on tiles all on screen is there nothing to lend: the tile is
 * noted as missed, the stroke does not show there while it is written, and
 * the lift paints it in. Nothing is reserved for live ink.
 *
 * Live tiles stack in tile order (`compareInkTiles`), the order the lift
 * adopts them in, so the lift does not change their stacking. Canvases that
 * abut meet in a seam row where each covers a hair of the other, and which one
 * sits on top shifts the stroke's edge pixels there by a level in 255. A
 * stroke that crossed a tile seam showed it: its live tiles stacked in the
 * order the stroke reached them, and adopting them in tile order changed those
 * pixels at the lift.
 *
 * One layer serves both kinds of stroke. Its stacking puts it between the dry
 * highlighter and dry pen layers for a highlighter stroke, so the highlighter
 * is under pen ink while it is written too, and above everything for a pen
 * stroke.
 */

import type { InkLayer, InkPaint } from "@/lib/ink/model";
import {
  compareInkTiles,
  inkDeviceRectIntersection,
  inkDeviceRectUnion,
  inkTileDeviceRect,
  inkTilesForDeviceRect,
  type InkDeviceRect,
  type InkRenderLevel,
  type InkTile,
} from "@/lib/ink/render-plan";
import { clearInkCanvas, copyInkCanvasRegion, placeInkCanvas, type InkCanvas } from "@/lib/ink-dom/canvas";
import { paintInkPath, setInkDeviceTransform, type InkPath2D } from "@/lib/ink-dom/rasterizer";

/** Stacking of the four layers inside the renderer's root. */
export const INK_LAYER_Z = {
  dryHighlighter: 1,
  liveHighlighter: 2,
  dryPen: 3,
  livePen: 4,
} as const;

/** Where live ink gets its canvases: the tile store's pool. */
export type InkCanvasLender = {
  lend(): InkCanvas | null;
  takeBack(canvas: InkCanvas): void;
};

/** What a stroke needs from the dry tiles: the canvas of its layer at a tile, and the pool. */
export type InkLiveSource = InkCanvasLender & {
  dryCanvas(tile: InkTile): InkCanvas | null;
};

type LiveTile = {
  tile: InkTile;
  canvas: InkCanvas;
  /** What this stroke has painted here, in sheet device pixels. */
  painted: InkDeviceRect | null;
  /** The dry canvas copied in and hidden, if there was one. */
  base: InkCanvas | null;
};

/** A short path drawn after the stroke, and everywhere it can paint. */
export type InkLiveTipPath = { path: InkPath2D; paint: InkPaint; area: InkDeviceRect };

/** A live tile the stroke painted, for the lift. */
export type InkLiveTileRegion = { tile: InkTile; canvas: InkCanvas };

export class InkLiveLayer {
  private readonly live = new Map<string, LiveTile>();
  /** Tiles on screen this stroke reached with no canvas to be had. */
  private readonly missed = new Set<string>();
  /** Tiles on screen: the only ones live ink draws. */
  private onScreen = new Set<string>();
  private level: InkRenderLevel | null = null;
  private source: InkLiveSource | null = null;

  constructor(readonly container: HTMLDivElement) {
    container.style.position = "absolute";
    container.style.left = "0";
    container.style.top = "0";
    container.style.transformOrigin = "0 0";
    container.style.zIndex = String(INK_LAYER_Z.livePen);
  }

  /**
   * Live ink draws on `level`, over `tiles` (what is on screen).
   * `standInScale` is the CSS scale the level is shown at while a newer zoom
   * draws, so live ink lines up with the tiles it will land in. Between
   * strokes only.
   */
  place(level: InkRenderLevel, tiles: readonly InkTile[], standInScale: number): void {
    this.end();
    this.level = level;
    this.onScreen = new Set(tiles.map((tile) => tile.key));
    this.container.style.transform = standInScale === 1 ? "" : `scale(${standInScale})`;
  }

  /** A stroke starts on `layer`, standing in for the dry tiles `source` finds. */
  begin(layer: InkLayer, source: InkLiveSource): void {
    this.end();
    this.source = source;
    this.container.style.zIndex = String(layer === "highlighter" ? INK_LAYER_Z.liveHighlighter : INK_LAYER_Z.livePen);
  }

  /**
   * Repaints `path` in every tile on screen that `dirty` (sheet device
   * pixels, where the stroke changed) meets: the dry pixels are put back
   * wherever the stroke was or now is, and the whole path is painted over
   * them. `area` is everywhere the path can paint, and the `tip` (drawn
   * after the path) says the same of itself; each is drawn only in tiles its
   * own area meets. Tiles `dirty` misses already show exactly this path. The
   * canvas's edge is the only clip, as in a dry tile: a clip set on the
   * context antialiases edges differently.
   */
  draw(
    path: InkPath2D,
    paint: InkPaint,
    area: InkDeviceRect | null,
    dirty: InkDeviceRect,
    tip: InkLiveTipPath | null = null
  ): void {
    const level = this.level;
    if (!level) return;
    for (const tile of inkTilesForDeviceRect(level, dirty)) {
      const live = this.live.get(tile.key) ?? this.standIn(level, tile);
      if (!live) continue;
      const tileRect = inkTileDeviceRect(level, tile.col, tile.row);
      const strokeRect = area ? inkDeviceRectIntersection(tileRect, area) : null;
      const tipRect = tip ? inkDeviceRectIntersection(tileRect, tip.area) : null;
      const painting = inkDeviceRectUnion(strokeRect, tipRect);
      const stale = inkDeviceRectUnion(live.painted, painting);
      if (stale) this.putBack(live, { ...stale, x: stale.x - tileRect.x, y: stale.y - tileRect.y });
      if (painting) {
        setInkDeviceTransform(live.canvas.ctx, level.unitPx, tileRect.x, tileRect.y);
        if (strokeRect) paintInkPath(live.canvas.ctx, path, paint);
        if (tip && tipRect) paintInkPath(live.canvas.ctx, tip.path, tip.paint);
      }
      live.painted = painting;
    }
  }

  /** Whether a stroke reaching this tile would have been drawn there (it is on screen). */
  covers(tile: InkTile): boolean {
    return this.onScreen.has(tile.key);
  }

  /** Whether this stroke reached the tile on screen but could not draw there. */
  missedTile(tile: InkTile): boolean {
    return this.missed.has(tile.key);
  }

  /** The tiles this stroke has painted, for the lift. */
  painted(): InkLiveTileRegion[] {
    const tiles: InkLiveTileRegion[] = [];
    for (const live of this.live.values()) if (live.painted) tiles.push({ tile: live.tile, canvas: live.canvas });
    return tiles;
  }

  /**
   * The lift has made this live tile's canvas the dry tile (and given the dry
   * canvas it stood in for back to the pool), so live ink lets go of it.
   */
  handOver(tile: InkTile): void {
    this.live.delete(tile.key);
  }

  /** Ends the stroke: lent canvases go back, and the dry tiles they stood in for show again. */
  end(): void {
    for (const live of this.live.values()) {
      if (live.base) live.base.element.style.visibility = "";
      live.canvas.element.remove();
      this.source?.takeBack(live.canvas);
    }
    this.live.clear();
    this.missed.clear();
    this.source = null;
  }

  dispose(): void {
    this.end();
    this.container.remove();
  }

  /**
   * The first touch of a tile on screen in a stroke: a canvas borrowed and
   * placed, the dry tile's pixels copied in, and the dry tile hidden.
   */
  private standIn(level: InkRenderLevel, tile: InkTile): LiveTile | null {
    const source = this.source;
    if (!source || !this.onScreen.has(tile.key)) return null;
    const canvas = source.lend();
    if (!canvas) {
      this.missed.add(tile.key);
      return null;
    }
    const rect = inkTileDeviceRect(level, tile.col, tile.row);
    placeInkCanvas(canvas, rect.x, rect.y, level.devicePixelRatio);
    const base = source.dryCanvas(tile);
    if (base) {
      copyInkCanvasRegion(base, canvas, { x: 0, y: 0, width: base.width, height: base.height });
      base.element.style.visibility = "hidden";
    } else {
      clearInkCanvas(canvas);
    }
    // In tile order, not in the order the stroke reached them (see the top of this file).
    this.container.insertBefore(canvas.element, this.canvasAfter(tile));
    const live: LiveTile = { tile, canvas, painted: null, base };
    this.live.set(tile.key, live);
    return live;
  }

  /** The canvas of the first live tile that sorts after `tile`, or null: where a new live tile goes. */
  private canvasAfter(tile: InkTile): HTMLCanvasElement | null {
    let next: LiveTile | null = null;
    for (const live of this.live.values()) {
      if (compareInkTiles(live.tile, tile) > 0 && (!next || compareInkTiles(live.tile, next.tile) < 0)) next = live;
    }
    return next ? next.canvas.element : null;
  }

  /** Puts the dry pixels back in a region (tile pixels), or clears it where there are none. */
  private putBack(live: LiveTile, region: InkDeviceRect): void {
    if (live.base) {
      copyInkCanvasRegion(live.base, live.canvas, region);
      return;
    }
    const ctx = live.canvas.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(region.x, region.y, region.width, region.height);
  }
}
