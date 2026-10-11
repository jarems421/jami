# Jami Ink

Notebook ink is moving from js-draw to Jami's own engine. This is the plan
while the work is live. When it has shipped, what is still true folds into
`docs/architecture.md` and code comments, and the plan is deleted.

## Why

js-draw has been bent to fit Jami through hooks into its private internals:

- the live ink layer redirects its wet-ink renderer (`notebook-live-ink.ts`);
- the ink window clips its canvas (`notebook-ink-window.ts`);
- its display cache is off because it blurs on 2x screens, so every pan and
  zoom repaints the whole page from vectors (`notebook-js-draw-setup.ts`);
- its pen, preview and eraser are patched (`notebook-ink-runtime.ts`,
  `notebook-pen-preview.ts`).

Every performance fix has been another of these. The last one (6601c748) made
writing feel choppier and strokes visibly change at the lift. Fixing that is
deferred: there is no point tuning the engine being replaced.

Most of the hard, Jami-specific work is already our own code:

- One Euro smoothing;
- the Catmull-Rom pen with its pressure taper;
- the chisel highlighter and nib angle;
- the precision eraser and scribble-to-erase;
- the lift-off gate and the predicted tip;
- palm rejection and the Safari pointer quirks;
- zoom and pan.

js-draw holds the strokes, the undo history, the stroke eraser, SVG reading
and writing, and painting. Painting is where the problems are.

## Owner decisions (9 October 2026)

- **Storage.** Jami's own stroke format, with the explicit migration below.
- **New tools.**
  - Lasso: picks up ink, images, graphs and text boxes; move, resize, rotate,
    recolour and thickness.
  - Shape snapping.
  - Ruler.

  Recorded as an exception in `AGENTS.md`.
- **Highlighter.** Always drawn under pen ink.
- **Exam working sheet.** Gets the new engine, and the ruler only.
- **Tuning.** iPad and Apple Pencil first; the owner tests each stage on the
  device.
- **Rollout.** Everyone at once, with `enableJamiInk` as an emergency fallback
  to js-draw.

## Performance gates

Each stage must hold these targets, measured in Chromium (headless and
headed-GPU, CPU slowed 4x) by `e2e/ink-performance.perf.spec.ts` (the notebook
editor) and `e2e/ink-engine/perf.ink.ts` (Jami Ink's renderer alone), and by
the owner on iPad.

| Gate | Target |
| --- | --- |
| Pen to ink | Drawn inside the pointer event that carried the sample; never waits for a frame |
| Work per pen packet | ≤ 2 ms p95 on iPad, ≤ 4 ms in 4x-throttled Chromium |
| During a stroke | No canvas allocation, layout read, React render, tile render or Firestore work |
| Writing frames | None over 25 ms across a 200-sample stroke, fitted and zoomed, thin and thick |
| Lift | Pixel-identical (the lift diff changes 0 pixels), in ≤ 2 ms |
| Pinch | Compositor-only during the gesture; never blank; sharp within 100 ms of settling |
| Zoomed pan | No blank ink inside the prefetch ring; new tiles drawn in ≤ 4 ms slices |
| Page open | First ink ≤ 150 ms after the data arrives, for a 3,000-segment page |
| Erase, undo, redo, lasso | Only affected tiles redrawn, in ≤ 8 ms |
| Memory | ≤ 96 MB of canvas on iPad; no canvas over 4 MP |

Safari holds web pages to 60 frames a second by default, so the floor on
latency is the display pipeline, not the engine.

In Low Power Mode, and when an iPad runs hot, Safari holds every page to 30
frames a second, and no page can opt out. Measured on the owner's iPad (the
`?inkstats=1` readout): the ink work stayed at a millisecond a packet while
every frame was 33 ms, and writing, panning and dragging the toolbar all
showed it. Scrolling elsewhere in the app, which the iPad does itself, does
not. So the notebook looks at its own frame rate while it is open (a second's
look shortly after opening, every minute, and on coming back to the tab) and,
when it is steadily 30, tells the student that Low Power Mode is slowing
writing down and where to turn it off (`lib/workspace/notebook-power-saving.ts`,
`hooks/useNotebookPowerSavingNotice.ts`, shown by `NotebookFloatingNotices`).

### Measuring

```
npm run emulators:free
INK_PERF=1 INK_LABEL=js-draw npx firebase emulators:exec --project demo-jami-browser --only auth,firestore,storage "npx playwright test ink-performance"
```

- In PowerShell, set the variables first (`$env:INK_PERF = "1"`).
- `INK_MODE=gpu` runs it headed on the machine's GPU. Headless Chromium draws
  canvases in software, which makes big canvases look costly and hides the cost
  of reallocating one; the original 6601c748 measurement fell into exactly that.
- Run nothing else heavy alongside it.

Each phase prints frame times, pen-down cost, canvas reallocations and page
repaints. The lift diff counts pixels that change between the pen held at the
end of a stroke and the pen lifted.

### js-draw baseline

Recorded on 9 October 2026, headless, CPU 4x, 1180 × 820 at 2x, on a page of 14
rows of handwriting.

| Phase | Frames over 25 ms | Longest task | Page repaints | Notes |
| --- | --- | --- | --- | --- |
| Fitted, 12 short strokes | 6 | none | 0 | Pen-down handler 2.9 ms on average |
| Fitted, long stroke | 6 | none | 0 | |
| Fitted lift (thickness 50) | n/a | n/a | n/a | 438 pixels change when the pen lifts |
| Pinch in and settle | 7 | 109 ms | 3 | The page canvas was reallocated once |
| Zoomed, 12 short strokes | 69 | 66 ms | 0 | |
| Zoomed, long stroke | 81 | 53 ms | 0 | The live canvas was reallocated 6 times mid-stroke |
| Zoomed lift (thickness 20 / 85) | n/a | n/a | n/a | About 2,700 pixels change when the pen lifts, half darker, half lighter |
| Zoomed, 6 one-finger pans | 39 | 129 ms | 18 | Every pan repaints the whole window about three times |
| Pinch out and settle | 20 | 78 ms | 3 | |

What students feel, in numbers:

- **The stroke changes at the lift.** It is redrawn by a different route the
  moment it is committed, so its edges move. That is the "resize".
- **Writing zoomed in is choppy.** A third of the frames of a long stroke run
  long.
- **Zoomed panning stalls.** Every pan repaints the whole window, because the
  display cache is off.

A first baseline recorded on the same day was wrong. Its helpers closed the
pen settings with Escape, which in the notebook picks the select tool, so
every stroke after it was a selection drag that drew nothing. The helpers now
close the settings by pressing the tool again, as a student would.

### Measuring the renderer alone (stage 3)

The renderer has its own specs in `e2e/ink-engine/`, run by
`playwright.ink.config.ts`. They bundle a small harness (the renderer, js-draw
and the test scenes) with esbuild into a blank page, so there is no app
server, no build and no emulator. The files end in `.ink.ts`, which the app's
Playwright config and Vitest never pick up.

```
npx playwright test -c playwright.ink.config.ts                       fidelity and lift
INK_PERF=1 npx playwright test -c playwright.ink.config.ts perf       the render gates
INK_PERF=1 INK_MODE=gpu npx playwright test -c playwright.ink.config.ts perf
```

In PowerShell `npx` is blocked; set the variables first and call the binary:

```
$env:INK_PERF = "1"; $env:INK_MODE = "gpu"
node_modules\.bin\playwright.cmd test -c playwright.ink.config.ts perf
```

- **Fidelity.** Each page is drawn by js-draw, set up as the notebook sets it
  up, and by the engine (importer, `InkDocument`, renderer), and the
  screenshots are compared. Pages: the captured fixtures in
  `tests/fixtures/ink/js-draw/`, old v1 strokes, a page in the shape
  `scripts/seed-large-notebook.mjs` writes (3,060 segments), the same page
  with half its rows in the script's old implicit form (which js-draw and the
  importer both drop), and a page of synthetic handwriting (about 3,000),
  each fitted and zoomed in.
- **The tolerance, and why.** Chrome antialiases the same path differently on
  canvases of different sizes: drawn by js-draw's calls and by the engine's
  on one canvas the pixels are identical, but the edge of the same line moves
  by 0.02 to 0.11 of a device pixel between a 2360 x 1640 canvas (js-draw's)
  and smaller ones (the engine's 512-pixel tiles). js-draw also flattens
  curves shorter than about 0.7 CSS pixels into lines, which moves the round
  end of a thin stroke. So a pixel counts as different when a channel moves
  by more than 64 of 255, and a page fails when the pixels over that touch
  one another in a group of more than 16. Antialiasing leaves isolated pixels
  and runs of at most 11; every real difference found makes groups of 75 to
  over 200,000. Two pages are expected to differ, and the spec checks that it
  sees them: the highlighter fixture (its highlighter crosses a pen line
  drawn before it, and Jami Ink puts highlighter under pen ink) and v1
  highlighters (js-draw ignores their `opacity="0.42"`, the importer honours
  it, by design).
- **Lift.** A stroke is written as live ink over existing pen and highlighter
  ink, screenshotted with the pen down and again after the lift: 0 pixels may
  change. A highlighter's last packet draws its traced outline, as the editor
  does (see "The lift" below), so its lift is held to 0 too. The page is then drawn again from nothing and compared with what the
  lift left, within 24 of 255 ("The lift", under `lib/ink-dom/` below, says
  why it is not 0). The same lifts are run again with the predicted tip
  showing on every packet, the last included: they must leave the very pixels
  of the same stroke lifted with no tip (0 differ), and the tip must show while
  the pen is down. The warm-up is checked for leaving no pixel changed, for
  being invisible while it is up (at most 1 of 255 off), and for giving its
  canvas back to a stroke that begins during it, which then lifts unchanged.
- **The gates** are measured at 1180 x 820 and 2x, the CPU slowed 4x: work
  per packet and frames for three 200-sample strokes through the real pen and
  highlighter geometry, thin and thick, fitted and zoomed, over a page of
  3,000 segments (the page is opened as the editor opens it, asking for the
  GPU warm-up once its ink is on screen); the first stroke on a page in a
  freshly launched browser, with the warm-up and without it, drawing the
  predicted tip too (every other test shares one browser, whose GPU would
  already be warm); canvas allocations, tile draws and layout reads during the
  strokes (layout reads are counted by watching the browser's own layout
  APIs); the lift; page open; six zoomed pans; erase, undo and add; a zoom
  settling; memory. Gates that need the real editor (ink inside the pointer
  event, the pinch, React renders and Firestore work during a stroke) are
  stage 4's, in `ink-performance.perf.spec.ts`.

One thing the fidelity work found about js-draw itself: `SVGLoader` drops a
subpath whose points after `M` are implicit line-tos with no minus sign (it
takes such a piece for a lone move), so the pages
`scripts/seed-large-notebook.mjs` wrote drew nothing in js-draw. The script
now writes an explicit `L`, and `importJsDrawSvg` drops what js-draw drops
(owner decision, 10 October 2026), so an old page opens exactly as it showed.

### Jami Ink renderer results

Recorded on 10 October 2026 with `e2e/ink-engine/perf.ink.ts`, CPU 4x,
1180 x 820 at 2x, over a page of about 3,000 segments. Writing is three
200-sample strokes, two samples a packet every 8 ms. The GPU column is the
last run before the stage was committed, with every change in; the headless
column is from just before the highlighter's last packet began drawing its
traced outline. The machine was shared, so timings vary by a few tenths of
a millisecond between runs.

| Gate | Target | Headless | Headed GPU | js-draw baseline (headless) |
| --- | --- | --- | --- | --- |
| Work per packet (p95) | ≤ 4 ms | 0.7 to 1.6 ms (longest 3.4) | 0.8 to 2.1 ms (longest 4.5: a highlighter's last packet, which traces its outline) | Pen-down handler 2.9 ms |
| Frames over 25 ms, fitted | 0 | 0 of about 290 per case | 0 of about 590 (with the warm-up) | 6 |
| Frames over 25 ms, zoomed | 0 | 1 to 15 of about 400, each 33 ms | 0 of about 590 (with the warm-up) | 69 (short strokes), 81 (long stroke) |
| First stroke, fresh browser | first four frames, and all of them, under 25 ms | 0 of about 95 fitted; zoomed pen 0 to 2 of about 130, the headless miss below | 0 of about 200 frames in each of three strokes (5.4 to 5.7 ms at the start); without the warm-up 1 of about 195, 28 to 39 ms, on frame 1 or 2 | not measured |
| During a stroke | 0 allocations, tile draws, layout reads | 0, 0, 0 (besides one copy of each dry tile a stroke reaches) | 0, 0, 0 (the same) | Live canvas reallocated 6 times |
| Lift | 0 px, ≤ 2 ms | 0 px; 0.8 to 1.4 ms (a page's first lift, cold: 2.6 to 3.4 ms) | 0 px; 0.6 to 1.2 ms (cold: 2.4 to 3.5 ms) | 438 px fitted, about 2,700 zoomed |
| Page open, 3,000 segments | first ink ≤ 150 ms | 22 to 29 ms (all on screen by 44 to 70 ms) | 23 to 38 ms (all by 30 to 44 ms) | not measured |
| Background slices | ≤ 4 ms | 3.8 ms at most | 3.7 ms at most | not sliced |
| Zoomed pan | no blank tiles; ≤ 4 ms slices | 0 blank; 3.3 ms; no frame over 25 ms | 0 blank; 1 ms | 39 frames over 25 ms, 18 repaints |
| Erase, undo, add | affected tiles only, ≤ 8 ms | 2 to 6 of 9 or 24 tiles; 0.6 to 2.9 ms | 0.4 to 1.8 ms | whole window repainted |
| Zoom settle | never blank | old level stood in; new one in 153 ms | in 24 ms | 3 repaints, 109 ms task |
| Memory | ≤ 96 MB, no canvas over 4 MP | 76.5 MB at most; 0.26 MP | 76.5 MB at most; 0.26 MP | |

Stage 4 added the predicted tip, the page size and `whenVisibleDrawn`, and the GPU warm-up that closes the first-frame stall (below); the figures above were re-run with them in on 10 October 2026, headless and on the GPU, and none regressed.

Not yet met:

- **Zoomed writing frames in headless Chromium**, accepted as they are by the
  owner on 10 October 2026: ink is not drawn differently to chase them. One
  to fifteen frames in about 400 take 33 ms (one missed frame each). They are
  spent in `Canvas2DResourceProviderSharedImage::ProduceCanvasResource`: headless
  composites in software and copies every changed tile canvas whole each
  frame, and a zoomed stroke changes one or more tiles a packet (all it
  covers, when pressure reshapes the whole stroke). On the GPU the same
  writing has none.

The first frame of the first stroke in a fresh browser took 28 to 33 ms on
the GPU (shaders compiled the first time a canvas is copied into another and
painted). Stage 4's `warmUp()` fixes it (see "Live ink" below); the first
stroke is now measured in a browser of its own, with and without it.

Lift timings are taken on the second and third strokes; the first lift on a
page runs before the JIT has seen it.

## Architecture

### `lib/ink/`: pure, DOM-free, and also used on the server

Built (stage 1), all flat files in `lib/ink/`:

- **`model.ts`.** An `InkDocument` holds ordered items, each with a stable id
  and cached bounds (`inkItemBounds`). Item kinds today:
  - `outline`: a filled or stroked path, for imported ink;
  - `shape`: a parametric line, arrow, polygon or ellipse;
  - `unknown`: an item from a newer writer, kept whole (id, layer byte,
    payload) and written back unchanged.

  Highlighter items are always drawn under pen items. Page coordinates stay
  900 × 1240. Pen and highlighter centreline items arrive as new kinds.
- **`codec.ts`, `codec-quantize.ts`, `bytes.ts`.** The `jami-ink` v3 codec,
  `"j3:" + base64url`: coordinates quantised to 1/16 page unit, delta- and
  varint-encoded, strict decoding that never throws, and golden strings that
  freeze the stored format.
- **`path.ts`, `arc.ts`, `matrix.ts`, `svg-scan.ts`.** The one SVG path
  reader and writer (the whole grammar reduced to absolute M, L, C, Q, Z,
  with arcs turned into curves), exact bounds, transforms and the shared
  number scanner.
- **`color.ts`.** Reading and writing CSS colours. Jami writes only 6 or 8
  digit hex, because js-draw reads short hex differently.
- **`shapes.ts`.** The path a parametric shape is stroked along.
- **`import-js-draw-svg.ts`, `svg-xml.ts`, `svg-style.ts`.**
  `importJsDrawSvg` turns a page saved by js-draw into `outline` items.
  It reproduces what js-draw drew, so it follows js-draw's own SVG loader,
  quirks included:
  - only `<path>` elements become ink, and other drawing elements are
    listed as unsupported;
  - paint is the path's own attributes, then its `style`, with no
    inheritance from groups and no stylesheets;
  - transforms and `viewBox` are not applied;
  - a subpath whose points after a capital `M` are implicit line-tos with
    no minus sign is dropped, as js-draw's loader drops it
    (`jsDrawPathData`); other readers of path data follow the SVG grammar;
  - old translucency written as `opacity` is honoured, on purpose.

  `svg-xml.ts` is a tolerant, linear-time, DOM-free XML reader for
  student-controlled text; `svg-style.ts` resolves the paint.
- **`import-legacy-strokes.ts`.** `importLegacyStrokes` handles v1 strokes
  through today's conversion, so old pages look as they do now.
- **`export-svg.ts`.** `inkToSvg` produces the static SVG for previews,
  thumbnails, the server, exam marking and the rollback copy, with explicit
  paint on every path and no stylesheet. A test loads it with js-draw's own
  loader and checks the strokes, colours and bounds.
- **`spatial-index.ts`.** A 64-unit grid for hit tests and tile queries.
- **`history.ts`.** Invertible commands (add, erase, transform, restyle,
  clear), feeding the merged text-and-ink history in `notebook-history.ts`.

Built (stage 2), in `lib/ink/geometry/`, with no js-draw import and runnable in
Node:

- **`pen.ts`, `pen-widths.ts`, `pen-tuning.ts`.** The pen: the Catmull-Rom
  spline through the samples, corners, easing, the pressure taper, and
  straightening with aiming. `createInkPenBuilder` takes samples and returns
  path commands plus whether to fill or stroke them. Colour stays with the
  caller.
- **`chisel.ts`, `convex-union.ts`.** The highlighter: the nib swept along the
  path, one footprint per step, and their union as one loop at the lift. The
  precision eraser uses the union too.
- **`vector.ts`.** The small immutable vector these use in place of js-draw's
  `Vec2`, with the same arithmetic.

`notebook-smooth-pen.ts` and `notebook-chisel-stroke.ts` are now only the
js-draw builders around this geometry (`notebook-stroke-builder-adapter.ts` has
what they share), so today's editor and the new engine draw from one
implementation. `tests/ink-geometry-golden.test.ts` freezes the paths they
draw, wet and committed, across about thirty strokes, so a saved stroke never
changes shape.

Built (stage 3), flat files in `lib/ink/`:

- **`render-plan.ts`.** The pure plan behind the renderer: a level per settled
  zoom and screen density, its tiles (256 CSS pixels, a whole number of
  device pixels, on a grid from the sheet's corner), the visible tiles nearest
  the middle first, the prefetch ring, the tiles a change touches, the memory
  budget and the LRU, when a new level may replace the old one, and the
  device-pixel snap. Page coordinates stay 900 x 1240 unless the renderer is
  given another page size (`createInkRenderer(host, { page })`, for the exam
  working sheets, which are 900 wide and any height): the size sets only the
  number of rows and columns, never what a tile holds.
- **`path-change.ts`.** Where a path changed between two packets of a stroke
  being written, for live ink to repaint only there.

Still to come:

- **Incremental geometry.** The builders recompute the whole curve on every
  preview. The incremental form returns newly frozen segments and the unstable
  tail, with corners and easing looking only a bounded window behind the tip.
  Some of the pen's geometry depends on the whole stroke, so this would change
  how ink looks, which is the owner's decision. Stage 3 does not do it: live
  ink redraws the whole stroke on every packet, which keeps today's look and
  measured well inside the per-packet gate.
- **`tools/`.** All pure:
  - the stroke and precision erasers (outline items clipped with
    `polygon-clipping`);
  - scribble-erase;
  - lasso selection;
  - shape recognition;
  - ruler geometry.

### `lib/ink-dom/`: the browser engine, imperative and outside React

Built (stage 3), the renderer: `createInkRenderer(host)` in `renderer.ts`.
It has no pointer input and reads no layout; whoever drives it says where the
sheet is (`setViewport`), what the page holds (`setDocument`, `applyChange`
with an `InkChange` from `history.ts`), when a gesture holds the sheet
(`beginGesture`, `endGesture`) and what the pen did (`beginLive`,
`drawLive`, `commitLive`, `cancelLive`). Always-on counters (`stats`,
`coverage()`) are what the perf spec reads.

- **One rasteriser** (`rasterizer.ts`). Every item, and the live stroke, is
  a `Path2D` in page units, built once per item, drawn through
  `setTransform` (device pixels per page unit, and a whole-pixel origin), so
  tiles are vector-sharp at any zoom. It paints as js-draw's canvas renderer
  did: fill then stroke, round caps and joins, one path per item.
- **Dry tiles** (`tile-store.ts`).
  - Tiles of a level are drawn in two layers, highlighter under pen, and a
    layer's canvas exists only where that layer has ink.
  - Every canvas is a tile: one pool at one fixed size, shared by dry and
    live tiles, re-targeted, never resized, and none over 4 MP. An LRU keeps
    the pool inside 96 MB; tiles on screen are pinned. Nothing is reserved
    for live ink. At 2x, 96 MB is 91 tiles, enough for both layers on 45
    tiles on screen: a 1180 x 820 screen meets at most 30 and a 12.9-inch
    iPad 35, but a 1920 x 1080 screen meets up to 54. Past the bound, a tile
    draws its pen layer first (writing never goes blank first) and its
    highlighter waits until a canvas comes back to the pool, which retries
    it in the background. If a new zoom cannot fit beside the old level, it
    replaces the old level partly drawn and finishes with the canvases that
    frees.
  - A dense tile is drawn over several slices, stopping before an item that
    would run past the slice and carrying on first in the next. A blank tile
    fills in as it goes; a tile still showing older ink (changed while out of
    sight, then panned to) is drawn into a spare canvas and swapped in whole,
    so a tile on screen never shows half drawn.
- **Live ink** (`live-layer.ts`).
  - Live tiles are canvases exactly like dry tiles, on the same grid: Chrome
    antialiases differently on canvases of different sizes, and one grid with
    one canvas size is what lets live and dry pixels match.
  - They are lent from the pool when a stroke first reaches a tile on screen
    and given back when it ends. The pool keeps a screenful of spares warm;
    past those it takes a canvas from a tile out of sight, and it never makes
    one during a stroke, so "no allocations during a stroke" always holds.
    With every canvas pinned, the tile is noted as missed: the stroke does
    not show there while it is written, and the lift paints it in.
  - When a stroke first reaches a tile, the live tile copies the dry tile of
    the stroke's layer (one full-tile copy per tile per stroke, counted in the
    packet's time, not as a tile draw) and stands in for it (the dry tile is
    hidden). What is on screen is then a composite the canvas made, not one the compositor
    blends from two layers; the two round a translucent blend differently by
    a level in 255, where a stroke crosses ink of its own layer.
  - Each packet paints the whole stroke again, in every tile where it changed
    since the last packet (`path-change.ts`); a tile the change does not reach
    already shows exactly this stroke. A context clip would have been finer,
    but Chrome antialiases edges differently under one.
  - Stacking order: dry highlighter, live highlighter, dry pen, live pen. A
    highlighter is under pen ink while it is drawn, too.
  - **The predicted tip** (`drawLive(path, paint, tip)`): a short round-capped
    stroked path drawn after the stroke in the same live tiles. Where the tip
    was and where it now is count as changed, like the stroke's own change, so
    a tile it left or reached is repainted (not clipped: see above). At the
    lift the tiles it touched are first repainted with the stroke alone, then
    the lift is as it always was, so the tip never reaches a dry tile; with no
    tip showing the lift does nothing extra.
  - **The GPU warm-up** (`warmUp()`, `warm-up.ts`). On a fresh browser the first
    stroke on a page stalled a frame for 28 to 33 ms while the GPU compiled the
    shaders for copying a tile canvas into another (the live tile copying the
    dry tile at a stroke's first touch, then the regions put back on every
    packet: a whole-tile copy and a partial one are different shaders) and for
    the paints. Measured by trying variants in fresh browsers: drawing on
    hidden canvases warms nothing (Chromium never flushes them), a canvas that
    is cleared whole in the task it was drawn in has its drawing thrown away
    unseen, and a presented canvas drawn on at full or at 1/255 alpha both
    work. So the warm-up takes two spare canvases from the pool (never making
    one), puts one over a visible tile in the live layer, runs every live-ink
    drawing path on it (whole and partial copies from the other, a pen outline
    fill, a round-capped stroke, the highlighter's translucent fill, a partial
    clear) at an alpha of 1/255, leaves it for two frames, then clears it and
    gives both back. It is three steps, each a background slice of its own
    (1 to 2 ms with the CPU slowed 4x, a software canvas included), at idle
    priority, so it starts only when the visible tiles and the ring are drawn:
    page-open first ink is unaffected. The editor asks for it when
    `whenVisibleDrawn` fires. A gesture, a new viewport or a destroy gives the
    canvas back at once (and it runs again later); a stroke gives it back and
    ends it for good, since the stroke is itself the first use of those paths.
    It leaves no pixel changed.
- **The lift.** If the committed item is exactly what live ink last drew, the
  live tiles become the dry tiles and the dry canvases they stood in for go
  back to the pool: nothing is drawn or copied, so no pixel changes. A tile
  live ink missed has the stroke painted in. Anything else (a path rounded by
  the codec, say) is painted afresh.
  - **The highlighter at the lift** (owner decision, 10 October 2026). Its
    footprints are drawn while it is written, but what is saved and reopens
    is their traced outline (`build()`). So the last live packet draws the
    traced outline, and the lift commits exactly that: what shows after the
    lift is what is saved. The renderer needs nothing for it: the last
    packet changes every subpath, `inkPathChange` covers both versions, and
    every tile either touches is repainted. Tiles off screen are redrawn in
    the background. One consequence: Skia picks its antialiasing per path
    (analytic or supersampled, by how many points the path has for its size),
    so a tile kept from earlier in a long stroke can differ from a later full
    redraw of it by a few levels at edge pixels (15 of 255 at most, measured on
    highlighter footprints).
  - **In the editor** (`InkStrokeSession`), the last live movement is not the
    pen-up: a pen that has stopped is still on the glass. The highlighter
    draws the traced outline (`build()`, made once and kept until a sample is
    added) as soon as the pen has stopped, that is no packet for
    `HIGHLIGHTER_SETTLE_MS` (50 ms: three frames at 60 Hz, where a pencil
    reports every 4 ms and a moving pen delivers a packet each frame), or as
    soon as the lift-off gate begins holding samples (the pressure is
    falling away as the pen leaves). Movement after that draws footprints
    again. The lift then commits the outline already on screen and draws
    nothing, so no pixel changes. Only a flick that lifts while the footprints
    are still showing draws the outline at the lift, and only then can edge
    pixels change, by the few levels above. The outline is never built on the
    per-packet path.
  - **Tile stacking order.** Canvases that abut meet in a seam row where each
    covers a hair of the other (the layers sit a rounding error off a device
    pixel), so the order they stack in decides that row's edge pixels by a
    level in 255. A zoomed pen stroke across a tile seam showed it: its live
    tiles stacked in the order the stroke reached them, the lift adopts them in
    tile order (`compareInkTiles`: a row at a time, left to right), and 8 to 18
    seam pixels changed. Live tiles are now inserted into the live layer in tile
    order, so adopting them changes nothing. Nothing else changes at the lift:
    no canvas is drawn on, none is made, the layer tree is identical, and the
    canvas pixels read back equal; only the stacking order differed.
- **Scheduler** (`scheduler.ts`). Priorities:
  1. live ink, synchronous;
  2. the commit at the lift, synchronous;
  3. visible tiles, nearest the middle first;
  4. the prefetch ring, one tile around the screen;
  5. idle work (spare canvases kept ready).

  Levels 3 to 5 run in slices aimed at 2.5 ms (so an item crossing the end
  still lands inside the 4 ms gate), posted through a message channel, and never
  during a stroke or gesture. A viewport, a document or a change set during a
  stroke waits for it to end (live tiles hold copies of the dry tiles under
  them); if the page changed, the lift paints the stroke afresh over it.
- **Zoom.** A new zoom is a new level drawn behind the old one, which stays on
  screen scaled until every tile on screen is ready, then is replaced in one
  step. A stroke written meanwhile is drawn on the old level, so its lift is
  still exact.
- **`whenVisibleDrawn(callback)`.** Calls back once when every visible tile of
  the level on screen is drawn and no new zoom waits to replace it, after
  `setDocument` and `setViewport` (on the next microtask if that is already
  so), and returns a cancel. The editor uses it to drop its static underlay
  when a page opens.
- **Changes.** A change redraws only the tiles it touches: those on screen at
  once, the rest when next needed. Items added on top of the page are painted
  onto the tiles rather than redrawing them.
- **Pixel snap.** Given the sheet's position on screen, the ink is nudged by
  under a pixel so every canvas sits on whole device pixels
  (`inkDevicePixelSnap`, which js-draw's live ink shares until it goes).

Still to come:

- **`InkSurface`** (stage 4). Owns the model, input, renderer and history,
  behind the handle `NotebookInkEditor` has today: undo, redo, clear,
  hasInk, serialize and snapshot.
- **The predicted tip's geometry**, drawn by stage 4's stroke session; the
  renderer side is built.
- **PDF detail and snapshots** under the scheduler (stage 7).
- **Input.** Kept as is:
  - `NotebookInkSmoother`, `NotebookLiftOffGate`, the coalesced-sample bounds,
    the predicted tip;
  - `NotebookNibAngleTracker`, `NotebookInkPointerLifecycle`;
  - the palm guards and the pen's eraser end.

## Integration

- **Editor.** `NotebookInkEditor` is rebuilt on `InkSurface` with the same
  props and handle, so the notebook page and `ExamScratchpad` change together.
  - It is a switch on `enableJamiInk` (`NEXT_PUBLIC_ENABLE_JAMI_INK`, on from
    stage 4 so the owner can test on the live iPad; off is the fallback):
    `JamiInkEditor`, or `JsDrawInkEditor`, which is the old
    editor unchanged and stays the fallback. The handle and props type live in
    `components/workspace/notebook-ink-editor-types.ts`.
  - `hooks/useJamiInkSurface.ts` builds and destroys the surface and is the one
    place the sheet is measured: a single `getBoundingClientRect()` of the host
    when the page, `inkFrame` or `inkWindow` change, when the window resizes and
    120 ms after a scroll ends (the engine's background drawing is held while it
    lasts). It never measures during a stroke or an erase; a scroll or resize
    marks the measurement stale, and the next contact measures once before it
    begins. The viewport and the stroke mapping come from the pure
    `inkSurfaceViewport` in `lib/ink-dom/surface-viewport.ts`.
  - `hooks/useJamiInkPointerInput.ts` is the pointer routing of
    `useNotebookInkPointerInput` without js-draw: the same contact tool per
    pointer (the pen's eraser end), palm and touch left to the page, capture and
    cancel safeguards, and the eraser ring. The tool is fixed when the pen lands,
    so a style change mid-stroke needs no deferral.
  - **Timing on the device** (`lib/ink-dom/input-trace.ts`,
    `components/workspace/InkStatsOverlay.tsx`). Opening a notebook with
    `?inkstats=1` (kept for the tab until `?inkstats=0`) shows the frames of
    the last two seconds, pen or no pen, and the worst two seconds since the
    notebook began to open (its loading screen included); and after each pen
    stroke, how old the samples were when the handler ran, how long the ink
    work took per packet, how long until the next frame, the frames while the
    pen was down, how many coalesced and predicted samples Safari sent, and the
    lift. It is how delay and heaviness felt on an iPad get measured, since
    desktop Chromium cannot stand in for Safari there. Off, it costs nothing;
    on, it allocates nothing during a stroke and writes the stroke figures only
    at the lift.
  - **Nothing under the page.** An open notebook covers the screen with its
    own opaque surface, so the app's photo background and its text halo are
    switched off while it is open (`jami-notebook-open` on the body, set by
    `useNotebookEditorShell`; the rule is in `app/globals.css`), and the header
    has no backdrop blur. On an iPad every layer under the page is composited
    with every frame of ink, pan and toolbar drag, seen or not.
  - `inkFrame` is where the sheet sits in the frame that shows it (the numbers
    `getNotebookInkRenderWindow` takes). The snapped `inkWindow` does not change
    for a small pan, so the engine needs it to know the visible part of the
    sheet once a pan settles. js-draw ignores it.
- **Saving.**
  - `NotebookInkData` becomes `js-draw-svg` (v2) or `jami-ink` (v3, with an
    SVG copy during the rollout window).
  - `isNotebookInkRecordWithinLimits` counts both. The copy is compacted, or
    marked omitted, when it would not fit.
  - Drafts store v3.
- **Readers.** One helper serves the server
  (`notebook-neighbour-pages.server.ts`, `practice-paper-evidence.server.ts`,
  `notebook-page-render.server.ts`), thumbnails, `previewInkSvg` and the
  static page readers.
- **Exam working.** `examWorkingHasInk` reads the model. The marking image is
  drawn by the engine. Exam attempt pages store v3 plus an SVG copy.
- **Swipes.** Swipe and warm snapshots become engine bitmaps.
- **Unchanged.** Toolbar, tool settings, shortcuts, style sync, the text, image
  and graph layers, PDF rendering (now scheduled by the engine) and phone
  viewing.

## New tools

- **Lasso (L).**
  - The loop is drawn with the pen or a mouse; touch still pans.
  - Handles move, resize and rotate the selection. Colour and thickness come
    from the tool popover.
  - Images and graphs gain an optional `rotation`, read as 0 when absent. Text
    boxes move and resize but stay upright.
- **Shapes on hold.** "Straighten on hold" becomes "Shapes on hold". Holding
  still at the end of a stroke snaps it to a recognised shape, stored as a
  `shape` item. While the pen stays down it can adjust the shape.
- **Ruler.**
  - Fingers that start on the ruler move and turn it instead of panning.
  - It has an angle readout with detents, and the pen within 16 px of an edge
    draws along it.
  - It is not saved. On the exam sheet it is the only new tool.

## Migration

Explicit, as `docs/architecture.md` requires:

- Nothing is converted in the background. Old pages (js-draw SVG, inline
  legacy ink, v1 strokes) open through the importers unchanged.
- A page becomes `jami-ink` v3 only when the student edits it and it saves.
- The SVG copy keeps every page readable by a js-draw build until cleanup.
- Readers of the old formats stay for good. Removing one needs an explicit
  migration and a production count check.

## Stages

Each stage lands complete in itself, inside the size gate. Stages 0 to 3 landed
with `enableJamiInk` off; from stage 4 it is on, so the owner tests each stage
on the live app (the few students using notebooks agreed), with off as the
fallback to js-draw.

0. **Housekeeping (done).** This document, the `AGENTS.md` exception, and the
   perf harness with the js-draw baseline.
1. **Model, format and history.** The model, codec, importers, SVG export,
   spatial index and history, with golden fixtures, round-trips and js-draw
   readback tests.
2. **Geometry port (done).** Golden tests prove the ported outlines equal today's,
   command for command.
3. **Renderer (done).** Rasteriser, dry and live layers, scheduler, zoom
   placeholders, the fidelity and lift diffs, and the render gates. One gate is
   not yet met in headless Chromium (zoomed writing frames); see "Jami Ink
   renderer results".
4. **Input and core tools (done).**
   - Pen, highlighter, both erasers, scribble-erase, straightening, the eraser
     end, undo, redo and clear.
   - `NotebookInkEditor` on `InkSurface`, in notebooks and the exam sheet.
   - The owner's first iPad round.
5. **Saving and every reader.** Format, drafts, limits, the server, thumbnails,
   swipes and exam working.
6. **New tools.** Lasso, shapes on hold and the ruler. The owner's second iPad
   round.
7. **Performance.**
   - A worker renderer, only if the gates need it.
   - PDF detail under the engine scheduler.
   - The memory budget.
   - The owner's third iPad round.
8. **Release and cleanup.**
   - `enableJamiInk` stays on, with the env override back to js-draw.
   - After two weeks without a rollback: stop the SVG copy, and delete
     js-draw, `@js-draw/math`, its CSS, the glue modules and their tests.
   - Update the README, `architecture.md`, `manual-qa.md` and `llms.txt`.

## Verification

- **Unit.** Unit and golden tests for every `lib/ink` module. A full
  `npm test`, typecheck, lint, `check:sizes` and build at each stage.
- **Browser.**
  - The fidelity and lift diffs.
  - The perf harness gates, headless and on the GPU.
  - The notebook smoke, sheets and exam specs, offline draft restore, and the
    fallback flag.
- **The owner on iPad** (the notebook section of `docs/manual-qa.md`):
  - rapid strokes, dots, sharp corners, long strokes;
  - both erasers and tool switching;
  - a palm on the glass;
  - pinching and panning zoomed in;
  - ruled, grid, dot and PDF pages; swipes;
  - the highlighter under ink;
  - lasso, shapes and ruler;
  - exam working and its marking image;
  - old pages;
  - the flag turned off.
- **Separately.** Desktop mouse and a touchscreen pen.
