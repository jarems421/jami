// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TUESDAY, planActivity, revisionPlan } from "./support/plan-fixtures";

/**
 * Planned notebook work, inside the notebook: there when the plan has some for
 * it today, started there, timed, and finished there -- which ticks it off the
 * plan with how long it ran, the same record the planner and Today read.
 */

const services = vi.hoisted(() => ({
  loadActiveRevisionPlan: vi.fn(),
  loadRevisionPlanEntries: vi.fn(),
  setRevisionPlanActivityDone: vi.fn(async () => undefined),
}));

vi.mock("@/services/firebase/client", () => ({ db: {}, auth: {} }));
vi.mock("@/services/planning/revision-plans", () => services);

const { default: NotebookPlanSession } = await import("@/components/workspace/NotebookPlanSession");

let container: HTMLDivElement;
let root: Root;

const cellBiology = planActivity({ id: "cells", title: "Cell biology", method: "notebook", notebookId: "nb-1", minutes: 30, startTime: "17:00" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  for (const mock of Object.values(services)) mock.mockReset();
  services.loadActiveRevisionPlan.mockResolvedValue(revisionPlan());
  services.loadRevisionPlanEntries.mockResolvedValue([{ dayKey: TUESDAY, activities: [cellBiology] }]);
  services.setRevisionPlanActivityDone.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(notebook = { id: "nb-1", folderId: "biology" }) {
  await act(async () => {
    root.render(<NotebookPlanSession uid="user-1" notebook={notebook} />);
  });
  await act(async () => undefined);
}

function button(name: string | RegExp) {
  const found = [...container.querySelectorAll("button")].find((element) => {
    const label = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`No button ${name}`);
  return found as HTMLButtonElement;
}

describe("a notebook's planned session", () => {
  it("is waiting in the notebook it was planned in", async () => {
    await render();
    expect(services.loadRevisionPlanEntries).toHaveBeenCalledWith("user-1", "plan-1", { fromDayKey: TUESDAY, toDayKey: TUESDAY, max: 1 });
    await act(async () => button("Planned today: Cell biology, 30 minutes").click());
    expect(container.textContent).toContain("30 min · from 17:00");
    expect(button("Start · 30 min")).toBeTruthy();
  });

  it("starts, runs, and finishes into a tick on the plan with how long it took", async () => {
    await render();
    await act(async () => button(/^Planned today/).click());
    await act(async () => button("Start · 30 min").click());
    expect(container.querySelector('[role="timer"]')?.textContent).toContain("30:00");

    await act(async () => {
      vi.advanceTimersByTime(28 * 60_000);
    });
    expect(container.querySelector('[role="timer"]')?.textContent).toContain("2:00");

    await act(async () => button("Finish").click());
    expect(services.setRevisionPlanActivityDone).toHaveBeenCalledWith("user-1", "plan-1", TUESDAY, "cells", {
      by: "activity",
      at: expect.any(Number),
      minutes: 28,
    });
    expect(container.textContent).toContain("Done · 28 min");
    expect(window.localStorage.getItem("jami:plan-session:user-1")).toBeNull();
  });

  it("keeps the clock when it could not save, so it can be finished again", async () => {
    services.setRevisionPlanActivityDone.mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () => button(/^Planned today/).click());
    await act(async () => button("Start · 30 min").click());
    await act(async () => button("Finish").click());
    expect(container.textContent).toContain("That couldn't be saved to your plan");
    expect(button("Finish")).toBeTruthy();
  });

  it("stops without a tick when asked", async () => {
    await render();
    await act(async () => button(/^Planned today/).click());
    await act(async () => button("Start · 30 min").click());
    await act(async () => button("Stop without ticking").click());
    expect(services.setRevisionPlanActivityDone).not.toHaveBeenCalled();
    expect(button("Start · 30 min")).toBeTruthy();
  });

  it("is not there when the plan has no notebook work here today", async () => {
    await render({ id: "nb-9", folderId: "chemistry" });
    expect(container.textContent).toBe("");
  });
});
