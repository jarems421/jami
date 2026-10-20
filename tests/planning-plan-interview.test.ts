import { describe, expect, it } from "vitest";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import {
  answerPlanStep,
  applyJamiReply,
  describeExamChoice,
  describeSubjectChoice,
  describeWeekChoice,
  jumpToPlanStep,
  mergePlanStepProposal,
  planStepQuestion,
  planWithDayToggled,
  planWithExams,
  planWithNoExams,
  planWithSessionLength,
  planWithSubjectPriority,
  recordStudentMessage,
  startPlanInterview,
  type PlanInterviewContext,
} from "@/lib/planning/plan-interview";
import type { RevisionPlanDraft } from "@/lib/planning/types";

/**
 * The planning interview's rules, which the model does not get a say in: the
 * order of the questions, which part of the plan each answer may change, and
 * that nothing starts before the last check.
 */

const CONTEXT: PlanInterviewContext = {
  notices: [
    {
      scopeKey: "folder:bio",
      subject: "Biology",
      detail: "Enzymes has been slipping",
      reason: "declining_mastery",
    },
  ],
  scopeNames: new Map([
    ["folder:chem", "Chemistry"],
    ["folder:bio", "Biology"],
  ]),
};

function empty() {
  return normalizeRevisionPlanDraft({ startDayKey: "2026-09-25" }).draft;
}

function full(): RevisionPlanDraft {
  return normalizeRevisionPlanDraft({
    title: "Mocks",
    startDayKey: "2026-09-25",
    endDayKey: "2026-11-14",
    scopes: [
      { folderId: "chem", weight: 2 },
      { folderId: "bio", weight: 3 },
    ],
    sessions: [
      { id: "a", weekday: 1, minutes: 45 },
      { id: "b", weekday: 3, minutes: 45 },
    ],
    exams: [{ id: "e1", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chem" }],
  }).draft;
}

describe("the order of the questions", () => {
  it("opens on what the student is working towards", () => {
    const state = startPlanInterview({ context: CONTEXT });
    expect(state.step).toBe("goal");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.text).toContain("What are you working towards?");
  });

  it("walks goal, subjects, week and anything else, then stops at the last check", () => {
    let state = startPlanInterview({ context: CONTEXT, draft: empty() });
    state = answerPlanStep(state, "No exams coming up", planWithNoExams(state.draft), CONTEXT);
    expect(state.step).toBe("subjects");
    state = answerPlanStep(state, "Chemistry", planWithSubjectPriority(state.draft, { folderId: "chem" }, 2), CONTEXT);
    expect(state.step).toBe("time");
    state = answerPlanStep(state, "Mon", planWithDayToggled(state.draft, 1), CONTEXT);
    expect(state.step).toBe("extras");
    state = answerPlanStep(state, "Nothing else", state.draft, CONTEXT);
    expect(state.step).toBe("review");
    expect(state.turns.at(-1)?.text).toContain("There's your timetable.");
  });

  it("opens a running plan's change on the last check, asking what to change", () => {
    const state = startPlanInterview({ context: CONTEXT, draft: full(), reshaping: true });
    expect(state.step).toBe("review");
    expect(state.turns[0]?.text).toContain("What would you like to change?");
  });

  it("goes back to an earlier question without losing the plan", () => {
    let state = startPlanInterview({ context: CONTEXT, draft: full() });
    state = { ...state, step: "extras" };
    state = jumpToPlanStep(state, "subjects", CONTEXT);
    expect(state.step).toBe("subjects");
    expect(state.draft.scopes).toHaveLength(2);
    expect(state.turns.at(-1)?.question).toBe(true);
  });
});

describe("what Jami says", () => {
  it("says what the Learning Engine noticed when asking about subjects, as a sentence", () => {
    const question = planStepQuestion("subjects", empty(), CONTEXT);
    expect(question).toContain("From your answers in Biology: Enzymes has been slipping.");
  });

  it("says which subjects the exams already put in", () => {
    const withExam = planWithExams(empty(), [
      { id: "e1", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chem" },
    ]);
    expect(planStepQuestion("subjects", withExam, CONTEXT)).toContain("I've put Chemistry in because of your exams.");
  });
});

describe("answers given by tapping", () => {
  it("runs a plan until its last exam and puts the exam's subject in it", () => {
    const draft = planWithExams(empty(), [
      { id: "e1", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chem" },
      { id: "e2", label: "Biology Paper 1", dayKey: "2026-11-14" },
    ]);
    expect(draft.endDayKey).toBe("2026-11-14");
    expect(draft.scopes.map((scope) => scope.folderId)).toEqual(["chem"]);
    // The exam stays tied to its subject, which only works if the plan covers it.
    expect(draft.exams?.[0]?.scopeKey).toBe("folder:chem");
    expect(describeExamChoice(draft)).toBe("Chemistry Paper 1 on Thu 12 Nov, Biology Paper 1 on Sat 14 Nov");
  });

  it("leaves out an exam row that has no name yet", () => {
    const draft = planWithExams(empty(), [
      { id: "e1", label: "", dayKey: "2026-11-12" },
      { id: "e2", label: "Physics", dayKey: "2026-11-20" },
    ]);
    expect(draft.exams?.map((exam) => exam.label)).toEqual(["Physics"]);
    expect(draft.title).toBe("Physics");
  });

  it("plans four weeks when there are no exams", () => {
    const draft = planWithNoExams(empty());
    expect(draft.exams ?? []).toEqual([]);
    expect(draft.endDayKey).toBe("2026-10-22");
  });

  it("weights, reweights and removes a subject", () => {
    let draft = planWithSubjectPriority(empty(), { folderId: "bio" }, 3);
    expect(draft.scopes).toEqual([{ folderId: "bio", weight: 3 }]);
    draft = planWithSubjectPriority(draft, { folderId: "bio" }, 1);
    expect(draft.scopes).toEqual([{ folderId: "bio", weight: 1 }]);
    draft = planWithSubjectPriority(draft, { folderId: "bio" }, 0);
    expect(draft.scopes).toEqual([]);
  });

  it("turns days on and off and sets one length for every sitting", () => {
    let draft = planWithDayToggled(empty(), 1, 30);
    draft = planWithDayToggled(draft, 3);
    expect(draft.sessions.map((session) => [session.weekday, session.minutes])).toEqual([
      [1, 30],
      [3, 30],
    ]);
    draft = planWithSessionLength(draft, 60);
    expect(describeWeekChoice(draft)).toBe("Mon, Wed · 60 min");
    draft = planWithDayToggled(draft, 1);
    expect(draft.sessions.map((session) => session.weekday)).toEqual([3]);
  });

  it("keeps a day's timed sittings when another day is toggled", () => {
    const timed = normalizeRevisionPlanDraft({
      ...empty(),
      sessions: [
        { id: "a", weekday: 1, minutes: 45, startTime: "16:30" },
        { id: "b", weekday: 1, minutes: 30, startTime: "18:00" },
      ],
    }).draft;
    const draft = planWithDayToggled(timed, 5);
    expect(draft.sessions.filter((session) => session.weekday === 1)).toHaveLength(2);
    expect(draft.sessions.some((session) => session.weekday === 5)).toBe(true);
  });

  it("says the subjects back with the heaviest first", () => {
    expect(describeSubjectChoice(full(), CONTEXT.scopeNames)).toBe("Biology (most), Chemistry");
  });
});

describe("an answer only changes its own part of the plan", () => {
  it("does not let the week question rewrite the exams or subjects", () => {
    const proposed = normalizeRevisionPlanDraft({
      startDayKey: "2026-09-25",
      scopes: [{ folderId: "bio", weight: 1 }],
      sessions: [{ id: "x", weekday: 2, minutes: 60 }],
    }).draft;
    const merged = mergePlanStepProposal("time", full(), proposed);
    expect(merged.sessions.map((session) => session.weekday)).toEqual([2]);
    expect(merged.scopes).toHaveLength(2);
    expect(merged.exams).toHaveLength(1);
  });

  it("ignores a subjects answer that came back with no subjects", () => {
    const merged = mergePlanStepProposal("subjects", full(), empty());
    expect(merged.scopes).toHaveLength(2);
  });

  it("keeps subjects, days and exams at the last check when the model leaves them out", () => {
    const proposed = normalizeRevisionPlanDraft({ title: "Mocks, lighter", startDayKey: "2026-09-25" }).draft;
    const merged = mergePlanStepProposal("review", full(), proposed);
    expect(merged.title).toBe("Mocks, lighter");
    expect(merged.scopes).toHaveLength(2);
    expect(merged.sessions).toHaveLength(2);
    expect(merged.exams).toHaveLength(1);
  });

  it("keeps a name the student gave when the answer comes back unnamed", () => {
    const proposed = normalizeRevisionPlanDraft({ startDayKey: "2026-09-25", endDayKey: "2026-12-01" }).draft;
    const merged = mergePlanStepProposal("goal", full(), proposed);
    expect(merged.title).toBe("Mocks");
    expect(merged.endDayKey).toBe("2026-12-01");
  });
});

describe("typed answers", () => {
  it("moves on once the answer gives the step what it needs", () => {
    let state = startPlanInterview({ context: CONTEXT, draft: planWithNoExams(empty()) });
    state = answerPlanStep(state, "No exams", state.draft, CONTEXT);
    state = recordStudentMessage(state, "Mostly biology");
    state = applyJamiReply(
      state,
      {
        text: "Biology gets the most time.",
        proposal: planWithSubjectPriority(state.draft, { folderId: "bio" }, 3),
      },
      CONTEXT
    );
    expect(state.step).toBe("time");
    expect(state.turns.map((turn) => turn.text).slice(-3)).toEqual([
      "Mostly biology",
      "Biology gets the most time.",
      expect.stringContaining("When can you study?"),
    ]);
  });

  it("stays on the step while Jami asks again", () => {
    let state = startPlanInterview({ context: CONTEXT, draft: planWithNoExams(empty()) });
    state = answerPlanStep(state, "No exams", state.draft, CONTEXT);
    state = applyJamiReply(state, { text: "Which subjects matter most?", proposal: null }, CONTEXT);
    expect(state.step).toBe("subjects");
    state = applyJamiReply(state, { text: "Still not sure which?", proposal: null }, CONTEXT);
    // Subjects cannot be skipped: a plan with none cannot start.
    expect(state.step).toBe("subjects");
  });

  it("moves past a question that can be skipped rather than asking a third time", () => {
    let state = startPlanInterview({ context: CONTEXT, draft: empty() });
    state = applyJamiReply(state, { text: "When are your exams?", proposal: null }, CONTEXT);
    expect(state.step).toBe("goal");
    state = applyJamiReply(state, { text: "Any date at all?", proposal: null }, CONTEXT);
    expect(state.step).toBe("subjects");
  });

  it("asks again at the last check after making a change, and never starts the plan itself", () => {
    let state = startPlanInterview({ context: CONTEXT, draft: full(), reshaping: true });
    state = applyJamiReply(
      state,
      { text: "Moved Wednesday to Thursday.", proposal: planWithDayToggled(planWithDayToggled(full(), 3), 4) },
      CONTEXT
    );
    expect(state.step).toBe("review");
    expect(state.draft.sessions.map((session) => session.weekday)).toEqual([1, 4]);
    expect(state.turns.at(-1)?.text).toBe("Anything else to change, or is it ready to save?");
  });
});

describe("exams already given", () => {
  it("survive an answer about the goal that left them out", () => {
    const proposed = normalizeRevisionPlanDraft({ title: "Mocks", startDayKey: "2026-09-25", endDayKey: "2026-12-10" }).draft;
    const merged = mergePlanStepProposal("goal", full(), proposed);
    expect(merged.exams?.map((exam) => exam.label)).toEqual(["Chemistry Paper 1"]);
    expect(merged.endDayKey).toBe("2026-12-10");
  });
});
