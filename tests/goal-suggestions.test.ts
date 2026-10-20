import { describe, expect, it } from "vitest";
import { endOfStudyDay, goalDeadlineDayKey, thisWeekDeadline } from "@/lib/goals/deadlines";
import {
  applyDeadlineChoice,
  blankGoalDraft,
  deadlineChoiceOf,
  goalPaceHint,
  goalPlanSentence,
  repeatGoalDraft,
  withCadence,
  withMeasure,
} from "@/lib/goals/drafts";
import { draftForIntent, goalIntentHref, readGoalIntent } from "@/lib/goals/intent";
import { goalFromDraft, type Goal } from "@/lib/goals/model";
import {
  engineTopicsFromActions,
  examGoalDraft,
  suggestGoals,
  upcomingPlanExams,
  type GoalSuggestionExam,
} from "@/lib/goals/suggestions";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import { getStudyDayKey, getStudyDayStartFromKey, shiftStudyDayKey } from "@/lib/study/day";

const TODAY = "2026-10-20";
const NOW = getStudyDayStartFromKey(TODAY) + 6 * 60 * 60 * 1000;

const exam: GoalSuggestionExam = {
  planId: "plan-1",
  examId: "chem-1",
  label: "Chemistry Paper 1",
  dayKey: shiftStudyDayKey(TODAY, 12),
  folderId: "chem",
  folderName: "Chemistry",
};

function action(overrides: Partial<StudyAction>): Pick<StudyAction, "reason" | "target" | "scope"> {
  return {
    reason: "low_mastery",
    target: { kind: "topic", topicKey: "topic:bonding", label: "Bonding", source: "student-topic" },
    scope: { folderId: "chem" },
    ...overrides,
  };
}

describe("goal suggestions", () => {
  it("lead with the next exam, set for the topic the engine points at in its folder", () => {
    const [first] = suggestGoals({
      now: NOW,
      activeGoals: [],
      nextExam: exam,
      engineTopics: [{ folderId: "chem", folderName: "Chemistry", topicKey: "topic:bonding", label: "Bonding" }],
    });
    expect(first?.reason).toBe("Before Chemistry Paper 1");
    expect(first?.draft).toMatchObject({
      measure: "topic",
      topic: { key: "topic:bonding", label: "Bonding" },
      scope: { type: "folder", id: "chem" },
      exam: { examId: "chem-1" },
    });
    expect(goalDeadlineDayKey(first!.draft.deadline)).toBe(shiftStudyDayKey(TODAY, 11));
  });

  it("set practice questions for an exam when the engine has nothing in its folder", () => {
    const draft = examGoalDraft(exam, TODAY);
    expect(draft).toMatchObject({ measure: "questions", cadence: "total", target: 25, scope: { type: "folder", id: "chem" } });
    expect(examGoalDraft({ ...exam, dayKey: shiftStudyDayKey(TODAY, 2) }, TODAY).target).toBe(10);
    expect(examGoalDraft({ ...exam, dayKey: shiftStudyDayKey(TODAY, 90) }, TODAY).target).toBe(60);
  });

  it("offer each idea once, in order: exam, topic, due cards, habit", () => {
    const ideas = suggestGoals({
      now: NOW,
      activeGoals: [],
      nextExam: { ...exam, folderId: undefined },
      engineTopics: [{ folderId: "bio", topicKey: "topic:enzymes", label: "Enzymes" }],
      dueCardCount: 34,
      limit: 4,
    });
    expect(ideas.map((idea) => idea.id)).toEqual(["exam-questions:chem-1", "topic:bio:topic:enzymes", "due-today", "habit"]);
    expect(ideas[2]?.draft).toMatchObject({ target: 34, deadline: endOfStudyDay(TODAY) });
  });

  it("pace the habit from how much the student actually reviews", () => {
    const habit = suggestGoals({ now: NOW, activeGoals: [], recentReviewCounts: [0, 31, 29, 40] }).find((idea) => idea.id === "habit");
    expect(habit?.draft).toMatchObject({ cadence: "daily", target: 35, days: 5 });
    expect(goalDeadlineDayKey(habit!.draft.deadline)).toBe(shiftStudyDayKey(TODAY, 6));
  });

  it("leave out what a running goal already covers", () => {
    const running: Goal = goalFromDraft("habit", blankGoalDraft("cards", NOW), NOW);
    const daily = { ...running, cadence: "daily" as const, days: 5 };
    const ideas = suggestGoals({ now: NOW, activeGoals: [daily], dueCardCount: 2 });
    expect(ideas.some((idea) => idea.id === "habit")).toBe(false);
  });

  it("skip an exam that is today or too far off to plan for", () => {
    expect(suggestGoals({ now: NOW, activeGoals: [], nextExam: { ...exam, dayKey: TODAY } })[0]?.id).toBe("habit");
    expect(suggestGoals({ now: NOW, activeGoals: [], nextExam: { ...exam, dayKey: shiftStudyDayKey(TODAY, 200) } })[0]?.id).toBe("habit");
  });
});

describe("what goals can be built from", () => {
  it("takes the engine's topics in its own order, once each, only when they are worth aiming at", () => {
    const topics = engineTopicsFromActions(
      [
        action({}),
        action({ reason: "due_for_retrieval", target: { kind: "topic", topicKey: "topic:moles", label: "Moles", source: "student-topic" } }),
        action({ target: { kind: "error", category: "missing_units", label: "Units" } }),
        action({ reason: "knowledge_decay" }),
        action({ scope: {} , target: { kind: "topic", topicKey: "topic:x", label: "X", source: "deck" } }),
      ],
      [{ id: "chem", name: "Chemistry" }]
    );
    expect(topics).toEqual([{ folderId: "chem", folderName: "Chemistry", topicKey: "topic:bonding", label: "Bonding" }]);
  });

  it("takes a plan's exams still to come, soonest first, with their folders", () => {
    const exams = upcomingPlanExams(
      {
        id: "plan-1",
        exams: [
          { id: "late", label: "Biology", dayKey: shiftStudyDayKey(TODAY, 20), scopeKey: "folder:bio" },
          { id: "today", label: "Maths", dayKey: TODAY },
          { id: "soon", label: "Chemistry", dayKey: shiftStudyDayKey(TODAY, 3), scopeKey: "deck:d1" },
        ],
      },
      TODAY,
      [{ id: "bio", name: "Biology folder" }]
    );
    expect(exams.map((item) => item.examId)).toEqual(["soon", "late"]);
    expect(exams[0]?.folderId).toBeUndefined();
    expect(exams[1]).toMatchObject({ folderId: "bio", folderName: "Biology folder", planId: "plan-1" });
    expect(upcomingPlanExams(null, TODAY, [])).toEqual([]);
  });
});

describe("composer drafts", () => {
  it("start each kind with sensible amounts", () => {
    expect(blankGoalDraft("cards", NOW)).toMatchObject({ measure: "cards", target: 50, deadline: thisWeekDeadline(NOW) });
    expect(blankGoalDraft("questions", NOW)).toMatchObject({ target: 10 });
    expect(blankGoalDraft("topic", NOW)).toMatchObject({ target: 1, deadline: 0 });
  });

  it("carry the deadline and a folder over when the kind changes", () => {
    const questions = { ...blankGoalDraft("questions", NOW), scope: { type: "folder" as const, id: "chem", label: "Chemistry" } };
    expect(withMeasure(questions, "topic", NOW)).toMatchObject({
      measure: "topic",
      scope: { type: "folder", id: "chem" },
      deadline: questions.deadline,
    });
    expect(withMeasure(questions, "cards", NOW).scope).toEqual({ type: "all" });
  });

  it("make a daily goal open-ended with a number of days", () => {
    expect(withCadence(blankGoalDraft("cards", NOW), "daily")).toMatchObject({ cadence: "daily", target: 20, days: 5, deadline: 0 });
  });

  it("map deadlines to chips and back", () => {
    const draft = blankGoalDraft("cards", NOW);
    expect(deadlineChoiceOf(draft, NOW)).toEqual({ kind: "week" });
    const today = applyDeadlineChoice(draft, { kind: "today" }, NOW, []);
    expect(deadlineChoiceOf(today, NOW)).toEqual({ kind: "today" });
    const picked = applyDeadlineChoice(draft, { kind: "date", dayKey: "2026-11-03" }, NOW, []);
    expect(deadlineChoiceOf(picked, NOW)).toEqual({ kind: "date", dayKey: "2026-11-03" });
    const forExam = applyDeadlineChoice(draft, { kind: "exam", examId: "chem-1" }, NOW, [exam]);
    expect(forExam.exam?.examId).toBe("chem-1");
    expect(deadlineChoiceOf(forExam, NOW)).toEqual({ kind: "exam", examId: "chem-1" });
    expect(applyDeadlineChoice(forExam, { kind: "none" }, NOW, [exam])).toMatchObject({ deadline: 0 });
    expect(applyDeadlineChoice(forExam, { kind: "none" }, NOW, [exam]).exam).toBeUndefined();
  });

  it("read a draft back in plain words", () => {
    const draft = { ...blankGoalDraft("cards", NOW), scope: { type: "deck" as const, id: "d", label: "Spanish verbs" } };
    expect(goalPlanSentence(draft)).toBe("Counts every flashcard you review in Spanish verbs.");
    expect(goalPaceHint({ ...draft, target: 60 }, NOW)).toBe("About 10 a day for 6 days.");
    expect(goalPaceHint({ ...draft, deadline: endOfStudyDay(TODAY) }, NOW)).toBe("All of it today.");
    expect(goalPaceHint(withCadence(draft, "daily"), NOW)).toBe("Any 5 days, in a row or not.");
  });

  it("start a past goal again with the time it had", () => {
    const madeAt = getStudyDayStartFromKey("2026-10-01") + 1000;
    const past = {
      ...goalFromDraft("old", { ...blankGoalDraft("cards", madeAt), deadline: endOfStudyDay("2026-10-08") }, madeAt),
      status: "failed" as const,
    };
    const again = repeatGoalDraft(past, NOW);
    expect(goalDeadlineDayKey(again.deadline)).toBe(shiftStudyDayKey(TODAY, 7));
    expect(repeatGoalDraft({ ...past, deadline: 0 }, NOW).deadline).toBe(0);
  });
});

describe("links into the composer", () => {
  it("round-trip an exam", () => {
    const href = goalIntentHref({ exam });
    expect(href.startsWith("/dashboard/goals?")).toBe(true);
    const intent = readGoalIntent(new URL(href, "https://jami.study").searchParams);
    expect(intent).toEqual({ exam });
    expect(draftForIntent(intent!, NOW)).toMatchObject({ measure: "questions", exam: { examId: "chem-1" } });
  });

  it("open a kind, or nothing at all", () => {
    expect(readGoalIntent(new URLSearchParams("new=topic"))).toEqual({ measure: "topic" });
    expect(readGoalIntent(new URLSearchParams("new=1&exam=only-half"))).toEqual({});
    expect(readGoalIntent(new URLSearchParams(""))).toBeNull();
    expect(draftForIntent({}, NOW).measure).toBe("cards");
    expect(getStudyDayKey(NOW)).toBe(TODAY);
  });
});

describe("pace hints while editing", () => {
  it("sum over what is left, not the whole target", () => {
    const draft = { ...blankGoalDraft("cards", NOW), target: 60 };
    expect(goalPaceHint(draft, NOW, { count: 30, daysHit: 0 })).toBe("About 5 a day for 6 days.");
    expect(goalPaceHint(draft, NOW, { count: 60, daysHit: 0 })).toBe("Already reached: saving finishes it.");
  });

  it("count only the days a habit still needs", () => {
    const habit = { ...withCadence(blankGoalDraft("cards", NOW), "daily"), deadline: endOfStudyDay(shiftStudyDayKey(TODAY, 1)) };
    expect(goalPaceHint(habit, NOW, { count: 60, daysHit: 3 })).toBe("2 more days, within the next 2 days.");
    expect(goalPaceHint({ ...habit, deadline: 0 }, NOW, { count: 60, daysHit: 4 })).toBe("1 more day, in a row or not.");
  });
});
