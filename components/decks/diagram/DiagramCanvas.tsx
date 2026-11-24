"use client";

import { useRef, useState, type PointerEvent } from "react";
import {
  OcclusionPointerLayer,
  OcclusionPolygon,
  occlusionChipStyle,
  occlusionShapeStyle,
  type OcclusionPointerLine,
} from "@/components/cards/OcclusionFigure";
import type { DiagramSelection, DiagramTool } from "@/hooks/useDiagramEditor";
import type {
  OcclusionLabel,
  OcclusionLabelMode,
  OcclusionPoint,
  OcclusionPointer,
  OcclusionShape,
} from "@/lib/study/image-occlusion";
import {
  defaultShapeAt,
  findShapeAt,
  getPointerLine,
  moveShape,
  polygonShapeFromPath,
  resizeShape,
  shapeContainsPoint,
  shapeFromPoints,
  type ResizeHandle,
} from "@/lib/study/image-occlusion-geometry";
import { midpointBend } from "@/lib/study/image-occlusion-editor";

type DiagramCanvasProps = {
  imageUrl: string | null;
  width: number;
  height: number;
  labels: OcclusionLabel[];
  labelMode: OcclusionLabelMode;
  pointerEnd?: "dot" | "arrow";
  tool: DiagramTool;
  zoom: number;
  selection: DiagramSelection;
  onSelect: (selection: DiagramSelection) => void;
  /** A finished shape, and what drew it, so a mouse can jump to the label field and a finger need not. */
  onDrawShape: (shape: OcclusionShape, pointerType: string) => void;
  onChangeShape: (labelId: string, shapeIndex: number, shape: OcclusionShape, gestureId: string) => void;
  /** Where a label's line points. A drag passes one gesture id throughout, so it undoes in one step. */
  onSetPointer: (labelId: string, pointer: OcclusionPointer, gestureId?: string) => void;
};

type Gesture =
  | {
      kind: "draw";
      pointerId: number;
      start: OcclusionPoint;
      startClient: { x: number; y: number };
      dragging: boolean;
    }
  | {
      /** The Outline tool: every point the pointer passes, traced round a part. */
      kind: "trace";
      pointerId: number;
      path: OcclusionPoint[];
      startClient: { x: number; y: number };
      dragging: boolean;
    }
  | {
      kind: "move";
      pointerId: number;
      labelId: string;
      shapeIndex: number;
      origin: OcclusionShape;
      start: OcclusionPoint;
      startClient: { x: number; y: number };
      dragging: boolean;
      gestureId: string;
    }
  | {
      kind: "resize";
      pointerId: number;
      labelId: string;
      shapeIndex: number;
      origin: OcclusionShape;
      handle: ResizeHandle;
      gestureId: string;
    }
  | {
      /** The Line tool: from a box, or from the selected label, to the part it names. */
      kind: "point";
      pointerId: number;
      labelId: string;
      /** The box the gesture began on, when it began on one: a tap there selects it instead. */
      startedOn: { labelId: string; shapeIndex: number } | null;
      startClient: { x: number; y: number };
      dragging: boolean;
    }
  | { kind: "tip"; pointerId: number; labelId: string; pointer: OcclusionPointer; gestureId: string }
  | { kind: "bend"; pointerId: number; labelId: string; pointer: OcclusionPointer; gestureId: string };

/** How far a pointer travels, in CSS pixels, before a tap becomes a drag. */
const DRAG_THRESHOLD = 6;
/** A drawn box smaller than this on screen was a tap that wobbled. */
const MIN_DRAWN_PIXELS = 10;
const HANDLES: ResizeHandle[] = ["nw", "ne", "sw", "se"];

let gestureCounter = 0;
const nextGestureId = () => `g${(gestureCounter += 1)}`;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The picture being labelled, and every box on it.
 *
 * Four tools. In every tool but Line, a box already there is picked up by
 * pressing on it: drag to move it, tap to select it and show its corners. The
 * tool decides only what a press on empty picture does:
 *
 * - **Box** and **Oval**: drag to draw. A tap drops a label-sized box where it
 *   landed -- on a phone that is the quickest way to cover a word.
 * - **Outline**: trace round an irregular part; lifting closes the shape.
 * - **Line**: drag from a box to the part it names. With a label selected, a
 *   tap anywhere points its line there -- the way to do it on a phone.
 *
 * The selected label has handles in every tool: its box's corners, the end of
 * its line, and the middle of the line, which bends it (a double-click there
 * straightens it again). Positions are fractions of the picture, so zooming is
 * only the stage getting wider. The keyboard (nudge, delete, undo) is handled
 * by the editor around this, not here.
 */
export default function DiagramCanvas({
  imageUrl,
  width,
  height,
  labels,
  labelMode,
  pointerEnd = "dot",
  tool,
  zoom,
  selection,
  onSelect,
  onDrawShape,
  onChangeShape,
  onSetPointer,
}: DiagramCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<OcclusionShape | null>(null);
  const [tracePreview, setTracePreview] = useState<OcclusionPoint[] | null>(null);
  const [pointerPreview, setPointerPreview] = useState<{ labelId: string; tip: OcclusionPoint } | null>(null);
  const aspect = width / height;
  const selectedLabel = selection ? labels.find((label) => label.id === selection.labelId) : undefined;

  const toPoint = (event: { clientX: number; clientY: number }): OcclusionPoint => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const stagePixels = () => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const beginStage = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current) return;
    // Leave any label field, so the keyboard acts on the picture again.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const start = toPoint(event);
    const startClient = { x: event.clientX, y: event.clientY };
    if (tool === "pointer") {
      const startedOn = findShapeAt(labels, start);
      const labelId = startedOn?.labelId ?? selection?.labelId;
      // Nothing to draw a line from: the editor's hint says to pick a box.
      if (!labelId) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gestureRef.current = { kind: "point", pointerId: event.pointerId, labelId, startedOn, startClient, dragging: false };
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current =
      tool === "outline"
        ? { kind: "trace", pointerId: event.pointerId, path: [start], startClient, dragging: false }
        : { kind: "draw", pointerId: event.pointerId, start, startClient, dragging: false };
  };

  // A box can be dragged in any tool but Line, whose drag from a box draws the box's line.
  const boxesMove = tool !== "pointer";
  const beginMove = (event: PointerEvent<HTMLElement>, labelId: string, shapeIndex: number, shape: OcclusionShape) => {
    if (event.button !== 0 || !boxesMove || gestureRef.current) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect({ labelId, shapeIndex });
    gestureRef.current = {
      kind: "move",
      pointerId: event.pointerId,
      labelId,
      shapeIndex,
      origin: shape,
      start: toPoint(event),
      startClient: { x: event.clientX, y: event.clientY },
      dragging: false,
      gestureId: nextGestureId(),
    };
  };

  const beginHandle = (event: PointerEvent<HTMLElement>, gesture: Gesture) => {
    if (event.button !== 0 || gestureRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = gesture;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = toPoint(event);
    if (gesture.kind === "resize") {
      onChangeShape(gesture.labelId, gesture.shapeIndex, resizeShape(gesture.origin, gesture.handle, point), gesture.gestureId);
      return;
    }
    if (gesture.kind === "tip") {
      onSetPointer(gesture.labelId, { ...gesture.pointer, ...point }, gesture.gestureId);
      return;
    }
    if (gesture.kind === "bend") {
      onSetPointer(gesture.labelId, { ...gesture.pointer, bend: point }, gesture.gestureId);
      return;
    }
    if (!gesture.dragging) {
      const travelled = Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y);
      if (travelled < DRAG_THRESHOLD) return;
      gesture.dragging = true;
    }
    if (gesture.kind === "draw") {
      setPreview(shapeFromPoints(tool === "ellipse" ? "ellipse" : "rect", gesture.start, point));
    } else if (gesture.kind === "trace") {
      const last = gesture.path[gesture.path.length - 1];
      if (Math.hypot((point.x - last.x) * aspect, point.y - last.y) > 0.002) gesture.path.push(point);
      setTracePreview([...gesture.path]);
    } else if (gesture.kind === "point") {
      setPointerPreview({ labelId: gesture.labelId, tip: point });
    } else {
      onChangeShape(
        gesture.labelId,
        gesture.shapeIndex,
        moveShape(gesture.origin, point.x - gesture.start.x, point.y - gesture.start.y),
        gesture.gestureId
      );
    }
  };

  const finishPoint = (gesture: Extract<Gesture, { kind: "point" }>, point: OcclusionPoint) => {
    const label = labels.find((entry) => entry.id === gesture.labelId);
    if (!label) return;
    // A tap on a box picks that box; so does ending a line inside the box it came from.
    const endedInOwnBox = label.shapes.some((shape) => shapeContainsPoint(shape, point));
    if ((gesture.startedOn && !gesture.dragging) || endedInOwnBox) {
      onSelect(gesture.startedOn ?? { labelId: label.id, shapeIndex: 0 });
      return;
    }
    // A new line starts straight; moving an existing tip keeps its bend.
    onSetPointer(label.id, { ...point, ...(label.pointer?.bend ? { bend: label.pointer.bend } : {}) });
    onSelect({ labelId: label.id, shapeIndex: 0 });
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setPreview(null);
    setTracePreview(null);
    setPointerPreview(null);
    if (cancelled) return;
    if (gesture.kind === "point") {
      finishPoint(gesture, toPoint(event));
      return;
    }
    if (gesture.kind === "trace") {
      const traced = gesture.dragging ? polygonShapeFromPath(gesture.path, aspect) : null;
      if (traced) {
        onDrawShape(traced, event.pointerType);
        return;
      }
      // A tap, or a scribble too small to be an outline: pick what is under it.
      const hit = findShapeAt(labels, gesture.path[0]);
      if (hit) onSelect(hit);
      return;
    }
    if (gesture.kind !== "draw") return;

    const kind = tool === "ellipse" ? "ellipse" : "rect";
    const point = toPoint(event);
    const drawn = shapeFromPoints(kind, gesture.start, point);
    const pixels = stagePixels();
    const bigEnough =
      drawn.width * pixels.width >= MIN_DRAWN_PIXELS && drawn.height * pixels.height >= MIN_DRAWN_PIXELS;
    if (gesture.dragging && bigEnough) {
      onDrawShape(drawn, event.pointerType);
      return;
    }
    // A tap: select what is under it, or drop a box there.
    const hit = findShapeAt(labels, gesture.start);
    if (hit) onSelect(hit);
    else onDrawShape(defaultShapeAt(kind, gesture.start, aspect), event.pointerType);
  };

  // Every label's line; the one being drawn follows the pointer.
  const lines = labels.flatMap((label): OcclusionPointerLine[] => {
    const tip = pointerPreview?.labelId === label.id ? pointerPreview.tip : label.pointer;
    const [shape] = label.shapes;
    if (!tip || !shape) return [];
    const pointer: OcclusionPointer = { ...tip, ...(label.pointer?.bend ? { bend: label.pointer.bend } : {}) };
    return [{ key: label.id, shape, pointer, tone: label.id === selection?.labelId ? "asked" : "other" }];
  });

  // The handle that bends the selected line: on its bend, or halfway along a straight one.
  const selectedLine =
    selectedLabel?.pointer && selectedLabel.shapes[0] && !pointerPreview
      ? getPointerLine(selectedLabel.shapes[0], selectedLabel.pointer, width, height)
      : null;
  const bendHandle =
    selectedLabel?.pointer && selectedLine
      ? selectedLabel.pointer.bend ?? midpointBend({ x: selectedLine.x1, y: selectedLine.y1 }, selectedLabel.pointer)
      : null;

  return (
    <div
      className="h-full w-full overflow-auto overscroll-contain [container-type:size]"
      data-diagram-canvas
    >
      <div className="grid min-h-full min-w-full w-max place-items-center p-4">
        <div
          ref={stageRef}
          // Drawing needs a pointer; the label list beside it is the keyboard's way in.
          aria-hidden="true"
          onPointerDown={beginStage}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finish(event, false)}
          onPointerCancel={(event) => finish(event, true)}
          className="relative cursor-crosshair touch-none select-none overflow-visible rounded-lg bg-white shadow-card"
          style={{
            aspectRatio: `${width} / ${height}`,
            width: `calc(${zoom} * min(100cqw - 2rem, (100cqh - 2rem) * ${aspect}))`,
          }}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview or private Storage URL
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full rounded-lg"
            />
          ) : (
            <div className="absolute inset-0 animate-pulse rounded-lg bg-[var(--color-glass-subtle)]" />
          )}

          <OcclusionPointerLayer lines={lines} width={width} height={height} end={pointerEnd} />

          {labels.map((label, labelIndex) =>
            label.shapes.map((shape, shapeIndex) => {
              const selected = selection?.labelId === label.id;
              // A named part with a line is a label slot: its name goes inside, as it will be studied.
              const inside =
                labelMode === "name" && label.pointer && shapeIndex === 0 ? label.answer.trim() : "";
              return (
                <div
                  key={`${label.id}:${shapeIndex}`}
                  onPointerDown={(event) => beginMove(event, label.id, shapeIndex, shape)}
                  className={`absolute grid place-items-center ${
                    selected ? "occlusion-edit-shape occlusion-edit-shape--selected" : "occlusion-edit-shape"
                  } ${shape.kind === "polygon" ? "is-polygon" : ""} ${boxesMove ? "cursor-move touch-none" : "pointer-events-none"}`}
                  style={occlusionShapeStyle(shape)}
                >
                  <OcclusionPolygon shape={shape} />
                  {inside ? <span className="occlusion-slot-text relative">{inside}</span> : null}
                  {/* Just above the middle of the top edge: clear of the corner handles and of the word underneath. */}
                  <span className="occlusion-edit-badge pointer-events-none absolute bottom-full left-1/2 mb-1 grid h-5 min-w-5 -translate-x-1/2 place-items-center rounded-full px-1 text-2xs font-bold leading-none">
                    {labelIndex + 1}
                  </span>
                </div>
              );
            })
          )}

          {/* In "name the parts" a box around its part has the name beside it, as it will be studied. */}
          {labelMode === "name"
            ? labels.map((label) =>
                label.answer.trim() && label.shapes[0] && !label.pointer ? (
                  <span
                    key={`chip:${label.id}`}
                    aria-hidden="true"
                    className="occlusion-chip pointer-events-none absolute z-10"
                    style={occlusionChipStyle(label.shapes[0])}
                  >
                    {label.answer.trim()}
                  </span>
                ) : null
              )
            : null}

          {preview ? (
            <div
              aria-hidden="true"
              className="occlusion-edit-shape occlusion-edit-shape--selected pointer-events-none absolute border-dashed"
              style={occlusionShapeStyle(preview)}
            />
          ) : null}

          {tracePreview && tracePreview.length > 1 ? (
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
            >
              <polyline
                points={tracePreview.map((point) => `${point.x},${point.y}`).join(" ")}
                className="occlusion-trace"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : null}

          {selection && selectedLabel?.shapes[selection.shapeIndex]
            ? HANDLES.map((handle) => {
                const shape = selectedLabel.shapes[selection.shapeIndex];
                return (
                  <div
                    key={handle}
                    aria-hidden="true"
                    onPointerDown={(event) =>
                      beginHandle(event, {
                        kind: "resize",
                        pointerId: event.pointerId,
                        labelId: selectedLabel.id,
                        shapeIndex: selection.shapeIndex,
                        origin: shape,
                        handle,
                        gestureId: nextGestureId(),
                      })
                    }
                    className={`absolute z-20 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center ${
                      handle === "nw" || handle === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize"
                    }`}
                    style={{
                      left: `${(handle === "nw" || handle === "sw" ? shape.x : shape.x + shape.width) * 100}%`,
                      top: `${(handle === "nw" || handle === "ne" ? shape.y : shape.y + shape.height) * 100}%`,
                    }}
                  >
                    <span className="occlusion-handle h-3.5 w-3.5 rounded-full" />
                  </div>
                );
              })
            : null}

          {selectedLabel?.pointer && bendHandle ? (
            <div
              aria-hidden="true"
              title="Drag to bend the line; double-click to straighten it"
              onPointerDown={(event) =>
                beginHandle(event, {
                  kind: "bend",
                  pointerId: event.pointerId,
                  labelId: selectedLabel.id,
                  pointer: selectedLabel.pointer!,
                  gestureId: nextGestureId(),
                })
              }
              onDoubleClick={() => {
                const { bend: _bend, ...straight } = selectedLabel.pointer!;
                void _bend;
                onSetPointer(selectedLabel.id, straight);
              }}
              className="absolute z-20 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none place-items-center"
              style={{ left: `${bendHandle.x * 100}%`, top: `${bendHandle.y * 100}%` }}
            >
              <span
                className={`occlusion-handle h-3 w-3 rounded-sm ${selectedLabel.pointer.bend ? "" : "opacity-70"}`}
              />
            </div>
          ) : null}

          {selectedLabel?.pointer && !pointerPreview ? (
            <div
              aria-hidden="true"
              onPointerDown={(event) =>
                beginHandle(event, {
                  kind: "tip",
                  pointerId: event.pointerId,
                  labelId: selectedLabel.id,
                  pointer: selectedLabel.pointer!,
                  gestureId: nextGestureId(),
                })
              }
              className="absolute z-20 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none place-items-center"
              style={{ left: `${selectedLabel.pointer.x * 100}%`, top: `${selectedLabel.pointer.y * 100}%` }}
            >
              <span className="occlusion-handle h-4 w-4 rounded-full" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
