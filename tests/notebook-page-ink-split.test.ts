import { describe, expect, it } from "vitest";

import {
  MAX_THUMBNAIL_INK_SVG_LENGTH,
  MAX_THUMBNAIL_STROKES,
  MAX_THUMBNAIL_STROKE_POINTS,
  buildNotebookPageThumbnail,
  isNotebookInkRecordWithinLimits,
  mergeNotebookPageInk,
  needsInkSplitConversion,
  pageHasSavedInk,
  pageHasUnloadedInk,
  resolveNotebookPageThumbnail,
  splitNotebookPageForPersistence,
} from "@/lib/workspace/notebook-page-ink-split";
import type { NotebookInkData, NotebookPage, NotebookStroke } from "@/lib/workspace/notebooks";
import { MAX_NOTEBOOK_INK_SVG_LENGTH, storedNotebookInkSvg } from "@/lib/workspace/notebooks";

function stroke(pointCount: number): NotebookStroke {
  return {
    tool: "pen",
    color: "black",
    width: 3,
    points: Array.from({ length: pointCount }, (_unused, index) => ({
      x: index,
      y: index * 2,
    })),
  } as NotebookStroke;
}

function svgOfLength(length: number) {
  const open = "<svg>";
  const close = "</svg>";
  return open + "a".repeat(Math.max(0, length - open.length - close.length)) + close;
}

function page(overrides: Partial<NotebookPage> = {}): NotebookPage {
  return {
    id: "page-1",
    notebookId: "notebook-1",
    folderId: "folder-1",
    pageNumber: 1,
    pageType: "blank",
    textBlocks: [],
    imageRefs: [],
    pageColor: "white",
    pageStyle: "plain",
    status: "blank",
    contentRevision: 3,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as NotebookPage;
}

describe("notebook page ink split", () => {
  it("keeps a normal page's svg in the thumbnail digest", () => {
    const svg = svgOfLength(2_000);
    const thumbnail = buildNotebookPageThumbnail({
      inkData: { version: 2, format: "js-draw-svg", svg },
    });

    expect(thumbnail.inkSvg).toBe(svg);
    expect(thumbnail.inkOmitted).toBe(false);
  });

  it("drops an oversized svg from the digest so page records stay small", () => {
    const thumbnail = buildNotebookPageThumbnail({
      inkData: {
        version: 2,
        format: "js-draw-svg",
        svg: svgOfLength(MAX_THUMBNAIL_INK_SVG_LENGTH + 1),
      },
    });

    expect(thumbnail.inkSvg).toBeUndefined();
    expect(thumbnail.inkOmitted).toBe(true);
  });

  it("does not report ink as omitted when legacy strokes can still be drawn", () => {
    const thumbnail = buildNotebookPageThumbnail({
      inkData: {
        version: 2,
        format: "js-draw-svg",
        svg: svgOfLength(MAX_THUMBNAIL_INK_SVG_LENGTH + 1),
      },
      strokeData: { version: 1, strokes: [stroke(4)] },
    });

    expect(thumbnail.inkSvg).toBeUndefined();
    expect(thumbnail.inkOmitted).toBe(false);
    expect(thumbnail.strokes).toHaveLength(1);
  });

  it("caps thumbnail strokes and their points", () => {
    const thumbnail = buildNotebookPageThumbnail({
      strokeData: {
        version: 1,
        strokes: Array.from({ length: MAX_THUMBNAIL_STROKES + 5 }, () =>
          stroke(400)
        ),
      },
    });

    expect(thumbnail.strokes).toHaveLength(MAX_THUMBNAIL_STROKES);
    for (const kept of thumbnail.strokes) {
      expect(kept.points.length).toBeLessThanOrEqual(MAX_THUMBNAIL_STROKE_POINTS);
    }
  });

  it("keeps the first and last point when downsampling a stroke", () => {
    const original = stroke(400);
    const [sampled] = buildNotebookPageThumbnail({
      strokeData: { version: 1, strokes: [original] },
    }).strokes;

    expect(sampled.points[0]).toEqual(original.points[0]);
    expect(sampled.points[sampled.points.length - 1]).toEqual(
      original.points[original.points.length - 1]
    );
  });

  it("separates full-fidelity ink from the page record", () => {
    const svg = svgOfLength(MAX_THUMBNAIL_INK_SVG_LENGTH + 500);
    const { thumbnail, ink } = splitNotebookPageForPersistence({
      pageId: "page-1",
      notebookId: "notebook-1",
      inkData: { version: 2, format: "js-draw-svg", svg },
      contentRevision: 7,
      updatedAt: 1234,
    });

    expect(thumbnail.inkSvg).toBeUndefined();
    expect(storedNotebookInkSvg(ink?.inkData)).toBe(svg);
    expect(ink?.contentRevision).toBe(7);
    expect(ink?.pageId).toBe("page-1");
  });

  it("writes no ink record for a page with no ink at all", () => {
    const { ink } = splitNotebookPageForPersistence({
      pageId: "page-1",
      notebookId: "notebook-1",
      contentRevision: 1,
      updatedAt: 1,
    });

    expect(ink).toBeNull();
  });

  it("merges a fetched ink record into a light page", () => {
    const merged = mergeNotebookPageInk(page(), {
      pageId: "page-1",
      notebookId: "notebook-1",
      inkData: { version: 2, format: "js-draw-svg", svg: "<svg>x</svg>" },
      contentRevision: 3,
      updatedAt: 2,
    });

    expect(storedNotebookInkSvg(merged.inkData)).toBe("<svg>x</svg>");
  });

  it("treats a legacy page's inline ink as authoritative", () => {
    const legacy = page({
      inkData: { version: 2, format: "js-draw-svg", svg: "<svg>inline</svg>" },
    });

    const merged = mergeNotebookPageInk(legacy, {
      pageId: "page-1",
      notebookId: "notebook-1",
      inkData: { version: 2, format: "js-draw-svg", svg: "<svg>stale</svg>" },
      contentRevision: 1,
      updatedAt: 1,
    });

    expect(storedNotebookInkSvg(merged.inkData)).toBe("<svg>inline</svg>");
  });

  it("leaves a page untouched when no ink record exists", () => {
    const light = page();
    expect(mergeNotebookPageInk(light, null)).toBe(light);
  });

  it("flags only legacy pages heavy enough to be worth converting", () => {
    expect(
      needsInkSplitConversion(
        page({
          inkData: {
            version: 2,
            format: "js-draw-svg",
            svg: svgOfLength(MAX_THUMBNAIL_INK_SVG_LENGTH + 1),
          },
        })
      )
    ).toBe(true);

    expect(
      needsInkSplitConversion(
        page({
          inkData: { version: 2, format: "js-draw-svg", svg: svgOfLength(500) },
        })
      )
    ).toBe(false);
  });

  it("knows a split page still owes its ink", () => {
    expect(
      pageHasUnloadedInk(
        page({ thumbnail: { inkSvg: "<svg>x</svg>", strokes: [], inkOmitted: false } })
      )
    ).toBe(true);
    expect(
      pageHasUnloadedInk(page({ thumbnail: { strokes: [], inkOmitted: true } }))
    ).toBe(true);
  });

  it("treats a page with no ink and a page already holding ink as ready", () => {
    expect(pageHasUnloadedInk(page())).toBe(false);
    expect(
      pageHasUnloadedInk(page({ thumbnail: { strokes: [], inkOmitted: false } }))
    ).toBe(false);
    expect(
      pageHasUnloadedInk(
        page({
          inkData: { version: 2, format: "js-draw-svg", svg: "<svg>x</svg>" },
          thumbnail: { inkSvg: "<svg>x</svg>", strokes: [], inkOmitted: false },
        })
      )
    ).toBe(false);
  });

  it("renders a loaded page's real ink rather than the stored digest", () => {
    const big = svgOfLength(MAX_THUMBNAIL_INK_SVG_LENGTH + 5_000);
    const resolved = resolveNotebookPageThumbnail(
      page({
        inkData: { version: 2, format: "js-draw-svg", svg: big },
        thumbnail: { strokes: [], inkOmitted: true },
      })
    );

    expect(resolved.inkSvg).toBe(big);
    expect(resolved.inkOmitted).toBe(false);
  });

  it("falls back to the stored digest for a page whose ink is not loaded", () => {
    const resolved = resolveNotebookPageThumbnail(
      page({ thumbnail: { inkSvg: "<svg>thumb</svg>", strokes: [], inkOmitted: false } })
    );

    expect(resolved.inkSvg).toBe("<svg>thumb</svg>");
  });

  it("holds ink records to the same limit as an inline page snapshot", () => {
    expect(
      isNotebookInkRecordWithinLimits({
        pageId: "page-1",
        notebookId: "notebook-1",
        inkData: {
          version: 2,
          format: "js-draw-svg",
          svg: svgOfLength(MAX_NOTEBOOK_INK_SVG_LENGTH + 1),
        },
        contentRevision: 1,
        updatedAt: 1,
      })
    ).toBe(false);
  });

  describe("Jami Ink's encoding", () => {
    const record = (inkData: NotebookInkData) => ({
      pageId: "page-1",
      notebookId: "notebook-1",
      inkData,
      contentRevision: 1,
      updatedAt: 1,
    });
    const half = Math.floor(MAX_NOTEBOOK_INK_SVG_LENGTH / 2);

    it("counts against the limit beside the SVG it rides with", () => {
      const both = (encoded: number): NotebookInkData => ({
        version: 2,
        format: "js-draw-svg",
        svg: svgOfLength(half),
        jamiInk: `j3:${"A".repeat(encoded)}`,
      });
      expect(isNotebookInkRecordWithinLimits(record(both(1_000)))).toBe(true);
      expect(isNotebookInkRecordWithinLimits(record(both(half)))).toBe(false);
    });

    it("alone, is ink the digest cannot show, so a build that cannot read it will not open the page empty", () => {
      const alone: NotebookInkData = { version: 3, format: "jami-ink", data: "j3:AAAA" };
      const thumbnail = buildNotebookPageThumbnail({ inkData: alone });
      expect(thumbnail).toEqual({ strokes: [], inkOmitted: true });
      // How a build from before Jami Ink, which drops the record it cannot read, sees the page.
      expect(pageHasUnloadedInk(page({ thumbnail }))).toBe(true);
      expect(resolveNotebookPageThumbnail(page({ inkData: alone }))).toEqual({
        strokes: [],
        inkOmitted: true,
      });
    });
  });

  it("knows a page has saved ink in any form", () => {
    expect(pageHasSavedInk(page())).toBe(false);
    expect(pageHasSavedInk(page({ inkData: { version: 3, format: "jami-ink", data: "j3:AAAA" } }))).toBe(true);
    expect(pageHasSavedInk(page({ inkData: { version: 2, format: "js-draw-svg", svg: "<svg></svg>" } }))).toBe(true);
    expect(
      pageHasSavedInk(page({ strokeData: { version: 1, strokes: [stroke(2)] } }))
    ).toBe(true);
  });
});
