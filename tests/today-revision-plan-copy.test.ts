// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";
import { planWeekdayOf, planWeekStartDayKey } from "@/lib/planning/plan-schedule";
import type { RevisionPlan, RevisionPlanEntry } from "@/lib/planning/types";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const server = vi.hoisted(() => ({
  loadActiveRevisionPlan: vi.fn(),
  loadRevisionPlanEntries: vi.fn(),
  applyRevisionPlanOps: vi.fn(),
  recordRevisionPlanActivitiesSeen: vi.fn(async () => undefined),
}));

vi.mock("@/services/learning/study-action-events", () => ({
  loadCompletedStudyActions: vi.fn(async () => new Map()),
}));
vi.mock("@/services/learning/study-actions", () => ({
  loadPlanStudyActions: vi.fn(async () => ({ actionsByScope: new Map(), answered: new Set() })),
}));

vi.mock("@/services/firebase/client", () => ({ db: {}, auth: {} }));
vi.mock("@/services/planning/revision-plans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/planning/revision-plans")>()),
  ...server,
}));

const {
  clearStoredTodayRevisionPlans,
  readStoredTodayRevisionPlan,
  storeTodayRevisionPlan,
} = await import("@/services/planning/revision-plans");
const { useRevisionPlanToday } = await import("@/hooks/useRevisionPlanToday");

const TODAY = getStudyDayKey();
const WEEK = planWeekStartDayKey(TODAY);
const UID = "planner";

function plan(overrides: Partial<RevisionPlan> = {}): RevisionPlan {
  return {
    id: "plan-1",
    schemaVersion: 3,
    autoFill: false,
    title: "Summer exams",
    status: "active",
    origin: "manual",
    startDayKey: shiftStudyDayKey(TODAY, -7),
    endDayKey: shiftStudyDayKey(TODAY, 30),
    scopes: [{ folderId: "biology", weight: 1 }],
    sessions: [{ id: "today-session", weekday: planWeekdayOf(TODAY), minutes: 45 }],
    emphasis: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A promise settled from outside, to hold a read or a save open. */
function held<T>() {
  let settle: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

type Hook = ReturnType<typeof useRevisionPlanToday>;

async function mount() {
  const seen: Hook[] = [];
  function Probe() {
    seen.push(useRevisionPlanToday({ uid: UID, enabled: true, folders: [], cards: [], decks: [] }));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(Probe));
  });
  return { seen, latest: () => seen[seen.length - 1] as Hook, unmount: () => act(() => root.unmount()) };
}

const taskTitles = (state: Hook) =>
  (state.today?.activities ?? []).flatMap((activity) => (activity.open ? [] : [activity.title]));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  server.loadActiveRevisionPlan.mockReset();
  server.loadRevisionPlanEntries.mockReset();
  server.applyRevisionPlanOps.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Today's plan, kept for the next launch", () => {
  it("is kept for the week it was read for, and goes at sign-out", () => {
    storeTodayRevisionPlan(UID, WEEK, { plan: plan(), entries: [{ dayKey: TODAY, skipped: true }] });
    const kept = readStoredTodayRevisionPlan(UID, WEEK);
    expect(kept?.plan?.title).toBe("Summer exams");
    expect(kept?.entries).toEqual([{ dayKey: TODAY, skipped: true }]);
    // Next week's page is not this week's.
    expect(readStoredTodayRevisionPlan(UID, shiftStudyDayKey(WEEK, 7))).toBeNull();
    expect(readStoredTodayRevisionPlan("someone-else", WEEK)).toBeNull();

    // Having no plan is worth keeping too: Today need not wait to learn it.
    storeTodayRevisionPlan("no-plan", WEEK, { plan: null, entries: [] });
    expect(readStoredTodayRevisionPlan("no-plan", WEEK)).toEqual({ plan: null, entries: [] });

    clearStoredTodayRevisionPlans();
    expect(readStoredTodayRevisionPlan(UID, WEEK)).toBeNull();
    expect(readStoredTodayRevisionPlan("no-plan", WEEK)).toBeNull();
  });

  it("comes back through the same normalising as a stored plan does", () => {
    window.localStorage.setItem(
      `jami:today-plan:${UID}`,
      JSON.stringify({ version: 1, weekStartDayKey: WEEK, plan: { id: 7 }, entries: [] })
    );
    expect(readStoredTodayRevisionPlan(UID, WEEK)).toBeNull();
    window.localStorage.setItem(`jami:today-plan:${UID}`, "{not json");
    expect(readStoredTodayRevisionPlan(UID, WEEK)).toBeNull();
  });

  it("draws the kept plan at once and reads it again without blanking the page", async () => {
    storeTodayRevisionPlan(UID, WEEK, { plan: plan(), entries: [] });
    const read = held<RevisionPlan | null>();
    server.loadActiveRevisionPlan.mockReturnValue(read.promise);
    server.loadRevisionPlanEntries.mockResolvedValue([]);

    const hook = await mount();
    expect(hook.seen[0].loading).toBe(false);
    expect(hook.seen[0].plan?.title).toBe("Summer exams");

    await act(async () => read.settle(plan({ title: "Mock exams" })));
    expect(hook.seen.every((state) => !state.loading)).toBe(true);
    expect(hook.latest().plan?.title).toBe("Mock exams");
    // And the copy is brought up to date for the launch after.
    expect(readStoredTodayRevisionPlan(UID, WEEK)?.plan?.title).toBe("Mock exams");
    hook.unmount();
  });

  it("waits for the plan when nothing was kept", async () => {
    const read = held<RevisionPlan | null>();
    server.loadActiveRevisionPlan.mockReturnValue(read.promise);
    server.loadRevisionPlanEntries.mockResolvedValue([]);

    const hook = await mount();
    expect(hook.latest().loading).toBe(true);
    await act(async () => read.settle(null));
    expect(hook.latest().loading).toBe(false);
    expect(hook.latest().plan).toBeNull();
    expect(readStoredTodayRevisionPlan(UID, WEEK)).toEqual({ plan: null, entries: [] });
    hook.unmount();
  });

  it("never lets a read from before a change undo it", async () => {
    storeTodayRevisionPlan(UID, WEEK, { plan: plan(), entries: [] });
    const firstRead = held<RevisionPlanEntry[]>();
    const save = held<RevisionPlanEntry[]>();
    server.loadActiveRevisionPlan.mockResolvedValue(plan());
    server.loadRevisionPlanEntries.mockReturnValueOnce(firstRead.promise);
    server.applyRevisionPlanOps.mockReturnValue(save.promise);

    const hook = await mount();
    const task = { id: "task", title: "Read chapter 3", method: "notes" as const, minutes: 20, mode: "fixed" as const, origin: "student" as const };
    // The student adds a task to the kept plan while the first read is out.
    await act(async () => {
      expect(hook.latest().timetable.apply([{ type: "add", dayKey: TODAY, activity: task }])).toBe(true);
    });
    expect(taskTitles(hook.latest())).toEqual(["Read chapter 3"]);
    // The free session the student could see is still there beside it.
    expect(hook.latest().today?.openCount).toBe(1);

    // That read began before the task existed, and comes back without it.
    await act(async () => firstRead.settle([]));
    expect(taskTitles(hook.latest())).toEqual(["Read chapter 3"]);

    // The save answers with the day as the server now has it.
    const saved = server.applyRevisionPlanOps.mock.calls[0]?.[2];
    expect(saved).toEqual([{ type: "add", dayKey: TODAY, activity: task }]);
    await act(async () =>
      save.settle([{ dayKey: TODAY, activities: [{ ...task }, { id: "routine-today-session", title: "", method: "other", minutes: 45, mode: "adaptive", origin: "student", open: true, scopeKey: "folder:biology", routineId: "today-session" }] }])
    );
    expect(taskTitles(hook.latest())).toEqual(["Read chapter 3"]);
    hook.unmount();
  });

  it("keeps the kept plan when it cannot be read again", async () => {
    storeTodayRevisionPlan(UID, WEEK, { plan: plan(), entries: [] });
    server.loadActiveRevisionPlan.mockRejectedValue(new Error("offline"));

    const hook = await mount();
    await act(async () => undefined);
    expect(hook.latest().plan?.title).toBe("Summer exams");
    expect(hook.latest().loading).toBe(false);
    hook.unmount();
  });
});
