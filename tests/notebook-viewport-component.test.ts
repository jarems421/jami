import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotebookViewport from "@/components/workspace/NotebookViewport";

describe("NotebookViewport", () => {
  it("renders every carousel slot through the same sheet treatment", () => {
    const html = renderToStaticMarkup(
      createElement(NotebookViewport, {
        activeClassName: "bg-white",
        activeContent: createElement("span", null, "Active"),
        activeRef: createRef<HTMLDivElement>(),
        frameRef: createRef<HTMLDivElement>(),
        geometry: {
          pageWidth: 450,
          pageHeight: 620,
          pageX: 100,
          pageY: 16,
          swipeTravel: 466,
        },
        nextPreview: {
          key: "next",
          className: "bg-white",
          content: createElement("span", null, "Next"),
        },
        onActivePointerCancel: () => undefined,
        onActivePointerMove: () => undefined,
        onActivePointerUp: () => undefined,
        onTrackTransitionCancel: () => undefined,
        onTrackTransitionEnd: () => undefined,
        previewLayerRef: createRef<HTMLDivElement>(),
        previousPreview: {
          key: "previous",
          className: "bg-white",
          content: createElement("span", null, "Previous"),
        },
        trackRef: createRef<HTMLDivElement>(),
      })
    );

    expect(html.match(/data-notebook-sheet="true"/g)).toHaveLength(3);
    expect(html).toContain('data-notebook-slot="previous"');
    expect(html).toContain('data-notebook-slot="active"');
    expect(html).toContain('data-notebook-slot="next"');
    expect(html).toContain("translate3d(-366px, 16px, 0)");
    expect(html).toContain("translate3d(100px, 16px, 0)");
    expect(html).toContain("translate3d(566px, 16px, 0)");
    // Every sheet is edged, but the shell never names the colour: that comes
    // with the page, so a black page can be outlined in something visible
    // against a dark workspace.
    expect(html.match(/after:border /g)).toHaveLength(3);
    expect(html).not.toContain("after:border-black");
    expect(html).not.toContain("box-border");
  });

  it("keeps live ink beneath the track controlled by the swipe-state hook", () => {
    const html = renderToStaticMarkup(
      createElement(NotebookViewport, {
        activeClassName: "bg-white",
        activeContent: createElement("div", {
          className: "notebook-ink-surface",
        }),
        activeRef: createRef<HTMLDivElement>(),
        frameRef: createRef<HTMLDivElement>(),
        geometry: {
          pageWidth: 450,
          pageHeight: 620,
          pageX: 100,
          pageY: 16,
          swipeTravel: 466,
        },
        onActivePointerCancel: () => undefined,
        onActivePointerMove: () => undefined,
        onActivePointerUp: () => undefined,
        onTrackTransitionCancel: () => undefined,
        onTrackTransitionEnd: () => undefined,
        previewLayerRef: createRef<HTMLDivElement>(),
        trackRef: createRef<HTMLDivElement>(),
      })
    );

    const trackIndex = html.indexOf("notebook-page-track");
    const inkIndex = html.indexOf("notebook-ink-surface");
    expect(trackIndex).toBeGreaterThanOrEqual(0);
    expect(inkIndex).toBeGreaterThan(trackIndex);
    // useNotebookPageTrack has dedicated behavior tests for the active,
    // direction, and snapshot-ready data attributes written to this node.
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the measurable frame mounted before a page is ready", () => {
    const html = renderToStaticMarkup(
      createElement(NotebookViewport, {
        activeClassName: "bg-white",
        activeContent: null,
        activeRef: createRef<HTMLDivElement>(),
        frameRef: createRef<HTMLDivElement>(),
        geometry: {
          pageWidth: 0,
          pageHeight: 0,
          pageX: 0,
          pageY: 0,
          swipeTravel: 16,
        },
        onActivePointerCancel: () => undefined,
        onActivePointerMove: () => undefined,
        onActivePointerUp: () => undefined,
        onTrackTransitionCancel: () => undefined,
        onTrackTransitionEnd: () => undefined,
        previewLayerRef: createRef<HTMLDivElement>(),
        trackRef: createRef<HTMLDivElement>(),
      })
    );

    expect(html).toContain("data-notebook-page-frame");
    expect(html).not.toContain("data-notebook-sheet");
  });

  it("scrolls a zoomed sheet natively inside the frame, the overlay staying put", () => {
    const base = {
      activeClassName: "bg-white",
      activeContent: createElement("span", null, "Active"),
      activeRef: createRef<HTMLDivElement>(),
      frameRef: createRef<HTMLDivElement>(),
      geometry: { pageWidth: 1800, pageHeight: 2480, pageX: 680, pageY: 880, swipeTravel: 466 },
      onActivePointerCancel: () => undefined,
      onActivePointerMove: () => undefined,
      onActivePointerUp: () => undefined,
      onTrackTransitionCancel: () => undefined,
      onTrackTransitionEnd: () => undefined,
      overlay: createElement("div", { "data-overlay": "true" }),
      previewLayerRef: createRef<HTMLDivElement>(),
      trackRef: createRef<HTMLDivElement>(),
    };
    const scrolled = renderToStaticMarkup(
      createElement(NotebookViewport, { ...base, scroll: { width: 2480, height: 3240, sheetX: 680, sheetY: 880 } })
    );
    expect(scrolled).toContain('data-notebook-native-scroll="true"');
    expect(scrolled).toMatch(/data-notebook-scroller="true" class="[^"]*overflow-auto/);
    expect(scrolled).toContain("width:2480px;height:3240px");
    expect(scrolled).toContain("translate3d(680px, 880px, 0)");
    // The overlay is the frame's, outside what scrolls.
    expect(scrolled.indexOf("data-overlay")).toBeLessThan(scrolled.indexOf("data-notebook-scroller"));

    const fitted = renderToStaticMarkup(createElement(NotebookViewport, { ...base, scroll: null }));
    expect(fitted).not.toContain("data-notebook-native-scroll");
    expect(fitted).toMatch(/data-notebook-scroller="true" class="[^"]*overflow-hidden/);
  });
});
