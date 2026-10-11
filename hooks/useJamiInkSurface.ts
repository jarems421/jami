"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type {
  NotebookInkEditorCallbacks,
  NotebookInkFrame,
} from "@/components/workspace/notebook-ink-editor-types";
import type { InkSheetRect } from "@/lib/ink/render-plan";
import { createInkSurface, type InkSurface } from "@/lib/ink-dom/surface";
import { inkSurfaceViewport } from "@/lib/ink-dom/surface-viewport";
import type { InkScreenMapping } from "@/lib/ink-dom/stroke-session";
import type { NotebookInkPointerLifecycle } from "@/lib/workspace/notebook-pointer-lifecycle";

/** How long after the last scroll or resize the sheet is taken to have settled. */
const SETTLE_MS = 120;

/**
 * The Jami Ink engine behind one notebook page, from building it to taking it
 * down, and where the sheet is on screen while it lives.
 *
 * Built afresh for each page. It loads the page's ink, reports every edit and
 * the undo history, and says when the ink has drawn so the page can drop the
 * static underlay it shows meanwhile.
 *
 * The engine reads no layout, so this is the one place the sheet is measured:
 * `getBoundingClientRect()` of the host (and of the frame around it, when it
 * sits in one) whenever the page or the part of it on screen changes, when the
 * window resizes and when a scroll settles.
 * Never while a stroke or an erase is in progress -- that waits for it to end --
 * and a scroll or resize marks the last measurement stale, so the next pen
 * contact measures once before it begins.
 */
export function useJamiInkSurface({
  hostRef,
  initialSvg,
  pageId,
  pageWidth,
  pageHeight,
  inkWindow,
  inkFrame,
  callbacksRef,
  lifecycleRef,
  reportInteraction,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  initialSvg: string;
  pageId: string;
  pageWidth: number;
  pageHeight: number;
  inkWindow: InkSheetRect | null;
  inkFrame: NotebookInkFrame | null;
  callbacksRef: RefObject<NotebookInkEditorCallbacks>;
  lifecycleRef: RefObject<NotebookInkPointerLifecycle | null>;
  reportInteraction: (active: boolean) => void;
}) {
  const surfaceRef = useRef<InkSurface | null>(null);
  /** The page's ink is in the surface (loading did not fail). */
  const loadedRef = useRef(false);
  const initialSvgRef = useRef(initialSvg);

  /** Where the page sits, as the last render said. */
  const placeRef = useRef({
    page: { width: pageWidth, height: pageHeight },
    frame: inkFrame,
    renderWindow: inkWindow,
  });
  /** The last measurement, which a stroke is mapped through. */
  const mappingRef = useRef<InkScreenMapping | null>(null);
  /** The page may have moved since `mappingRef` was taken. */
  const staleRef = useRef(true);
  /** A measurement was asked for during a stroke or an erase and is owed. */
  const owedRef = useRef(false);
  /** `onReady` is waiting on the first viewport's ink being drawn. */
  const readyRef = useRef<{ waiting: boolean; cancel: (() => void) | null }>({ waiting: false, cancel: null });

  const measure = useCallback((): InkScreenMapping | null => {
    const surface = surfaceRef.current;
    const host = hostRef.current;
    if (!surface || !host || !loadedRef.current) return mappingRef.current;
    if (surface.busy) {
      owedRef.current = true;
      return mappingRef.current;
    }
    owedRef.current = false;
    const { page, frame, renderWindow } = placeRef.current;
    const rect = host.getBoundingClientRect();
    // Where the sheet is in its frame, read off the page itself: a natively
    // scrolled sheet has moved before the page's own pan catches up with it.
    const frameElement = frame ? host.closest<HTMLElement>("[data-notebook-page-frame]") : null;
    const frameRect = frameElement?.getBoundingClientRect() ?? null;
    const measured = inkSurfaceViewport({
      rect,
      page,
      devicePixelRatio: window.devicePixelRatio || 1,
      frame: frameRect
        ? {
            pageX: rect.left - frameRect.left,
            pageY: rect.top - frameRect.top,
            frameWidth: frameRect.width,
            frameHeight: frameRect.height,
          }
        : frame,
      window: renderWindow,
    });
    staleRef.current = measured === null;
    mappingRef.current = measured?.mapping ?? null;
    if (!measured) return null;
    surface.setViewport(measured.viewport);
    const ready = readyRef.current;
    if (!ready.waiting) {
      ready.waiting = true;
      ready.cancel = surface.whenVisibleDrawn(() => callbacksRef.current.onReady?.());
    }
    return measured.mapping;
  }, [callbacksRef, hostRef]);

  /** The mapping for a contact about to begin: measured once if the page may have moved. */
  const getMapping = useCallback((): InkScreenMapping | null => {
    if (staleRef.current || mappingRef.current === null) return measure();
    return mappingRef.current;
  }, [measure]);

  const peekMapping = useCallback(() => mappingRef.current, []);

  /** A contact has ended: take the measurement it made wait. */
  const settle = useCallback(() => {
    if (owedRef.current) measure();
  }, [measure]);

  // The page, or the part of it on screen, has moved.
  useLayoutEffect(() => {
    placeRef.current = {
      page: { width: pageWidth, height: pageHeight },
      frame: inkFrame,
      renderWindow: inkWindow,
    };
    staleRef.current = true;
    measure();
  }, [inkFrame, inkWindow, measure, pageHeight, pageWidth]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const readyState = { waiting: false, cancel: null as (() => void) | null };
    readyRef.current = readyState;
    loadedRef.current = false;
    mappingRef.current = null;
    staleRef.current = true;
    owedRef.current = false;
    const lifecycle = lifecycleRef.current;
    lifecycle?.reset();

    let surface: InkSurface | null = null;
    try {
      surface = createInkSurface(host, {
        page: { width: pageWidth, height: pageHeight },
        onChange: () => callbacksRef.current.onChange(),
        onHistoryChange: (undoDepth, redoDepth) => callbacksRef.current.onHistoryChange(undoDepth, redoDepth),
      });
      surfaceRef.current = surface;
      surface.load(initialSvgRef.current);
      loadedRef.current = true;
      // The first viewport; `onReady` follows once its ink is drawn.
      measure();
    } catch (error) {
      console.error("Notebook ink editor failed to initialize.", error);
      callbacksRef.current.onReadyError?.(error);
    }

    return () => {
      readyState.cancel?.();
      loadedRef.current = false;
      surfaceRef.current = null;
      mappingRef.current = null;
      staleRef.current = true;
      owedRef.current = false;
      lifecycle?.reset();
      reportInteraction(false);
      surface?.destroy();
    };
  }, [callbacksRef, hostRef, lifecycleRef, measure, pageHeight, pageId, pageWidth, reportInteraction]);

  // A scroll anywhere moves the sheet; resizing the window can too. Both hold
  // the engine's background drawing while they last and measure once they stop.
  useEffect(() => {
    let timer = 0;
    let scrolling = false;
    const settleAfterQuiet = () => {
      timer = 0;
      if (scrolling) {
        scrolling = false;
        surfaceRef.current?.endGesture();
      }
      measure();
    };
    const wait = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settleAfterQuiet, SETTLE_MS);
    };
    const handleScroll = () => {
      staleRef.current = true;
      if (!scrolling) {
        scrolling = true;
        surfaceRef.current?.beginGesture();
      }
      wait();
    };
    const handleResize = () => {
      staleRef.current = true;
      wait();
    };
    // Capturing on the window hears every scroller on the page, not just the
    // document, since scroll events do not bubble.
    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("scroll", handleScroll, scrollOptions);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", handleScroll, scrollOptions);
      window.removeEventListener("resize", handleResize);
      window.clearTimeout(timer);
    };
  }, [measure]);

  return useMemo(
    () => ({ surfaceRef, loadedRef, getMapping, measureNow: measure, peekMapping, settle }),
    [getMapping, measure, peekMapping, settle]
  );
}

export type JamiInkSurfaceEngine = ReturnType<typeof useJamiInkSurface>;
