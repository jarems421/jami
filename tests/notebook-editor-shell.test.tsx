// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNotebookEditorShell } from "@/hooks/useNotebookEditorShell";
import {
  NOTEBOOK_EDITOR_LOCK_BODY_CLASS,
  NOTEBOOK_OPEN_BODY_CLASS,
} from "@/lib/workspace/notebook-interaction-lock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Shell() {
  useNotebookEditorShell();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
});

describe("useNotebookEditorShell", () => {
  it("marks the body as a notebook being open, which switches off the photo under it, and unmarks it on the way out", () => {
    document.body.style.background = "red";
    act(() => root.render(<Shell />));
    expect(document.body.classList.contains(NOTEBOOK_EDITOR_LOCK_BODY_CLASS)).toBe(true);
    expect(document.body.classList.contains(NOTEBOOK_OPEN_BODY_CLASS)).toBe(true);

    act(() => root.unmount());
    expect(document.body.classList.contains(NOTEBOOK_EDITOR_LOCK_BODY_CLASS)).toBe(false);
    expect(document.body.classList.contains(NOTEBOOK_OPEN_BODY_CLASS)).toBe(false);
    expect(document.body.style.background).toBe("red");
  });
});
