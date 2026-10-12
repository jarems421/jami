// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotebookRuler from "@/components/workspace/NotebookRuler";
import type { InkRuler } from "@/lib/ink/tools/ruler";

const RULER: InkRuler = { cx: 400, cy: 300, angle: 0, length: 600, width: 60 };

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

function pointer(target: Element, type: string, init: { x: number; y: number; id?: number; kind?: string }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x, clientY: init.y });
  Object.defineProperties(event, {
    pointerId: { value: init.id ?? 1 },
    pointerType: { value: init.kind ?? "touch" },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

function renderRuler() {
  const onChange = vi.fn();
  const ink = {
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onPointerCancel: vi.fn(),
    onLostPointerCapture: vi.fn(),
  };
  act(() =>
    root.render(
      <NotebookRuler
        ruler={RULER}
        page={{ width: 900, height: 1240 }}
        toPage={(x, y) => ({ x, y })}
        onChange={onChange}
        ink={ink}
      />
    )
  );
  const element = container.querySelector("[data-notebook-ruler]")!;
  return { element, onChange, ink };
}

describe("NotebookRuler", () => {
  it("slides under one finger, and turns under two", () => {
    const { element, onChange } = renderRuler();
    pointer(element, "pointerdown", { x: 400, y: 300 });
    pointer(element, "pointermove", { x: 430, y: 290 });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cx: 430, cy: 290, angle: 0 }));

    pointer(element, "pointerup", { x: 430, y: 290 });
    pointer(element, "pointerdown", { x: 300, y: 300, id: 2 });
    pointer(element, "pointerdown", { x: 500, y: 300, id: 3 });
    pointer(element, "pointermove", { x: 500, y: 400, id: 3 });
    const turned = onChange.mock.lastCall?.[0] as InkRuler;
    expect(turned.angle).toBeGreaterThan(0.3);
  });

  it("hands the pen to the ink underneath, so a stroke can start on its edge", () => {
    const { element, onChange, ink } = renderRuler();
    pointer(element, "pointerdown", { x: 400, y: 272, kind: "pen" });
    pointer(element, "pointermove", { x: 420, y: 272, kind: "pen" });
    pointer(element, "pointerup", { x: 420, y: 272, kind: "pen" });
    expect(ink.onPointerDown).toHaveBeenCalledTimes(1);
    expect(ink.onPointerMove).toHaveBeenCalledTimes(1);
    expect(ink.onPointerUp).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reads out its angle", () => {
    const { element } = renderRuler();
    expect(element.textContent).toBe("0°");
  });
});
