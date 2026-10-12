import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inkToSvg } from "@/lib/ink/export-svg";
import { importJsDrawSvg } from "@/lib/ink/import-js-draw-svg";
import { inkItemBounds, inkItemLayer, type InkDocument, type InkItem } from "@/lib/ink/model";
import { inkPathBounds } from "@/lib/ink/path";
import { inkShapePath } from "@/lib/ink/shapes";
import { goldenInkDocument } from "./support/ink-golden";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ink", "js-draw");
const manifest = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")) as Record<
  string,
  { file: string }
>;

const ROOT =
  '<svg viewBox="0 0 900 1240" width="900" height="1240" version="1.1" baseProfile="full" xmlns="http://www.w3.org/2000/svg">';

function mixedDocument(): InkDocument {
  return {
    version: 3,
    items: [
      {
        kind: "outline",
        id: "pen-a",
        layer: "pen",
        path: [
          { op: "M", x: 10, y: 10 },
          { op: "C", x1: 20, y1: 0, x2: 30, y2: 20, x: 40, y: 10 },
        ],
        paint: {
          fill: null,
          stroke: { color: { r: 17, g: 24, b: 39, a: 1 }, width: 4.75, cap: "round", join: "round" },
          opacity: 1,
        },
      },
      {
        kind: "outline",
        id: "hi-a",
        layer: "highlighter",
        path: [
          { op: "M", x: 0, y: 50 },
          { op: "L", x: 90, y: 50 },
          { op: "L", x: 90, y: 70 },
          { op: "Z" },
        ],
        paint: { fill: { r: 253, g: 224, b: 71, a: 107 / 255 }, stroke: null, opacity: 1 },
      },
      {
        kind: "shape",
        id: "line-a",
        layer: "pen",
        color: { r: 255, g: 0, b: 0, a: 1 },
        width: 3.5,
        shape: { type: "line", from: { x: 100, y: 100 }, to: { x: 300, y: 150 } },
      },
      {
        kind: "outline",
        id: "hi-b",
        layer: "highlighter",
        path: [
          { op: "M", x: 5, y: 5 },
          { op: "L", x: 25, y: 5 },
        ],
        paint: {
          fill: null,
          stroke: { color: { r: 253, g: 224, b: 71, a: 1 }, width: 12, cap: "square", join: "bevel" },
          opacity: 0.42,
        },
      },
      { kind: "unknown", id: "future", layerCode: 1, code: 9, payload: new Uint8Array([1, 2, 3]) },
    ],
  };
}

function drawable(items: InkItem[]): InkItem[] {
  return items.filter((item) => item.kind !== "unknown");
}

/** Highlighter first, then pen: the order the export writes. */
function layerOrder(items: InkItem[]): InkItem[] {
  return [
    ...drawable(items).filter((item) => inkItemLayer(item) === "highlighter"),
    ...drawable(items).filter((item) => inkItemLayer(item) === "pen"),
  ];
}

describe("inkToSvg", () => {
  it("writes the exact js-draw root and no stylesheet", () => {
    const svg = inkToSvg(mixedDocument());
    expect(svg.startsWith(ROOT)).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toContain("<style");
  });

  it("writes an empty page as just the root", () => {
    expect(inkToSvg({ version: 3, items: [] })).toBe(`${ROOT}</svg>`);
  });

  it("sizes the root to a custom page", () => {
    const empty = { version: 3 as const, items: [] };
    expect(inkToSvg(empty, { width: 900, height: 600 })).toBe(
      '<svg viewBox="0 0 900 600" width="900" height="600" version="1.1" baseProfile="full" xmlns="http://www.w3.org/2000/svg"></svg>'
    );
    const doc = mixedDocument();
    expect(inkToSvg(doc, { width: 900, height: 1240 })).toBe(inkToSvg(doc));
  });

  it("puts highlighter items before pen items, each in document order", () => {
    const imported = importJsDrawSvg(inkToSvg(mixedDocument()));
    expect(imported?.document.items.map(inkItemLayer)).toEqual([
      "highlighter",
      "highlighter",
      "pen",
      "pen",
    ]);
    const svg = inkToSvg(mixedDocument());
    expect(svg.indexOf("#fde0476b")).toBeLessThan(svg.indexOf('stroke="#111827"'));
    expect(svg.indexOf('stroke="#111827"')).toBeLessThan(svg.indexOf('stroke="#ff0000"'));
  });

  it("skips unknown items", () => {
    expect(inkToSvg({ version: 3, items: [mixedDocument().items[4]] })).toBe(`${ROOT}</svg>`);
  });

  it("writes explicit paint on every path", () => {
    const svg = inkToSvg(mixedDocument());
    expect(svg).toContain(
      'fill="none" stroke="#111827" stroke-width="4.75" stroke-linecap="round" stroke-linejoin="round"'
    );
    expect(svg).toContain('fill="#fde0476b"></path>');
    expect(svg).toContain('stroke-width="12" stroke-linecap="square" stroke-linejoin="bevel" opacity="0.42"');
    expect(svg).toContain(
      'fill="none" stroke="#ff0000" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"'
    );
  });

  it("reads back to the same geometry and paint within quantisation", () => {
    const doc = mixedDocument();
    const back = importJsDrawSvg(inkToSvg(doc));
    expect(back?.unsupported).toEqual([]);
    const original = layerOrder(doc.items);
    const items = back?.document.items ?? [];
    expect(items).toHaveLength(original.length);
    original.forEach((before, index) => {
      const after = items[index];
      if (after.kind !== "outline") throw new Error("expected an outline");
      const beforePath =
        before.kind === "shape"
          ? inkShapePath(before.shape, before.width)
          : before.kind === "outline"
            ? before.path
            : [];
      expect(after.path).toHaveLength(beforePath.length);
      const a = inkPathBounds(beforePath);
      const b = inkPathBounds(after.path);
      expect(b?.minX).toBeCloseTo(a?.minX ?? NaN, 3);
      expect(b?.maxY).toBeCloseTo(a?.maxY ?? NaN, 3);
      expect(after.layer).toBe(inkItemLayer(before));
      if (before.kind === "shape") {
        expect(after.paint.fill).toBeNull();
        expect(after.paint.stroke?.width).toBeCloseTo(before.width, 4);
        expect(after.paint.stroke?.color).toEqual(before.color);
        expect(after.paint.stroke).toMatchObject({ cap: "round", join: "round" });
      } else if (before.kind === "outline") {
        expect(after.paint.fill === null).toBe(before.paint.fill === null);
        if (before.paint.fill && after.paint.fill) {
          expect(after.paint.fill.a).toBeCloseTo(before.paint.fill.a, 2);
          expect(after.paint.fill).toMatchObject({
            r: before.paint.fill.r,
            g: before.paint.fill.g,
            b: before.paint.fill.b,
          });
        }
        // The importer reads js-draw's way: strokes always have round caps and joins.
        expect(after.paint.stroke?.color).toEqual(before.paint.stroke?.color);
        expect(after.paint.stroke?.width).toEqual(before.paint.stroke?.width);
        if (after.paint.stroke) expect(after.paint.stroke).toMatchObject({ cap: "round", join: "round" });
        expect(after.paint.opacity).toBeCloseTo(before.paint.opacity, 4);
      }
    });
  });

  it("exports the golden document and reads every drawable item back", () => {
    const doc = goldenInkDocument();
    const back = importJsDrawSvg(inkToSvg(doc));
    expect(back?.document.items).toHaveLength(drawable(doc.items).length);
  });
});

describe("js-draw fixtures through import, export and import", () => {
  for (const [name, entry] of Object.entries(manifest)) {
    it(`${name} keeps its item count, layers and bounds`, () => {
      const first = importJsDrawSvg(readFileSync(path.join(FIXTURE_DIR, entry.file), "utf8"));
      if (!first) throw new Error("fixture did not import");
      const second = importJsDrawSvg(inkToSvg(first.document));
      if (!second) throw new Error("export did not import");
      expect(second.unsupported).toEqual([]);

      const expected = layerOrder(first.document.items);
      expect(second.document.items).toHaveLength(expected.length);
      expect(second.document.items.map(inkItemLayer)).toEqual(expected.map(inkItemLayer));
      expected.forEach((item, index) => {
        const before = inkItemBounds(item);
        const after = inkItemBounds(second.document.items[index]);
        expect(Math.abs(after.minX - before.minX)).toBeLessThan(0.01);
        expect(Math.abs(after.minY - before.minY)).toBeLessThan(0.01);
        expect(Math.abs(after.maxX - before.maxX)).toBeLessThan(0.01);
        expect(Math.abs(after.maxY - before.maxY)).toBeLessThan(0.01);
      });
    });
  }
});

describe("writing a page again", () => {
  it("writes each item as it is now, not as an earlier item it replaced", () => {
    const item = (r: number) => ({
      kind: "outline" as const,
      id: "a",
      layer: "pen" as const,
      path: [
        { op: "M" as const, x: 1, y: 2 },
        { op: "L" as const, x: 30, y: 40 },
      ],
      paint: { fill: { r, g: 0, b: 0, a: 1 }, stroke: null, opacity: 1 },
    });
    expect(inkToSvg({ version: 3, items: [item(10)] })).not.toBe(inkToSvg({ version: 3, items: [item(200)] }));
  });
});
