// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotebookKeyboardShortcuts } from "@/hooks/useNotebookKeyboardShortcuts";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderShortcuts(onEscape: () => "menu" | void) {
  const switchTool = vi.fn();
  function Harness() {
    useNotebookKeyboardShortcuts({
      enabled: true,
      readTool: () => "pen",
      switchTool,
      undo: vi.fn(),
      redo: vi.fn(),
      onEscape,
    });
    return null;
  }
  act(() => root.render(<Harness />));
  return { switchTool };
}

const press = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

describe("Escape in the notebook", () => {
  it("only closes a menu that is open, keeping the tool in hand", () => {
    const onEscape = vi.fn(() => "menu" as const);
    const { switchTool } = renderShortcuts(onEscape);
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(switchTool).not.toHaveBeenCalled();
  });

  it("lets go and puts the tool down when there is no menu to close", () => {
    const onEscape = vi.fn(() => undefined);
    const { switchTool } = renderShortcuts(onEscape);
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(switchTool).toHaveBeenCalledWith("select");
  });

  it("picks up the lasso with L", () => {
    const { switchTool } = renderShortcuts(vi.fn());
    press("l");
    expect(switchTool).toHaveBeenCalledWith("lasso");
  });
});
