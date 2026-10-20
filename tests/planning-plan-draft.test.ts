import { describe, expect, it } from "vitest";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";

const NOW = Date.parse("2026-09-14T09:00:00Z");

describe("normalising a plan", () => {
  it("keeps a plan the student built", () => {
    const { draft, valid, problems } = normalizeRevisionPlanDraft(
      {
        title: "  Summer exams  ",
        scopes: [{ folderId: "biology", weight: 2 }],
        sessions: [{ id: "w1", weekday: 1, minutes: 45 }],
        startDayKey: "2026-09-14",
        endDayKey: "2026-10-12",
      },
      NOW
    );

    expect(valid).toBe(true);
    expect(problems).toEqual([]);
    expect(draft.title).toBe("Summer exams");
    expect(draft.scopes).toEqual([{ folderId: "biology", weight: 2 }]);
  });

  it("refuses to trust anything a draft arrives with", () => {
    /*
     * The student's own builder is bounded by its controls, so most of this
     * only ever fires for a plan a language model wrote. Running both through
     * one gate means the builder is never the only thing between a bad value
     * and Firestore.
     */
    const { draft } = normalizeRevisionPlanDraft(
      {
        title: "x".repeat(500),
        origin: "tutor",
        scopes: [
          { folderId: "biology", weight: 99 },
          { folderId: "biology", weight: 1 },
          { weight: 2 } as never,
          { deckId: "spanish", weight: -4 },
        ],
        sessions: [
          { id: "a", weekday: 1, minutes: 9000 },
          { id: "b", weekday: 1, minutes: 30 },
          { id: "c", weekday: 42 as never, minutes: 30 },
        ],
      },
      NOW
    );

    expect(draft.title.length).toBe(80);
    // Duplicates dropped, scopes with no subject dropped, weights clamped.
    expect(draft.scopes).toEqual([
      { folderId: "biology", weight: 3 },
      { deckId: "spanish", weight: 1 },
    ]);
    // Both Monday sittings kept -- version 2 can hold a second one -- with the
    // absurd length clamped and the nonsense weekday gone.
    expect(draft.sessions).toEqual([
      { id: "a", weekday: 1, minutes: 240 },
      { id: "b", weekday: 1, minutes: 30 },
    ]);
  });

  it("drops emphasis on a subject the plan does not cover", () => {
    const { draft } = normalizeRevisionPlanDraft(
      {
        scopes: [{ folderId: "biology", weight: 1 }],
        sessions: [{ id: "w1", weekday: 1, minutes: 30 }],
        emphasis: [
          { scopeKey: "folder:biology", wants: "diagnose", note: "enzymes confuse me" },
          { scopeKey: "folder:physics", wants: "practice" },
        ],
      },
      NOW
    );

    expect(draft.emphasis).toEqual([
      { scopeKey: "folder:biology", wants: "diagnose", note: "enzymes confuse me" },
    ]);
  });

  it("says what is missing without throwing the rest away", () => {
    // A half-finished plan still renders what has been set, so the problems
    // read as guidance rather than as a wall.
    const { draft, problems, valid } = normalizeRevisionPlanDraft(
      { title: "Mocks", scopes: [], sessions: [] },
      NOW
    );

    expect(valid).toBe(false);
    expect(problems).toEqual(["no-scopes", "no-sessions"]);
    expect(draft.title).toBe("Mocks");
  });

  it("catches a finish date before the start", () => {
    const { problems } = normalizeRevisionPlanDraft(
      {
        scopes: [{ folderId: "biology", weight: 1 }],
        sessions: [{ id: "w1", weekday: 1, minutes: 30 }],
        startDayKey: "2026-10-12",
        endDayKey: "2026-09-14",
      },
      NOW
    );
    expect(problems).toContain("bad-dates");
  });
});

describe("a week with times on it", () => {
  const base = {
    scopes: [
      { folderId: "biology", weight: 1 },
      { folderId: "chemistry", weight: 1 },
    ],
  };

  it("keeps a time, a subject and a name when they are given", () => {
    const { draft, valid } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [
          {
            id: "after-school",
            weekday: 1,
            minutes: 45,
            startTime: "16:30",
            scopeKey: "folder:chemistry",
            label: "After school",
          },
        ],
      },
      NOW
    );

    expect(valid).toBe(true);
    expect(draft.sessions).toEqual([
      {
        id: "after-school",
        weekday: 1,
        minutes: 45,
        startTime: "16:30",
        scopeKey: "folder:chemistry",
        label: "After school",
      },
    ]);
  });

  it("drops a bad time without dropping the sitting", () => {
    // Somebody who typed something odd into the clock still meant to study
    // that day, and deleting the evening would be a strange way to say so.
    const { draft } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [{ id: "a", weekday: 1, minutes: 45, startTime: "25:99" }],
      },
      NOW
    );
    expect(draft.sessions).toEqual([{ id: "a", weekday: 1, minutes: 45 }]);
  });

  it("drops a sitting pinned to a subject the plan does not cover", () => {
    const { draft } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [{ id: "a", weekday: 1, minutes: 45, scopeKey: "folder:physics" }],
      },
      NOW
    );
    // The sitting stays; only the stray reference goes, and the plan's own
    // weighting decides what it is for.
    expect(draft.sessions[0]?.scopeKey).toBeUndefined();
  });

  it("holds more than one sitting a day, up to a point", () => {
    const { draft } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [
          { id: "a", weekday: 1, minutes: 30 },
          { id: "b", weekday: 1, minutes: 30 },
          { id: "c", weekday: 1, minutes: 30 },
          { id: "d", weekday: 1, minutes: 30 },
          { id: "e", weekday: 1, minutes: 30 },
        ],
      },
      NOW
    );
    expect(draft.sessions).toHaveLength(4);
  });

  it("gives a sitting an id when it arrives without one, or with a taken one", () => {
    const { draft } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [
          { weekday: 1, minutes: 30 } as never,
          { id: "same", weekday: 1, minutes: 30 },
          { id: "same", weekday: 3, minutes: 30 },
        ],
      },
      NOW
    );
    const ids = draft.sessions.map((session) => session.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(Boolean)).toBe(true);
  });

  it("says two sittings clash, and saves it anyway", () => {
    /*
     * A clash is usually somebody halfway through rearranging their week, and
     * refusing to save would trap them there. It is worth saying once and then
     * getting out of the way.
     */
    const { problems, valid } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [
          { id: "a", weekday: 1, minutes: 60, startTime: "16:30" },
          { id: "b", weekday: 1, minutes: 30, startTime: "17:00" },
        ],
      },
      NOW
    );
    expect(problems).toContain("overlapping-sessions");
    expect(valid).toBe(true);
  });

  it("does not invent a clash between sittings with no times", () => {
    const { problems } = normalizeRevisionPlanDraft(
      {
        ...base,
        sessions: [
          { id: "a", weekday: 1, minutes: 60 },
          { id: "b", weekday: 1, minutes: 30 },
        ],
      },
      NOW
    );
    expect(problems).not.toContain("overlapping-sessions");
  });
});
