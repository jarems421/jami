import { describe, expect, it } from "vitest";
import {
  isInStudentWords,
  methodFromTitle,
  parsePlanProposalChanges,
  planProposalOps,
  summarizePlanProposal,
  type PlanProposalParseContext,
} from "@/lib/planning/plan-proposal";
import type { PlanDraftingContext } from "@/lib/planning/plan-drafting";
import { openActivityFromFreeSession, planFreeSessionsOn } from "@/lib/planning/timetable";
import { MONDAY, TUESDAY, WEDNESDAY, planActivity, revisionPlan, studyAction } from "./support/plan-fixtures";

/**
 * Changes Jami proposes to the timetable. What the model may decide is held in
 * code: refs it was shown, dates that exist, titles in the student's words.
 */

const parseContext = (studentText: string): PlanProposalParseContext => ({
  activityRefs: new Map([
    ["A1", { dayKey: MONDAY, activityId: "bio-1", done: false }],
    ["A2", { dayKey: MONDAY, activityId: "bio-2", done: false }],
    ["A3", { dayKey: MONDAY, activityId: "done-1", done: true }],
  ]),
  subjectRefs: new Map([
    ["S1", "folder:biology"],
    ["S2", "folder:chemistry"],
  ]),
  todayDayKey: MONDAY,
  studentText,
});

describe("the student's own words", () => {
  it("keeps a title only when its topic is something the student said", () => {
    const said = "I want to revise Biology on Monday at 5pm, do 20 minutes of homeostasis practice, and finish with flashcards.";
    expect(isInStudentWords("Homeostasis practice", said)).toBe(true);
    expect(isInStudentWords("Biology flashcards", said)).toBe(true);
    // A title of method words names no topic, so it cannot have invented one.
    expect(isInStudentWords("Practice questions", "add something on Friday")).toBe(true);
    expect(isInStudentWords("Photosynthesis questions", said)).toBe(false);
    // Plurals and tenses of what they said count; a near synonym does not.
    expect(isInStudentWords("Quadratic homework", "can you add my quadratics homework")).toBe(true);
    expect(isInStudentWords("Quadratic equations", "can you add my quadratics homework")).toBe(false);
  });

  it("reads how a named task is done from its words", () => {
    expect(methodFromTitle("Homeostasis exam questions")).toBe("practice");
    expect(methodFromTitle("Review flashcards")).toBe("flashcards");
    expect(methodFromTitle("Read chapter 4 notes")).toBe("notes");
    expect(methodFromTitle("Finish my homework")).toBe("other");
  });
});

describe("reading Jami's proposal", () => {
  it("keeps the changes whose refs and dates are real, and drops the rest", () => {
    const changes = parsePlanProposalChanges(
      [
        { op: "add", date: MONDAY, time: "17:00", minutes: 20, subject: "S1", title: "Homeostasis practice" },
        { op: "add", date: MONDAY, time: "17:20", minutes: 15, subject: "S1", method: "flashcards" },
        { op: "move", id: "A1", date: WEDNESDAY },
        { op: "move", id: "A9", date: WEDNESDAY },
        { op: "move", id: "A3", date: WEDNESDAY },
        { op: "remove", id: "A2" },
        { op: "clear", date: "2026-10-18" },
        { op: "fill", from: MONDAY, to: "2026-10-25" },
        { op: "teleport", id: "A1" },
      ],
      parseContext("Biology on Monday at 5pm, 20 minutes of homeostasis practice, then flashcards")
    );
    expect(changes).toEqual([
      { kind: "add", dayKey: MONDAY, startTime: "17:00", minutes: 20, scopeKey: "folder:biology", title: "Homeostasis practice", method: "practice" },
      // No title: Jami's pick for the subject, chosen by the engine when it is applied.
      { kind: "add", dayKey: MONDAY, startTime: "17:20", minutes: 15, scopeKey: "folder:biology" },
      { kind: "move", dayKey: MONDAY, activityId: "bio-1", toDayKey: WEDNESDAY },
      { kind: "remove", dayKey: MONDAY, activityId: "bio-2" },
      { kind: "fill", fromDayKey: MONDAY, toDayKey: "2026-10-25" },
    ]);
  });

  it("turns a topic the student never mentioned into Jami's pick", () => {
    const [change] = parsePlanProposalChanges(
      [{ op: "add", date: TUESDAY, minutes: 30, subject: "S1", title: "Photosynthesis questions" }],
      parseContext("add some biology tomorrow")
    );
    expect(change).toEqual({ kind: "add", dayKey: TUESDAY, minutes: 30, scopeKey: "folder:biology" });
  });

  it("never lets one sentence fill more than six weeks", () => {
    expect(parsePlanProposalChanges([{ op: "fill", from: MONDAY, to: "2027-01-30" }], parseContext(""))).toEqual([]);
  });
});

describe("saying what it would do", () => {
  const summaryContext = {
    activityOf: (_dayKey: string, activityId: string) =>
      activityId === "bio-1"
        ? { title: "Homeostasis", scopeKey: "folder:biology" }
        : { title: "Review your cards", scopeKey: "folder:biology" },
    scopeName: (scopeKey: string) => (scopeKey === "folder:biology" ? "Biology" : "Chemistry"),
  };

  it("leads with what the student asked for: two sessions moved from Monday to Wednesday", () => {
    const summary = summarizePlanProposal(
      [
        { kind: "move", dayKey: MONDAY, activityId: "bio-1", toDayKey: WEDNESDAY },
        { kind: "move", dayKey: MONDAY, activityId: "bio-2", toDayKey: WEDNESDAY },
      ],
      summaryContext
    );
    expect(summary.headline).toBe("Move 2 activities · Mon → Wed");
    expect(summary.lines).toEqual([
      "Move Homeostasis · Mon 19 Oct → Wed 21 Oct",
      "Move Review your cards · Mon 19 Oct → Wed 21 Oct",
    ]);
  });

  it("names Jami's picks and rest days plainly", () => {
    const summary = summarizePlanProposal(
      [
        { kind: "add", dayKey: MONDAY, startTime: "17:20", minutes: 15, scopeKey: "folder:biology" },
        { kind: "clear", dayKey: TUESDAY },
      ],
      summaryContext
    );
    expect(summary.headline).toBe("2 changes");
    expect(summary.lines).toEqual(["Add Biology (Jami's pick) · Mon 19 Oct, 17:20 · 15 min", "Clear Tue 20 Oct — a rest day"]);
  });
});

describe("applying it", () => {
  const plan = revisionPlan();
  const drafting: PlanDraftingContext = {
    actionsByScope: new Map([["folder:biology", [studyAction("homeostasis"), studyAction("enzymes")]]]),
    support: new Map([["folder:biology", { deckIds: ["bio-deck"], cardCount: 30 }]]),
    random: (() => {
      let next = 0;
      return () => (next += 1) / 1000;
    })(),
  };
  const activitiesOn = (dayKey: string) =>
    dayKey === MONDAY
      ? [planActivity({ id: "bio-1", title: "Homeostasis", startTime: "17:00", mode: "adaptive", origin: "jami", actionId: "folder:biology|low_mastery|topic:homeostasis" })]
      : planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession);

  it("makes the same ops the timetable's own controls make", () => {
    const ops = planProposalOps(
      [
        { kind: "add", dayKey: TUESDAY, startTime: "17:00", minutes: 20, scopeKey: "folder:biology", title: "Homeostasis practice", method: "practice" },
        { kind: "add", dayKey: TUESDAY, startTime: "17:20", minutes: 15, scopeKey: "folder:biology", method: "flashcards" },
        { kind: "move", dayKey: MONDAY, activityId: "bio-1", toDayKey: WEDNESDAY },
        { kind: "clear", dayKey: TUESDAY },
      ],
      { activitiesOn, drafting }
    );
    expect(ops.map((op) => op.type)).toEqual(["add", "add", "move", "clearDay"]);
    expect(ops[0]).toMatchObject({ activity: { title: "Homeostasis practice", mode: "fixed", origin: "student", method: "practice" } });
    // Jami's pick comes from the engine, never from the model.
    expect(ops[1]).toMatchObject({ activity: { title: "Homeostasis", mode: "adaptive", origin: "jami" } });
  });

  it("fills a range from the engine, day by day, without repeating what is already there", () => {
    const ops = planProposalOps([{ kind: "fill", fromDayKey: MONDAY, toDayKey: "2026-10-25" }], { activitiesOn, drafting });
    // Wednesday is Chemistry's turn and Jami has nothing it can set there, so it stays free time.
    expect(ops.map((op) => (op.type === "setDay" ? op.dayKey : op.type))).toEqual(["2026-10-23"]);
    const friday = ops[0]?.type === "setDay" ? (ops[0].activities ?? []) : [];
    // Homeostasis is already on Monday.
    expect(friday.map((activity) => activity.title)).toEqual(["Enzymes", "Review your cards"]);
  });
});
