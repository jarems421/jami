"use client";

import {
  memo,
  forwardRef,
  type PointerEventHandler,
  type ReactNode,
  type Ref,
  type TransitionEventHandler,
} from "react";
import { PAGE_EDGE_CLASS } from "@/components/workspace/NotebookPageBackground";
import type { NotebookViewportGeometry, NotebookViewportScroll } from "@/lib/workspace/notebook-viewport";

export type { NotebookViewportGeometry };

export type NotebookViewportPreview = {
  className: string;
  content: ReactNode;
  key: string;
};

type NotebookSheetProps = {
  children: ReactNode;
  className: string;
  dataNotebookPageSurface?: boolean;
  dataNotebookSlot: "active" | "next" | "previous";
  geometry: NotebookViewportGeometry;
  offsetX?: number;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
};

/**
 * Everything about the sheet edge except its colour, which belongs to the page
 * rather than to the sheet -- see `PAGE_COLOR_CLASS`. Naming a colour here as
 * well would leave two utilities of equal weight fighting over the same
 * property, settled by whichever Tailwind happened to emit last.
 *
 * Clipped with `overflow: clip`, not `hidden`: a sheet clipped by `hidden` is
 * a scroll container of its own, and a finger on it scrolled nothing -- Chrome
 * handed the pan to the sheet, which cannot scroll, instead of the scroller
 * around it that pans a zoomed page natively. `clip` clips the same, rounded
 * corners included, without being one.
 */
const NOTEBOOK_SHEET_BASE_CLASS = `overflow-clip rounded-sm shadow-none ${PAGE_EDGE_CLASS}`;

function getSheetStyle(
  geometry: NotebookViewportGeometry,
  offsetX = 0
) {
  return {
    width: `${geometry.pageWidth}px`,
    height: `${geometry.pageHeight}px`,
    transform: `translate3d(${geometry.pageX + offsetX}px, ${
      geometry.pageY
    }px, 0)`,
  };
}

const NotebookSheet = forwardRef<HTMLDivElement, NotebookSheetProps>(
  function NotebookSheet(
    {
      children,
      className,
      dataNotebookPageSurface = false,
      dataNotebookSlot,
      geometry,
      offsetX = 0,
      onPointerCancel,
      onPointerMove,
      onPointerUp,
    },
    ref
  ) {
    return (
      <div
        ref={ref}
        data-notebook-page-surface={
          dataNotebookPageSurface ? "true" : undefined
        }
        data-notebook-sheet="true"
        data-notebook-slot={dataNotebookSlot}
        className={`absolute left-0 top-0 ${NOTEBOOK_SHEET_BASE_CLASS} ${className}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={getSheetStyle(geometry, offsetX)}
      >
        {children}
      </div>
    );
  }
);

type Props = {
  activeClassName: string;
  activeContent: ReactNode | null;
  activeRef: Ref<HTMLDivElement>;
  frameRef: Ref<HTMLDivElement>;
  geometry: NotebookViewportGeometry;
  nextPreview?: NotebookViewportPreview | null;
  onActivePointerCancel: PointerEventHandler<HTMLDivElement>;
  onActivePointerMove: PointerEventHandler<HTMLDivElement>;
  onActivePointerUp: PointerEventHandler<HTMLDivElement>;
  /** A tap anywhere in the frame, including the margin around the sheet. */
  onFramePointerDown?: PointerEventHandler<HTMLDivElement>;
  onTrackTransitionCancel: TransitionEventHandler<HTMLDivElement>;
  onTrackTransitionEnd: TransitionEventHandler<HTMLDivElement>;
  overlay?: ReactNode;
  previewLayerRef: Ref<HTMLDivElement>;
  previousPreview?: NotebookViewportPreview | null;
  /**
   * The scroll area a zoomed sheet pans in with the browser's own scrolling,
   * or null (at fit, or with `enableNotebookNativeScroll` off) for a sheet
   * the gesture handlers move.
   */
  scroll?: NotebookViewportScroll | null;
  scrollerRef?: Ref<HTMLDivElement>;
  trackRef: Ref<HTMLDivElement>;
};

function NotebookViewport({
  activeClassName,
  activeContent,
  activeRef,
  frameRef,
  geometry,
  nextPreview,
  onActivePointerCancel,
  onActivePointerMove,
  onActivePointerUp,
  onFramePointerDown,
  onTrackTransitionCancel,
  onTrackTransitionEnd,
  overlay,
  previewLayerRef,
  previousPreview,
  scroll = null,
  scrollerRef,
  trackRef,
}: Props) {
  return (
    <div
      ref={frameRef}
      data-notebook-page-frame
      data-notebook-native-scroll={scroll ? "true" : undefined}
      /*
       * The page fills its frame.
       *
       * This was inset by env(safe-area-inset-bottom) at the bottom, which left
       * a strip below the page on any iPad with a home indicator that the sheet
       * could not reach, and by the same value at the top, which is a different
       * edge needing a different inset -- the header already handles the top, so
       * that one only cost height. Together they took roughly 40 to 48px off the
       * drawing surface.
       *
       * Nothing needs the frame to hold that space. The toolbar and the page
       * navigation are positioned against --notebook-control-bottom-inset, which
       * accounts for the safe area itself, so they stay clear of the indicator
       * whatever the sheet does.
       */
      className="absolute inset-0 isolate overflow-hidden"
      onPointerDown={onFramePointerDown}
    >
      {overlay}
      {/*
        What scrolls, when a zoomed sheet is panned natively: the frame stays
        put around it, so the overlay above stays where it is.
      */}
      <div
        ref={scrollerRef}
        data-notebook-scroller
        className={
          scroll
            ? "absolute inset-0 overflow-auto overscroll-contain scrollbar-hide"
            : "absolute inset-0 overflow-hidden"
        }
      >
        {activeContent !== null && geometry.pageWidth > 0 ? (
          <div
            ref={trackRef}
            className={`notebook-page-track absolute left-0 top-0 ${scroll ? "" : "h-full w-full"}`}
            style={scroll ? { width: `${scroll.width}px`, height: `${scroll.height}px` } : undefined}
            onTransitionEnd={onTrackTransitionEnd}
            onTransitionCancel={onTrackTransitionCancel}
          >
            <div
              ref={previewLayerRef}
              aria-hidden="true"
              className="invisible pointer-events-none absolute inset-0"
            >
              {previousPreview ? (
                <NotebookSheet
                  key={previousPreview.key}
                  className={`notebook-page-swipe-preview ${previousPreview.className}`}
                  dataNotebookSlot="previous"
                  geometry={geometry}
                  offsetX={-geometry.swipeTravel}
                >
                  {previousPreview.content}
                </NotebookSheet>
              ) : null}
              {nextPreview ? (
                <NotebookSheet
                  key={nextPreview.key}
                  className={`notebook-page-swipe-preview ${nextPreview.className}`}
                  dataNotebookSlot="next"
                  geometry={geometry}
                  offsetX={geometry.swipeTravel}
                >
                  {nextPreview.content}
                </NotebookSheet>
              ) : null}
            </div>
            <NotebookSheet
              ref={activeRef}
              className={`notebook-page-surface ${activeClassName}`}
              dataNotebookPageSurface
              dataNotebookSlot="active"
              geometry={geometry}
              onPointerMove={onActivePointerMove}
              onPointerUp={onActivePointerUp}
              onPointerCancel={onActivePointerCancel}
            >
              {activeContent}
            </NotebookSheet>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { NOTEBOOK_SHEET_BASE_CLASS };

/**
 * Memoised: this subtree sits under the stylus and its props are now
 * stable, so a parent render no longer forces it to re-render.
 */
export default memo(NotebookViewport);
