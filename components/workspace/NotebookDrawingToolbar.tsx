"use client";

import { memo, useRef, type ComponentPropsWithoutRef, type Ref } from "react";
import { NOTEBOOK_PAGE_IMAGE_TYPES } from "@/lib/workspace/notebook-page-image-upload";
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

/** Position per dock edge. Side docks respect the device safe-area inset. */
const DOCK_CLASS: Record<NotebookToolbarDock, string> = {
  top: "left-1/2 top-[0.9rem] -translate-x-1/2",
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
  onToggleTextTool: () => void;
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

function NotebookDrawingToolbar({
  dock,
  toolbarRef,
  dockBindings,
  tool,
  penColor,
  highlighterColor,
  openMenu,
  onSelectDrawingTool,
  onToggleTextTool,
  onAddImage,
  addingImage,
  onAddGraph,
  undoDepth,
  redoDepth,
  onUndo,
  onRedo,
}: NotebookDrawingToolbarProps) {
  const sideDock = isNotebookToolbarSideDock(dock);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className={`pointer-events-none absolute z-40 ${DOCK_CLASS[dock]}`}>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Drawing tools"
        aria-orientation={sideDock ? "vertical" : "horizontal"}
        title="Drag the toolbar to dock it to another edge"
        data-toolbar-dock={dock}
        {...dockBindings}
        className={`notebook-dockable-toolbar notebook-floating-control pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--color-border)] p-1.5 ${
          sideDock ? "flex-col" : "flex-row"
        } cursor-grab data-[toolbar-dragging=true]:cursor-grabbing data-[toolbar-dragging=true]:border-[var(--color-border-strong)]`}
      >
        <div className="relative">
          <ToolbarIconButton
            label="Pen (P)"
            icon="pen"
            tutorialTarget="pen"
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
            active={tool === "eraser" || openMenu === "eraser"}
            expanded={openMenu === "eraser"}
            controls={NOTEBOOK_TOOL_SETTINGS_ID}
            onClick={() => onSelectDrawingTool("eraser")}
          />
        </div>
        <ToolbarIconButton
          label="Text box (T)"
          icon="text"
          active={tool === "text"}
          onClick={onToggleTextTool}
        />

        <ToolbarIconButton
          label={addingImage ? "Adding image…" : "Add image"}
          icon="image"
          disabled={addingImage}
          onClick={() => imageInputRef.current?.click()}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept={NOTEBOOK_PAGE_IMAGE_TYPES.join(",")}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file again still fires a change.
            event.target.value = "";
            if (file) onAddImage(file);
          }}
        />
        <ToolbarIconButton label="Add graph" icon="graph" onClick={onAddGraph} />
        <span
          aria-hidden="true"
          className={`shrink-0 rounded-full bg-[var(--color-border)] ${
            sideDock ? "my-0.5 h-px w-6" : "mx-0.5 h-6 w-px"
          }`}
        />
        <ToolbarIconButton
          label="Undo (Ctrl+Z)"
          icon="undo"
          disabled={undoDepth === 0}
          onClick={onUndo}
        />
        <ToolbarIconButton
          label="Redo (Ctrl+Shift+Z)"
          icon="redo"
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
