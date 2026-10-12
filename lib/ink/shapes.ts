import type { InkPaint, InkPathCommand, InkPoint, InkShapeGeometry, InkShapeItem } from "@/lib/ink/model";

/** Quarter-circle Bézier handle length as a fraction of the radius. */
const ELLIPSE_KAPPA = 0.5522847498307936;
const ARROW_HEAD_MIN_LENGTH = 12;
const ARROW_HEAD_WIDTHS = 4;
const ARROW_HEAD_ANGLE = Math.PI / 6;

function arrowPath(from: InkPoint, to: InkPoint, width: number): InkPathCommand[] {
  const shaft: InkPathCommand[] = [
    { op: "M", x: from.x, y: from.y },
    { op: "L", x: to.x, y: to.y },
  ];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return shaft;

  // A head longer than the shaft would poke out behind the tail.
  const headLength = Math.min(length, Math.max(ARROW_HEAD_MIN_LENGTH, width * ARROW_HEAD_WIDTHS));
  const backX = -dx / length;
  const backY = -dy / length;
  const head: InkPathCommand[] = [];
  for (const side of [1, -1]) {
    const angle = ARROW_HEAD_ANGLE * side;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    head.push(
      { op: "M", x: to.x, y: to.y },
      {
        op: "L",
        x: to.x + headLength * (backX * cos - backY * sin),
        y: to.y + headLength * (backX * sin + backY * cos),
      }
    );
  }
  return [...shaft, ...head];
}

function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number
): InkPathCommand[] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const at = (u: number, v: number) => ({
    x: cx + u * cos - v * sin,
    y: cy + u * sin + v * cos,
  });
  const kx = rx * ELLIPSE_KAPPA;
  const ky = ry * ELLIPSE_KAPPA;
  // Four quarter arcs starting at the right-hand end of the major axis.
  const quarter = (
    c1: [number, number],
    c2: [number, number],
    end: [number, number]
  ): InkPathCommand => {
    const p1 = at(c1[0], c1[1]);
    const p2 = at(c2[0], c2[1]);
    const p = at(end[0], end[1]);
    return { op: "C", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
  };
  const first = at(rx, 0);
  return [
    { op: "M", x: first.x, y: first.y },
    quarter([rx, ky], [kx, ry], [0, ry]),
    quarter([-kx, ry], [-rx, ky], [-rx, 0]),
    quarter([-rx, -ky], [-kx, -ry], [0, -ry]),
    quarter([kx, -ry], [rx, -ky], [rx, 0]),
    { op: "Z" },
  ];
}

/**
 * How a shape is painted: stroked, never filled, round at its width. The very
 * paint a pen stroke of that width is drawn live with (`penInkPaint`), which is
 * what lets a stroke snapped to a shape lift without a pixel changing.
 */
export function inkShapePaint(item: Pick<InkShapeItem, "color" | "width">): InkPaint {
  return { fill: null, stroke: { color: item.color, width: item.width, cap: "round", join: "round" }, opacity: 1 };
}

/**
 * The path a shape is stroked along. Shapes are stroked (never filled) with
 * round caps and joins at `width`, so the same path serves the renderer, hit
 * tests and the SVG export. An arrow is its shaft plus two head strokes as
 * separate subpaths, sized from the width so thick arrows keep a visible head.
 */
export function inkShapePath(geometry: InkShapeGeometry, width: number): InkPathCommand[] {
  switch (geometry.type) {
    case "line":
      return [
        { op: "M", x: geometry.from.x, y: geometry.from.y },
        { op: "L", x: geometry.to.x, y: geometry.to.y },
      ];
    case "arrow":
      return arrowPath(geometry.from, geometry.to, width);
    case "polygon": {
      if (geometry.corners.length === 0) return [];
      const [first, ...rest] = geometry.corners;
      return [
        { op: "M", x: first.x, y: first.y },
        ...rest.map((corner): InkPathCommand => ({ op: "L", x: corner.x, y: corner.y })),
        { op: "Z" },
      ];
    }
    case "ellipse":
      return ellipsePath(geometry.cx, geometry.cy, geometry.rx, geometry.ry, geometry.rotation);
  }
}
