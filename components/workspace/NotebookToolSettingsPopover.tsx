"use client";

import InkColorPicker from "@/components/workspace/NotebookInkColorPicker";
import { NOTEBOOK_TOOL_SETTINGS_ID } from "@/components/workspace/NotebookDrawingToolbar";
import type { NotebookToolMenu } from "@/lib/workspace/notebook-toolbar";
import NotebookPenAdvancedSettings from "@/components/workspace/NotebookPenAdvancedSettings";
import SettingSwitch from "@/components/ui/SettingSwitch";
import SmoothingSlider from "@/components/workspace/NotebookSmoothingSlider";
import ThicknessSlider from "@/components/workspace/NotebookThicknessSlider";
import { NotebookIcon } from "@/components/workspace/NotebookToolbarIconButton";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";
import { getNotebookStrokePaintColor } from "@/lib/workspace/notebook-page-content";
import type {
  NotebookEraserMode,
  NotebookEraserSize,
} from "@/lib/workspace/notebook-eraser";
import {
  getHighlighterWidthFromPercent,
  getPenWidthFromPercent,
} from "@/lib/workspace/notebook-inking";
import type { NotebookPenSettings } from "@/lib/workspace/notebook-pen-feel";
import type { NotebookToolbarDock } from "@/lib/workspace/notebook-toolbar";

/**
 * Where the panel hangs, by where the toolbar is: `top-bar` for the notebook's
 * toolbar in its top bar, just under the bar; `top` under a toolbar floating
 * at the top of its frame, as the exam working sheet's does.
 */
export type NotebookToolSettingsPlacement = NotebookToolbarDock | "top-bar";

const DOCK_CLASS: Record<NotebookToolSettingsPlacement, string> = {
  "top-bar": "left-1/2 top-3 -translate-x-1/2",
  top: "left-1/2 top-[4.85rem] -translate-x-1/2",
  right:
    "right-[calc(env(safe-area-inset-right,0px)+4.85rem)] top-1/2 -translate-y-1/2",
  bottom:
    "bottom-[calc(var(--notebook-control-bottom-inset)+3.95rem)] left-1/2 -translate-x-1/2",
  left:
    "left-[calc(env(safe-area-inset-left,0px)+4.85rem)] top-1/2 -translate-y-1/2",
};

const ERASER_DOT_SIZE: Record<NotebookEraserSize, string> = {
  small: "0.7rem",
  medium: "1rem",
  large: "1.35rem",
};

export type NotebookToolSettingsPopoverProps = {
  /** Which toolbar edge the popover hangs off. */
  dock: NotebookToolSettingsPlacement;
  /** The toolbar and this panel always agree on which tool is showing. */
  openMenu: NotebookToolMenu;
  pen: {
    color: NotebookStrokeColor;
    thicknessPercent: number;
    onColorChange: (color: NotebookStrokeColor) => void;
    onThicknessChange: (percent: number) => void;
    settings: NotebookPenSettings;
    onSettingsChange: (settings: NotebookPenSettings) => void;
    scribbleToErase: boolean;
    onScribbleToEraseChange: (enabled: boolean) => void;
  };
  highlighter: {
    color: NotebookStrokeColor;
    thicknessPercent: number;
    onColorChange: (color: NotebookStrokeColor) => void;
    onThicknessChange: (percent: number) => void;
  };
  eraser: {
    mode: NotebookEraserMode;
    size: NotebookEraserSize;
    onModeChange: (mode: NotebookEraserMode) => void;
    onSizeChange: (size: NotebookEraserSize) => void;
    canClearPage: boolean;
    onClearPage: () => void;
  };
};

/**
 * The settings panel behind the pen, highlighter, and eraser toolbar buttons.
 *
 * Only one tool's settings are ever shown, so the three sections share a single
 * docked surface rather than each carrying its own popover.
 */
export default function NotebookToolSettingsPopover({
  dock,
  openMenu,
  pen,
  highlighter,
  eraser,
}: NotebookToolSettingsPopoverProps) {
  // The Insert menu is the toolbar's own, and opens beside its button.
  if (!openMenu || openMenu === "insert") return null;

  return (
    <div
      id={NOTEBOOK_TOOL_SETTINGS_ID}
      role="group"
      aria-label={`${openMenu} settings`}
      className={`notebook-toolbar-popover-in notebook-drawer-surface absolute z-50 w-[min(92vw,22rem)] rounded-lg border border-[var(--color-border)] p-3.5 shadow-e2 ${DOCK_CLASS[dock]}`}
    >
      {openMenu === "pen" ? (
        <div className="space-y-3">
          <InkColorPicker
            label="Pen color"
            value={pen.color}
            presets={["black", "white", "red", "green"]}
            getPresetColor={(color) => getNotebookStrokePaintColor(color, "pen")}
            onPresetSelect={pen.onColorChange}
            onCustomColorChange={pen.onColorChange}
          />
          <ThicknessSlider
            label="Pen thickness"
            percent={pen.thicknessPercent}
            color={getNotebookStrokePaintColor(pen.color, "pen")}
            previewWidth={getPenWidthFromPercent(pen.thicknessPercent)}
            onChange={pen.onThicknessChange}
          />
          <SmoothingSlider
            percent={pen.settings.smoothingPercent}
            onChange={(smoothingPercent) =>
              pen.onSettingsChange({ ...pen.settings, smoothingPercent })
            }
          />
          <NotebookPenAdvancedSettings
            settings={pen.settings}
            onChange={pen.onSettingsChange}
          />
          <div className="border-t border-[var(--color-border)] pt-3">
            <SettingSwitch
              density="compact"
              label="Scribble to erase"
              description="Scribble back and forth over writing to delete it"
              checked={pen.scribbleToErase}
              onChange={pen.onScribbleToEraseChange}
            />
          </div>
        </div>
      ) : null}

      {openMenu === "highlighter" ? (
        <div className="space-y-3">
          <InkColorPicker
            label="Highlighter color"
            value={highlighter.color}
            presets={["yellow", "green", "pink"]}
            getPresetColor={(color) =>
              getNotebookStrokePaintColor(color, "highlighter")
            }
            onPresetSelect={highlighter.onColorChange}
            onCustomColorChange={highlighter.onColorChange}
          />
          <ThicknessSlider
            label="Highlighter thickness"
            percent={highlighter.thicknessPercent}
            color={getNotebookStrokePaintColor(highlighter.color, "highlighter")}
            // Halved so the swatch reads as a nib rather than a filled bar.
            previewWidth={
              getHighlighterWidthFromPercent(highlighter.thicknessPercent) / 2
            }
            onChange={highlighter.onThicknessChange}
          />
        </div>
      ) : null}

      {openMenu === "eraser" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-xs font-semibold text-text-secondary">
              Eraser mode
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["precision", "stroke"] as NotebookEraserMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-label={`${mode} eraser mode`}
                  onClick={() => eraser.onModeChange(mode)}
                  className={`min-h-11 rounded-full border px-3 py-2 text-xs font-semibold capitalize transition ${
                    eraser.mode === mode ? "app-selected" : "app-chip"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-text-secondary">
              Eraser size
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(["small", "medium", "large"] as NotebookEraserSize[]).map(
                (size) => (
                  <button
                    key={size}
                    type="button"
                    aria-label={`${size} eraser`}
                    title={`${size[0].toUpperCase()}${size.slice(1)} eraser`}
                    onClick={() => eraser.onSizeChange(size)}
                    className={`grid h-11 place-items-center rounded-full border transition ${
                      eraser.size === size ? "app-selected" : "app-chip"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="rounded-full border-2 border-current"
                      style={{
                        width: ERASER_DOT_SIZE[size],
                        height: ERASER_DOT_SIZE[size],
                      }}
                    />
                  </button>
                )
              )}
            </div>
          </div>
          <div className="border-t border-[var(--color-border)] pt-2 sm:col-span-2">
            <button
              type="button"
              disabled={!eraser.canClearPage}
              onClick={eraser.onClearPage}
              className="inline-flex min-h-[2.25rem] w-full items-center justify-center gap-1.5 rounded-full px-3 text-xs font-semibold text-[var(--color-error-text)] transition hover:bg-[var(--color-error-text)]/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <NotebookIcon name="trash" />
              Clear ink from this page
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
