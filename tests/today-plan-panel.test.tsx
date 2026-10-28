// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TodayPlanPanel from "@/components/today/TodayPlanPanel";
import type { RevisionPlanTodayState } from "@/hooks/useRevisionPlanToday";
import { resolveTimetableDay } from "@/lib/planning/timetable";
import { TUESDAY, revisionPlan } from "./support/plan-fixtures";

/**
 * Today's plan: exactly what was planned for today, the next thing lit with
 * its Start button, free time said plainly with the way to fill it, and the
 * same edits the planner makes.
 */

let container: HTMLDivElement;
let root: Root;

const plan = revisionPlan({ sessions: [{ id: "tue", weekday: 2, minutes: 30, startTime: "19:00", scopeKey: "folder:chemistry" }] });

function state(overrides: Partial<RevisionPlanTodayState> = {}) {
  const today = resolveTimetableDay({
    plan,
    dayKey: TUESDAY,
    todayDayKey: TUESDAY,
    entry: {
      dayKey: TUESDAY,
      activities: [
        { id: "a", title: "Homeostasis", method: "practice", minutes: 30, startTime: "17:00", scopeKey: "folder:biology", mode: "adaptive", origin: "jami", href: "/dashboard/practice/questions/new?folderId=biology" },
        { id: "b", title: "Finish my homework", method: "other", minutes: 20, startTime: "18:00", mode: "fixed", origin: "student" },
        { id: "routine-tue", title: "", method: "other", minutes: 30, startTime: "19:00", scopeKey: "folder:chemistry", mode: "adaptive", origin: "student", open: true, routineId: "tue" },
      ],
    },
  });
  const timetable = {
    entries: new Map(),
    loading: false,
    synced: true,
    saving: false,
    problem: "",
    apply: vi.fn(() => true),
    setDone: vi.fn(),
    recordSeen: vi.fn(),
    undo: vi.fn(),
    undoLabel: null,
    ownDays: () => new Map(),
    clearProblem: vi.fn(),
    reload: vi.fn(async () => undefined),
  };
  return {
    plan,
    loading: false,
    week: [today],
    today,
    todayDayKey: TUESDAY,
    scopeNames: new Map([
      ["folder:biology", "Biology"],
      ["folder:chemistry", "Chemistry"],
    ]),
    timetable,
    drafting: {
      context: null,
      support: new Map(),
      answered: new Set<string>(),
      loading: false,
      refresh: vi.fn(async () => undefined),
      readyFor: () => null,
      // Chemistry has nothing in it for Jami to pick from.
      forScopes: vi.fn(async () => ({ actionsByScope: new Map(), support: new Map() })),
    },
    changePlan: vi.fn(async () => true),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  } satisfies RevisionPlanTodayState;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(planToday: RevisionPlanTodayState) {
  act(() => root.render(<TodayPlanPanel uid="user-1" planToday={planToday} folders={[]} topics={[]} />));
}

describe("today's plan", () => {
  it("shows what was planned, the next thing lit with a way to start it, and free time as free time", () => {
    render(state());
    const text = container.textContent ?? "";
    expect(text).toContain("2 tasks · about 1h 20m");
    expect(text).toContain("Homeostasis");
    expect(text).toContain("Jami’s pick");
    expect(text).toContain("Up next");
    expect(container.querySelector('a[href="/dashboard/practice/questions/new?folderId=biology"]')?.textContent).toBe("Practice");
    expect(text).toContain("Free · Chemistry");
    expect(text).toContain("Let Jami pick");
  });

  it("ticks a task the student did, through the same edit the planner makes", () => {
    const planToday = state();
    render(planToday);
    act(() => (container.querySelector('[aria-label="Mark done: Finish my homework"]') as HTMLButtonElement).click());
    expect(planToday.timetable.setDone).toHaveBeenCalledWith(TUESDAY, "b", true);
  });

  it("adds to today in the same editor as the planner", () => {
    render(state());
    act(() => ([...container.querySelectorAll("button")].find((button) => button.textContent === "Add to today") as HTMLButtonElement).click());
    expect(document.body.textContent).toContain("Add to Tuesday 20 October");
  });

  it("says so when Jami has nothing to pick for a free session, rather than doing nothing", async () => {
    const planToday = state();
    render(planToday);
    await act(async () => ([...container.querySelectorAll("button")].find((button) => button.textContent === "Let Jami pick") as HTMLButtonElement).click());
    expect(planToday.drafting.forScopes).toHaveBeenCalledWith(["folder:chemistry"]);
    expect(planToday.timetable.apply).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Jami has nothing to pick from in Chemistry yet");
  });

  it("draws nothing without a plan", () => {
    render(state({ plan: null, today: null }));
    expect(container.textContent).toBe("");
  });
});
