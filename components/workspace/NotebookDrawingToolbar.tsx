"use client";

import { memo, type ComponentPropsWithoutRef, type Ref } from "react";
import NotebookToolbarInsertMenu from "@/components/workspace/NotebookToolbarInsertMenu";
import ToolbarIconButton from "@/components/workspace/NotebookToolbarIconButton";
import { getNotebookStrokePaintColor } from "@/lib/workspace/notebook-page-content";
import {
  isNotebookToolbarSideDock,
  type NotebookToolbarDock,
  type NotebookToolMenu,
} from "@/lib/workspace/notebook-toolbar";
import type { NotebookStrokeColor } from "@/lib/workspace/notebooks";
import type { NotebookEditorTool } from "@/lib/workspace/notebook-page-state";

export const NOTEBOOK_TOOL_SETTINGS_ID = "notebook-tool-settings";

/**
 * Where the toolbar floats, for the docks over the page. Side docks respect
 * the device safe-area inset. The top dock is no float: the toolbar sits in
 * the notebook's top bar (`NotebookEditorHeader`), clear of the page.
 */
const FLOATING_DOCK_CLASS: Record<Exclude<NotebookToolbarDock, "top">, string> = {
  right:
    "right-[calc(env(safe-area-inset-right,0px)+0.9rem)] top-1/2 -translate-y-1/2",
  bottom:
    "bottom-[var(--notebook-control-bottom-inset)] left-1/2 -translate-x-1/2",
  left:
    "left-[calc(env(safe-area-inset-left,0px)+0.9rem)] top-1/2 -translate-y-1/2",
};

export type NotebookDrawingToolbarProps = {
  dock: NotebookToolbarDock;
  toolbarRef: Ref<HTMLDivElement>;
  /** Drag bindings from the docking controller. */
  dockBindings: ComponentPropsWithoutRef<"div">;
  tool: NotebookEditorTool;
  penColor: NotebookStrokeColor;
  highlighterColor: NotebookStrokeColor;
  openMenu: NotebookToolMenu;
  /**
   * A drawing tool button was pressed. Selecting an inactive tool switches to
   * it; pressing the active one toggles its options popover.
   */
  onSelectDrawingTool: (tool: "pen" | "highlighter" | "eraser") => void;
  /** The text box or the lasso: picked up, or put down when it is in hand. */
  onToggleTool: (tool: "text" | "lasso") => void;
  onToggleInsertMenu: () => void;
  rulerShown: boolean;
  onToggleRuler: () => void;
  /** A picture chosen from the device, to place on the current page. */
  onAddImage: (file: File) => void;
  addingImage: boolean;
  /** Opens the graph editor, to plot a new graph on the current page. */
  onAddGraph: () => void;
  undoDepth: number;
  redoDepth: number;
  onUndo: () => void;
  onRedo: () => void;
};

/** A colour bar under the pen and highlighter buttons. */
function ToolColorBar({
  color,
  tool,
}: {
  color: NotebookStrokeColor;
  tool: "pen" | "highlighter";
}) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-[0.35rem] left-1/2 h-[3px] w-4 -translate-x-1/2 rounded-full"
      style={{ backgroundColor: getNotebookStrokePaintColor(color, tool) }}
    />
  );
}

/**
 * The notebook's drawing tools: pen, highlighter, eraser, lasso, text, Insert (a
 * picture or a graph), the ruler, then undo and redo.
 *
 * At home in the top bar, where it never covers the page: a row of quiet
 * buttons, outlined only when picked, beside the title. Dragged out, it floats
 * over the page at its left, right or bottom edge as a pill, and dragged back
 * up it returns to the bar (`useNotebookToolbarDocking`).
 */
function NotebookDrawingToolbar({
  dock,
  toolbarRef,
  dockBindings,
  tool,
  penColor,
  highlighterColor,
  openMenu,
  onSelectDrawingTool,
  onToggleTool,
  onToggleInsertMenu,
  rulerShown,
  onToggleRuler,
  onAddImage,
  addingImage,
  onAddGraph,
  undoDepth,
  redoDepth,
  onUndo,
  onRedo,
}: NotebookDrawingToolbarProps) {
  const sideDock = isNotebookToolbarSideDock(dock);
  const inBar = dock === "top";

  return (
    <div className={inBar ? "relative" : `pointer-events-none absolute z-40 ${FLOATING_DOCK_CLASS[dock]}`}>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Drawing tools"
        aria-orientation={sideDock ? "vertical" : "horizontal"}
        title="Drag the toolbar to dock it to another edge"
        data-toolbar-dock={dock}
        {...dockBindings}
        // In the bar it is outlined, so it reads as something that can be
        // picked up and moved, and padded as it is floating, so the ring round
        // a pressed or focused tool is never cut off by the toolbar's paint
        // containment.
        className={`notebook-dockable-toolbar pointer-events-auto flex items-center rounded-full border ${
          inBar
            ? "flex-wrap justify-center gap-0.5 border-[var(--color-border)] p-1.5 data-[toolbar-dragging=true]:bg-[var(--color-surface-panel-strong)] data-[toolbar-dragging=true]:shadow-e2"
            : "notebook-floating-control gap-1 border-[var(--color-border)] p-1.5"
        } ${
          sideDock ? "flex-col" : "flex-row"
        } cursor-grab data-[toolbar-dragging=true]:cursor-grabbing data-[toolbar-dragging=true]:border-[var(--color-border-strong)]`}
      >
        <div className="relative">
          <ToolbarIconButton
            label="Pen (P)"
            icon="pen"
            tutorialTarget="pen"
            quiet={inBar}
            active={tool === "pen" || openMenu === "pen"}
            expanded={openMenu === "pen"}
            controls={NOTEBOOK_TOOL_SETTINGS_ID}
            onClick={() => onSelectDrawingTool("pen")}
          >
            <ToolColorBar color={penColor} tool="pen" />
          </ToolbarIconButton>
        </div>
        <div className="relative">
          <ToolbarIconButton
            label="Highlighter (H)"
            icon="highlighter"
            quiet={inBar}
            active={tool === "highlighter" || openMenu === "highlighter"}
            expanded={openMenu === "highlighter"}
            controls={NOTEBOOK_TOOL_SETTINGS_ID}
            onClick={() => onSelectDrawingTool("highlighter")}
          >
            <ToolColorBar color={highlighterColor} tool="highlighter" />
          </ToolbarIconButton>
        </div>
        <div className="relative">
          <ToolbarIconButton
            label="Eraser (E)"
            icon="eraser"
            quiet={inBar}
            active={tool === "eraser" || openMenu === "eraser"}
            expanded={openMenu === "eraser"}
            controls={NOTEBOOK_TOOL_SETTINGS_ID}
            onClick={() => onSelectDrawingTool("eraser")}
          />
        </div>
        <ToolbarIconButton
          label="Lasso (L)"
          icon="lasso"
          quiet={inBar}
          active={tool === "lasso"}
          onClick={() => onToggleTool("lasso")}
        />
        <ToolbarIconButton
          label="Text box (T)"
          icon="text"
          quiet={inBar}
          active={tool === "text"}
          onClick={() => onToggleTool("text")}
        />
        <NotebookToolbarInsertMenu
          dock={dock}
          open={openMenu === "insert"}
          quiet={inBar}
          onToggle={onToggleInsertMenu}
          onAddImage={onAddImage}
          addingImage={addingImage}
          onAddGraph={onAddGraph}
        />
        <ToolbarIconButton
          label={rulerShown ? "Put the ruler away" : "Ruler"}
          icon="ruler"
          quiet={inBar}
          active={rulerShown}
          pressed={rulerShown}
          onClick={onToggleRuler}
        />
        <span
          aria-hidden="true"
          className={`shrink-0 rounded-full bg-[var(--color-border)] ${
            sideDock ? "my-0.5 h-px w-6" : "mx-0.5 h-6 w-px"
          }`}
        />
        <ToolbarIconButton
          label="Undo (Ctrl+Z)"
          icon="undo"
          quiet={inBar}
          disabled={undoDepth === 0}
          onClick={onUndo}
        />
        <ToolbarIconButton
          label="Redo (Ctrl+Shift+Z)"
          icon="redo"
          quiet={inBar}
          disabled={redoDepth === 0}
          onClick={onRedo}
        />
      </div>
    </div>
  );
}

export { NotebookDrawingToolbar };

/**
 * Memoised: this sits over the page surface, so a render caused by ink or
 * autosave should not walk the toolbar as well.
 */
export default memo(NotebookDrawingToolbar);
