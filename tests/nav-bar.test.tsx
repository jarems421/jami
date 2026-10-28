// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/layout/TabBar";

const pathname = vi.hoisted(() => ({ current: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<TabBar />);
  });
}

const bar = () => document.querySelector<HTMLElement>("nav[data-nav='bar']");
const sidebar = () =>
  document.querySelector<HTMLElement>("nav[data-nav='sidebar']");

beforeEach(() => {
  // jsdom has no layout, so the bar's "scroll the active tab into view" pass
  // has nothing to call. It is not what these tests are about.
  Element.prototype.scrollIntoView = vi.fn();
  pathname.current = "/dashboard";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the phone navigation bar", () => {
  it("scrolls sideways through every destination, with no More sheet", async () => {
    await render();

    expect(bar()?.className).toContain("overflow-x-auto");
    const labels = Array.from(bar()?.querySelectorAll("a") ?? []).map((item) =>
      item.textContent?.trim()
    );
    expect(labels).toEqual([
      "Today",
      "Learn",
      "Practice",
      "Jami",
      "Cards",
      "Topics",
      "Plan",
      "Stars",
      "Progress",
      "Account",
    ]);
    expect(bar()?.querySelector("button")).toBeNull();
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("scrolls the current destination into view", async () => {
    pathname.current = "/dashboard/goals";
    await render();

    const current = bar()?.querySelector("[aria-current='page']");
    expect(current?.textContent).toContain("Plan");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("the sidebar", () => {
  it("has no hide or show buttons; swiping is the only toggle", async () => {
    await render();

    expect(sidebar()).not.toBeNull();
    expect(sidebar()?.querySelector("button")).toBeNull();
    expect(document.querySelector("[aria-label='Hide sidebar']")).toBeNull();
    expect(document.querySelector("[aria-label='Show sidebar']")).toBeNull();
  });
});
