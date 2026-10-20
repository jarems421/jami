// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RevisionPlan, RevisionPlanEntry } from "@/lib/planning/types";

/**
 * The planner, the way a student uses it: the week's real activities and free
 * sessions on screen, every one of them changed directly -- added, edited,
 * moved, filled, undone -- and a plan built by hand saved with what was put on it.
 */

const services = vi.hoisted(() => ({
  loadRevisionPlanEntries: vi.fn(),
  applyRevisionPlanOps: vi.fn(),
  setRevisionPlanActivityDone: vi.fn(async () => undefined),
  recordRevisionPlanActivitiesSeen: vi.fn(async () => undefined),
  saveRevisionPlan: vi.fn(),
  createRevisionPlan: vi.fn(),
  loadPlanStudyActions: vi.fn(),
}));

vi.mock("@/services/firebase/client", () => ({ db: {}, auth: {} }));
vi.mock("@/services/planning/revision-plans", () => ({
  loadRevisionPlanEntries: services.loadRevisionPlanEntries,
  applyRevisionPlanOps: services.applyRevisionPlanOps,
  setRevisionPlanActivityDone: services.setRevisionPlanActivityDone,
  recordRevisionPlanActivitiesSeen: services.recordRevisionPlanActivitiesSeen,
  saveRevisionPlan: services.saveRevisionPlan,
  createRevisionPlan: services.createRevisionPlan,
}));
vi.mock("@/services/learning/study-actions", () => ({ loadPlanStudyActions: services.loadPlanStudyActions }));
vi.mock("@/services/learning/study-action-events", () => ({ loadCompletedStudyActions: async () => new Map() }));
vi.mock("@/services/planning/plan-draft", () => ({ draftPlanWithJami: vi.fn(), PlanDraftError: class extends Error {} }));
vi.mock("@/services/study/goals", () => ({ getActiveGoalsWithCurrentStatuses: async () => [] }));
vi.mock("@/services/study/notebooks", () => ({
  getActiveNotebooks: async () => [
    { id: "nb-1", title: "Cell biology", folderId: "bio" },
    { id: "nb-2", title: "Bonding", folderId: "chem" },
  ],
}));

const { default: RevisionPlanner } = await import("@/components/planning/RevisionPlanner");

const OPTIONS = [
  { key: "folder:bio", label: "Biology", folderId: "bio" },
  { key: "folder:chem", label: "Chemistry", folderId: "chem" },
];
const FOLDERS = [
  { id: "bio", name: "Biology", topicIds: [] },
  { id: "chem", name: "Chemistry", topicIds: [] },
];

function livePlan(overrides: Partial<RevisionPlan> = {}): RevisionPlan {
  return {
    id: "plan-1",
    schemaVersion: 3,
    title: "Summer exams",
    status: "active",
    origin: "manual",
    startDayKey: "2026-10-19",
    endDayKey: "2026-11-29",
    scopes: [
      { folderId: "bio", weight: 2 },
      { folderId: "chem", weight: 1 },
    ],
    sessions: [{ id: "fri", weekday: 5, minutes: 45, startTime: "17:00" }],
    emphasis: [],
    autoFill: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const MONDAY_ENTRY: RevisionPlanEntry = {
  dayKey: "2026-10-19",
  activities: [
    { id: "hq", title: "Homeostasis questions", method: "practice", minutes: 30, startTime: "17:00", scopeKey: "folder:bio", mode: "fixed", origin: "student" },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width: 1280px"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  for (const mock of Object.values(services)) mock.mockReset();
  services.loadRevisionPlanEntries.mockResolvedValue([MONDAY_ENTRY]);
  services.applyRevisionPlanOps.mockImplementation(async () => []);
  services.loadPlanStudyActions.mockResolvedValue({
    actionsByScope: new Map([
      [
        "folder:bio",
        [
          {
            id: "folder:bio|low_mastery|topic:enzymes",
            reason: "low_mastery",
            action: "practice",
            target: { kind: "topic", topicKey: "topic:enzymes", source: "student-topic", label: "enzymes" },
            scope: { folderId: "bio" },
            destination: { kind: "flashcards", href: "/dashboard/study?mode=custom&topics=enzymes", selection: {} },
          },
        ],
      ],
    ]),
    answered: new Set(["folder:bio", "folder:chem"]),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(savedPlan: RevisionPlan | null, onPlanSaved = vi.fn()) {
  await act(async () => {
    root.render(
      <RevisionPlanner
        uid="user-1"
        savedPlan={savedPlan}
        options={OPTIONS}
        folders={FOLDERS}
        decks={[]}
        cards={[]}
        topics={[]}
        notices={[]}
        onPlanSaved={onPlanSaved}
        onArchive={vi.fn()}
      />
    );
  });
  return onPlanSaved;
}

function byLabel(label: string | RegExp) {
  const found = [...document.querySelectorAll("button")].find((element) => {
    const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
  if (!found) throw new Error(`No button ${label}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function setField(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(label: string, value: string) {
  const field = [...document.querySelectorAll("label")].find((element) => element.textContent === label);
  const select = document.getElementById(field?.htmlFor ?? "") as HTMLSelectElement | null;
  if (!select) throw new Error(`No field ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function week() {
  return document.querySelector('[aria-label="Your week"]')?.textContent ?? "";
}

function addedActivities() {
  return (services.applyRevisionPlanOps.mock.calls.at(-1)?.[2] ?? []).flatMap((op: { type: string; activity?: object }) =>
    op.type === "add" && op.activity ? [op.activity] : []
  );
}

describe("a running plan's week", () => {
  it("shows what was planned and the usual week's free time, each where it falls", async () => {
    await render(livePlan());
    expect(document.body.textContent).toContain("Week 1 of 6");
    expect(document.body.textContent).toContain("19–25 October");
    expect(week()).toContain("Homeostasis questions");
    // Friday has no timetable of its own yet: its usual sitting is shown as free time, honestly.
    expect(week()).toContain("Free · Biology");
    expect(week()).not.toContain("Jami fills this in on the day");
  });

  it("edits an activity directly: a new time and length, saved as one change", async () => {
    await render(livePlan());
    await click(byLabel(/^Homeostasis questions at 17:00, 30 minutes/));
    const time = [...document.querySelectorAll('input[type="time"]')][0] as HTMLInputElement;
    setField(time, "18:15");
    await click(byLabel("45 min"));
    await click(byLabel("Save"));

    expect(services.applyRevisionPlanOps).toHaveBeenCalledTimes(1);
    const ops = services.applyRevisionPlanOps.mock.calls[0]?.[2];
    expect(ops).toEqual([{ type: "update", dayKey: "2026-10-19", activityId: "hq", patch: { minutes: 45, startTime: "18:15" } }]);
    expect(week()).toContain("18:15 · 45m");
  });

  it("adds the student's own task to any day, and undoes it", async () => {
    await render(livePlan());
    await click(byLabel("Add to Thursday 22"));
    await click(byLabel("Your own task"));
    setField(document.querySelector('input[placeholder="e.g. Finish my homework"]') as HTMLInputElement, "Finish my homework");
    await click(byLabel("Add"));
    expect(week()).toContain("Finish my homework");
    expect(services.applyRevisionPlanOps.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        type: "add",
        dayKey: "2026-10-22",
        activity: expect.objectContaining({ title: "Finish my homework", method: "other", mode: "fixed", origin: "student" }),
      }),
    ]);

    await click(byLabel("Undo adding that"));
    expect(week()).not.toContain("Finish my homework");
  });

  it("adds notebook work with nothing more than its kind and its length", async () => {
    await render(livePlan());
    await click(byLabel("Add to Thursday 22"));
    await click(byLabel("Notebook work"));
    await click(byLabel("45 min"));
    await click(byLabel("Add"));
    expect(week()).toContain("Notebook work");
    expect(addedActivities()).toEqual([
      expect.objectContaining({ title: "Notebook work", method: "notebook", minutes: 45, href: "/dashboard/folders/bio" }),
    ]);
  });

  it("plans notebook work in one notebook, named after it and opening it", async () => {
    await render(livePlan());
    await click(byLabel("Add to Thursday 22"));
    await click(byLabel("Notebook work"));
    // The student's notebooks are read the first time notebook work is chosen.
    await act(async () => undefined);
    choose("Which notebook", "nb-1");
    await click(byLabel("Add"));
    expect(addedActivities()).toEqual([
      expect.objectContaining({ title: "Cell biology", notebookId: "nb-1", href: "/dashboard/notebooks/nb-1", scopeKey: "folder:bio" }),
    ]);
  });

  it("adds a session Jami picks from the subject's own work", async () => {
    await render(livePlan());
    await click(byLabel("Add to Thursday 22"));
    // Jami's pick is the first choice, in the plan's first subject.
    await click(byLabel("Add Jami's pick"));
    expect(week()).toContain("Enzymes");
    expect(addedActivities()).toEqual([expect.objectContaining({ title: "Enzymes", origin: "jami", mode: "adaptive", scopeKey: "folder:bio" })]);
  });

  it("says when Jami has nothing to pick from, and keeps the time free if asked", async () => {
    await render(livePlan());
    await click(byLabel("Add to Thursday 22"));
    choose("Subject", "folder:chem");
    await click(byLabel("Add Jami's pick"));
    expect(document.body.textContent).toContain("Jami has nothing to pick from in Chemistry yet");
    expect(services.applyRevisionPlanOps).not.toHaveBeenCalled();

    await click(byLabel("Keep it as free time"));
    expect(week()).toContain("Free · Chemistry");
  });

  it("fills a free session with Jami's pick from the student's own work, when asked", async () => {
    await render(livePlan());
    await click(byLabel("Let Jami fill the free sessions on Friday 23"));
    expect(week()).toContain("Enzymes");
    const [op] = services.applyRevisionPlanOps.mock.calls[0]?.[2] ?? [];
    expect(op).toMatchObject({ type: "setDay", dayKey: "2026-10-23", ifIds: ["routine-fri"] });
  });

  it("says which subject Jami had nothing for, instead of a fill that does nothing", async () => {
    await render(livePlan({ sessions: [{ id: "fri", weekday: 5, minutes: 45, startTime: "17:00", scopeKey: "folder:chem" }] }));
    await click(byLabel("Let Jami fill the free sessions on Friday 23"));
    expect(services.applyRevisionPlanOps).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Jami has nothing to pick from in Chemistry yet");
  });

  it("reads a day in full and the month at a glance", async () => {
    await render(livePlan());
    await click(byLabel("Day"));
    expect(document.body.textContent).toContain("Today");
    await click(byLabel("Month"));
    expect(document.querySelector('[aria-label="This month"]')).not.toBeNull();
    expect(document.body.textContent).toContain("October 2026");
  });
});

describe("a plan built by hand", () => {
  it("starts from an empty timetable and saves exactly what was put on it", async () => {
    services.createRevisionPlan.mockImplementation(async (_uid: string, id: string, draft: object) => ({ ...livePlan(), ...draft, id }));
    const onPlanSaved = await render(null);
    expect(document.body.textContent).toContain("Your timetable starts here");
    expect(byLabel("Save plan").disabled).toBe(true);

    await click(byLabel("Add a study session"));
    await click(byLabel("Your own task"));
    setField(document.querySelector('input[placeholder="e.g. Finish my homework"]') as HTMLInputElement, "10 algebra questions");
    await click(byLabel("Add"));
    expect(week()).toContain("10 algebra questions");
    // Nothing is written until the plan is saved.
    expect(services.applyRevisionPlanOps).not.toHaveBeenCalled();

    await click(byLabel("Save plan"));
    expect(services.createRevisionPlan).toHaveBeenCalledTimes(1);
    const [, , draft, days] = services.createRevisionPlan.mock.calls[0] ?? [];
    expect(draft.scopes).toEqual([{ folderId: "bio", weight: 1 }]);
    expect([...days.values()][0]).toEqual([expect.objectContaining({ title: "10 algebra questions", origin: "student" })]);
    expect(onPlanSaved).toHaveBeenCalled();
  });

  it("takes the student straight to Jami's first question when they ask to plan with Jami", async () => {
    await render(null);
    await click(byLabel("Plan with Jami"));
    expect(document.activeElement?.getAttribute("placeholder")).toBe("Chemistry Paper 1");
  });
});
