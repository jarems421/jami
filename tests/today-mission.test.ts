import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildTodayMission,
  greeting,
  hubSubline,
  missionCompletionCopy,
} from "@/lib/dashboard/today-mission";
import {
  evidenceSentence,
  missionCopy,
  missionEffort,
} from "@/lib/learning/interventions/explain";
import {
  DAILY_REVIEW_MISSION_ID,
  noteMissionCompleted,
  noteMissionFinished,
  noteMissionStarted,
  takeCompletedMission,
} from "@/lib/learning/mission-handoff";
import { parseStudyActionId } from "@/lib/learning/events/study-action-event";
import type { InterventionChoice } from "@/lib/learning/interventions/catalogue";
import type { TodayNextAction, TodayStudyAction } from "@/lib/dashboard/today-plan";

/**
 * What Today says, and what it refuses to say.
 *
 * The Study Hub is where the Learning Engine finally speaks to a student, and
 * the risks are all about wording rather than arithmetic: leaking an internal
 * code, claiming evidence that does not exist, or congratulating somebody for
 * work they did not do. Those are what these cover.
 */

const CHOICE: InterventionChoice = {
  type: "past_paper",
  because: "recall_strong_application_weak",
  alternatives: ["create_practice"],
};

function action(overrides: Partial<TodayStudyAction> = {}): TodayStudyAction {
  return {
    id: "folder:f1|low_mastery|topic:spec:quad-complete",
    reason: "low_mastery",
    action: "practice",
    title: "Work on Completing the square",
    description: "Consistently difficult across 8 answers.",
    label: "Study",
    href: "/dashboard/practice/questions/new?folderId=f1",
    target: { kind: "topic", topicKey: "spec:quad-complete", label: "Completing the square", source: "specification" },
    scope: { folderId: "f1" },
    evidence: { count: 8, uniqueItems: 8, sources: ["flashcards", "past-paper"] },
    intervention: CHOICE,
    targetItems: 5,
    ...overrides,
  };
}

function nextAction(overrides: Partial<TodayNextAction> = {}): TodayNextAction {
  return {
    type: "learning_action",
    title: "Work on Completing the square",
    description: "Consistently difficult across 8 answers.",
    href: "/dashboard/practice/questions/new?folderId=f1",
    label: "Study",
    priority: 3,
    actionId: "folder:f1|low_mastery|topic:spec:quad-complete",
    ...overrides,
  };
}

/*
 * Every string a student can be shown, gathered so one assertion can check the
 * whole vocabulary rather than the handful of cases a test happened to build.
 */
function allStudentFacingText(mission: ReturnType<typeof buildTodayMission>) {
  return [
    mission.eyebrow,
    mission.headline,
    mission.summary,
    mission.actionLabel,
    ...mission.explanation,
    mission.effort?.items ?? "",
    mission.effort?.minutes ?? "",
  ].join(" | ");
}

describe("the mission Today leads with", () => {
  it("words an engine recommendation from its intervention, not its reason code", () => {
    const mission = buildTodayMission({
      nextAction: nextAction(),
      studyActions: [action()],
    });

    expect(mission.headline).toBe("Make completing the square exam-ready");
    expect(mission.summary).toBe("Your recall is strong, but application is weaker.");
    expect(mission.actionLabel).toBe("Start practicing");
    expect(mission.effort).toEqual({ items: "5 questions", minutes: "about 15 min" });
  });

  it("never leaks an internal identifier to the student", () => {
    const mission = buildTodayMission({
      nextAction: nextAction(),
      studyActions: [action()],
    });
    const text = allStudentFacingText(mission);

    for (const internal of [
      "recall_strong_application_weak",
      "past_paper",
      "low_mastery",
      "spec:",
      "folder:f1",
      "intervention",
      "mastery",
      "confidence",
    ]) {
      expect(text.toLowerCase()).not.toContain(internal.toLowerCase());
    }
  });

  it("falls back to the engine's own wording when no intervention could be offered", () => {
    const withoutIntervention = action();
    delete withoutIntervention.intervention;
    const mission = buildTodayMission({
      nextAction: nextAction(),
      studyActions: [withoutIntervention],
    });

    expect(mission.headline).toBe("Work on Completing the square");
    // Nothing was decided about the material, so there is nothing to account for.
    expect(mission.explanation).toEqual([]);
    expect(mission.effort).toBeUndefined();
  });

  it("explains a due review without pretending the engine chose it", () => {
    const mission = buildTodayMission({
      nextAction: nextAction({
        type: "review_due_cards",
        title: "Review 12 due flashcards.",
        label: "Start review",
        actionId: undefined,
      }),
      studyActions: [action()],
    });

    expect(mission.action).toBeUndefined();
    // The scheduler's reasoning, not the engine's: no evidence sentence, no
    // claim about how well anything has been going.
    expect(mission.explanation.join(" ")).toContain("came up today");
    expect(mission.explanation.join(" ")).not.toContain("Jami has");
  });

  it("offers no explanation for a step that had no reasoning behind it", () => {
    const mission = buildTodayMission({
      nextAction: nextAction({
        type: "continue_notebook",
        title: "Continue Mechanics",
        label: "Continue notebook",
        actionId: undefined,
      }),
      studyActions: [],
    });
    expect(mission.explanation).toEqual([]);
  });

  it("carries the generating action so the page can offer to write the material", () => {
    const mission = buildTodayMission({
      nextAction: nextAction(),
      studyActions: [
        action({
          intervention: {
            type: "create_flashcards",
            because: "weak_without_flashcards",
            alternatives: [],
          },
          generate: { kind: "create_flashcards", conceptId: "quad-complete" },
        }),
      ],
    });

    expect(mission.generate).toEqual({ kind: "create_flashcards", conceptId: "quad-complete" });
    expect(mission.actionLabel).toBe("Make cards");
    expect(mission.effort?.items).toBe("5 cards");
  });
});

describe("what the explanation is allowed to claim", () => {
  it("counts what exists and names where it came from", () => {
    expect(evidenceSentence({ count: 8, sources: ["flashcards", "past-paper"] })).toBe(
      "Jami has 8 answers from you on this, across flashcards and exam questions."
    );
  });

  it("says nothing has been recorded rather than implying a weakness", () => {
    const sentence = evidenceSentence({ count: 0, sources: [] });
    expect(sentence).toBe("Nothing has been recorded against this yet.");
    expect(sentence.toLowerCase()).not.toContain("wrong");
    expect(sentence.toLowerCase()).not.toContain("weak");
  });

  it("keeps an unevidenced concept apart from a weak one", () => {
    const unevidenced = missionCopy({
      conceptLabel: "Vectors",
      choice: { type: "create_practice", because: "declared_but_unevidenced", alternatives: [] },
      evidence: { count: 0, sources: [] },
    });
    const weak = missionCopy({
      conceptLabel: "Vectors",
      choice: { type: "create_practice", because: "evidenced_knowledge_gap", alternatives: [] },
      evidence: { count: 9, sources: ["flashcards"] },
    });

    expect(unevidenced.summary).not.toBe(weak.summary);
    expect(unevidenced.summary.toLowerCase()).not.toContain("difficult");
    expect(unevidenced.explanation[0]).toBe("Nothing has been recorded against this yet.");
  });

  it("names the Topic a student drilled rather than claiming they drilled this concept", () => {
    const copy = missionCopy({
      conceptLabel: "Completing the square",
      choice: {
        type: "past_paper",
        because: "recall_strong_application_weak",
        alternatives: [],
        recallFrom: { topicKey: "topic:quadratics", label: "Quadratics" },
      },
      evidence: { count: 3, sources: ["past-paper"] },
    });
    expect(copy.summary).toBe(
      "Your cards on quadratics are going well, but exam-style answers on this are not."
    );
    expect(copy.explanation[1]).toBe(copy.summary);
  });

  it("offers no estimate when the engine did not size the work", () => {
    expect(missionEffort({ type: "past_paper" })).toBeUndefined();
    expect(missionEffort({ type: "past_paper", targetItems: 0 })).toBeUndefined();
  });
});

describe("the line under the greeting", () => {
  it("counts what is waiting without previewing the mission", () => {
    expect(hubSubline({ hasMission: true, extraActions: 0 })).toBe("One thing worth focusing on.");
    expect(hubSubline({ hasMission: true, extraActions: 3 })).toContain("3 more");
    expect(hubSubline({ hasMission: false, extraActions: 0 })).toContain("wherever you feel like");
  });

  it("greets by the hour the student is actually reading it", () => {
    expect(greeting(new Date(2026, 8, 22, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 8, 22, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 8, 22, 21))).toBe("Good evening");
    expect(greeting(new Date(2026, 8, 22, 2))).toBe("Still up");
  });
});

/**
 * Session storage, in a node test.
 *
 * A stub rather than jsdom: the handoff touches exactly one browser API, and
 * standing up a whole document to exercise it costs seconds per run on this
 * machine for nothing the assertions would see.
 */
function installSessionStorage() {
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as { window?: unknown }).window = { sessionStorage };
  return store;
}

describe("the handoff between Today and the session it sent you on", () => {
  beforeEach(() => {
    installSessionStorage();
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const started = {
    actionId: "folder:f1|low_mastery|topic:spec:quad-complete",
    headline: "Make completing the square exam-ready",
    conceptLabel: "Completing the square",
    targetItems: 5,
  };

  it("reports what was actually answered, not what was asked for", () => {
    noteMissionStarted(started);
    noteMissionCompleted(started.actionId, 2);
    const completed = takeCompletedMission();

    expect(completed?.answered).toBe(2);
    expect(completed?.targetItems).toBe(5);
  });

  it("is read once and then gone", () => {
    noteMissionStarted(started);
    noteMissionCompleted(started.actionId, 5);

    expect(takeCompletedMission()).not.toBeNull();
    expect(takeCompletedMission()).toBeNull();
  });

  it("refuses a completion from a different piece of advice", () => {
    noteMissionStarted(started);
    noteMissionCompleted("folder:f1|knowledge_decay|topic:spec:vectors", 4);

    expect(takeCompletedMission()).toBeNull();
  });

  it("holds an unfinished mission rather than clearing it on a return visit", () => {
    noteMissionStarted(started);

    expect(takeCompletedMission()).toBeNull();
    noteMissionCompleted(started.actionId, 3);
    expect(takeCompletedMission()?.answered).toBe(3);
  });

  it("forgets a completion that is no longer about this sitting", () => {
    const longAgo = Date.now() - 6 * 60 * 60 * 1000;
    noteMissionStarted(started, longAgo);
    noteMissionCompleted(started.actionId, 5, longAgo + 60_000);

    expect(takeCompletedMission()).toBeNull();
  });

  /*
   * Load-bearing, not incidental. The day-review marker rides in the same slot
   * a real action id does, and the only thing stopping it becoming a study
   * action event about advice nobody gave is that the parser refuses it.
   */
  it("cannot be mistaken for a recommendation", () => {
    expect(parseStudyActionId(DAILY_REVIEW_MISSION_ID)).toBeNull();
  });

  /*
   * A session that produced nothing attributable is not a completion.
   *
   * The study page only reports one once answers exist, so arriving at an
   * empty queue -- or opening a session and closing it -- leaves nothing for
   * Today to acknowledge. Congratulating somebody for work they did not do is
   * the one failure this whole surface cannot afford.
   */
  it("acknowledges nothing when no answers were attributable", () => {
    noteMissionStarted(started);
    expect(takeCompletedMission()).toBeNull();
  });

  /*
   * Material Jami wrote carries its own provenance, durably, so the surface
   * that marks it can say what was finished without anything having been left
   * in this tab first. A student can confirm a set of questions today and sit
   * them next week; requiring a start record would mean the acknowledgement
   * only ever worked for people who did it immediately.
   */
  it("accepts a finish from something that already knows what it was", () => {
    // Nothing was left here by a start, which is the whole point.
    expect(takeCompletedMission()).toBeNull();

    noteMissionFinished(
      {
        actionId: "folder:f1|low_mastery|topic:spec:quad-complete",
        headline: "Practice completing the square",
        conceptLabel: "Completing the square",
        targetItems: 3,
      },
      2
    );

    const completed = takeCompletedMission();
    expect(completed?.answered).toBe(2);
    expect(completed?.targetItems).toBe(3);
    expect(completed?.conceptLabel).toBe("Completing the square");
  });

  it("refuses to manufacture a finish out of no answers", () => {
    noteMissionFinished(
      {
        actionId: "folder:f1|low_mastery|topic:spec:quad-complete",
        headline: "Practice completing the square",
        conceptLabel: "Completing the square",
      },
      0
    );
    expect(takeCompletedMission()).toBeNull();
  });
});

describe("what Jami says about work just finished", () => {
  it("says it is done when all of it was", () => {
    const copy = missionCompletionCopy({
      conceptLabel: "Completing the square",
      answered: 5,
      targetItems: 5,
    });

    expect(copy.headline).toBe("Nice. That's done.");
    expect(copy.detail).toBe("Completing the square · 5 / 5");
    expect(copy.complete).toBe(true);
  });

  it("does not round a part-finished session up into a finished one", () => {
    const partial = missionCompletionCopy({
      conceptLabel: "Completing the square",
      answered: 2,
      targetItems: 5,
    });
    const whole = missionCompletionCopy({
      conceptLabel: "Completing the square",
      answered: 5,
      targetItems: 5,
    });

    expect(partial.complete).toBe(false);
    expect(partial.headline).not.toBe(whole.headline);
    expect(partial.note).not.toBe(whole.note);
    expect(partial.detail).toContain("2 / 5");
  });

  it("claims the answers exist, never that the student improved", () => {
    const copy = missionCompletionCopy({
      conceptLabel: "Vectors",
      answered: 4,
      targetItems: 4,
    });
    const text = `${copy.headline} ${copy.detail} ${copy.note}`.toLowerCase();

    // Whether anything moved is the engine's call, from all the evidence
    // rather than from one session, and it may well decide nothing did.
    for (const overclaim of ["improved", "mastered", "stronger", "you now know", "progress"]) {
      expect(text).not.toContain(overclaim);
    }
    // And no internal vocabulary reaches the student.
    for (const internal of ["evidence weight", "intervention", "mastery", "profile", "attribut"]) {
      expect(text).not.toContain(internal);
    }
  });

  it("counts plainly when the work was never sized", () => {
    const copy = missionCompletionCopy({ conceptLabel: "Your due cards", answered: 1 });
    expect(copy.detail).toBe("Your due cards · 1 answer");
    expect(copy.complete).toBe(true);
  });
});
