// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalFromDraft, type Goal, type GoalDraft } from "@/lib/goals/model";

const mocks = vi.hoisted(() => ({
  search: new URLSearchParams(),
  replace: vi.fn(),
  getActiveGoalsWithCurrentStatuses: vi.fn(),
  createGoal: vi.fn(),
  editGoal: vi.fn(),
  endGoal: vi.fn(),
  claimGoalRewards: vi.fn(),
  recordTopicReadings: vi.fn(),
  getGoalHistoryPage: vi.fn(),
  loadTopicStandings: vi.fn(),
  loadActiveRevisionPlan: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => mocks.search,
  usePathname: () => "/dashboard/goals",
}));
vi.mock("@/components/providers/UserProvider", () => ({ useUser: () => ({ user: { uid: "user-1" } }) }));
vi.mock("@/services/study/goals", () => ({
  getActiveGoalsWithCurrentStatuses: mocks.getActiveGoalsWithCurrentStatuses,
  createGoal: mocks.createGoal,
  editGoal: mocks.editGoal,
  endGoal: mocks.endGoal,
  claimGoalRewards: mocks.claimGoalRewards,
  recordTopicReadings: mocks.recordTopicReadings,
  getGoalHistoryPage: mocks.getGoalHistoryPage,
}));
vi.mock("@/services/study/decks", () => ({
  getDecks: vi.fn().mockResolvedValue([{ id: "deck-1", name: "Spanish verbs", folderIds: ["spanish"] }]),
}));
vi.mock("@/services/study/topics", () => ({ getActiveTopics: vi.fn().mockResolvedValue([]) }));
vi.mock("@/services/study/folders", () => ({
  getActiveStudyFolders: vi.fn().mockResolvedValue([{ id: "chem", name: "Chemistry", topicIds: [] }]),
}));
vi.mock("@/services/planning/revision-plans", () => ({ loadActiveRevisionPlan: mocks.loadActiveRevisionPlan }));
vi.mock("@/services/learning/study-actions", () => ({
  getCachedStudyActions: () => null,
  readStoredStudyActions: () => null,
  loadStudyActionsForToday: vi.fn().mockRejectedValue(new Error("offline")),
}));
vi.mock("@/services/learning/topic-standing", () => ({ loadTopicStandings: mocks.loadTopicStandings }));
vi.mock("@/services/dashboard/today", () => ({ getCachedDashboardSnapshot: () => null }));

const { default: GoalsPage } = await import("@/app/dashboard/goals/page");

const NOW = Date.now();

function goal(id: string, overrides: Partial<GoalDraft> = {}, progress: Partial<Goal["progress"]> = {}): Goal {
  const made = goalFromDraft(
    id,
    { name: "", measure: "cards", cadence: "total", target: 40, days: 0, scope: { type: "all" }, deadline: 0, ...overrides },
    NOW - 60_000
  );
  return { ...made, progress: { ...made.progress, ...progress } };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<GoalsPage />);
  });
  // The goals load on the next tick, and settle a tick after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string) {
  return [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
}

function radio(label: string) {
  return [...document.querySelectorAll('[role="radio"]')].find((candidate) => candidate.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;
}

/** "New goal" when goals are running; with none, the welcome panel's "Make a goal" is the one button. */
function newGoalButton() {
  return button("New goal") ?? button("Make a goal");
}

async function click(element: Element | undefined) {
  expect(element).toBeDefined();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  mocks.search = new URLSearchParams();
  mocks.getActiveGoalsWithCurrentStatuses.mockResolvedValue([]);
  mocks.claimGoalRewards.mockResolvedValue([]);
  mocks.recordTopicReadings.mockResolvedValue({ changed: [], rewards: [] });
  mocks.getGoalHistoryPage.mockResolvedValue({ items: [], nextCursor: null });
  mocks.loadActiveRevisionPlan.mockResolvedValue(null);
  mocks.loadTopicStandings.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("the goals page", () => {
  it("shows each running goal with where it stands and the way to the work", async () => {
    mocks.getActiveGoalsWithCurrentStatuses.mockResolvedValue([
      goal("spanish", { scope: { type: "deck", id: "deck-1", label: "Spanish verbs" } }, { count: 12 }),
    ]);
    await render();
    expect(document.body.textContent).toContain("1 goal in progress");
    expect(document.body.textContent).toContain("Review 40 cards");
    expect(document.body.textContent).toContain("12 of 40 cards");
    const review = [...document.querySelectorAll("a")].find((link) => link.textContent?.includes("Review cards"));
    expect(review?.getAttribute("href")).toBe("/dashboard/study?mode=custom&decks=deck-1");
    expect(document.querySelector('[data-tutorial-target="new-goal"]')).not.toBeNull();
  });

  it("welcomes a student with no goals and offers ideas to start from", async () => {
    await render();
    expect(document.body.textContent).toContain("Give your revision something to aim at");
    expect(document.body.textContent).toContain("A week-long habit");
    // One button to make a goal, which is where the first-night note points.
    expect(button("New goal")).toBeUndefined();
    expect(document.querySelectorAll('[data-tutorial-target="new-goal"]')).toHaveLength(1);
    await click([...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Set this up")));
    expect(document.getElementById("goal-composer")).not.toBeNull();
    expect(document.body.textContent).toContain("cards a day");
  });

  it("opens the composer on the kind picked from the welcome, with quick starts that fill it in", async () => {
    mocks.createGoal.mockImplementation(async (_uid: string, draft: GoalDraft) => goalFromDraft("made", draft, NOW));
    await render();
    await click([...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Practice questions")));
    expect(radio("Practice questions")?.getAttribute("aria-checked")).toBe("true");

    const quick = (title: string) =>
      [...document.querySelectorAll("button[aria-pressed]")].find((candidate) => candidate.textContent?.startsWith(title));
    expect(quick("Review 100 cards")?.getAttribute("aria-pressed")).toBe("false");
    await click(quick("Review 100 cards"));
    expect(quick("Review 100 cards")?.getAttribute("aria-pressed")).toBe("true");
    expect(radio("Flashcards")?.getAttribute("aria-checked")).toBe("true");
    await click(button("Create goal"));
    expect(mocks.createGoal).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ measure: "cards", cadence: "total", target: 100, scope: { type: "all" } })
    );
  });

  it("makes a goal from the composer, with the star it will earn beside it", async () => {
    mocks.createGoal.mockImplementation(async (_uid: string, draft: GoalDraft) => goalFromDraft("made", draft, NOW));
    await render();
    await click(newGoalButton());
    expect(document.querySelector('[data-tutorial-target="create-goal"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Finish it to earn this star");
    await click(radio("Practice questions"));
    expect(document.body.textContent).toContain("Answer 10 practice questions");
    await click(button("Create goal"));
    expect(mocks.createGoal).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ measure: "questions", cadence: "total", target: 10, scope: { type: "all" } })
    );
    expect(document.getElementById("goal-composer")).toBeNull();
    expect(document.body.textContent).toContain("Goal set. Finish it to earn its star.");
    expect(document.body.textContent).toContain("1 goal in progress");
  });

  it("turns a goal into a daily habit with a number of days", async () => {
    mocks.createGoal.mockImplementation(async (_uid: string, draft: GoalDraft) => goalFromDraft("made", draft, NOW));
    await render();
    await click(newGoalButton());
    await click(radio("Every day"));
    expect(document.body.textContent).toContain("On how many days?");
    await click(button("Create goal"));
    expect(mocks.createGoal).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ measure: "cards", cadence: "daily", target: 20, days: 5, deadline: 0 })
    );
  });

  it("uses a real date field when a date is picked", async () => {
    await render();
    await click(newGoalButton());
    await click(radio("Pick a date"));
    const label = [...document.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === "Finish by");
    const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
    expect(input?.getAttribute("type")).toBe("date");
    expect(input?.className).toContain("date-field-native");
  });

  it("asks for a folder before a topic goal can be made", async () => {
    await render();
    await click(newGoalButton());
    await click(radio("A topic"));
    expect(document.body.textContent).toContain("Choose the folder the topic is in.");
    expect(button("Create goal")?.disabled).toBe(true);
  });

  it("ends a goal only after asking, and keeps it in past goals", async () => {
    mocks.getActiveGoalsWithCurrentStatuses.mockResolvedValue([goal("g1")]);
    mocks.endGoal.mockResolvedValue(undefined);
    await render();
    await click(document.querySelector('[aria-label="End Review 40 cards"]') ?? undefined);
    expect(document.body.textContent).toContain("End this goal?");
    expect(mocks.endGoal).not.toHaveBeenCalled();
    await click(button("End goal"));
    expect(mocks.endGoal).toHaveBeenCalledWith("user-1", "g1");
    expect(document.body.textContent).toContain("Nothing running yet");
  });

  it("reads past goals only when they are opened, and can start one again", async () => {
    const past = { ...goal("old", { target: 25 }), status: "completed" as const, completedAt: NOW - 1000 };
    mocks.getGoalHistoryPage.mockResolvedValue({ items: [past], nextCursor: null });
    await render();
    expect(mocks.getGoalHistoryPage).not.toHaveBeenCalled();
    await click([...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Past goals")));
    expect(mocks.getGoalHistoryPage).toHaveBeenCalledWith("user-1", { cursor: null, pageSize: 30 });
    expect(document.body.textContent).toContain("Completed");
    await click(button("Go again"));
    expect(document.getElementById("goal-composer")).not.toBeNull();
    expect(document.body.textContent).toContain("Review 25 cards");
  });

  it("opens the composer set up for an exam when a plan links here", async () => {
    const examDay = new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mocks.search = new URLSearchParams({
      new: "1",
      plan: "plan-1",
      exam: "chem-1",
      examLabel: "Chemistry Paper 1",
      examDay,
      folder: "chem",
      folderName: "Chemistry",
    });
    await render();
    expect(document.getElementById("goal-composer")).not.toBeNull();
    expect(document.body.textContent).toContain("practice questions");
    expect(radio("Before Chemistry Paper 1")?.getAttribute("aria-checked")).toBe("true");
    expect(mocks.replace).toHaveBeenCalledWith("/dashboard/goals", { scroll: false });
  });

  it("asks the engine where a topic goal's topic stands, and records it", async () => {
    const topicGoal = goal("topic-goal", {
      measure: "topic",
      scope: { type: "folder", id: "chem", label: "Chemistry" },
      topic: { key: "topic:bonding", label: "Bonding" },
    });
    mocks.getActiveGoalsWithCurrentStatuses.mockResolvedValue([topicGoal]);
    mocks.loadTopicStandings.mockResolvedValue([
      { key: "topic:bonding", label: "Bonding", demonstration: "developing", action: { label: "Practise", href: "/dashboard/practice/questions/new?folderId=chem" } },
    ]);
    mocks.recordTopicReadings.mockImplementation(async () => ({
      changed: [{ ...topicGoal, progress: { ...topicGoal.progress, demonstration: "developing" } }],
      rewards: [],
    }));
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.loadTopicStandings).toHaveBeenCalledWith("chem");
    expect(mocks.recordTopicReadings).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Developing");
    const next = [...document.querySelectorAll("a")].find((link) => link.textContent?.includes("Practise"));
    expect(next?.getAttribute("href")).toBe("/dashboard/practice/questions/new?folderId=chem");
  });
});
