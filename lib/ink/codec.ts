/**
 * The stored `jami-ink` v3 encoding: `"j3:" + base64url(bytes)`.
 *
 * Byte layout (all varints are little-endian base-128, zigzag where signed):
 *
 *   document  := version:byte minReader:varint itemCount:varint item*
 *   version   := the writer's format version (3 today); never below minReader
 *   minReader := the oldest reader version that may read this document. A
 *                reader whose own version is lower returns null: the escape
 *                hatch for a genuinely incompatible change. 3 today.
 *
 *   item      := kind:varint id layer payloadLength:varint payload
 *   kind      := 1 (outline) | 2 (shape) | 3 or more (unknown to this reader)
 *   id        := byteLength:varint utf8Bytes       1-64 bytes, unique
 *   layer     := 0 (highlighter) | 1 (pen)         shapes are always pen; an
 *                unknown kind may carry any byte 0-255 (a newer build's new
 *                layer), kept raw so the page still opens
 *   payload   := exactly payloadLength bytes, laid out per kind below
 *
 * Every item is framed with its layer and payload length so a reader can step
 * over a kind it does not know. A newer build can add item kinds (pen and
 * highlighter centrelines are next) and an older tab or rollback build still
 * reads the page: the unknown item decodes to an `InkUnknownItem`, keeps its
 * id, layer byte and payload bytes, and is written back byte for byte. A known
 * kind's payload must be consumed exactly, so a change to an existing kind
 * takes a new kind code (or a new minReader), never a longer payload.
 *
 *   colour    := r g b alpha                       4 bytes, alpha = round(a * 255)
 *   point     := dx:zigzag dy:zigzag               in 1/16 unit, from the previous
 *                                                  point written in the same item
 *                                                  (the first is from 0,0)
 *
 *   outline   := commandCount:varint command* flags [fillColour] [stroke] opacity
 *   command   := opcode(1 M, 2 L, 3 C, 4 Q, 5 Z) point*   (C: 3 points, Q: 2, M/L: 1)
 *   flags     := bit 0 = has fill, bit 1 = has stroke    other bits must be 0
 *   stroke    := colour width:varint cap(0 round, 1 butt, 2 square)
 *                join(0 round, 1 miter, 2 bevel)
 *   opacity   := 1 byte, round(opacity * 255)
 *
 *   shape     := colour width:varint geometry
 *   geometry  := 1 line  point point
 *              | 2 arrow point point
 *              | 3 polygon cornerCount:varint point{3+}
 *              | 4 ellipse point(centre) rx:varint ry:varint rotation:zigzag
 *   rotation  := round(radians * 65536)
 *
 * Numbers are rounded to 1/16 page unit (see `codec-quantize.ts`). Control
 * points are delta-coded too, because on a smooth curve each point is close to
 * the one before it, which is what makes a stroke a fraction of its SVG size.
 *
 * Decoding is strict and never throws: truncated data, trailing bytes, a
 * payload shorter or longer than its declared length, an overlong varint, a
 * non-canonical base64url tail, duplicate ids, a minReader above this reader's
 * version, or absurd counts all return null. Text this build wrote therefore
 * has one spelling, so `encode(decode(text)) === text`. (A document written by
 * a newer build with a higher version byte decodes, and re-encodes as 3.)
 */

import { base64UrlToBytes, ByteReader, ByteWriter, bytesToBase64Url } from "@/lib/ink/bytes";
import {
  fromQuantized,
  MAX_ENCODED_CHARACTERS,
  MAX_ID_BYTES,
  MAX_INK_ITEMS,
  MAX_PATH_COMMANDS_PER_ITEM,
  MAX_PATH_COMMANDS_TOTAL,
  MAX_POLYGON_CORNERS,
  MAX_QUANTIZED,
  MAX_ROTATION,
  ROTATION_SCALE,
  toAlphaByte,
  toQuantized,
} from "@/lib/ink/codec-quantize";
import type {
  InkCap,
  InkColor,
  InkDocument,
  InkItem,
  InkJoin,
  InkLayer,
  InkPaint,
  InkPathCommand,
  InkPoint,
  InkShapeGeometry,
} from "@/lib/ink/model";

export { quantizeInkDocument } from "@/lib/ink/codec-quantize";

const PREFIX = "j3:";
/** The version this build writes, and the newest format it can read. */
const VERSION = 3;

const KIND_OUTLINE = 1;
const KIND_SHAPE = 2;
/** Kind codes below this are taken; a code at or above it is an unknown item. */
const FIRST_UNKNOWN_KIND = 3;
const LAYERS: readonly InkLayer[] = ["highlighter", "pen"];
const CAPS: readonly InkCap[] = ["round", "butt", "square"];
const JOINS: readonly InkJoin[] = ["round", "miter", "bevel"];
const OPCODES = { M: 1, L: 2, C: 3, Q: 4, Z: 5 } as const;
const GEOMETRY_CODES = { line: 1, arrow: 2, polygon: 3, ellipse: 4 } as const;
const FLAG_FILL = 1;
const FLAG_STROKE = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class InkDecodeError extends Error {}

function reject(message: string): never {
  throw new InkDecodeError(message);
}

/* ------------------------------------------------------------------ encode */

/** Tracks the running point so coordinates are written as small deltas. */
class PointWriter {
  private lastX = 0;
  private lastY = 0;

  constructor(private readonly out: ByteWriter) {}

  point(x: number, y: number): void {
    const qx = checkedUnits(x, "coordinate");
    const qy = checkedUnits(y, "coordinate");
    this.out.writeZigzag(qx - this.lastX);
    this.out.writeZigzag(qy - this.lastY);
    this.lastX = qx;
    this.lastY = qy;
  }
}

function checkedUnits(value: number, what: string): number {
  const units = toQuantized(value);
  if (!Number.isFinite(units) || Math.abs(units) > MAX_QUANTIZED) {
    throw new Error(`Ink ${what} ${value} cannot be stored.`);
  }
  return units;
}

function writeUnsignedUnits(out: ByteWriter, value: number, what: string): void {
  const units = checkedUnits(value, what);
  if (units < 0) throw new Error(`Ink ${what} ${value} cannot be negative.`);
  out.writeVarint(units);
}

function writeColor(out: ByteWriter, color: InkColor): void {
  for (const channel of [color.r, color.g, color.b]) {
    if (!Number.isFinite(channel)) throw new Error("Ink colour channel is not a number.");
    out.writeByte(Math.min(255, Math.max(0, Math.round(channel))));
  }
  if (!Number.isFinite(color.a)) throw new Error("Ink colour alpha is not a number.");
  out.writeByte(toAlphaByte(color.a));
}

function writeCommands(out: ByteWriter, commands: InkPathCommand[]): void {
  if (commands.length > MAX_PATH_COMMANDS_PER_ITEM) {
    throw new Error(`Ink path has more than ${MAX_PATH_COMMANDS_PER_ITEM} commands.`);
  }
  out.writeVarint(commands.length);
  const points = new PointWriter(out);
  for (const command of commands) {
    out.writeByte(OPCODES[command.op]);
    switch (command.op) {
      case "M":
      case "L":
        points.point(command.x, command.y);
        break;
      case "Q":
        points.point(command.x1, command.y1);
        points.point(command.x, command.y);
        break;
      case "C":
        points.point(command.x1, command.y1);
        points.point(command.x2, command.y2);
        points.point(command.x, command.y);
        break;
      case "Z":
        break;
    }
  }
}

function writePaint(out: ByteWriter, paint: InkPaint): void {
  out.writeByte((paint.fill ? FLAG_FILL : 0) | (paint.stroke ? FLAG_STROKE : 0));
  if (paint.fill) writeColor(out, paint.fill);
  if (paint.stroke) {
    writeColor(out, paint.stroke.color);
    writeUnsignedUnits(out, paint.stroke.width, "stroke width");
    out.writeByte(enumCode(CAPS, paint.stroke.cap, "cap"));
    out.writeByte(enumCode(JOINS, paint.stroke.join, "join"));
  }
  if (!Number.isFinite(paint.opacity)) throw new Error("Ink opacity is not a number.");
  out.writeByte(toAlphaByte(paint.opacity));
}

function writeGeometry(out: ByteWriter, geometry: InkShapeGeometry): void {
  out.writeByte(GEOMETRY_CODES[geometry.type]);
  const points = new PointWriter(out);
  switch (geometry.type) {
    case "line":
    case "arrow":
      points.point(geometry.from.x, geometry.from.y);
      points.point(geometry.to.x, geometry.to.y);
      break;
    case "polygon":
      if (geometry.corners.length < 3 || geometry.corners.length > MAX_POLYGON_CORNERS) {
        throw new Error("An ink polygon needs between 3 and 10,000 corners.");
      }
      out.writeVarint(geometry.corners.length);
      for (const corner of geometry.corners) points.point(corner.x, corner.y);
      break;
    case "ellipse": {
      points.point(geometry.cx, geometry.cy);
      writeUnsignedUnits(out, geometry.rx, "ellipse radius");
      writeUnsignedUnits(out, geometry.ry, "ellipse radius");
      if (!Number.isFinite(geometry.rotation) || Math.abs(geometry.rotation) > MAX_ROTATION) {
        throw new Error("Ink ellipse rotation cannot be stored.");
      }
      out.writeZigzag(Math.round(geometry.rotation * ROTATION_SCALE) + 0);
      break;
    }
  }
}

/** Strings with a lone surrogate would be stored as U+FFFD and read back changed. */
function isWellFormedString(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** The byte for an option, or a clear Error rather than a wrapped -1. */
function enumCode<T>(choices: readonly T[], value: T, what: string): number {
  const code = choices.indexOf(value);
  if (code < 0) throw new Error(`Ink ${what} "${String(value)}" cannot be stored.`);
  return code;
}

function checkedLayerCode(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Error(`Ink layer code ${code} cannot be stored.`);
  }
  return code;
}

/** The kind code and the payload bytes of an item. */
function itemPayload(item: InkItem): { kind: number; payload: Uint8Array } {
  const body = new ByteWriter();
  switch (item.kind) {
    case "outline":
      writeCommands(body, item.path);
      writePaint(body, item.paint);
      return { kind: KIND_OUTLINE, payload: body.toBytes() };
    case "shape":
      writeColor(body, item.color);
      writeUnsignedUnits(body, item.width, "shape width");
      writeGeometry(body, item.shape);
      return { kind: KIND_SHAPE, payload: body.toBytes() };
    case "unknown":
      if (!Number.isSafeInteger(item.code) || item.code < FIRST_UNKNOWN_KIND) {
        throw new Error(`Ink item kind code ${item.code} cannot be stored.`);
      }
      return { kind: item.code, payload: item.payload };
  }
}

function writeItem(out: ByteWriter, item: InkItem, seenIds: Set<string>): void {
  if (!isWellFormedString(item.id)) throw new Error("Ink item id is not well-formed text.");
  const id = textEncoder.encode(item.id);
  if (id.length === 0 || id.length > MAX_ID_BYTES) {
    throw new Error(`Ink item id must be 1 to ${MAX_ID_BYTES} bytes.`);
  }
  if (seenIds.has(item.id)) throw new Error(`Ink item id "${item.id}" is used twice.`);
  seenIds.add(item.id);

  const { kind, payload } = itemPayload(item);
  out.writeVarint(kind);
  out.writeVarint(id.length);
  out.writeBytes(id);
  out.writeByte(item.kind === "unknown" ? checkedLayerCode(item.layerCode) : enumCode(LAYERS, item.layer, "layer"));
  out.writeVarint(payload.length);
  out.writeBytes(payload);
}

/** Throws a clear Error if the document cannot be stored within the limits. */
export function encodeInkDocument(doc: InkDocument): string {
  if (doc.items.length > MAX_INK_ITEMS) {
    throw new Error(`Ink document has more than ${MAX_INK_ITEMS} items.`);
  }
  const out = new ByteWriter();
  out.writeByte(VERSION);
  out.writeVarint(VERSION); // minReader
  out.writeVarint(doc.items.length);
  const seenIds = new Set<string>();
  let commandTotal = 0;
  for (const item of doc.items) {
    if (item.kind === "outline") commandTotal += item.path.length;
    if (commandTotal > MAX_PATH_COMMANDS_TOTAL) {
      throw new Error(`Ink document has more than ${MAX_PATH_COMMANDS_TOTAL} path commands.`);
    }
    writeItem(out, item, seenIds);
  }
  const bytes = out.toBytes();
  // Refuse to write what decode would refuse to read, so a save never stores a lost page.
  if (PREFIX.length + Math.ceil((bytes.length * 4) / 3) > MAX_ENCODED_CHARACTERS) {
    throw new Error("Ink document is too large to store.");
  }
  return PREFIX + bytesToBase64Url(bytes);
}

/* ------------------------------------------------------------------ decode */

class PointReader {
  private lastX = 0;
  private lastY = 0;

  constructor(private readonly input: ByteReader) {}

  point(): InkPoint {
    const x = this.lastX + this.input.readZigzag();
    const y = this.lastY + this.input.readZigzag();
    if (Math.abs(x) > MAX_QUANTIZED || Math.abs(y) > MAX_QUANTIZED) reject("Coordinate out of range.");
    this.lastX = x;
    this.lastY = y;
    return { x: fromQuantized(x), y: fromQuantized(y) };
  }
}

function readColor(input: ByteReader): InkColor {
  const r = input.readByte();
  const g = input.readByte();
  const b = input.readByte();
  return { r, g, b, a: input.readByte() / 255 };
}

function readUnsignedUnits(input: ByteReader): number {
  const units = input.readVarint();
  if (units > MAX_QUANTIZED) reject("Size out of range.");
  return fromQuantized(units);
}

function readChoice<T>(input: ByteReader, choices: readonly T[]): T {
  const choice = choices[input.readByte()];
  if (choice === undefined) reject("Unknown option code.");
  return choice;
}

function readCommands(input: ByteReader, budget: { left: number }): InkPathCommand[] {
  const count = input.readVarint();
  // Every command takes at least one byte, so a count beyond that is a lie.
  if (count > MAX_PATH_COMMANDS_PER_ITEM || count > input.remaining) reject("Too many commands.");
  budget.left -= count;
  if (budget.left < 0) reject("Too many commands in total.");
  const points = new PointReader(input);
  const commands: InkPathCommand[] = [];
  for (let i = 0; i < count; i += 1) {
    switch (input.readByte()) {
      case OPCODES.M: {
        const p = points.point();
        commands.push({ op: "M", x: p.x, y: p.y });
        break;
      }
      case OPCODES.L: {
        const p = points.point();
        commands.push({ op: "L", x: p.x, y: p.y });
        break;
      }
      case OPCODES.Q: {
        const c = points.point();
        const p = points.point();
        commands.push({ op: "Q", x1: c.x, y1: c.y, x: p.x, y: p.y });
        break;
      }
      case OPCODES.C: {
        const c1 = points.point();
        const c2 = points.point();
        const p = points.point();
        commands.push({ op: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y });
        break;
      }
      case OPCODES.Z:
        commands.push({ op: "Z" });
        break;
      default:
        reject("Unknown path command.");
    }
  }
  return commands;
}

function readPaint(input: ByteReader): InkPaint {
  const flags = input.readByte();
  if ((flags & ~(FLAG_FILL | FLAG_STROKE)) !== 0) reject("Unknown paint flags.");
  const fill = flags & FLAG_FILL ? readColor(input) : null;
  const stroke =
    flags & FLAG_STROKE
      ? {
          color: readColor(input),
          width: readUnsignedUnits(input),
          cap: readChoice(input, CAPS),
          join: readChoice(input, JOINS),
        }
      : null;
  return { fill, stroke, opacity: input.readByte() / 255 };
}

function readGeometry(input: ByteReader): InkShapeGeometry {
  const code = input.readByte();
  const points = new PointReader(input);
  switch (code) {
    case GEOMETRY_CODES.line:
    case GEOMETRY_CODES.arrow: {
      const from = points.point();
      const to = points.point();
      return { type: code === GEOMETRY_CODES.line ? "line" : "arrow", from, to };
    }
    case GEOMETRY_CODES.polygon: {
      const count = input.readVarint();
      if (count < 3 || count > MAX_POLYGON_CORNERS || count > input.remaining) {
        reject("Bad polygon.");
      }
      const corners: InkPoint[] = [];
      for (let i = 0; i < count; i += 1) corners.push(points.point());
      return { type: "polygon", corners };
    }
    case GEOMETRY_CODES.ellipse: {
      const centre = points.point();
      const rx = readUnsignedUnits(input);
      const ry = readUnsignedUnits(input);
      const rotationUnits = input.readZigzag();
      if (Math.abs(rotationUnits) > MAX_ROTATION * ROTATION_SCALE) reject("Rotation out of range.");
      return {
        type: "ellipse",
        cx: centre.x,
        cy: centre.y,
        rx,
        ry,
        rotation: rotationUnits / ROTATION_SCALE,
      };
    }
    default:
      return reject("Unknown shape.");
  }
}

/** Reads a known kind's payload, which must be used up exactly. */
function readKnownPayload(
  kind: number,
  id: string,
  layer: InkLayer,
  payload: Uint8Array,
  budget: { left: number }
): InkItem {
  const input = new ByteReader(payload);
  let item: InkItem;
  if (kind === KIND_OUTLINE) {
    const path = readCommands(input, budget);
    item = { kind: "outline", id, layer, path, paint: readPaint(input) };
  } else {
    if (layer !== "pen") reject("Shapes live on the pen layer.");
    const color = readColor(input);
    const width = readUnsignedUnits(input);
    item = { kind: "shape", id, layer: "pen", color, width, shape: readGeometry(input) };
  }
  if (input.remaining !== 0) reject("Payload is longer than its contents.");
  return item;
}

function readItem(input: ByteReader, budget: { left: number }): InkItem {
  const kind = input.readVarint();
  if (kind < 1) reject("Bad item kind.");
  const idLength = input.readVarint();
  if (idLength < 1 || idLength > MAX_ID_BYTES) reject("Bad id length.");
  const id = textDecoder.decode(input.readBytes(idLength));
  const layerByte = input.readByte();
  const payloadLength = input.readVarint();
  if (payloadLength > input.remaining) reject("Payload is cut short.");
  const payload = input.readBytes(payloadLength);
  if (kind === KIND_OUTLINE || kind === KIND_SHAPE) {
    // Known kinds keep the strict check; only unknown ones may carry a new layer.
    const layer = LAYERS[layerByte];
    if (layer === undefined) reject("Unknown option code.");
    return readKnownPayload(kind, id, layer, payload, budget);
  }
  // A kind from a newer build: keep it whole (copied, so it does not pin the input buffer).
  return { kind: "unknown", id, layerCode: layerByte, code: kind, payload: payload.slice() };
}

/**
 * Whether text claims to be stored v3 ink, by its prefix alone: what a record's
 * shape is checked against without paying for a decode. Only
 * `decodeInkDocument` says whether it actually is.
 */
export function isInkDocumentText(text: unknown): text is string {
  return typeof text === "string" && text.startsWith(PREFIX) && text.length <= MAX_ENCODED_CHARACTERS;
}

/** Reads stored ink, or null if it is anything other than valid v3 data. */
export function decodeInkDocument(text: string): InkDocument | null {
  try {
    if (!text.startsWith(PREFIX) || text.length > MAX_ENCODED_CHARACTERS) return null;
    const input = new ByteReader(base64UrlToBytes(text.slice(PREFIX.length)));
    const version = input.readByte();
    const minReader = input.readVarint();
    // A writer cannot need a newer reader than itself, and every format starts at 3.
    if (minReader < VERSION || version < minReader) return null;
    // A newer build marked this page unreadable by older ones.
    if (minReader > VERSION) return null;
    const count = input.readVarint();
    // An item takes several bytes, so a bigger count than bytes is a lie.
    if (count > MAX_INK_ITEMS || count > input.remaining) return null;
    const budget = { left: MAX_PATH_COMMANDS_TOTAL };
    const seenIds = new Set<string>();
    const items: InkItem[] = [];
    for (let i = 0; i < count; i += 1) {
      const item = readItem(input, budget);
      if (seenIds.has(item.id)) return null;
      seenIds.add(item.id);
      items.push(item);
    }
    return input.remaining === 0 ? { version: VERSION, items } : null;
  } catch {
    return null;
  }
}
