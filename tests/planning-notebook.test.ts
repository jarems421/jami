import { describe, expect, it } from "vitest";
import { MAX_PLAN_SESSION_MINUTES } from "@/lib/planning/plan-activities";
import {
  formatPlanSessionClock,
  notebookPlanActivities,
  planSessionMinutes,
  planSessionSecondsLeft,
  readPlanNotebookSession,
} from "@/lib/planning/plan-notebook";
import { planActivity } from "./support/plan-fixtures";

/**
 * Planned notebook work, waiting in the notebook it is for: the work set in
 * this notebook first, then work set for any notebook in its folder, timed
 * honestly, and a session nobody finished never ticked at the wrong length.
 */

const notebook = { id: "nb-1", folderId: "biology" };

describe("which planned work a notebook offers", () => {
  it("offers its own work first, then its folder's, and nothing else", () => {
    const day = {
      activities: [
        planActivity({ id: "folder-work", title: "Notebook work", method: "notebook", scopeKey: "folder:biology" }),
        planActivity({ id: "this-one", title: "Cell biology", method: "notebook", notebookId: "nb-1", scopeKey: "folder:biology" }),
        planActivity({ id: "other-notebook", title: "Enzymes", method: "notebook", notebookId: "nb-2", scopeKey: "folder:biology" }),
        planActivity({ id: "other-folder", title: "Bonding", method: "notebook", scopeKey: "folder:chemistry" }),
        planActivity({ id: "questions", title: "Homeostasis", method: "practice", scopeKey: "folder:biology" }),
        planActivity({ id: "free", title: "", method: "notebook", open: true, scopeKey: "folder:biology" }),
      ],
    };
    expect(notebookPlanActivities(day, notebook).map((activity) => activity.id)).toEqual(["this-one", "folder-work"]);
    expect(notebookPlanActivities(null, notebook)).toEqual([]);
  });
});

describe("timing a session", () => {
  const start = Date.UTC(2026, 9, 20, 17, 0, 0);

  it("counts whole minutes, at least one, never more than a sitting could be", () => {
    expect(planSessionMinutes(start, start + 28 * 60_000 + 20_000)).toBe(28);
    expect(planSessionMinutes(start, start + 10_000)).toBe(1);
    expect(planSessionMinutes(start, start + 20 * 60 * 60_000)).toBe(MAX_PLAN_SESSION_MINUTES);
  });

  it("shows the time left, then the time over", () => {
    expect(formatPlanSessionClock(planSessionSecondsLeft(start, 30, start + 11 * 60_000 + 56_000))).toBe("18:04");
    expect(formatPlanSessionClock(planSessionSecondsLeft(start, 30, start + 32 * 60_000 + 10_000))).toBe("+2:10");
    expect(formatPlanSessionClock(planSessionSecondsLeft(start, 90, start))).toBe("1:30:00");
  });

  it("reads back a session this device kept, unless nobody finished it", () => {
    const kept = { planId: "plan-1", dayKey: "2026-10-20", activityId: "this-one", startedAt: start };
    expect(readPlanNotebookSession(kept, start + 60_000)).toEqual(kept);
    expect(readPlanNotebookSession(kept, start + (MAX_PLAN_SESSION_MINUTES + 1) * 60_000)).toBeNull();
    expect(readPlanNotebookSession({ ...kept, activityId: "" }, start)).toBeNull();
    expect(readPlanNotebookSession("nonsense", start)).toBeNull();
  });
});
