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

type Handlers = {
  closeMenus: () => void;
  setMenuOpen: (menu: "pen" | "highlighter" | "eraser" | "insert", open: boolean) => void;
  undo: () => void;
  redo: () => void;
};

function renderToolbar(handlers: Handlers, openMenu: "pen" | "insert" | null = "pen") {
  let seen: Toolbar | null = null;
  const report = (toolbar: Toolbar) => {
    seen = toolbar;
  };
  function Harness() {
    const frameRef = useRef<HTMLDivElement | null>(null);
    const toolbar = useNotebookDrawingToolbar({
      frameRef,
      frameSize: { width: 800, height: 600 },
      closeMenus: handlers.closeMenus,
      undo: handlers.undo,
      redo: handlers.redo,
      drawingTools: { setMenuOpen: handlers.setMenuOpen, rulerShown: false, toggleRuler: () => undefined },
      tool: "pen",
      penColor: "black",
      highlighterColor: "yellow",
      openMenu,
      onSelectDrawingTool: () => undefined,
      onToggleTool: () => undefined,
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
      setMenuOpen: vi.fn(),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });
    toolbar.toolbarProps.onUndo();
    toolbar.toolbarProps.onRedo();
    expect(calls).toEqual(["close", "undo", "close", "redo"]);
  });

  it("hands the toolbar its state and its dock, with the dock's drag bindings", () => {
    const toolbar = renderToolbar({ closeMenus: vi.fn(), setMenuOpen: vi.fn(), undo: vi.fn(), redo: vi.fn() });
    expect(toolbar.toolbarProps).toMatchObject({
      dock: toolbar.dock,
      tool: "pen",
      openMenu: "pen",
      undoDepth: 2,
      redoDepth: 1,
    });
    expect(typeof toolbar.toolbarProps.dockBindings.onPointerDown).toBe("function");
  });

  it("opens the Insert menu when it is shut, and shuts it when it is open", () => {
    const setMenuOpen = vi.fn();
    const handlers = { closeMenus: vi.fn(), setMenuOpen, undo: vi.fn(), redo: vi.fn() };
    renderToolbar(handlers, "pen").toolbarProps.onToggleInsertMenu();
    renderToolbar(handlers, "insert").toolbarProps.onToggleInsertMenu();
    expect(setMenuOpen.mock.calls).toEqual([
      ["insert", true],
      ["insert", false],
    ]);
  });
});
