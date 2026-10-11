"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { JamiInkSurfaceEngine } from "@/hooks/useJamiInkSurface";
import type { InkPoint } from "@/lib/ink/model";
import { formatInkTrace, type InkInputTrace, type InkTraceContext } from "@/lib/ink-dom/input-trace";
import {
  createScribbleTrack,
  inkStrokeToolFor,
  noteScribbleSample,
  scribbleSamplesOf,
  startScribbleTrack,
  type ActiveContact,
  type EraseContact,
  type ScribbleTrack,
  type StrokeContact,
} from "@/lib/ink-dom/pointer-contact";
import type { InkScreenMapping } from "@/lib/ink-dom/stroke-session";
import { inkClientToPage, inkScribbleInPageUnits } from "@/lib/ink-dom/surface-viewport";
import {
  getContinuousNotebookEraserSamples,
  getNotebookEraserCursorDiameter,
  getSpatiallySimplifiedNotebookEraserSamples,
  type NotebookEraserMode,
} from "@/lib/workspace/notebook-eraser";
import { getBoundedLivePointerSamples } from "@/lib/workspace/notebook-inking";
import {
  getNotebookContactTool,
  installNotebookNativeInkGuards,
  positionNotebookEraserCursor,
  shouldExpectNotebookCaptureLoss,
  type NotebookInkPointerEventType,
} from "@/lib/workspace/notebook-ink-contact";
import type { NotebookInkStyle, NotebookInkTool } from "@/lib/workspace/notebook-ink-types";
import { shouldSuppressNotebookNativeInkPointer } from "@/lib/workspace/notebook-interaction-lock";
import { NIB_ANGLE_DEFAULT, NotebookNibAngleTracker } from "@/lib/workspace/notebook-nib-angle";
import type { NotebookInkPointerLifecycle } from "@/lib/workspace/notebook-pointer-lifecycle";
import { detectNotebookScribble } from "@/lib/workspace/notebook-scribble-erase";

type SurfacePointerHandler = (event: ReactPointerEvent<HTMLDivElement>) => void;

/** What the handlers read at the pen's full rate: this render's props, in a ref. */
type LiveInputs = NotebookInkStyle & {
  readOnly: boolean;
  scribbleToErase: boolean;
  page: {
    onPointerDown: SurfacePointerHandler;
    onPointerMove: SurfacePointerHandler;
    onPointerUp: SurfacePointerHandler;
    onPointerCancel: SurfacePointerHandler;
  };
};

function inkTakes(tool: NotebookInkTool) {
  return tool === "pen" || tool === "highlighter" || tool === "eraser";
}

/**
 * Routes pointers on the ink surface into the Jami Ink engine: the pen,
 * highlighter and both erasers draw, and everything ink does not take -- touch,
 * the text and select tools, a read-only page -- goes to the page's own
 * handlers, so fingers navigate and the stylus writes.
 *
 * The routing and its safeguards are the js-draw editor's
 * (`useNotebookInkPointerInput`): the contact's tool is decided once, when the
 * pen lands, and a pen turned to its eraser end borrows the eraser for that
 * one contact; a hover is not a stroke; a contact whose capture is lost or
 * whose window loses focus is cancelled; a new contact over a stranded one
 * cancels it first. What differs is the engine: the tool is fixed at contact,
 * so a style change mid-stroke needs no deferral.
 *
 * Inside `pointermove` there is no React state, no layout read and no
 * allocation beyond the sample arrays. The handlers read the props through a
 * ref, so their identity never changes.
 */
export function useJamiInkPointerInput({
  engine,
  inkSurfaceRef,
  eraserCursorRef,
  lifecycleRef,
  eraserModeRef,
  style,
  readOnly,
  scribbleToErase,
  reportInteraction,
  page,
  trace = null,
}: {
  engine: JamiInkSurfaceEngine;
  inkSurfaceRef: RefObject<HTMLDivElement | null>;
  eraserCursorRef: RefObject<HTMLDivElement | null>;
  lifecycleRef: RefObject<NotebookInkPointerLifecycle | null>;
  /** The eraser's mode for the next contact. */
  eraserModeRef: RefObject<NotebookEraserMode>;
  style: NotebookInkStyle;
  readOnly: boolean;
  /** Scribbling out with the pen deletes the strokes it covers. */
  scribbleToErase: boolean;
  reportInteraction: (active: boolean) => void;
  /** The page's handlers, for pointers ink does not take. */
  page: LiveInputs["page"];
  /** Times each pen stroke and shows the figures at the lift, when `?inkstats=1` asked for it. */
  trace?: { recorder: InkInputTrace; readoutRef: RefObject<HTMLDivElement | null> } | null;
}) {
  const { surfaceRef, loadedRef, getMapping, measureNow, peekMapping, settle } = engine;
  const { activeTool, eraserThickness } = style;

  const liveRef = useRef<LiveInputs>({ ...style, readOnly, scribbleToErase, page });
  useLayoutEffect(() => {
    liveRef.current = { ...style, readOnly, scribbleToErase, page };
  });

  const activeRef = useRef<ActiveContact | null>(null);
  /**
   * The tool each pen contact is working with, by pointer id.
   *
   * Usually the selected tool. A pen turned over to its eraser end borrows the
   * eraser for that one contact -- see `getNotebookContactTool`.
   */
  const contactToolsRef = useRef<Map<number, NotebookInkTool>>(new Map());
  /** The raw path of a pen stroke, for recognising a scribble-out at the lift: x, y, time. */
  const scribbleRef = useRef<ScribbleTrack | null>(null);
  const ringDiameterRef = useRef(getNotebookEraserCursorDiameter(eraserThickness));
  // Which way the highlighter's flat edge faces. One per editor rather than one
  // per stroke: grip carries across strokes, so a stroke opens at the angle the
  // hand was already holding.
  const nibAngleRef = useRef<NotebookNibAngleTracker | null>(null);
  nibAngleRef.current ??= new NotebookNibAngleTracker();
  const nibAngle = useCallback(() => nibAngleRef.current?.current() ?? NIB_ANGLE_DEFAULT, []);
  /** What the readout says about the stroke being timed, if one is. */
  const traceContextRef = useRef<InkTraceContext | null>(null);

  useLayoutEffect(() => {
    const surface = inkSurfaceRef.current;
    if (!surface) return;
    // WebKit can decide that a fast horizontal Pencil stroke is a native
    // navigation gesture before React's delegated pointer handler runs. An
    // active, non-passive capture listener on the real ink target closes
    // that timing gap without affecting finger page navigation.
    return installNotebookNativeInkGuards(surface, (event) =>
      shouldSuppressNotebookNativeInkPointer({
        activeTool,
        pointerType: event.pointerType,
        readOnly,
      })
    );
  }, [activeTool, inkSurfaceRef, readOnly]);

  const hideRing = useCallback(() => {
    const ring = eraserCursorRef.current;
    if (ring) ring.style.opacity = "0";
  }, [eraserCursorRef]);

  const placeRing = useCallback(
    (clientX: number, clientY: number, mapping: InkScreenMapping, diameter: number) => {
      const ring = eraserCursorRef.current;
      if (!ring) return;
      ringDiameterRef.current = positionNotebookEraserCursor({
        clientX,
        clientY,
        cursor: ring,
        cursorDiameter: diameter,
        previousDiameter: ringDiameterRef.current,
        surfaceLeft: mapping.left,
        surfaceTop: mapping.top,
      });
    },
    [eraserCursorRef]
  );

  /** Drops whatever stroke or erase is in progress, as if it never began. */
  const cancelGesture = useCallback(() => {
    activeRef.current = null;
    const surface = surfaceRef.current;
    surface?.cancelStroke();
    surface?.cancelErase();
    hideRing();
  }, [hideRing, surfaceRef]);

  const finishPointerInteraction = useCallback(
    (input: { pointerId: number; expectCaptureLoss?: boolean; timeStamp: number }) => {
      const endedInteraction =
        lifecycleRef.current?.finish({
          pointerId: input.pointerId,
          expectCaptureLoss: input.expectCaptureLoss ?? false,
          timeStamp: input.timeStamp,
        }) ?? false;
      if (endedInteraction) reportInteraction(false);
    },
    [lifecycleRef, reportInteraction]
  );

  useEffect(() => {
    const cancelInteractions = () => {
      cancelGesture();
      contactToolsRef.current.clear();
      const lifecycle = lifecycleRef.current;
      const wasInteracting = lifecycle?.isInteracting ?? false;
      lifecycle?.reset();
      if (!wasInteracting) return;
      reportInteraction(false);
      settle();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelInteractions();
    };
    window.addEventListener("blur", cancelInteractions);
    window.addEventListener("pagehide", cancelInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelInteractions);
      window.removeEventListener("pagehide", cancelInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cancelGesture, lifecycleRef, reportInteraction, settle]);

  /** Puts a new contact on the engine. */
  const beginContact = useCallback(
    (tool: "pen" | "highlighter" | "eraser", event: ReactPointerEvent<HTMLDivElement>, live: LiveInputs) => {
      const surface = surfaceRef.current;
      const lifecycle = lifecycleRef.current;
      if (!surface || !lifecycle || !loadedRef.current) return;
      const { pointerId } = event;
      const native = event.nativeEvent;
      // A clean pointerdown goes straight to the engine. Only a previous
      // contact that is genuinely stranded is cancelled first; cancelling every
      // new stroke would race with rapid Pencil re-contact on Safari.
      if (lifecycle.begin(pointerId).shouldCancelStaleGesture) cancelGesture();
      const mapping = getMapping();
      if (!mapping) {
        lifecycle.finish({ pointerId, expectCaptureLoss: false, timeStamp: event.timeStamp });
        return;
      }

      if (tool === "eraser") {
        const cursorDiameter = getNotebookEraserCursorDiameter(live.eraserThickness);
        placeRing(event.clientX, event.clientY, mapping, cursorDiameter);
        surface.beginErase({
          mode: eraserModeRef.current,
          radius: cursorDiameter / 2 / mapping.scale,
          at: inkClientToPage(mapping, event.clientX, event.clientY),
        });
        activeRef.current = {
          kind: "erase",
          pointerId,
          mapping,
          cursorDiameter,
          lastSample: { clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp },
        };
      } else {
        surface.beginStroke({
          tool: inkStrokeToolFor({ tool, pointerType: event.pointerType, style: live, device: navigator, nibAngle }),
          mapping,
          first: native,
        });
        const watchScribble = live.scribbleToErase && tool === "pen";
        if (watchScribble) {
          // Raw client coordinates: recognising a scribble does not need to
          // know where the page is, and asking would force a layout flush at
          // the start of every stroke.
          startScribbleTrack((scribbleRef.current ??= createScribbleTrack()), event.clientX, event.clientY, event.timeStamp);
        }
        activeRef.current = {
          kind: "stroke",
          pointerId,
          mapping,
          last: native,
          predict: tool === "pen" && event.pointerType === "pen",
          nibWidth: live.penThickness,
          scribble: watchScribble,
        };
        if (trace) {
          traceContextRef.current = { tool: `${tool}, ${event.pointerType}`, scale: mapping.scale, devicePixelRatio: window.devicePixelRatio || 1 };
          trace.recorder.begin();
        }
      }
      try {
        if (!event.currentTarget.hasPointerCapture(pointerId)) {
          event.currentTarget.setPointerCapture(pointerId);
        }
      } catch {
        // Safari can reject capture on rapid stylus re-contact; keep drawing.
      }
      reportInteraction(true);
    },
    [cancelGesture, eraserModeRef, getMapping, lifecycleRef, loadedRef, placeRing, reportInteraction, nibAngle, surfaceRef, trace]
  );

  /** The scribble this stroke made, brought onto the page, or null if it was not one. */
  const scribbleOf = useCallback((active: StrokeContact) => {
    const track = scribbleRef.current;
    if (!active.scribble || !track || track.count === 0) return null;
    const samples = scribbleSamplesOf(track);
    const { scale } = active.mapping;
    const found = detectNotebookScribble(samples, { strokeWidth: active.nibWidth * scale, viewportScale: scale });
    return found ? inkScribbleInPageUnits(found, active.mapping) : null;
  }, []);

  /** The packet an erase move carries, onto the page. */
  const moveErase = useCallback(
    (active: EraseContact, event: PointerEvent) => {
      const samples = getContinuousNotebookEraserSamples(event, active.lastSample);
      const simplified = getSpatiallySimplifiedNotebookEraserSamples(samples, active.lastSample);
      if (simplified.length > 0) {
        const points = new Array<InkPoint>(simplified.length);
        for (let index = 0; index < simplified.length; index += 1) {
          points[index] = inkClientToPage(active.mapping, simplified[index].clientX, simplified[index].clientY);
        }
        surfaceRef.current?.moveErase(points);
      }
      const latest = samples[samples.length - 1];
      if (latest) active.lastSample = latest;
    },
    [surfaceRef]
  );

  /** Puts the ring back to the chosen thickness once an erase is over. */
  const restoreRingSize = useCallback(
    (eraserThicknessNow: number) => {
      const selected = getNotebookEraserCursorDiameter(eraserThicknessNow);
      ringDiameterRef.current = selected;
      const ring = eraserCursorRef.current;
      if (ring) {
        ring.style.width = `${selected}px`;
        ring.style.height = `${selected}px`;
      }
    },
    [eraserCursorRef]
  );

  /** Ends a contact: the engine keeps or drops it, and the pointer is let go. */
  const endContact = useCallback(
    (type: "pointerup" | "pointercancel", event: ReactPointerEvent<HTMLDivElement>, live: LiveInputs) => {
      const { pointerId } = event;
      const surface = surfaceRef.current;
      const active = activeRef.current;
      if (active && active.pointerId === pointerId) {
        activeRef.current = null;
        if (type === "pointercancel") {
          // An iPadOS navigation cancellation must not leave a stroke half
          // drawn, or the next Pencil stroke waiting behind it.
          surface?.cancelStroke();
          surface?.cancelErase();
          hideRing();
          trace?.recorder.cancel();
        } else if (active.kind === "stroke") {
          noteScribbleSample(scribbleRef.current, active, event.clientX, event.clientY, event.timeStamp);
          const liftStart = trace ? performance.now() : 0;
          // A scribble over ink erases it and is never drawn; over blank paper
          // it commits as the ordinary stroke it is.
          surface?.endStroke(scribbleOf(active));
          const context = traceContextRef.current;
          if (trace && context) {
            const summary = trace.recorder.end(performance.now() - liftStart);
            const readout = trace.readoutRef.current;
            if (readout) readout.textContent = formatInkTrace(summary, context);
          }
        } else {
          moveErase(active, event.nativeEvent);
          surface?.endErase();
          restoreRingSize(live.eraserThickness);
        }
      }
      contactToolsRef.current.delete(pointerId);

      const target = event.currentTarget;
      let hadPointerCapture = false;
      try {
        hadPointerCapture = target.hasPointerCapture(pointerId);
      } catch {
        // Capture state may be unavailable after a browser cancellation.
      }
      // Mark the release before capture is dropped. Safari can dispatch the
      // resulting lostpointercapture after the next contact has begun. A
      // pointercancel also ends implicit capture, even when Safari has
      // already stopped reporting it through hasPointerCapture().
      finishPointerInteraction({
        pointerId,
        expectCaptureLoss: shouldExpectNotebookCaptureLoss(type, hadPointerCapture),
        timeStamp: event.timeStamp,
      });
      try {
        if (hadPointerCapture) target.releasePointerCapture(pointerId);
      } catch {
        // Capture may already be gone; interaction cleanup still runs.
      }
      settle();
    },
    [finishPointerInteraction, hideRing, moveErase, restoreRingSize, scribbleOf, settle, surfaceRef, trace]
  );

  /** Hands a pointer to ink. Answers false when ink does not take it, so the page should. */
  const route = useCallback(
    (type: NotebookInkPointerEventType, event: ReactPointerEvent<HTMLDivElement>): boolean => {
      const live = liveRef.current;
      const native = event.nativeEvent;
      const { pointerId } = event;
      // Read before any of the branching below, so the edge keeps following the
      // hand through gestures that never reach the engine at all. Non-pen
      // pointers and pens reporting no orientation are ignored inside.
      if (type === "pointerdown" || type === "pointermove") nibAngleRef.current?.observe(native);

      // Decided once, at contact, and kept for the whole of it: which end of the
      // pen touched down does not change mid-stroke, whatever `buttons` reports
      // on the way. Touch never draws, so it never takes a slot.
      const contactTools = contactToolsRef.current;
      if (type === "pointerdown" && event.pointerType !== "touch") {
        contactTools.set(
          pointerId,
          getNotebookContactTool({
            activeTool: live.activeTool,
            buttons: event.buttons,
            pointerType: event.pointerType,
          })
        );
      }
      const tool = contactTools.get(pointerId) ?? live.activeTool;
      let active = activeRef.current;
      // A contact owns its pointer until release or cancellation. Props can
      // change while the Pencil is still down (a finger toolbar tap, say), but
      // the stroke or erase in progress must still be finished or restored.
      const continuing = active !== null && active.pointerId === pointerId && type !== "pointerdown";

      if (
        type === "pointerdown" &&
        active &&
        event.pointerType !== "touch" &&
        (!inkTakes(tool) || live.readOnly)
      ) {
        const strandedPointerId = active.pointerId;
        cancelGesture();
        active = null;
        finishPointerInteraction({ pointerId: strandedPointerId, timeStamp: event.timeStamp });
        try {
          if (event.currentTarget.hasPointerCapture(strandedPointerId)) {
            event.currentTarget.releasePointerCapture(strandedPointerId);
          }
        } catch {
          // Safari may already have discarded the stranded capture.
        }
      }
      if (!continuing && (event.pointerType === "touch" || !inkTakes(tool) || live.readOnly)) return false;
      event.preventDefault();

      if (type === "pointerdown") {
        if (tool === "pen" || tool === "highlighter" || tool === "eraser") beginContact(tool, event, live);
        return true;
      }
      const surface = surfaceRef.current;
      if (!loadedRef.current || !surface) return true;

      const own = active !== null && active.pointerId === pointerId ? active : null;
      if (tool === "eraser" && type !== "pointercancel" && eraserCursorRef.current) {
        // The ring follows the pen, down or hovering, at the size the erase
        // began with. A hover before any contact has the page where the last
        // measurement left it.
        const mapping = own ? own.mapping : (peekMapping() ?? getMapping());
        const diameter =
          own?.kind === "erase" ? own.cursorDiameter : getNotebookEraserCursorDiameter(live.eraserThickness);
        if (mapping) placeRing(event.clientX, event.clientY, mapping, diameter);
      }

      if (type === "pointermove") {
        /*
         * Only while this contact is actually down.
         *
         * A Pencil reports pointermove as it hovers, before it has touched
         * anything and after it has left, and a mouse reports it whenever it
         * crosses the page. Without this, every one of those would be drawn
         * as ink -- so the stroke went on growing after the pen had been
         * lifted, following it through the air.
         *
         * `buttons` is the second half of it. A contact can end without this
         * component seeing the up -- capture lost to a system gesture, a
         * pointer cancelled out from under it -- and the browser is the only
         * one that always knows whether anything is currently pressed.
         */
        if (!own || !lifecycleRef.current?.isDown(pointerId) || event.buttons === 0) return true;
        if (own.kind === "stroke") {
          const startedAt = trace ? performance.now() : 0;
          // Safari groups high-frequency Pencil input into coalesced packets;
          // the engine takes exactly those points, and draws before this
          // handler returns.
          const samples = getBoundedLivePointerSamples(native, own.last);
          const predicted =
            own.predict && typeof native.getPredictedEvents === "function"
              ? native.getPredictedEvents()
              : undefined;
          const tipPx = surface.moveStroke(samples, predicted);
          if (trace) {
            const oldest = samples.length > 0 ? samples[0].timeStamp : native.timeStamp;
            const newest = samples.length > 0 ? samples[samples.length - 1].timeStamp : native.timeStamp;
            const farthest = predicted && predicted.length > 0 ? predicted[predicted.length - 1].timeStamp : Number.NaN;
            trace.recorder.packet(
              native.timeStamp,
              oldest,
              startedAt,
              performance.now(),
              samples.length,
              predicted?.length ?? 0,
              farthest - newest,
              tipPx
            );
          }
          own.last = native;
          noteScribbleSample(scribbleRef.current, own, event.clientX, event.clientY, event.timeStamp);
        } else {
          moveErase(own, native);
        }
        return true;
      }

      endContact(type, event, live);
      return true;
    },
    [
      beginContact,
      cancelGesture,
      endContact,
      finishPointerInteraction,
      getMapping,
      lifecycleRef,
      loadedRef,
      moveErase,
      peekMapping,
      placeRing,
      surfaceRef,
      eraserCursorRef,
      trace,
    ]
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!route("pointerdown", event)) liveRef.current.page.onPointerDown(event);
    },
    [route]
  );
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!route("pointermove", event)) liveRef.current.page.onPointerMove(event);
    },
    [route]
  );
  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!route("pointerup", event)) liveRef.current.page.onPointerUp(event);
    },
    [route]
  );
  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!route("pointercancel", event)) liveRef.current.page.onPointerCancel(event);
    },
    [route]
  );
  const handlePointerEnter = useCallback(() => {
    // The page may have moved since the pen last hovered here.
    if (liveRef.current.activeTool === "eraser") measureNow();
  }, [measureNow]);
  const handleLostPointerCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") {
        liveRef.current.page.onPointerCancel(event);
        return;
      }
      const { pointerId } = event;
      const lifecycle = lifecycleRef.current;
      const decision = lifecycle?.handleLostCapture(pointerId, event.timeStamp);
      if (decision?.kind !== "cancel-active") return;
      if (!lifecycle?.isCurrent(pointerId, decision.generation)) return;
      cancelGesture();
      contactToolsRef.current.delete(pointerId);
      finishPointerInteraction({ pointerId, timeStamp: event.timeStamp });
      settle();
    },
    [cancelGesture, finishPointerInteraction, lifecycleRef, settle]
  );

  /*
   * React sizes the eraser ring from the chosen thickness. An erase in
   * progress keeps the size it began with, so a thickness changed mid-erase is
   * put back before paint.
   */
  useLayoutEffect(() => {
    const active = activeRef.current;
    const ring = eraserCursorRef.current;
    if (!active || active.kind !== "erase" || !ring) return;
    ring.style.width = `${active.cursorDiameter}px`;
    ring.style.height = `${active.cursorDiameter}px`;
  }, [activeTool, eraserCursorRef, eraserThickness]);

  return {
    /** For the ink surface element. */
    surfaceHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onPointerEnter: handlePointerEnter,
      onLostPointerCapture: handleLostPointerCapture,
      onPointerLeave: hideRing,
    },
    /** The eraser ring's size for the chosen thickness. */
    eraserCursorDiameter: getNotebookEraserCursorDiameter(eraserThickness),
  };
}
