import { describe, expect, it } from "vitest";
import { decodeInkDocument, encodeInkDocument, quantizeInkDocument } from "@/lib/ink/codec";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/ink/bytes";
import {
  emptyInkDocument,
  inkItemLayer,
  type InkDocument,
  type InkPathCommand,
  type InkUnknownItem,
} from "@/lib/ink/model";
import { formatSvgPathData } from "@/lib/ink/path";
import { docOf, lineShape, outline, randomInkDocument, seededRandom } from "./support/ink-fixtures";

function sampleDocument(): InkDocument {
  return {
    version: 3,
    items: [
      outline("a", [
        { op: "M", x: 10.3, y: 20.7 },
        { op: "C", x1: 12, y1: 22, x2: 14.1, y2: 25, x: 16, y: 30 },
        { op: "Q", x1: 20, y1: 31, x: 22, y: 29 },
        { op: "L", x: -5, y: 700.25 },
        { op: "Z" },
      ]),
      lineShape("b", 1, 2, 300, 400),
      {
        kind: "shape",
        id: "poly",
        layer: "pen",
        color: { r: 10, g: 20, b: 30, a: 0.5 },
        width: 3.3,
        shape: {
          type: "polygon",
          corners: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 50, y: 80 },
          ],
        },
      },
      {
        kind: "shape",
        id: "ell",
        layer: "pen",
        color: { r: 255, g: 0, b: 0, a: 1 },
        width: 2,
        shape: { type: "ellipse", cx: 450, cy: 600, rx: 120.5, ry: 60, rotation: -0.7 },
      },
    ],
  };
}

const wrap = (bytes: number[]) => "j3:" + bytesToBase64Url(Uint8Array.from(bytes));

describe("ink codec", () => {
  it("round-trips an empty document", () => {
    const text = encodeInkDocument(emptyInkDocument());
    expect(text.startsWith("j3:")).toBe(true);
    expect(decodeInkDocument(text)).toEqual(emptyInkDocument());
  });

  it("decodes to the quantised document", () => {
    const doc = sampleDocument();
    const decoded = decodeInkDocument(encodeInkDocument(doc));
    expect(decoded).toEqual(quantizeInkDocument(doc));
    const first = decoded?.items[0];
    // 10.3 and 20.7 snap to the nearest 1/16 page unit.
    expect(first?.kind === "outline" && first.path[0]).toEqual({ op: "M", x: 10.3125, y: 20.6875 });
  });

  it("is deterministic and canonical", () => {
    const text = encodeInkDocument(sampleDocument());
    expect(encodeInkDocument(sampleDocument())).toBe(text);
    const decoded = decodeInkDocument(text);
    expect(decoded && encodeInkDocument(decoded)).toBe(text);
  });

  it("round-trips a few hundred random documents", () => {
    const random = seededRandom(20261009);
    for (let i = 0; i < 300; i += 1) {
      const doc = randomInkDocument(random);
      const text = encodeInkDocument(doc);
      const decoded = decodeInkDocument(text);
      expect(decoded).toEqual(quantizeInkDocument(doc));
      expect(decoded && encodeInkDocument(decoded)).toBe(text);
    }
  });

  it("keeps non-ASCII ids", () => {
    const id = "héllo-✏";
    const doc = docOf(lineShape(id, 0, 0, 1, 1));
    expect(decodeInkDocument(encodeInkDocument(doc))?.items[0].id).toBe(id);
  });

  it("returns null for every truncation", () => {
    const text = encodeInkDocument(sampleDocument());
    for (let length = 0; length < text.length; length += 1) {
      expect(decodeInkDocument(text.slice(0, length))).toBeNull();
    }
  });

  it("never throws on mutated or random input, and accepts only canonical text", () => {
    const text = encodeInkDocument(sampleDocument());
    const random = seededRandom(7);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < 2000; i += 1) {
      // Past the version, minReader and count bytes: a higher version byte is
      // allowed to decode (and re-encodes as 3), so it is checked separately.
      const at = 7 + Math.floor(random() * (text.length - 7));
      const mutated = text.slice(0, at) + alphabet[Math.floor(random() * 64)] + text.slice(at + 1);
      const decoded = decodeInkDocument(mutated);
      if (decoded) expect(encodeInkDocument(decoded)).toBe(mutated);
    }
    for (let i = 0; i < 500; i += 1) {
      let noise = "j3:";
      const length = Math.floor(random() * 60);
      for (let c = 0; c < length; c += 1) noise += alphabet[Math.floor(random() * 64)];
      expect(() => decodeInkDocument(noise)).not.toThrow();
    }
  });

  it("rejects the wrong prefix, padding and characters", () => {
    const text = encodeInkDocument(sampleDocument());
    expect(decodeInkDocument(text.slice(3))).toBeNull();
    expect(decodeInkDocument("j2:" + text.slice(3))).toBeNull();
    expect(decodeInkDocument(text + "=")).toBeNull();
    expect(decodeInkDocument(text + "+")).toBeNull();
    expect(decodeInkDocument(text + "A")).toBeNull();
    expect(decodeInkDocument("")).toBeNull();
  });

  it("checks the version and minReader header", () => {
    // [version, minReader, itemCount]
    expect(decodeInkDocument(wrap([3, 3, 0]))).toEqual(emptyInkDocument());
    // A reader below minReader gives up: the escape hatch for incompatible changes.
    expect(decodeInkDocument(wrap([4, 4, 0]))).toBeNull();
    expect(decodeInkDocument(wrap([3, 4, 0]))).toBeNull();
    // A newer writer that still allows this reader is read as version 3.
    expect(decodeInkDocument(wrap([4, 3, 0]))).toEqual(emptyInkDocument());
    // Nothing older than 3 exists, and a writer cannot need a newer reader than itself.
    expect(decodeInkDocument(wrap([2, 2, 0]))).toBeNull();
    expect(decodeInkDocument(wrap([3, 2, 0]))).toBeNull();
    expect(decodeInkDocument(wrap([3, 0x83, 0x00, 0]))).toBeNull();
  });

  it("rejects absurd counts and trailing bytes", () => {
    // claims 100,000 items in a handful of bytes
    expect(decodeInkDocument(wrap([3, 3, 0xa0, 0x8d, 0x06]))).toBeNull();
    // claims a million path commands in a few bytes
    expect(decodeInkDocument(wrap([3, 3, 1, 1, 1, 97, 1, 3, 0xc0, 0x84, 0x3d]))).toBeNull();
    // a trailing byte after a valid empty document
    expect(decodeInkDocument(wrap([3, 3, 0, 0]))).toBeNull();
    // kind 0 is reserved
    expect(decodeInkDocument(wrap([3, 3, 1, 0, 1, 97, 1, 0]))).toBeNull();
  });

  it("rejects a shape on the highlighter layer", () => {
    const bytes = Uint8Array.from(
      base64UrlToBytes(encodeInkDocument(docOf(lineShape("a", 0, 0, 1, 1))).slice(3))
    );
    // [version, minReader, count, kind, idLength, 'a', layer, ...]
    expect(bytes[6]).toBe(1);
    bytes[6] = 0;
    expect(decodeInkDocument("j3:" + bytesToBase64Url(bytes))).toBeNull();
  });

  it("bounds a known payload by its declared length", () => {
    const bytes = Array.from(
      base64UrlToBytes(encodeInkDocument(docOf(lineShape("a", 0, 0, 1, 1))).slice(3))
    );
    const lengthAt = 7;
    expect(bytes[lengthAt]).toBe(bytes.length - 8);
    // Longer than its contents (extra byte inside the payload).
    const longer = [...bytes.slice(0, lengthAt), bytes[lengthAt] + 1, ...bytes.slice(lengthAt + 1), 0];
    expect(decodeInkDocument(wrap(longer))).toBeNull();
    // Shorter than its contents.
    const shorter = [...bytes.slice(0, lengthAt), bytes[lengthAt] - 1, ...bytes.slice(lengthAt + 1)];
    expect(decodeInkDocument(wrap(shorter))).toBeNull();
    // Claiming more bytes than exist.
    const missing = [...bytes.slice(0, lengthAt), bytes[lengthAt] + 5, ...bytes.slice(lengthAt + 1)];
    expect(decodeInkDocument(wrap(missing))).toBeNull();
  });

  it("keeps items of an unknown kind, byte for byte", () => {
    // version 3, minReader 3, three items: a known shape, kind 9 with a payload, then kind 7.
    const doc = docOf(lineShape("a", 0, 0, 1, 1));
    const known = Array.from(base64UrlToBytes(encodeInkDocument(doc).slice(3))).slice(3);
    const future = [9, 1, 98, 0, 3, 7, 8, 9];
    const later = [7, 1, 99, 1, 0];
    const text = wrap([3, 3, 3, ...known, ...future, ...later]);
    const decoded = decodeInkDocument(text);
    expect(decoded?.items.map((item) => item.kind)).toEqual(["shape", "unknown", "unknown"]);
    expect(decoded?.items[1]).toEqual({
      kind: "unknown",
      id: "b",
      layerCode: 0,
      code: 9,
      payload: Uint8Array.from([7, 8, 9]),
    });
    expect(decoded && encodeInkDocument(decoded)).toBe(text);
    expect(decoded && decodeInkDocument(encodeInkDocument(decoded))).toEqual(decoded);
  });

  it("keeps any layer byte on an unknown kind, but rejects one on a known kind", () => {
    const known = Array.from(base64UrlToBytes(encodeInkDocument(docOf(lineShape("a", 0, 0, 1, 1))).slice(3))).slice(3);
    const future = [9, 1, 98, 200, 3, 7, 8, 9];
    const text = wrap([3, 3, 2, ...known, ...future]);
    const decoded = decodeInkDocument(text);
    expect(decoded?.items[1]).toMatchObject({ kind: "unknown", layerCode: 200 });
    expect(decoded && encodeInkDocument(decoded)).toBe(text);
    expect(inkItemLayer(decoded?.items[1] ?? lineShape("x", 0, 0, 1, 1))).toBe("pen");
    expect(inkItemLayer({ kind: "unknown", id: "u", layerCode: 0, code: 9, payload: new Uint8Array() })).toBe(
      "highlighter"
    );
    // The shape's layer byte follows kind, id length and the one-byte id.
    const badKnown = [...known];
    badKnown[3] = 7;
    expect(decodeInkDocument(wrap([3, 3, 1, ...badKnown]))).toBeNull();
    const unknown = (layerCode: number): InkUnknownItem => ({
      kind: "unknown",
      id: "u",
      layerCode,
      code: 9,
      payload: new Uint8Array(),
    });
    expect(() => encodeInkDocument(docOf(unknown(256)))).toThrow(/layer code/);
    expect(() => encodeInkDocument(docOf(unknown(-1)))).toThrow(/layer code/);
    expect(() => encodeInkDocument(docOf(unknown(255)))).not.toThrow();
  });

  it("refuses to store an unknown item with a taken kind code", () => {
    const unknown = (code: number): InkUnknownItem => ({
      kind: "unknown",
      id: "u",
      layerCode: 1,
      code,
      payload: new Uint8Array(),
    });
    expect(() => encodeInkDocument(docOf(unknown(1)))).toThrow(/kind code/);
    expect(() => encodeInkDocument(docOf(unknown(2.5)))).toThrow(/kind code/);
    expect(() => encodeInkDocument(docOf(unknown(3)))).not.toThrow();
  });

  it("rejects non-canonical varints", () => {
    // item count 1 written as 0x81 0x00
    expect(decodeInkDocument(wrap([3, 3, 0x81, 0x00]))).toBeNull();
  });

  it("throws clear errors for documents it cannot store", () => {
    const tooMany: InkDocument = {
      version: 3,
      items: Array.from({ length: 50_001 }, (_, i) => lineShape(`i${i}`, 0, 0, 1, 1)),
    };
    expect(() => encodeInkDocument(tooMany)).toThrow(/50000 items/);
    expect(() => encodeInkDocument(docOf(lineShape("x".repeat(65), 0, 0, 1, 1)))).toThrow(/id/);
    expect(() => encodeInkDocument(docOf(lineShape("", 0, 0, 1, 1)))).toThrow(/id/);
    // A lone surrogate would be stored as U+FFFD and read back as a different id.
    expect(() => encodeInkDocument(docOf(lineShape("a\ud800", 0, 0, 1, 1)))).toThrow(/well-formed/);
    expect(() => encodeInkDocument(docOf(lineShape("\udc00a", 0, 0, 1, 1)))).toThrow(/well-formed/);
    expect(() => encodeInkDocument(docOf(lineShape("a\ud83d\ude00", 0, 0, 1, 1)))).not.toThrow();
    expect(() => encodeInkDocument(docOf(lineShape("a", Number.NaN, 0, 1, 1)))).toThrow(
      /cannot be stored/
    );
    expect(() => encodeInkDocument(docOf(lineShape("a", 1e12, 0, 1, 1)))).toThrow(/cannot be stored/);
    expect(() =>
      encodeInkDocument(docOf(lineShape("a", 0, 0, 1, 1), lineShape("a", 0, 0, 1, 1)))
    ).toThrow(/twice/);
  });

  it("refuses to write more text than it will read", () => {
    const big = (id: string): InkUnknownItem => ({
      kind: "unknown",
      id,
      layerCode: 1,
      code: 3,
      payload: new Uint8Array(20_000_000),
    });
    // 60 MB of payload is about 80 million characters, past the 48 million decode accepts.
    expect(() => encodeInkDocument(docOf(big("a"), big("b"), big("c")))).toThrow(/too large/);
  });

  it("stores a 2,000-segment path in well under 40% of its SVG length", () => {
    const random = seededRandom(99);
    const path: InkPathCommand[] = [{ op: "M", x: 400.123, y: 600.456 }];
    let x = 400.123;
    let y = 600.456;
    const step = () => (random() - 0.5) * 8;
    for (let i = 0; i < 2000; i += 1) {
      const c1 = { x: x + step(), y: y + step() };
      const c2 = { x: c1.x + step(), y: c1.y + step() };
      x = c2.x + step();
      y = c2.y + step();
      path.push({ op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x, y });
    }
    const stored = encodeInkDocument(docOf(outline("long", path))).length;
    const svg = formatSvgPathData(path).length;
    expect(stored).toBeLessThan(svg * 0.4);
  });
});

describe("encoding a page again", () => {
  it("writes each item's own bytes, not an earlier item's it once replaced", () => {
    const black = { r: 17, g: 24, b: 39, a: 1 };
    const red = { r: 220, g: 38, b: 38, a: 1 };
    const item = (color: typeof black) => ({
      kind: "outline" as const,
      id: "a",
      layer: "pen" as const,
      path: [
        { op: "M" as const, x: 1, y: 2 },
        { op: "L" as const, x: 30, y: 40 },
      ],
      paint: { fill: color, stroke: null, opacity: 1 },
    });
    const first = { version: 3 as const, items: [item(black)] };
    const encoded = encodeInkDocument(first);
    expect(encodeInkDocument(first)).toBe(encoded);
    // Recoloured, as the lasso does: a new item in its place.
    const again = decodeInkDocument(encodeInkDocument({ version: 3, items: [item(red)] }));
    expect(again?.items[0].kind === "outline" && again.items[0].paint.fill).toEqual(red);
  });
});
