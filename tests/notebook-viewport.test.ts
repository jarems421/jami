import { describe, expect, it } from "vitest";
import {
  clampNotebookViewportOrigin,
  getNotebookInkViewportScale,
  getNotebookOriginForScroll,
  getNotebookScrollOffset,
  getNotebookViewportScroll,
  getNotebookViewportLayout,
  getNotebookViewportPanBounds,
  getNotebookViewportSwipeGap,
  getNotebookViewportSwipeTravel,
  NOTEBOOK_VIEWPORT_COMPACT_SWIPE_GAP,
  NOTEBOOK_VIEWPORT_MAX_ZOOM,
  NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE,
  NOTEBOOK_VIEWPORT_MIN_ZOOM,
  NOTEBOOK_VIEWPORT_SWIPE_GAP,
  zoomNotebookViewportAbout,
} from "@/lib/workspace/notebook-viewport";

describe("notebook viewport layout", () => {
  it("fits the fixed 900 by 1240 page inside an iPad portrait frame", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 768,
      frameHeight: 956,
    });

    expect(layout.logicalPageSize).toEqual({ width: 900, height: 1240 });
    expect(layout.inset).toBe(16);
    expect(layout.availableSize).toEqual({ width: 736, height: 924 });
    expect(layout.fitSize.width).toBeCloseTo(670.6451612903226);
    expect(layout.fitSize.height).toBe(924);
    expect(layout.fitScale).toBeCloseTo(924 / 1240);
    expect(layout.fitOrigin.x).toBeCloseTo((768 - layout.fitSize.width) / 2);
    expect(layout.fitOrigin.y).toBe(16);
    expect(layout.pageOrigin).toEqual(layout.fitOrigin);
    expect(layout.swipeTravel).toBeCloseTo(
      layout.pageSize.width +
        Math.max(
          NOTEBOOK_VIEWPORT_SWIPE_GAP,
          (layout.frameSize.width - layout.pageSize.width) / 2
        )
    );
  });

  it("opens iPad landscape at a true proportional full-page fit", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
    });

    expect(layout.inset).toBe(8);
    expect(layout.availableSize).toEqual({ width: 1008, height: 684 });
    expect(layout.fitSize.width).toBeCloseTo((684 * 900) / 1240);
    expect(layout.fitSize.height).toBe(684);
    expect(layout.zoom).toBe(1);
    expect(layout.pageSize).toEqual(layout.fitSize);
    expect(layout.pageOrigin).toEqual(layout.fitOrigin);
    expect(layout.pageOrigin.y).toBe(8);
    expect(layout.pageSize.width / layout.pageSize.height).toBeCloseTo(
      900 / 1240
    );
  });

  it("keeps user zoom relative to fit instead of rewriting it on rotation", () => {
    const portrait = getNotebookViewportLayout({
      frameWidth: 768,
      frameHeight: 956,
      zoom: 1.6,
    });
    const landscape = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
      zoom: 1.6,
    });

    expect(portrait.zoom).toBe(1.6);
    expect(landscape.zoom).toBe(1.6);
    expect(portrait.pageSize.width).toBeCloseTo(portrait.fitSize.width * 1.6);
    expect(landscape.pageSize.width).toBeCloseTo(
      landscape.fitSize.width * 1.6
    );
  });

  it("still allows the complete landscape page at fit and minimum zoom", () => {
    const fitted = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
      zoom: 1,
    });
    const minimum = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
      zoom: NOTEBOOK_VIEWPORT_MIN_ZOOM,
    });

    expect(fitted.pageSize).toEqual(fitted.fitSize);
    expect(fitted.fitOrigin.y).toBe(8);
    expect(minimum.pageSize.width).toBeLessThan(fitted.pageSize.width);
    expect(minimum.pageSize.height).toBeLessThan(fitted.pageSize.height);
  });

  it("uses 12px fit insets on compact phone frames", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 390,
      frameHeight: 776,
    });

    expect(layout.inset).toBe(12);
    expect(layout.availableSize).toEqual({ width: 366, height: 752 });
    expect(layout.fitSize).toEqual({
      width: 366,
      height: (366 * 1240) / 900,
    });
    expect(layout.fitOrigin.x).toBe(12);
    expect(layout.fitOrigin.y).toBeCloseTo(
      (776 - layout.fitSize.height) / 2
    );
  });

  it("centres the complete sheet with extra workspace at 92 percent", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 768,
      frameHeight: 956,
      zoom: 0,
      pan: { x: -500, y: 900 },
    });

    expect(layout.zoom).toBe(NOTEBOOK_VIEWPORT_MIN_ZOOM);
    expect(layout.pageSize.width).toBeCloseTo(layout.fitSize.width * 0.92);
    expect(layout.pageSize.height).toBeCloseTo(layout.fitSize.height * 0.92);
    expect(layout.pageOrigin.x).toBeCloseTo(
      (layout.frameSize.width - layout.pageSize.width) / 2
    );
    expect(layout.pageOrigin.y).toBeCloseTo(
      (layout.frameSize.height - layout.pageSize.height) / 2
    );
    expect(layout.pageOrigin.y).toBeCloseTo(
      layout.frameSize.height - layout.pageSize.height - layout.pageOrigin.y
    );
  });

  it("caps zoom at 400 percent and clamps oversized page pan", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 768,
      frameHeight: 956,
      zoom: 20,
      pan: { x: 200, y: -10_000 },
    });

    expect(layout.zoom).toBe(NOTEBOOK_VIEWPORT_MAX_ZOOM);
    expect(layout.pageSize.width).toBeCloseTo(layout.fitSize.width * 4);
    expect(layout.pageSize.height).toBeCloseTo(layout.fitSize.height * 4);
    expect(layout.panBounds).toEqual({
      minX: NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE - layout.pageSize.width,
      maxX: 768 - NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE,
      minY: NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE - layout.pageSize.height,
      maxY: 956 - NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE,
    });
    expect(layout.pageOrigin.x).toBe(200);
    expect(layout.pageOrigin.y).toBe(layout.panBounds.minY);
  });

  it("preserves the fixed page aspect ratio at every supported zoom", () => {
    for (const zoom of [0.92, 1, 4]) {
      const layout = getNotebookViewportLayout({
        frameWidth: 1024,
        frameHeight: 700,
        zoom,
      });

      expect(layout.pageSize.width / layout.pageSize.height).toBeCloseTo(
        900 / 1240,
        12
      );
    }
  });

  it("recentres an undersized axis at fit zoom", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
      pan: { x: -900, y: -200 },
    });

    expect(layout.pageSize.width).toBeLessThan(layout.frameSize.width);
    expect(layout.pageOrigin.x).toBeCloseTo(
      (layout.frameSize.width - layout.pageSize.width) / 2
    );
    expect(layout.pageOrigin.y).toBeCloseTo(
      (layout.frameSize.height - layout.pageSize.height) / 2
    );
  });

  it("leaves a zoomed sheet wherever the gesture put it", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
      zoom: 2,
      pan: { x: -120, y: -200 },
    });

    expect(layout.pageSize.width).toBeLessThan(layout.frameSize.width);
    expect(layout.pageSize.height).toBeGreaterThan(layout.frameSize.height);
    // Off centre on the narrow axis and away from the edges on the tall one:
    // neither is pulled back towards the middle of the frame.
    expect(layout.pageOrigin).toEqual({ x: -120, y: -200 });
  });

  it("keeps a graspable slice of a zoomed sheet on screen", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 1024,
      frameHeight: 700,
      zoom: 2,
      pan: { x: 5_000, y: -9_000 },
    });

    expect(layout.pageOrigin.x).toBeCloseTo(
      layout.frameSize.width - NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE
    );
    expect(layout.pageOrigin.y).toBeCloseTo(
      NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE - layout.pageSize.height
    );
  });

  it("hands over that freedom without a jump out of the fitted view", () => {
    const frame = { frameWidth: 1194, frameHeight: 790 };
    const pinned = getNotebookViewportLayout({ ...frame, zoom: 1 });
    const barelyZoomed = getNotebookViewportLayout({
      ...frame,
      zoom: 1.001,
      pan: { x: -5_000, y: 0 },
    });

    expect(pinned.panBounds.minX).toBe(pinned.panBounds.maxX);
    expect(
      Math.abs(barelyZoomed.pageOrigin.x - pinned.pageOrigin.x)
    ).toBeLessThan(10);
    // And fully free a short way further in.
    const free = getNotebookViewportLayout({ ...frame, zoom: 1.2 });
    expect(free.panBounds.minX).toBeCloseTo(
      NOTEBOOK_VIEWPORT_MIN_VISIBLE_PAGE - free.pageSize.width
    );
  });

  it("derives one page-and-gap travel distance for every carousel sheet", () => {
    const fitted = getNotebookViewportLayout({
      frameWidth: 1200,
      frameHeight: 900,
    });
    const zoomed = getNotebookViewportLayout({
      frameWidth: 1200,
      frameHeight: 900,
      zoom: 2.5,
      swipeGap: 24,
    });

    expect(fitted.swipeGap).toBe(NOTEBOOK_VIEWPORT_SWIPE_GAP);
    expect(fitted.swipeTravel).toBe(
      fitted.pageSize.width +
        Math.max(
          NOTEBOOK_VIEWPORT_SWIPE_GAP,
          (fitted.frameSize.width - fitted.pageSize.width) / 2
        )
    );
    expect(zoomed.swipeGap).toBe(24);
    expect(zoomed.swipeTravel).toBe(zoomed.pageSize.width + 24);
  });

  it("keeps a smaller but visible sheet gap on compact screens", () => {
    expect(getNotebookViewportSwipeGap(390)).toBe(
      NOTEBOOK_VIEWPORT_COMPACT_SWIPE_GAP
    );
    expect(getNotebookViewportSwipeGap(1024)).toBe(
      NOTEBOOK_VIEWPORT_SWIPE_GAP
    );
  });

  it("places adjacent fitted sheets immediately beyond a wide viewport", () => {
    const frameWidth = 1912;
    const pageWidth = 672;
    const pageX = (frameWidth - pageWidth) / 2;
    const swipeTravel = getNotebookViewportSwipeTravel({
      frameWidth,
      pageWidth,
      swipeGap: NOTEBOOK_VIEWPORT_SWIPE_GAP,
    });

    expect(pageX + swipeTravel).toBe(frameWidth);
    expect(pageX - swipeTravel + pageWidth).toBe(0);
  });

  it("provides deterministic centred bounds for an undersized page", () => {
    const bounds = getNotebookViewportPanBounds({
      pageWidth: 300,
      pageHeight: 400,
      frameWidth: 500,
      frameHeight: 600,
    });

    expect(bounds).toEqual({ minX: 100, maxX: 100, minY: 100, maxY: 100 });
    expect(
      clampNotebookViewportOrigin({
        origin: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
        bounds,
      })
    ).toEqual({ x: 100, y: 100 });
  });

  it("returns stable empty geometry before the frame is measured", () => {
    const layout = getNotebookViewportLayout({
      frameWidth: 0,
      frameHeight: Number.NaN,
    });

    expect(layout.frameSize).toEqual({ width: 0, height: 0 });
    expect(layout.fitSize).toEqual({ width: 0, height: 0 });
    expect(layout.fitScale).toBe(0);
    expect(layout.pageOrigin).toEqual({ x: 0, y: 0 });
    expect(layout.swipeTravel).toBe(NOTEBOOK_VIEWPORT_COMPACT_SWIPE_GAP);
  });
});

describe("notebook ink viewport", () => {
  it("maps notebook coordinates to the full visible page without centred margins", () => {
    expect(
      getNotebookInkViewportScale({
        displayWidth: 450,
        displayHeight: 713,
        pageWidth: 900,
        pageHeight: 1240,
      })
    ).toEqual({
      x: 0.5,
      y: 713 / 1240,
    });
  });

  it("supports the portrait page stretch without adding an origin offset", () => {
    const scale = getNotebookInkViewportScale({
      displayWidth: 900,
      displayHeight: 1426,
      pageWidth: 900,
      pageHeight: 1240,
    });

    expect(scale.x).toBe(1);
    expect(scale.y).toBeCloseTo(1.15, 2);
  });
});

describe("zooming about a point", () => {
  const fitted = getNotebookViewportLayout({ frameWidth: 800, frameHeight: 1000 });

  it("keeps whatever is under the point where it was", () => {
    const focus = { x: 300, y: 400 };
    const zoomed = zoomNotebookViewportAbout({ layout: fitted, zoom: 2, focus });
    expect(zoomed?.zoom).toBe(2);
    const next = getNotebookViewportLayout({ frameWidth: 800, frameHeight: 1000, zoom: 2, pan: zoomed?.pan });

    const before = (focus.x - fitted.pageOrigin.x) / fitted.pageSize.width;
    const after = (focus.x - next.pageOrigin.x) / next.pageSize.width;
    expect(after).toBeCloseTo(before, 5);
  });

  it("zooms about the middle of the frame when no point is given", () => {
    const zoomed = zoomNotebookViewportAbout({ layout: fitted, zoom: 1.5 });
    const next = getNotebookViewportLayout({ frameWidth: 800, frameHeight: 1000, zoom: 1.5, pan: zoomed?.pan });

    expect(next.pageOrigin.x + next.pageSize.width / 2).toBeCloseTo(400, 3);
  });

  it("returns to the fitted page, and does nothing when the zoom would not change", () => {
    const zoomedIn = getNotebookViewportLayout({ frameWidth: 800, frameHeight: 1000, zoom: 2 });

    expect(zoomNotebookViewportAbout({ layout: zoomedIn, zoom: 1 })).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
    expect(zoomNotebookViewportAbout({ layout: fitted, zoom: 1 })).toBeNull();
  });
});

describe("a zoomed sheet scrolled natively", () => {
  const zoomed = getNotebookViewportLayout({ frameWidth: 1180, frameHeight: 760, zoom: 2.5 });
  const fitted = getNotebookViewportLayout({ frameWidth: 1180, frameHeight: 760, zoom: 1 });

  it("has no scroll area at fit, where a sideways drag turns the page", () => {
    expect(getNotebookViewportScroll(fitted)).toBeNull();
  });

  it("scrolls over exactly the bounds a pan has", () => {
    const scroll = getNotebookViewportScroll(zoomed)!;
    const { panBounds, frameSize } = zoomed;
    // Scrolled right back to the start, the sheet is as far right and down as a pan takes it ...
    expect(getNotebookOriginForScroll({ scroll, left: 0, top: 0, bounds: panBounds })).toEqual({
      x: panBounds.maxX,
      y: panBounds.maxY,
    });
    // ... and scrolled all the way, as far left and up.
    expect(
      getNotebookOriginForScroll({
        scroll,
        left: scroll.width - frameSize.width,
        top: scroll.height - frameSize.height,
        bounds: panBounds,
      })
    ).toEqual({ x: panBounds.minX, y: panBounds.minY });
  });

  it("turns a pan into scroll offsets and back", () => {
    const scroll = getNotebookViewportScroll(zoomed)!;
    const origin = { x: -310, y: -420 };
    const offset = getNotebookScrollOffset(scroll, origin);
    expect(getNotebookOriginForScroll({ scroll, ...offset, bounds: zoomed.panBounds })).toEqual(origin);
  });

  it("holds the sheet inside its bounds while an iPad bounces past the end of a scroll", () => {
    const scroll = getNotebookViewportScroll(zoomed)!;
    expect(getNotebookOriginForScroll({ scroll, left: -60, top: -40, bounds: zoomed.panBounds })).toEqual({
      x: zoomed.panBounds.maxX,
      y: zoomed.panBounds.maxY,
    });
  });
});
