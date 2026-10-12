import { describe, expect, it } from "vitest";
import {
  engageNotebookPinch,
  getNotebookLivePinchTransform,
  getNotebookPagePanAfterPinch,
  NOTEBOOK_PINCH_PAN_SLOP,
  NOTEBOOK_PINCH_ZOOM_SLOP,
} from "@/lib/workspace/notebook-inking";
import { getNotebookViewportLayout } from "@/lib/workspace/notebook-viewport";

describe("notebook pinch zoom release continuity", () => {
  it("keeps an unconstrained page point at the exact release position", () => {
    const frameWidth = 500;
    const frameHeight = 600;
    const startPageWidth = 1_000;
    const startPageHeight = 1_200;
    const anchorFx = 0.5;
    const anchorFy = 0.5;
    const currentCenterX = 260;
    const currentCenterY = 280;

    const live = getNotebookLivePinchTransform({
      anchorFx,
      anchorFy,
      basePanX: -250,
      basePanY: -300,
      currentCenterX,
      currentCenterY,
      frameWidth,
      frameHeight,
      nextZoom: 1.2,
      startCenterX: 250,
      startCenterY: 300,
      startPageHeight,
      startPageWidth,
      startZoom: 1,
    });
    const committed = getNotebookPagePanAfterPinch({
      pinchCenterX: currentCenterX,
      pinchCenterY: currentCenterY,
      frameLeft: 0,
      frameTop: 0,
      anchorFx,
      anchorFy,
      pageWidth: startPageWidth * live.scaleRatio,
      pageHeight: startPageHeight * live.scaleRatio,
      frameWidth,
      frameHeight,
      zoom: 1.2,
    });

    expect(live).toEqual({ x: -340, y: -440, scaleRatio: 1.2 });
    expect({ x: live.x, y: live.y }).toEqual(committed);
  });

  it("centres an undersized page during the live pinch instead of on release", () => {
    const frameWidth = 500;
    const frameHeight = 600;
    const startPageWidth = 400;
    const startPageHeight = 500;
    const anchorFx = 0.25;
    const anchorFy = 0.3;
    const currentCenterX = 180;
    const currentCenterY = 220;

    const live = getNotebookLivePinchTransform({
      anchorFx,
      anchorFy,
      basePanX: 50,
      basePanY: 50,
      currentCenterX,
      currentCenterY,
      frameWidth,
      frameHeight,
      nextZoom: 0.92,
      startCenterX: 150,
      startCenterY: 200,
      startPageHeight,
      startPageWidth,
      startZoom: 1,
    });
    const committed = getNotebookPagePanAfterPinch({
      pinchCenterX: currentCenterX,
      pinchCenterY: currentCenterY,
      frameLeft: 0,
      frameTop: 0,
      anchorFx,
      anchorFy,
      pageWidth: startPageWidth * live.scaleRatio,
      pageHeight: startPageHeight * live.scaleRatio,
      frameWidth,
      frameHeight,
      zoom: 0.92,
    });

    expect(live).toEqual({ x: 66, y: 70, scaleRatio: 0.92 });
    expect({ x: live.x, y: live.y }).toEqual(committed);
  });

  it("applies the same free limits before the fingers are released", () => {
    const frameWidth = 500;
    const frameHeight = 600;
    const startPageWidth = 400;
    const startPageHeight = 500;
    const anchorFx = 0.1;
    const anchorFy = 0.1;
    const currentCenterX = 90;
    const currentCenterY = 100;

    const live = getNotebookLivePinchTransform({
      anchorFx,
      anchorFy,
      basePanX: 50,
      basePanY: 50,
      currentCenterX,
      currentCenterY,
      frameWidth,
      frameHeight,
      nextZoom: 2,
      startCenterX: 90,
      startCenterY: 100,
      startPageHeight,
      startPageWidth,
      startZoom: 1,
    });
    const committed = getNotebookPagePanAfterPinch({
      pinchCenterX: currentCenterX,
      pinchCenterY: currentCenterY,
      frameLeft: 0,
      frameTop: 0,
      anchorFx,
      anchorFy,
      pageWidth: startPageWidth * live.scaleRatio,
      pageHeight: startPageHeight * live.scaleRatio,
      frameWidth,
      frameHeight,
      zoom: 2,
    });

    // The anchor is honoured outright: the page point the fingers landed on is
    // still exactly under them, even though the sheet no longer covers the frame.
    expect(live).toEqual({ x: 10, y: 0, scaleRatio: 2 });
    expect({ x: live.x, y: live.y }).toEqual(committed);
  });
});

describe("notebook pinch zoom anchoring", () => {
  // A landscape iPad fits the sheet by height, so it stays narrower than the
  // frame until roughly 2x. That used to pin it to the middle of the frame for
  // most of a zoom: the page appeared to zoom into its own centre and only
  // swung towards the fingers once it grew wide enough to be pannable.
  const frameWidth = 1194;
  const frameHeight = 790;
  const fitted = getNotebookViewportLayout({ frameWidth, frameHeight });
  const startPageWidth = fitted.pageSize.width;
  const startPageHeight = fitted.pageSize.height;
  const basePanX = fitted.pageOrigin.x;
  const basePanY = fitted.pageOrigin.y;
  const anchorFx = 0.2;
  const anchorFy = 0.25;
  // Fingers land on the page and stay put, so any movement of the page point
  // beneath them is drift the zoom introduced.
  const centerX = basePanX + anchorFx * startPageWidth;
  const centerY = basePanY + anchorFy * startPageHeight;

  const anchorScreenPositionAt = (nextZoom: number) => {
    const live = getNotebookLivePinchTransform({
      anchorFx,
      anchorFy,
      basePanX,
      basePanY,
      currentCenterX: centerX,
      currentCenterY: centerY,
      frameWidth,
      frameHeight,
      nextZoom,
      startCenterX: centerX,
      startCenterY: centerY,
      startPageHeight,
      startPageWidth,
      startZoom: 1,
    });
    return {
      x: live.x + anchorFx * startPageWidth * live.scaleRatio,
      y: live.y + anchorFy * startPageHeight * live.scaleRatio,
    };
  };

  it("holds the pinched page point exactly under the fingers at every zoom", () => {
    for (const zoom of [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
      const anchor = anchorScreenPositionAt(zoom);
      expect(anchor.x).toBeCloseTo(centerX, 6);
      expect(anchor.y).toBeCloseTo(centerY, 6);
    }
  });

  it("holds it for anchors anywhere across the sheet", () => {
    for (const zoom of [1.5, 2.125, 3]) {
      for (const fx of [0, 0.2, 0.5, 0.8, 1]) {
        const finger = basePanX + fx * startPageWidth;
        const live = getNotebookLivePinchTransform({
          anchorFx: fx,
          anchorFy: 0.5,
          basePanX,
          basePanY,
          currentCenterX: finger,
          currentCenterY: centerY,
          frameWidth,
          frameHeight,
          nextZoom: zoom,
          startCenterX: finger,
          startCenterY: centerY,
          startPageHeight,
          startPageWidth,
          startZoom: 1,
        });
        expect(live.x + fx * startPageWidth * live.scaleRatio).toBeCloseTo(
          finger,
          6
        );
      }
    }
  });

  it("moves continuously out of the fitted view", () => {
    // Fit zoom is the one place the sheet is pinned rather than free, so it is
    // the one place a jump could appear.
    const before = anchorScreenPositionAt(1).x;
    const after = anchorScreenPositionAt(1.001).x;

    expect(Math.abs(after - before)).toBeLessThan(1);
  });
});

describe("two fingers moving the page only once they mean it", () => {
  const start = { startDistance: 200, startCenter: { x: 300, y: 300 } };

  it("moves nothing while they spread, close or drift less than the slop", () => {
    expect(engageNotebookPinch({ ...start, distance: 220, center: { x: 310, y: 305 } })).toBeNull();
    expect(engageNotebookPinch({ ...start, distance: 180, center: { x: 300, y: 290 } })).toBeNull();
  });

  it("zooms from the edge of the slop, keeping the fingers' middle where it is", () => {
    const spread = engageNotebookPinch({ ...start, distance: 250, center: { x: 305, y: 300 } });
    expect(spread).toEqual({ startDistance: 200 + NOTEBOOK_PINCH_ZOOM_SLOP, startCenter: { x: 305, y: 300 } });
    const closed = engageNotebookPinch({ ...start, distance: 150, center: { x: 300, y: 300 } });
    expect(closed?.startDistance).toBe(200 - NOTEBOOK_PINCH_ZOOM_SLOP);
  });

  it("pans from the edge of the slop, along the way the fingers went", () => {
    const carried = engageNotebookPinch({ ...start, distance: 200, center: { x: 300, y: 340 } });
    expect(carried).toEqual({ startDistance: 200, startCenter: { x: 300, y: 300 + NOTEBOOK_PINCH_PAN_SLOP } });
  });
});
