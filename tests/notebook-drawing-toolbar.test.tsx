// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookDrawingToolbar } from "@/components/workspace/NotebookDrawingToolbar";
import type { NotebookToolbarDock, NotebookToolMenu } from "@/lib/workspace/notebook-toolbar";
import type { NotebookEditorTool } from "@/lib/workspace/notebook-page-state";

let container: HTMLDivElement;
let root: Root;

const onSelectDrawingTool = vi.fn();
const onToggleTextTool = vi.fn();
const onToggleInsertMenu = vi.fn();
const onToggleRuler = vi.fn();
const onAddImage = vi.fn();
const onAddGraph = vi.fn();
const onUndo = vi.fn();
const onRedo = vi.fn();

function render(
  overrides: Partial<{
    dock: NotebookToolbarDock;
    tool: NotebookEditorTool;
    openMenu: NotebookToolMenu;
    undoDepth: number;
    redoDepth: number;
    addingImage: boolean;
    rulerShown: boolean;
  }> = {}
) {
  act(() => {
    root.render(
      <NotebookDrawingToolbar
        dock={overrides.dock ?? "bottom"}
        toolbarRef={null}
        dockBindings={{}}
        tool={overrides.tool ?? "pen"}
        penColor="black"
        highlighterColor="yellow"
        openMenu={overrides.openMenu ?? null}
        onSelectDrawingTool={onSelectDrawingTool}
        onToggleTextTool={onToggleTextTool}
        onToggleInsertMenu={onToggleInsertMenu}
        rulerShown={overrides.rulerShown ?? false}
        onToggleRuler={onToggleRuler}
        onAddImage={onAddImage}
        addingImage={overrides.addingImage ?? false}
        onAddGraph={onAddGraph}
        undoDepth={overrides.undoDepth ?? 0}
        redoDepth={overrides.redoDepth ?? 0}
        onUndo={onUndo}
        onRedo={onRedo}
      />
    );
  });
}

function button(label: string) {
  const el = container.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`
  );
  if (!el) throw new Error(`no button labelled ${label}`);
  return el;
}

function click(label: string) {
  act(() => {
    button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The open Insert menu, which is drawn on the page's body, outside the toolbar. */
function menu() {
  return document.querySelector<HTMLElement>('[role="menu"]');
}

/** An item of the open Insert menu, by what it says. */
function menuItem(text: string) {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (each) => each.textContent === text
  );
  if (!item) throw new Error(`no menu item ${text}`);
  return item;
}

function choose(text: string) {
  act(() => {
    menuItem(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  onSelectDrawingTool.mockClear();
  onToggleTextTool.mockClear();
  onToggleInsertMenu.mockClear();
  onAddImage.mockClear();
  onAddGraph.mockClear();
  onUndo.mockClear();
  onRedo.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("NotebookDrawingToolbar", () => {
  it("reports which drawing tool was pressed", () => {
    render();
    click("Pen (P)");
    click("Highlighter (H)");
    click("Eraser (E)");
    expect(onSelectDrawingTool.mock.calls.map(([t]) => t)).toEqual([
      "pen",
      "highlighter",
      "eraser",
    ]);
  });

  it("marks the active tool, and its button while its menu is open", () => {
    render({ tool: "pen" });
    expect(button("Pen (P)").dataset.active).toBe("true");

    // The eraser reads active while its options are showing, even though the
    // pen is still the selected tool.
    render({ tool: "pen", openMenu: "eraser" });
    expect(button("Eraser (E)").dataset.active).toBe("true");
    expect(button("Highlighter (H)").dataset.active).not.toBe("true");
  });

  it("exposes which tool settings popover is expanded", () => {
    render({ openMenu: "highlighter" });
    expect(button("Pen (P)").getAttribute("aria-expanded")).toBe("false");
    expect(button("Highlighter (H)").getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(button("Eraser (E)").getAttribute("aria-expanded")).toBe("false");
    expect(button("Highlighter (H)").getAttribute("aria-controls")).toBe(
      "notebook-tool-settings"
    );
  });

  it("disables undo and redo only when nothing is left to step", () => {
    render({ undoDepth: 0, redoDepth: 0 });
    expect(button("Undo (Ctrl+Z)").disabled).toBe(true);
    expect(button("Redo (Ctrl+Shift+Z)").disabled).toBe(true);

    render({ undoDepth: 1, redoDepth: 2 });
    expect(button("Undo (Ctrl+Z)").disabled).toBe(false);
    expect(button("Redo (Ctrl+Shift+Z)").disabled).toBe(false);

    click("Undo (Ctrl+Z)");
    click("Redo (Ctrl+Shift+Z)");
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  /*
   * The pointer button was taken off. Images and graphs are moved with the text
   * tool on, or with no tool on, so nothing on the bar is needed for it.
   */
  it("has no select button", () => {
    render({ tool: "select" });
    expect(container.querySelector('[aria-label^="Select"]')).toBeNull();
  });

  it("keeps pictures and graphs behind one Insert button, whose menu the page opens", () => {
    render();
    expect(container.querySelector('[aria-label="Add image"]')).toBeNull();
    expect(container.querySelector('[aria-label="Add graph"]')).toBeNull();
    expect(menu()).toBeNull();
    expect(button("Insert").getAttribute("aria-haspopup")).toBe("menu");
    expect(button("Insert").getAttribute("aria-expanded")).toBe("false");
    click("Insert");
    expect(onToggleInsertMenu).toHaveBeenCalledTimes(1);

    render({ openMenu: "insert" });
    expect(button("Insert").getAttribute("aria-expanded")).toBe("true");
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(["Image", "Graph"]);
    // Not inside the toolbar, whose paint containment would clip it.
    expect(container.contains(menu())).toBe(false);
  });

  it("opens the graph editor from the menu, and puts the menu away", () => {
    render({ openMenu: "insert" });
    choose("Graph");
    expect(onToggleInsertMenu).toHaveBeenCalledTimes(1);
    expect(onAddGraph).toHaveBeenCalledTimes(1);
  });

  it("asks for a picture from the menu in the same tap, and hands the one chosen to the page", () => {
    render({ openMenu: "insert" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no image file input");
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");
    const picker = vi.spyOn(input, "click").mockImplementation(() => undefined);
    choose("Image");
    expect(picker).toHaveBeenCalledTimes(1);
    expect(onToggleInsertMenu).toHaveBeenCalledTimes(1);

    // The menu has gone by the time the picker answers; the input has not.
    render({ openMenu: null });
    const file = new File(["png"], "graph.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onAddImage).toHaveBeenCalledWith(file);
  });

  it("holds the picture item while one uploads, and shows it on the button", () => {
    render({ addingImage: true, openMenu: "insert" });
    expect(menuItem("Adding image…").disabled).toBe(true);
    expect(button("Insert (adding an image)").disabled).toBe(false);
  });

  it("sits in the top bar as a row of quiet buttons, and floats as a pill anywhere else", () => {
    render({ dock: "top" });
    let bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    expect((container.firstElementChild as HTMLElement).className).not.toContain("absolute");
    expect(bar.className).not.toContain("notebook-floating-control");
    expect(button("Highlighter (H)").className).toContain("border-transparent");

    render({ dock: "bottom" });
    bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    expect((container.firstElementChild as HTMLElement).className).toContain("absolute");
    expect(bar.className).toContain("notebook-floating-control");
    expect(button("Highlighter (H)").className).not.toContain("border-transparent");
  });

  it("opens the Insert menu beside its button, away from the edge it is docked to", () => {
    const placement = (dock: NotebookToolbarDock) => {
      render({ dock, openMenu: null });
      render({ dock, openMenu: "insert" });
      const style = menu()!.style;
      return { top: style.top, bottom: style.bottom, left: style.left, right: style.right };
    };
    expect(placement("top")).toMatchObject({ top: "8px", bottom: "" });
    expect(placement("bottom")).toMatchObject({ top: "", bottom: `${window.innerHeight + 8}px` });
    expect(placement("left")).toMatchObject({ left: "8px", right: "" });
    expect(placement("right")).toMatchObject({ left: "", right: `${window.innerWidth + 8}px` });
  });

  it("keeps a press on the menu from reaching the toolbar's drag", () => {
    const onPointerDown = vi.fn();
    act(() => {
      root.render(
        <NotebookDrawingToolbar
          dock="top"
          toolbarRef={null}
          dockBindings={{ onPointerDown }}
          tool="pen"
          penColor="black"
          highlighterColor="yellow"
          openMenu="insert"
          onSelectDrawingTool={onSelectDrawingTool}
          onToggleTextTool={onToggleTextTool}
          onToggleInsertMenu={onToggleInsertMenu}
          rulerShown={false}
          onToggleRuler={onToggleRuler}
          onAddImage={onAddImage}
          addingImage={false}
          onAddGraph={onAddGraph}
          undoDepth={0}
          redoDepth={0}
          onUndo={onUndo}
          onRedo={onRedo}
        />
      );
    });
    act(() => {
      menuItem("Graph").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("keeps side docks clear of the device safe area", () => {
    for (const dock of ["left", "right"] as const) {
      render({ dock });
      const positioned = container.firstElementChild as HTMLElement;
      // A dock under the notch is invisible to every automated check, so the
      // inset is pinned here.
      expect(positioned.className).toContain("env(safe-area-inset-");
    }
  });

  it("switches orientation when docked to a side", () => {
    render({ dock: "bottom" });
    let bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    expect(bar.getAttribute("aria-orientation")).toBe("horizontal");

    render({ dock: "left" });
    bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");
    expect(bar.className).toContain("flex-col");
  });

  it("exposes the dock edge for the docking controller to read back", () => {
    render({ dock: "top" });
    const bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    expect(bar.dataset.toolbarDock).toBe("top");
  });

  it("puts the ruler out and away, and shows when it is out", () => {
    render();
    expect(button("Ruler").getAttribute("aria-pressed")).toBe("false");
    click("Ruler");
    expect(onToggleRuler).toHaveBeenCalledTimes(1);
    render({ rulerShown: true });
    expect(button("Put the ruler away").getAttribute("aria-pressed")).toBe("true");
  });
});
