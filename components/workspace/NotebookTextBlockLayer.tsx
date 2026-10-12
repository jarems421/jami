"use client";

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import AiResponse from "@/components/ai/AiResponse";
import NotebookTextBlockOptions from "@/components/workspace/NotebookTextBlockOptions";
import { NotebookIcon } from "@/components/workspace/NotebookToolbarIconButton";
import {
  getNotebookTextBlockTextLimit,
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
  type NotebookPageColor,
  type NotebookTextBlock,
  type NotebookTextBlockResizeEdge,
} from "@/lib/workspace/notebooks";
import { getNotebookPaperPalette } from "@/lib/workspace/notebook-paper-palette";
import {
  NOTEBOOK_TEXT_BODY_ATTRIBUTE,
  NOTEBOOK_TEXT_LAYER_ATTRIBUTE,
  NOTEBOOK_TEXT_LAYER_STYLE,
  getNotebookTextBlockBodyHeight,
  getNotebookTextBlockFitHeight,
  getNotebookTextBlockStyle,
} from "@/lib/workspace/notebook-text-metrics";

const TEXT_COLOR_CLASS: Record<NotebookPageColor, string> = {
  white: "text-slate-950 placeholder:text-slate-400",
  cream: "text-[#2a2318] placeholder:text-[#8a7d63]",
  black: "text-[#f8fafc] placeholder:text-slate-500",
};

// Each edge keeps a generous 32px invisible hit area, but the visible
// affordance is a slim grip bar sitting on the border, not a bubble.
const RESIZE_HANDLES: Array<{
  edge: NotebookTextBlockResizeEdge;
  label: string;
  positionClass: string;
  gripClass: string;
}> = [
  {
    edge: "top",
    label: "Resize text box from top edge",
    positionClass: "left-1/2 top-0 h-8 w-8 -translate-x-1/2 -translate-y-1/2",
    gripClass: "h-[3px] w-4",
  },
  {
    edge: "right",
    label: "Resize text box from right edge",
    positionClass: "right-0 top-1/2 h-8 w-8 -translate-y-1/2 translate-x-1/2",
    gripClass: "h-4 w-[3px]",
  },
  {
    edge: "bottom",
    label: "Resize text box from bottom edge",
    positionClass: "bottom-0 left-1/2 h-8 w-8 -translate-x-1/2 translate-y-1/2",
    gripClass: "h-[3px] w-4",
  },
  {
    edge: "left",
    label: "Resize text box from left edge",
    positionClass: "left-0 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2",
    gripClass: "h-4 w-[3px]",
  },
];

export type NotebookTextBlockLayerProps = {
  textBlocks: NotebookTextBlock[];
  pageColor: NotebookPageColor;
  editingEnabled: boolean;
  selectedTextBlockId: string | null;
  editingTextBlockId: string | null;
  /** Block currently being dragged or resized; its chrome is hidden. */
  activeTextGestureId: string | null;
  openTextBlockOptionsId: string | null;
  onPointerDown: (block: NotebookTextBlock, event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (block: NotebookTextBlock, event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (block: NotebookTextBlock, event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (block: NotebookTextBlock, event: ReactPointerEvent<HTMLElement>) => void;
  onSelect: (blockId: string) => void;
  onSetOptionsOpen: (blockId: string, open: boolean) => void;
  onToggleOutline: (blockId: string) => void;
  onDelete: (blockId: string) => void;
  onOptionsKeyDown: (
    blockId: string,
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => void;
  onStartResize: (
    block: NotebookTextBlock,
    edge: NotebookTextBlockResizeEdge,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
  onResize: (event: ReactPointerEvent<HTMLElement>) => void;
  onStopResize: (event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * The move handle was pressed. A box being typed in has no body left to
   * drag -- the text area has it all -- so this is how it is moved.
   */
  onStartMove?: (
    block: NotebookTextBlock,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
  onChangeText: (blockId: string, text: string) => void;
  /** The box needs to be this tall, in page units, to show all its text. */
  onFitHeight?: (blockId: string, height: number) => void;
  onStopEditing: () => void;
};

/** Near enough the top that nothing fits above the box, in page units. */
const OPTIONS_TRIGGER_CLEARANCE = 80;

function NotebookTextEditor({
  block,
  pageColor,
  onSelect,
  onChangeText,
  onFitHeight,
  onStopEditing,
}: {
  block: NotebookTextBlock;
  pageColor: NotebookPageColor;
  onSelect: (blockId: string) => void;
  onChangeText: (blockId: string, text: string) => void;
  onFitHeight?: (blockId: string, height: number) => void;
  onStopEditing: () => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Focus without scrolling: the page is positioned by its own pan, and a
    // browser scrolling the caret into view would shift it under the hand.
    editor.focus({ preventScroll: true });
    // Resume at the end of what is there, not at the start of it.
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
  }, []);

  /*
   * The box grows to hold what is typed, rather than hiding it.
   *
   * Measured before paint, so a new line never flickers through a scrollbar
   * on its way to a taller box. The stored height is what grows, so every
   * device -- and the page image Tutor reads -- shows the whole of it too.
   */
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || !onFitHeight) return;
    const layer = editor.closest(`[${NOTEBOOK_TEXT_LAYER_ATTRIBUTE}]`);
    const height = getNotebookTextBlockFitHeight({
      block,
      contentHeightPx: editor.scrollHeight,
      visibleHeightPx: editor.clientHeight,
      pageWidthPx: layer instanceof HTMLElement ? layer.clientWidth : 0,
    });
    if (height !== null) onFitHeight(block.id, height);
  }, [block, onFitHeight]);

  return (
    <textarea
      ref={editorRef}
      value={block.text}
      maxLength={getNotebookTextBlockTextLimit(block)}
      // The box beneath owns dragging; typing must not start one.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onStopEditing();
        }
      }}
      onFocus={() => onSelect(block.id)}
      onChange={(event) => onChangeText(block.id, event.target.value)}
      placeholder="Type here..."
      data-notebook-text-editor="true"
      style={{ ...getNotebookTextBlockStyle(block), height: getNotebookTextBlockBodyHeight(block) }}
      className={`notebook-text-editor block w-full resize-none overflow-y-auto break-words rounded-sm bg-transparent font-medium outline-none ${TEXT_COLOR_CLASS[pageColor]}`}
    />
  );
}

/**
 * A Tutor answer on the page, shown the way the Tutor showed it.
 *
 * Its tables, headings and maths only take their final size once KaTeX has
 * set them -- after the renderer's chunk arrives, after fonts load -- so the
 * box is fitted whenever the answer changes size, not once. It only ever
 * grows, like a typed box, and stops at the foot of the page.
 */
function NotebookMarkdownText({
  block,
  onFitHeight,
}: {
  block: NotebookTextBlock;
  onFitHeight?: (blockId: string, height: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef(block);
  const fitRef = useRef(onFitHeight);

  // Read by the observer, which outlives any one render.
  useLayoutEffect(() => {
    blockRef.current = block;
    fitRef.current = onFitHeight;
  });

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const holder = body?.parentElement;
    if (!body || !holder || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const current = blockRef.current;
      const layer = body.closest(`[${NOTEBOOK_TEXT_LAYER_ATTRIBUTE}]`);
      const pageWidthPx = layer instanceof HTMLElement ? layer.clientWidth : 0;
      if (!(pageWidthPx > 0) || !fitRef.current) return;
      const style = window.getComputedStyle(holder);
      const contentHeightPx =
        body.offsetHeight +
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0);
      const height = getNotebookTextBlockFitHeight({
        block: current,
        contentHeightPx,
        // What the stored height shows, less the border, as the text area does.
        visibleHeightPx:
          (current.height / NOTEBOOK_PAGE_COORDINATE_WIDTH) * pageWidthPx - 2,
        pageWidthPx,
      });
      if (height !== null) fitRef.current(current.id, height);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={bodyRef}
      {...{ [NOTEBOOK_TEXT_BODY_ATTRIBUTE]: "true" }}
      className="min-w-0 flex-1 break-words"
    >
      <AiResponse content={block.text} variant="page" />
    </div>
  );
}

/**
 * The typed text boxes floating above the ink surface.
 *
 * Positions are percentages of the fixed page coordinate space, so a box keeps
 * its place on the sheet at any zoom.
 */
function NotebookTextBlockLayer({
  textBlocks,
  pageColor,
  editingEnabled,
  selectedTextBlockId,
  editingTextBlockId,
  activeTextGestureId,
  openTextBlockOptionsId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onSelect,
  onSetOptionsOpen,
  onToggleOutline,
  onDelete,
  onOptionsKeyDown,
  onStartResize,
  onResize,
  onStopResize,
  onStartMove,
  onChangeText,
  onFitHeight,
  onStopEditing,
}: NotebookTextBlockLayerProps) {
  const onBlack = getNotebookPaperPalette(pageColor).isDark;
  const frameBorderClass = onBlack ? "border-white/55" : "border-slate-950/40";

  return (
    <div
      {...{ [NOTEBOOK_TEXT_LAYER_ATTRIBUTE]: "true" }}
      className="pointer-events-none absolute inset-0 z-30"
      style={NOTEBOOK_TEXT_LAYER_STYLE}
    >
      {textBlocks.map((block) => {
        const selected = selectedTextBlockId === block.id;
        const editing = editingTextBlockId === block.id;
        const gesturing = activeTextGestureId === block.id;
        const displayText = block.text.trim()
          ? block.text
          : selected
            ? "Tap again to type"
            : "";
        const idleBorderClass = block.outlineVisible
          ? onBlack
            ? "border-white/30"
            : "border-slate-950/25"
          : "border-transparent";
        const optionsOpen = openTextBlockOptionsId === block.id;
        // Flip the popover above the box when it sits low on the page.
        const optionsOpenAbove =
          block.y + block.height / 2 > NOTEBOOK_PAGE_COORDINATE_HEIGHT / 2;
        const optionsAlignFromLeft = block.x + block.width < 420;
        const chromeBelow = block.y < OPTIONS_TRIGGER_CLEARANCE;

        return (
          <div
            key={block.id}
            // What a lasso drag carries about (`NotebookLassoLayer`).
            data-notebook-placed={`text:${block.id}`}
            className={`notebook-text-object absolute rounded-sm border bg-transparent transition-[border-color,box-shadow] duration-150 ${
              editingEnabled ? "pointer-events-auto" : "pointer-events-none"
            } ${
              editing
                ? `cursor-text ${frameBorderClass} shadow-e0`
                : selected
                  ? `cursor-grab touch-none select-none ${frameBorderClass} active:cursor-grabbing`
                  : `cursor-grab touch-none select-none ${idleBorderClass} active:cursor-grabbing`
            }`}
            // No height: the text inside sets it, at least the stored height
            // and more if what is typed needs more.
            style={{
              left: `${(block.x / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
              top: `${(block.y / NOTEBOOK_PAGE_COORDINATE_HEIGHT) * 100}%`,
              width: `${(block.width / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
            }}
            onPointerDown={(event) => onPointerDown(block, event)}
            onPointerMove={(event) => onPointerMove(block, event)}
            onPointerUp={(event) => onPointerUp(block, event)}
            onPointerCancel={(event) => onPointerCancel(block, event)}
          >
            {selected && editingEnabled && !gesturing ? (
              <>
                <NotebookTextBlockOptions
                  blockId={block.id}
                  open={optionsOpen}
                  outlineVisible={block.outlineVisible}
                  openAbove={optionsOpenAbove}
                  alignFromLeft={optionsAlignFromLeft}
                  triggerBelow={chromeBelow}
                  onOpenChange={(open) => onSetOptionsOpen(block.id, open)}
                  onToggleOutline={() => onToggleOutline(block.id)}
                  onDelete={() => onDelete(block.id)}
                  onKeyDown={(event) => onOptionsKeyDown(block.id, event)}
                />
                {RESIZE_HANDLES.map((handle) => (
                  <button
                    key={handle.edge}
                    type="button"
                    data-text-resize-handle="true"
                    aria-label={handle.label}
                    title={handle.label}
                    className={`group absolute z-20 inline-grid touch-none place-items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-selected-border)] ${handle.positionClass}`}
                    onPointerDown={(event) =>
                      onStartResize(block, handle.edge, event)
                    }
                    onPointerMove={onResize}
                    onPointerUp={onStopResize}
                    onPointerCancel={onStopResize}
                  >
                    <span
                      aria-hidden="true"
                      className={`rounded-full shadow-e0 transition group-hover:scale-110 ${
                        onBlack ? "bg-white/75" : "bg-slate-950/55"
                      } ${handle.gripClass}`}
                    />
                  </button>
                ))}
              </>
            ) : null}

            {/*
              Kept through its own drag, unlike the rest of the chrome: it is
              what the pointer is holding, and unmounting it would drop the
              capture and strand the box mid-move.
            */}
            {selected && editingEnabled && onStartMove ? (
              <button
                type="button"
                aria-label="Move text box"
                title="Drag to move"
                data-text-block-move-handle="true"
                className={`absolute left-0 z-30 inline-grid h-7 w-7 cursor-move touch-none place-items-center rounded-sm border border-black/15 bg-black/60 text-[#f8fafc] shadow-sm backdrop-blur-sm transition hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f8fafc] [&_svg]:h-4 [&_svg]:w-4 ${
                  chromeBelow ? "top-full mt-1.5" : "bottom-full mb-1.5"
                }`}
                onPointerDown={(event) => onStartMove(block, event)}
                onClick={(event) => event.stopPropagation()}
              >
                <NotebookIcon name="move" />
              </button>
            ) : null}

            {editing && editingEnabled ? (
              <NotebookTextEditor
                block={block}
                pageColor={pageColor}
                onSelect={onSelect}
                onChangeText={onChangeText}
                onFitHeight={onFitHeight}
                onStopEditing={onStopEditing}
              />
            ) : block.format === "markdown" && block.text.trim() ? (
              /*
               * Not a button: an answer holds tables, figures and links, none
               * of which a button may contain. It is selected the same way.
               */
              <div
                role="button"
                tabIndex={0}
                aria-label={`Select Tutor answer: ${block.text.slice(0, 80)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(block.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(block.id);
                }}
                style={{
                  ...getNotebookTextBlockStyle(block),
                  minHeight: getNotebookTextBlockBodyHeight(block),
                }}
                className={`flex w-full items-start rounded-sm text-left font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-selected-border)] ${
                  onBlack ? "text-[#f8fafc]" : "text-slate-950"
                }`}
              >
                <NotebookMarkdownText block={block} onFitHeight={onFitHeight} />
              </div>
            ) : (
              <button
                type="button"
                aria-label={
                  block.text.trim()
                    ? `Select text box: ${block.text.slice(0, 80)}`
                    : "Select empty text box"
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(block.id);
                }}
                // Laid out exactly as the text area it turns into, so tapping
                // in to type moves no words: same type, same padding, and
                // top-aligned, where a button would otherwise centre its text.
                style={{
                  ...getNotebookTextBlockStyle(block),
                  minHeight: getNotebookTextBlockBodyHeight(block),
                }}
                className={`flex w-full items-start rounded-sm border-0 bg-transparent text-left font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-selected-border)] ${
                  onBlack ? "text-[#f8fafc]" : "text-slate-950"
                } ${block.text.trim() ? "" : "opacity-60"}`}
              >
                <span
                  {...{ [NOTEBOOK_TEXT_BODY_ATTRIBUTE]: "true" }}
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words"
                >
                  {displayText}
                </span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { NotebookTextBlockLayer };

export default memo(NotebookTextBlockLayer);
