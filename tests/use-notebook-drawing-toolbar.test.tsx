// @vitest-environment jsdom

import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNotebookDrawingToolbar } from "@/hooks/useNotebookDrawingToolbar";

type Toolbar = ReturnType<typeof useNotebookDrawingToolbar>;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function renderToolbar(handlers: { closeMenus: () => void; undo: () => void; redo: () => void }) {
  let seen: Toolbar | null = null;
  const report = (toolbar: Toolbar) => {
    seen = toolbar;
  };
  function Harness() {
    const frameRef = useRef<HTMLDivElement | null>(null);
    const toolbar = useNotebookDrawingToolbar({
      frameRef,
      frameSize: { width: 800, height: 600 },
      ...handlers,
      tool: "pen",
      penColor: "black",
      highlighterColor: "yellow",
      openMenu: "pen",
      onSelectDrawingTool: () => undefined,
      onToggleTextTool: () => undefined,
      onAddImage: () => undefined,
      addingImage: false,
      onAddGraph: () => undefined,
      undoDepth: 2,
      redoDepth: 1,
    });
    useLayoutEffect(() => report(toolbar));
    return <div ref={frameRef} />;
  }
  const host = document.createElement("div");
  root = createRoot(host);
  act(() => root!.render(<Harness />));
  if (!seen) throw new Error("the toolbar never rendered");
  return seen as Toolbar;
}

describe("useNotebookDrawingToolbar", () => {
  it("puts any open tool menu away before undoing or redoing from the toolbar", () => {
    const calls: string[] = [];
    const toolbar = renderToolbar({
      closeMenus: () => calls.push("close"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });
    toolbar.toolbarProps.onUndo();
    toolbar.toolbarProps.onRedo();
    expect(calls).toEqual(["close", "undo", "close", "redo"]);
  });

  it("hands the toolbar its state and its dock, with the dock's drag bindings", () => {
    const toolbar = renderToolbar({ closeMenus: vi.fn(), undo: vi.fn(), redo: vi.fn() });
    expect(toolbar.toolbarProps).toMatchObject({
      dock: toolbar.dock,
      tool: "pen",
      openMenu: "pen",
      undoDepth: 2,
      redoDepth: 1,
    });
    expect(typeof toolbar.toolbarProps.dockBindings.onPointerDown).toBe("function");
  });
});
