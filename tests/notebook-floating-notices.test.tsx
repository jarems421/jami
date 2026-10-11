// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NotebookFloatingNotices from "@/components/workspace/NotebookFloatingNotices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const notices = () => Array.from(container.querySelectorAll(".notebook-floating-control")).map((node) => node.textContent);

describe("NotebookFloatingNotices", () => {
  it("shows nothing when there is nothing to say", () => {
    act(() => root.render(<NotebookFloatingNotices toolbarDock="bottom" touchInkHint={false} inkLoading={false} />));
    expect(container.innerHTML).toBe("");
  });

  it("stacks the touch hint and the loading notice in one column, the loading one as a status", () => {
    act(() => root.render(<NotebookFloatingNotices toolbarDock="bottom" touchInkHint inkLoading />));
    expect(notices()).toEqual([
      "Use Apple Pencil or stylus to write. Fingers move the page.",
      "Loading this page’s drawing. Writing is paused until it arrives.",
    ]);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("sits clear of the toolbar wherever it is docked", () => {
    act(() => root.render(<NotebookFloatingNotices toolbarDock="bottom" touchInkHint inkLoading={false} />));
    expect((container.firstElementChild as HTMLElement).className).toContain("+6.35rem");
    act(() => root.render(<NotebookFloatingNotices toolbarDock="left" touchInkHint inkLoading={false} />));
    expect((container.firstElementChild as HTMLElement).className).not.toContain("+6.35rem");
  });
});
