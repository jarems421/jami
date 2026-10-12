// @vitest-environment jsdom

import { act, createRef, forwardRef, useImperativeHandle, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookInkEditor } from "@/components/workspace/NotebookInkEditor";
import type { NotebookInkEditorHandle } from "@/components/workspace/notebook-ink-editor-types";
import { NOTEBOOK_PEN_SETTINGS_DEFAULT } from "@/lib/workspace/notebook-pen-feel";

const flags = vi.hoisted(() => ({ enableJamiInk: false }));
vi.mock("@/lib/app/feature-flags", () => ({ featureFlags: flags }));

const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

function fakeHandle(label: string): NotebookInkEditorHandle {
  const ink = { version: 2, format: "js-draw-svg", svg: `<svg data-engine="${label}"/>` } as const;
  return {
    clear: vi.fn(),
    getHistoryState: () => ({ undoDepth: 0, redoDepth: 0 }),
    hasInk: () => false,
    isInteracting: () => false,
    redo: vi.fn(),
    serialize: () => ink,
    serializeAsync: async () => ink,
    serializeWarm: () => ink,
    setEraserMode: vi.fn(),
    undo: vi.fn(),
  };
}

vi.mock("@/components/workspace/JsDrawInkEditor", () => ({
  JsDrawInkEditor: forwardRef<NotebookInkEditorHandle, Record<string, unknown>>(function FakeJsDraw(props, ref) {
    seen.props.push(props);
    useImperativeHandle(ref, () => fakeHandle("js-draw"), []);
    return <div data-engine="js-draw" />;
  }),
}));

vi.mock("@/components/workspace/JamiInkEditor", () => ({
  JamiInkEditor: forwardRef<NotebookInkEditorHandle, Record<string, unknown>>(function FakeJami(props, ref) {
    seen.props.push(props);
    useImperativeHandle(ref, () => fakeHandle("jami"), []);
    return <div data-engine="jami" />;
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props: ComponentProps<typeof NotebookInkEditor> = {
  activeTool: "pen",
  eraserMode: "precision",
  eraserThickness: 24,
  highlighterColor: "yellow",
  highlighterThickness: 18,
  penColor: "black",
  penSettings: NOTEBOOK_PEN_SETTINGS_DEFAULT,
  penThickness: 3,
  initialInk: { version: 2, format: "js-draw-svg", svg: "<svg />" },
  inkFrame: { pageX: -10, pageY: -20, frameWidth: 300, frameHeight: 400 },
  pageHeight: 1240,
  pageId: "page-1",
  pageWidth: 900,
  onChange: vi.fn(),
  onHistoryChange: vi.fn(),
  onInteractionChange: vi.fn(),
  onPointerCancel: vi.fn(),
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

function render() {
  const ref = createRef<NotebookInkEditorHandle>();
  act(() => {
    root.render(<NotebookInkEditor ref={ref} {...props} />);
  });
  return ref;
}

beforeEach(() => {
  seen.props.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NotebookInkEditor", () => {
  it("is the js-draw editor while enableJamiInk is off", () => {
    flags.enableJamiInk = false;
    const ref = render();
    expect(container.querySelector("[data-engine]")?.getAttribute("data-engine")).toBe("js-draw");
    expect(ref.current?.serialize()).toMatchObject({ svg: "<svg data-engine=\"js-draw\"/>" });
    expect(seen.props[0]).toMatchObject({ pageId: "page-1", penThickness: 3, inkFrame: props.inkFrame });
  });

  it("is the Jami Ink editor while enableJamiInk is on, with the same props and handle", () => {
    flags.enableJamiInk = true;
    const ref = render();
    expect(container.querySelector("[data-engine]")?.getAttribute("data-engine")).toBe("jami");
    expect(ref.current?.serialize()).toMatchObject({ svg: "<svg data-engine=\"jami\"/>" });
    expect(seen.props[0]).toMatchObject({ pageId: "page-1", penThickness: 3, inkFrame: props.inkFrame });
  });
});
