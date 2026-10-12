// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NotebookPenAdvancedSettings from "@/components/workspace/NotebookPenAdvancedSettings";
import {
  NOTEBOOK_CORNER_SHARPNESS_DEFAULT,
  NOTEBOOK_PEN_SETTINGS_DEFAULT,
  type NotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";

declare global {
  // React only treats a test as an act() environment when this is set, and
  // without it every state update warns.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

/** The panel wired to state, so a control's effect is what the reader sees. */
function Panel({ initial }: { initial: NotebookPenSettings }) {
  const [settings, setSettings] = useState(initial);
  return (
    <NotebookPenAdvancedSettings settings={settings} onChange={setSettings} />
  );
}

/**
 * Mounts the panel afresh.
 *
 * A second `root.render` would reuse the same component instance, and the
 * panel holds its settings in state -- so the new starting values would be
 * ignored and the test would be reading the first mount.
 */
let mounted = 0;
function render(initial: NotebookPenSettings = NOTEBOOK_PEN_SETTINGS_DEFAULT) {
  mounted += 1;
  act(() => {
    root.render(<Panel key={mounted} initial={initial} />);
  });
}

function slider(label: string) {
  const found = container.querySelector<HTMLInputElement>(
    `input[type="range"][aria-label="${label}"]`
  );
  if (!found) throw new Error(`No "${label}" control rendered.`);
  return found;
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === text ||
      element.getAttribute("aria-label") === text
  );
  if (!found) throw new Error(`No "${text}" button rendered.`);
  return found;
}

const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

function drag(control: HTMLInputElement, to: number) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(control, String(to));
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

describe("the advanced pen settings", () => {
  it("folds away, and says from the outside whether anything is set", () => {
    render();
    expect(container.textContent).toContain("Advanced");
    // A closed section still has to say what is chosen inside it.
    expect(container.textContent).toContain("Default");

    render({ ...NOTEBOOK_PEN_SETTINGS_DEFAULT, trackingPercent: 90 });
    expect(container.textContent).toContain("Customised");
  });

  it("names where each control sits rather than showing a bare number", () => {
    render();

    for (const label of ["Nib tracking", "Pressure"]) {
      expect(slider(label).value, label).toBe("50");
    }
    expect(slider("Corner sharpness").value).toBe(
      String(NOTEBOOK_CORNER_SHARPNESS_DEFAULT)
    );
    // Steadiness is what Smoothing on the front of the panel does now; asking
    // it twice was two controls fighting over one filter.
    expect(container.querySelector('input[aria-label="Line steadiness"]')).toBeNull();
    // The name is what the reader is given; the percentage stays in the
    // accessible value text, where a screen reader can still reach it.
    expect(slider("Pressure").getAttribute("aria-valuetext")).toBe(
      "Natural, 50%"
    );
    expect(container.textContent).toContain("Width follows pressure as a pen does");
  });

  it("gives corners a control of their own, live from the start", () => {
    render({ ...NOTEBOOK_PEN_SETTINGS_DEFAULT, smoothingPercent: 20 });

    // It used to sit greyed out, following Smoothing, until a link beside it
    // was found and pressed -- which read as a control that did nothing.
    expect(slider("Corner sharpness").disabled).toBe(false);
    expect(container.textContent).not.toContain("Set separately from Smoothing");

    drag(slider("Corner sharpness"), 10);
    expect(slider("Corner sharpness").value).toBe("10");
    expect(container.textContent).toContain("Flowing");
    expect(container.textContent).toContain("Customised");
  });

  it("offers the three answers to holding still, one at a time", () => {
    render();
    expect(button("Shapes").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("circles, ovals, rectangles, triangles and arrows");

    click(button("Lines"));
    expect(button("Lines").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("at your own angle");

    click(button("Off"));
    expect(button("Off").getAttribute("aria-checked")).toBe("true");
    expect(button("Shapes").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Strokes are always left as drawn");
  });

  it("puts everything back without touching Smoothing", () => {
    render({
      ...NOTEBOOK_PEN_SETTINGS_DEFAULT,
      smoothingPercent: 15,
      pressurePercent: 0,
      straightenOnHold: "off",
    });

    const reset = button("Reset advanced settings") as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    click(reset);

    expect(slider("Pressure").value).toBe("50");
    expect(button("Shapes").getAttribute("aria-checked")).toBe("true");
    // Smoothing is not an advanced setting, so reset leaves it alone; the
    // corners go back to their own default, whatever Smoothing says.
    expect(slider("Corner sharpness").value).toBe(
      String(NOTEBOOK_CORNER_SHARPNESS_DEFAULT)
    );
    expect(
      (button("Reset advanced settings") as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
