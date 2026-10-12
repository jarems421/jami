import type { NotebookEraserMode } from "@/lib/workspace/notebook-eraser";
import type { NotebookPenSettings } from "@/lib/workspace/notebook-pen-feel";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";

export type NotebookStrokeTool = "pen" | "eraser" | "highlighter";

export type NotebookInkTool =
  | "pen"
  | "highlighter"
  | "eraser"
  | "select"
  | "text"
  | "lasso";

/** Everything about the ink editor that a style application depends on. */
export type NotebookInkStyle = {
  activeTool: NotebookInkTool;
  eraserMode: NotebookEraserMode;
  eraserThickness: number;
  highlighterColor: NotebookStrokeColor;
  highlighterThickness: number;
  penColor: NotebookStrokeColor;
  penThickness: number;
  /**
   * How the pen shapes and filters the line. See `notebook-pen-feel.ts`.
   *
   * The whole settings object rather than the one Smoothing number, because
   * every field in it changes what the next stroke looks like, and so has to
   * reach the stroke factory the way Smoothing always did.
   */
  penSettings: NotebookPenSettings;
};
