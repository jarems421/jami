"use client";

import { memo } from "react";
import AiResponse from "@/components/ai/AiResponse";
import NotebookGraphLayer from "@/components/workspace/NotebookGraphLayer";
import NotebookImageLayer from "@/components/workspace/NotebookImageLayer";
import NotebookPageBackground from "@/components/workspace/NotebookPageBackground";
import type {
  Notebook,
  NotebookFile,
  NotebookPage,
} from "@/lib/workspace/notebooks";
import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
} from "@/lib/workspace/notebooks";
import { legacyStrokesToJsDrawSvg, notebookInkSvg } from "@/lib/workspace/notebook-ink-data";
import { normalizeNotebookStrokes } from "@/lib/workspace/notebook-page-content";
import { pageHasSavedInk } from "@/lib/workspace/notebook-page-ink-split";
import { getNotebookPaperPalette } from "@/lib/workspace/notebook-paper-palette";
import {
  NOTEBOOK_TEXT_LAYER_ATTRIBUTE,
  NOTEBOOK_TEXT_LAYER_STYLE,
  getNotebookTextBlockBodyHeight,
  getNotebookTextBlockStyle,
} from "@/lib/workspace/notebook-text-metrics";

// Full-size, non-interactive render of a page's saved content (style, background
// file, ink SVG, text blocks). Used as the swipe preview so the real adjacent
// page is visible while dragging, instead of a blank placeholder that only fills
// in after the editor remounts.
const NotebookPageStaticContent = memo(function NotebookPageStaticContent({
  page,
  notebook,
  backgroundFile,
  backgroundUrl,
}: {
  page: NotebookPage;
  notebook: Notebook | null;
  backgroundFile: NotebookFile | null;
  backgroundUrl?: string;
}) {
  const pageColor = page.pageColor ?? notebook?.pageColor ?? "white";
  const pageStyle = page.pageStyle ?? notebook?.pageStyle ?? "plain";
  const inkSvg =
    notebookInkSvg(page.inkData) ??
    legacyStrokesToJsDrawSvg(
      normalizeNotebookStrokes(page.strokeData?.strokes),
      NOTEBOOK_PAGE_COORDINATE_WIDTH,
      NOTEBOOK_PAGE_COORDINATE_HEIGHT
    );
  const hasInk = pageHasSavedInk(page);

  const isDarkPaper = getNotebookPaperPalette(pageColor).isDark;


  return (
    <>
      <NotebookPageBackground
        pageColor={pageColor}
        pageStyle={pageStyle}
        backgroundFile={backgroundFile}
        backgroundUrl={backgroundUrl}
        pageIndex={page.pdfPageIndex ?? 0}
        pdfLazy={false}
        pdfFadeIn={false}
        // Seen only mid-swipe, and both neighbours are held alongside the page
        // being written on: at full resolution a PDF notebook kept three 24 MB
        // canvases under the ink, where a blank notebook keeps none.
        pdfMaxPixelRatio={1.25}
        inkSvg={hasInk ? inkSvg : undefined}
        inkSizes="48rem"
        inkClassName="pointer-events-none absolute inset-0 z-[12] object-fill"
      />
      <NotebookImageLayer images={page.imageRefs} />
      <NotebookGraphLayer graphs={page.graphBlocks} />
      {/*
        The same layer, type and stacking as the live page, so a page being
        swiped in shows its text exactly where it will land -- above the ink,
        as it is once the page is open.
      */}
      <div
        {...{ [NOTEBOOK_TEXT_LAYER_ATTRIBUTE]: "true" }}
        className="pointer-events-none absolute inset-0 z-30"
        style={NOTEBOOK_TEXT_LAYER_STYLE}
      >
        {page.textBlocks.map((block) => (
          <div
            key={block.id}
            aria-hidden="true"
            className={`absolute rounded-sm border bg-transparent ${
              block.outlineVisible
                ? isDarkPaper
                  ? "border-white/30"
                  : "border-slate-950/25"
                : "border-transparent"
            }`}
            style={{
              left: `${(block.x / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
              top: `${(block.y / NOTEBOOK_PAGE_COORDINATE_HEIGHT) * 100}%`,
              width: `${(block.width / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
            }}
          >
            {block.format === "markdown" ? (
              <div
                className={`w-full break-words rounded-sm ${
                  isDarkPaper ? "text-[#f8fafc]" : "text-slate-950"
                }`}
                style={{
                  ...getNotebookTextBlockStyle(block),
                  minHeight: getNotebookTextBlockBodyHeight(block),
                }}
              >
                <AiResponse content={block.text} variant="page" />
              </div>
            ) : (
              <div
                className={`w-full whitespace-pre-wrap break-words rounded-sm font-medium ${
                  isDarkPaper ? "text-[#f8fafc]" : "text-slate-950"
                }`}
                style={{
                  ...getNotebookTextBlockStyle(block),
                  minHeight: getNotebookTextBlockBodyHeight(block),
                }}
              >
                {block.text}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
});

export default NotebookPageStaticContent;
