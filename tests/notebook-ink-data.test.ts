import { describe, expect, it } from "vitest";
import { decodeInkDocument } from "@/lib/ink/codec";
import { inkToSvg } from "@/lib/ink/export-svg";
import {
  getNotebookInkColor,
  jamiInkData,
  legacyStrokesToJsDrawSvg,
  notebookInkDocument,
  notebookInkSvg,
  svgNotebookInkData,
} from "@/lib/workspace/notebook-ink-data";
import {
  mapNotebookPageData,
  normalizeNotebookInkData,
  normalizeNotebookPreviewSvg,
  notebookInkStoredLength,
  type NotebookInkData,
} from "@/lib/workspace/notebooks";
import { docOf, outline } from "./support/ink-fixtures";

const PAGE = docOf(
  outline("first", [{ op: "M", x: 10, y: 10 }, { op: "L", x: 60, y: 30 }]),
  outline("second", [{ op: "M", x: 100, y: 200 }, { op: "L", x: 140, y: 260 }], "highlighter")
);

/** What Jami Ink saves for `PAGE`, and the encoding inside it. */
const saved = jamiInkData(PAGE);
const encoding = saved.format === "js-draw-svg" ? saved.jamiInk! : "";
const encodedAlone: NotebookInkData = { version: 3, format: "jami-ink", data: encoding };

describe("notebook ink in either stored form", () => {
  it("saves Jami Ink's page as the SVG every older build reads, with its own encoding beside it", () => {
    expect(saved).toEqual({
      version: 2,
      format: "js-draw-svg",
      svg: inkToSvg(PAGE),
      jamiInk: expect.stringMatching(/^j3:/),
    });
    // The shape a build from before Jami Ink accepted, untouched.
    expect(normalizeNotebookInkData(saved)).toEqual(saved);
    expect(decodeInkDocument(encoding)).toEqual(PAGE);
    expect(notebookInkStoredLength(saved)).toBe(inkToSvg(PAGE).length + encoding.length);
  });

  it("reads the encoding alone, and refuses anything that is not one", () => {
    expect(normalizeNotebookInkData(encodedAlone)).toEqual(encodedAlone);
    expect(normalizeNotebookInkData({ version: 3, format: "jami-ink", data: "<svg></svg>" })).toBeUndefined();
    // An encoding beside an SVG that is not one is set aside, and the SVG kept.
    expect(normalizeNotebookInkData({ ...saved, jamiInk: "not ink" })).toEqual(
      svgNotebookInkData(inkToSvg(PAGE))
    );
  });

  it("draws either form as SVG", () => {
    expect(notebookInkSvg(saved)).toBe(inkToSvg(PAGE));
    expect(notebookInkSvg(encodedAlone)).toBe(inkToSvg(PAGE));
    expect(notebookInkSvg(encodedAlone, { width: 900, height: 2000 })).toBe(
      inkToSvg(PAGE, { width: 900, height: 2000 })
    );
    expect(notebookInkSvg(undefined)).toBeUndefined();
  });

  it("opens Jami Ink's own encoding, with its items as they were", () => {
    expect(notebookInkDocument(saved)).toEqual(PAGE);
    expect(notebookInkDocument(encodedAlone)).toEqual(PAGE);
    // An SVG alone is read as js-draw drew it.
    const imported = notebookInkDocument(svgNotebookInkData(inkToSvg(PAGE)));
    expect(imported?.items).toHaveLength(2);
    expect(notebookInkDocument(null)).toEqual({ version: 3, items: [] });
  });

  it("will not open an encoding it cannot read as an empty page, but falls back to an SVG beside it", () => {
    expect(notebookInkDocument({ version: 3, format: "jami-ink", data: "j3:AAAA" })).toBeNull();
    const fallback = notebookInkDocument({ ...saved, jamiInk: "j3:AAAA" } as NotebookInkData);
    expect(fallback?.items).toHaveLength(2);
  });
});

describe("notebook js-draw ink data", () => {
  it("keeps bounded SVG previews and rejects invalid or oversized values", () => {
    expect(normalizeNotebookPreviewSvg("<svg></svg>")).toBe("<svg></svg>");
    expect(normalizeNotebookPreviewSvg("not svg")).toBeUndefined();
    expect(
      normalizeNotebookPreviewSvg(`<svg>${"x".repeat(120_000)}</svg>`)
    ).toBeUndefined();
  });
  it("converts legacy pen and highlighter strokes to importable SVG", () => {
    const svg = legacyStrokesToJsDrawSvg(
      [
        {
          color: "red",
          points: [
            { x: 10, y: 20 },
            { x: 40, y: 50 },
          ],
          tool: "pen",
          width: 5,
        },
        {
          color: "yellow",
          points: [
            { x: 80, y: 90 },
            { x: 120, y: 110 },
          ],
          tool: "highlighter",
          width: 24,
        },
      ],
      900,
      1240
    );

    expect(svg).toContain('viewBox="0 0 900 1240"');
    expect(svg).toContain('stroke="#ef4444"');
    expect(svg).toContain('stroke="#fde047"');
    expect(svg).toContain('opacity="0.42"');
  });

  it("normalizes a versioned js-draw SVG payload on reload", () => {
    const inkData = svgNotebookInkData(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1240"><path d="M0 0L10 10"/></svg>'
    );
    const page = mapNotebookPageData("page-1", {
      notebookId: "notebook-1",
      folderId: "folder-1",
      pageNumber: 1,
      pageType: "blank",
      inkData,
    });

    expect(page.inkData).toEqual(inkData);
    expect(page.strokeData).toBeUndefined();
  });

  it("maps every Jami toolbar colour without falling back to purple", () => {
    expect(getNotebookInkColor("black", "pen")).toEqual({
      color: "#111827",
      opacity: 1,
    });
    expect(getNotebookInkColor("white", "pen").color).toBe("#f8fafc");
    expect(getNotebookInkColor("red", "pen").color).toBe("#ef4444");
    expect(getNotebookInkColor("green", "pen").color).toBe("#22c55e");
    expect(getNotebookInkColor("#123abc", "pen").color).toBe("#123abc");
    expect(getNotebookInkColor("yellow", "highlighter")).toEqual({
      color: "#fde047",
      opacity: 0.42,
    });
  });
});
