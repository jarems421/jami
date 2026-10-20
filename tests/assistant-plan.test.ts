import { describe, expect, it } from "vitest";
import {
  buildPlanNotices,
  describeAssistantPlanDraft,
  MAX_NOTICES_PER_SUBJECT,
  MAX_PLAN_NOTICES,
  parseAssistantPlanSpec,
  type PlanSubjectOption,
} from "@/lib/ai/assistant-plan";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import { planScopeKey, type RevisionPlanDraft } from "@/lib/planning/types";
import { getStudyDayKey } from "@/lib/study/day";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import type { LearningRecommendationReason } from "@/lib/learning/types";

const NOW = Date.parse("2026-09-14T09:00:00Z");

const SUBJECTS: PlanSubjectOption[] = [
  { ref: "S1", label: "Chemistry", folderId: "chem" },
  { ref: "S2", label: "Biology", folderId: "bio" },
  { ref: "S3", label: "Spanish verbs", deckId: "verbs" },
];

const spec = (value: Record<string, unknown>) => JSON.stringify(value);

function action(
  id: string,
  reason: LearningRecommendationReason,
  label: string,
  folderId = "chem"
): StudyAction {
  return {
    id,
    reason,
    action: "practice",
    priority: 0.5,
    target: { kind: "topic", topicKey: `topic:${id}`, source: "student-topic", label },
    evidence: { count: 4, uniqueItems: 3, sources: ["flashcards"] },
    scope: { folderId },
    explanationCode: `${reason}.practice`,
    destination: { kind: "flashcards", href: `/study?x=${id}` },
  } as StudyAction;
}

describe("reading a plan Jami drafted", () => {
  it("keeps the shape it is allowed to set", () => {
    const parsed = parseAssistantPlanSpec(
      spec({
        title: "Chemistry mock",
        subjects: [
          { ref: "S1", weight: 3, start: "diagnose" },
          { ref: "S2", weight: 1, start: "practice" },
        ],
        days: [1, 3, 5],
        minutes: 45,
        start: "2026-09-14",
        end: "2026-10-12",
      }),
      SUBJECTS,
      NOW
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.draft.title).toBe("Chemistry mock");
    expect(parsed?.draft.origin).toBe("tutor");
    expect(parsed?.draft.scopes).toEqual([
      { folderId: "chem", weight: 3 },
      { folderId: "bio", weight: 1 },
    ]);
    expect(parsed?.draft.sessions).toEqual([
      { id: "w1", weekday: 1, minutes: 45 },
      { id: "w3", weekday: 3, minutes: 45 },
      { id: "w5", weekday: 5, minutes: 45 },
    ]);
    expect(parsed?.draft.emphasis).toEqual([
      { scopeKey: "folder:chem", wants: "diagnose" },
      { scopeKey: "folder:bio", wants: "practice" },
    ]);
  });

  it("cannot name anything to study, however hard it tries", () => {
    /*
     * The guarantee the whole feature rests on. There is no field here for a
     * topic, a card, a paper or a task, so a model that ignored every word of
     * its prompt still cannot produce a plan that says what to revise. That is
     * decided by the Learning Engine from recorded answers, every time the plan
     * is read.
     */
    const parsed = parseAssistantPlanSpec(
      spec({
        title: "Mocks",
        subjects: [{ ref: "S1", weight: 1 }],
        days: [2],
        minutes: 30,
        topics: ["Moles", "Electrolysis"],
        tasks: [{ day: "2026-09-15", do: "Past paper 2H" }],
        schedule: "Monday: revise bonding",
      }),
      SUBJECTS,
      NOW
    );

    const asJson = JSON.stringify(parsed?.draft);
    expect(asJson).not.toContain("Moles");
    expect(asJson).not.toContain("Electrolysis");
    expect(asJson).not.toContain("2H");
    expect(asJson).not.toContain("bonding");
    expect(Object.keys(parsed?.draft ?? {}).sort()).toEqual([
      "emphasis",
      "endDayKey",
      "origin",
      "scopes",
      "sessions",
      "startDayKey",
      "status",
      "title",
    ]);
  });

  it("drops a subject it was never offered", () => {
    // Refs rather than ids or names: the model cannot invent a folder it was
    // not shown, and there is no fuzzy name matching to get wrong.
    const parsed = parseAssistantPlanSpec(
      spec({
        subjects: [
          { ref: "S1", weight: 1 },
          { ref: "S9", weight: 3 },
          { ref: "chem", weight: 2 },
        ],
        days: [1],
        minutes: 30,
      }),
      SUBJECTS,
      NOW
    );

    expect(parsed?.draft.scopes).toEqual([{ folderId: "chem", weight: 1 }]);
    expect(parsed?.unknownSubjects).toEqual(["S9", "CHEM"]);
  });

  it("reaches a deck as readily as a folder", () => {
    const parsed = parseAssistantPlanSpec(
      spec({ subjects: [{ ref: "S3", weight: 2 }], days: [0], minutes: 20 }),
      SUBJECTS,
      NOW
    );
    expect(parsed?.draft.scopes).toEqual([{ deckId: "verbs", weight: 2 }]);
  });

  it("puts anything out of range back inside it", () => {
    const parsed = parseAssistantPlanSpec(
      spec({
        title: "x".repeat(400),
        subjects: [{ ref: "S1", weight: 99 }],
        days: [1, 9, "tuesday"],
        minutes: 100000,
        start: "not-a-date",
      }),
      SUBJECTS,
      NOW
    );

    expect(parsed?.draft.title.length).toBe(80);
    expect(parsed?.draft.scopes[0]?.weight).toBe(3);
    expect(parsed?.draft.sessions).toEqual([{ id: "w1", weekday: 1, minutes: 240 }]);
    // An unreadable start date falls back to today rather than to nothing --
    // today being the study day, which turns over at its own hour rather than
    // at midnight UTC.
    expect(parsed?.draft.startDayKey).toBe(getStudyDayKey(NOW));
  });

  it("returns nothing at all for something that is not a plan", () => {
    expect(parseAssistantPlanSpec("", SUBJECTS, NOW)).toBeNull();
    expect(parseAssistantPlanSpec("I think you should revise more", SUBJECTS, NOW)).toBeNull();
    expect(parseAssistantPlanSpec(`{"subjects":`, SUBJECTS, NOW)).toBeNull();
    expect(parseAssistantPlanSpec(JSON.stringify("a string"), SUBJECTS, NOW)).toBeNull();
  });

  it("reads a spec that arrived wrapped in a code fence", () => {
    const parsed = parseAssistantPlanSpec(
      "```plan\n" + spec({ subjects: [{ ref: "S1", weight: 1 }], days: [1], minutes: 30 }) + "\n```",
      SUBJECTS,
      NOW
    );
    expect(parsed?.draft.scopes).toEqual([{ folderId: "chem", weight: 1 }]);
  });
});

describe("a timetable Jami drafted", () => {
  it("reads sittings with times and subjects", () => {
    const parsed = parseAssistantPlanSpec(
      spec({
        title: "Mocks",
        subjects: [{ ref: "S1", weight: 2 }],
        sessions: [
          { day: 1, minutes: 45, time: "16:30", ref: "S1" },
          { day: 1, minutes: 30 },
        ],
        start: "2026-09-14",
        end: "2026-10-12",
      }),
      SUBJECTS,
      NOW
    );

    expect(parsed?.draft.sessions).toHaveLength(2);
    expect(parsed?.draft.sessions[0]).toMatchObject({
      weekday: 1,
      minutes: 45,
      startTime: "16:30",
      scopeKey: "folder:chem",
    });
    // The second sitting said only how long it was, and that is a complete
    // answer -- an evening with no clock on it is still an evening.
    expect(parsed?.draft.sessions[1]).toMatchObject({ weekday: 1, minutes: 30 });
    expect(parsed?.draft.sessions[1]?.startTime).toBeUndefined();
  });

  it("still reads the older shape a model may answer in", () => {
    const parsed = parseAssistantPlanSpec(
      spec({
        subjects: [{ ref: "S1", weight: 1 }],
        days: [1, 3],
        minutes: 30,
      }),
      SUBJECTS,
      NOW
    );
    expect(parsed?.draft.sessions).toEqual([
      { id: "w1", weekday: 1, minutes: 30 },
      { id: "w3", weekday: 3, minutes: 30 },
    ]);
  });

  it("keeps a sitting whose time or subject it could not use", () => {
    const parsed = parseAssistantPlanSpec(
      spec({
        subjects: [{ ref: "S1", weight: 1 }],
        sessions: [
          { day: 1, minutes: 45, time: "half four", ref: "S9" },
          { day: 99, minutes: 45 },
        ],
      }),
      SUBJECTS,
      NOW
    );
    expect(parsed?.draft.sessions).toHaveLength(1);
    expect(parsed?.draft.sessions[0]?.startTime).toBeUndefined();
    expect(parsed?.draft.sessions[0]?.scopeKey).toBeUndefined();
  });

  it("still has nowhere to put what a student should revise", () => {
    /*
     * The guarantee that matters, restated for the newer shape. A model that
     * ignored every word of the prompt still cannot write content into a plan,
     * because no field of a session can carry any.
     */
    const parsed = parseAssistantPlanSpec(
      spec({
        subjects: [{ ref: "S1", weight: 1 }],
        sessions: [
          {
            day: 1,
            minutes: 45,
            time: "16:30",
            topic: "Moles",
            task: "Do paper 2H",
            label: "Bonding revision",
          },
        ],
      }),
      SUBJECTS,
      NOW
    );

    const asJson = JSON.stringify(parsed?.draft);
    expect(asJson).not.toContain("Moles");
    expect(asJson).not.toContain("2H");
    expect(asJson).not.toContain("Bonding");
  });
});

describe("what Jami says it has noticed", () => {
  const names = new Map([
    ["folder:chem", "Chemistry"],
    ["folder:bio", "Biology"],
  ]);

  it("speaks from the engine's reasons, not from a model's impression", () => {
    const notices = buildPlanNotices(
      [
        action("a", "declining_mastery", "Moles"),
        action("b", "persistent_error", "Balancing equations"),
        action("c", "untested_exposure", "Enzymes", "bio"),
      ],
      names
    );

    expect(notices.map((notice) => notice.detail)).toEqual([
      "Moles has been slipping",
      "Balancing equations keeps costing marks",
      "Enzymes has been covered but never tested",
    ]);
    expect(notices[0]?.subject).toBe("Chemistry");
    expect(notices[2]?.subject).toBe("Biology");
  });

  it("lets no one subject crowd out the rest", () => {
    const notices = buildPlanNotices(
      [
        action("a", "low_mastery", "One"),
        action("b", "low_mastery", "Two"),
        action("c", "low_mastery", "Three"),
        action("d", "low_mastery", "Four", "bio"),
      ],
      names
    );

    expect(notices.filter((notice) => notice.scopeKey === "folder:chem")).toHaveLength(
      MAX_NOTICES_PER_SUBJECT
    );
    expect(notices).toHaveLength(3);
  });

  it("stays short enough to read", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      action(`a${index}`, "low_mastery", `Topic ${index}`, `folder-${index}`)
    );
    const labels = new Map(many.map((entry) => [planScopeKey(entry.scope), "A subject"]));
    expect(buildPlanNotices(many, labels).length).toBeLessThanOrEqual(MAX_PLAN_NOTICES);
  });

  it("says nothing about an error it has no phrase for", () => {
    // A recurring error is about a category rather than a topic, and the
    // notice line names a topic -- so it is left out rather than mangled.
    const errorAction = {
      ...action("e", "persistent_error", "ignored"),
      target: { kind: "error", category: "missing_working", label: "Missing working" },
    } as StudyAction;
    expect(buildPlanNotices([errorAction], names)).toEqual([]);
  });
});

describe("exams Jami was told about", () => {
  it("keeps the exams the student named, tied to a subject where Jami said which", () => {
    const parsed = parseAssistantPlanSpec(
      spec({
        title: "Mocks",
        subjects: [{ ref: "S1", weight: 2 }],
        days: [1, 3],
        minutes: 45,
        end: "2026-11-20",
        exams: [
          { label: "Chemistry Paper 1", date: "2026-11-12", ref: "S1" },
          { label: "Biology Paper 1", date: "2026-11-20", ref: "S9" },
          { label: "No date", ref: "S1" },
        ],
      }),
      SUBJECTS,
      NOW
    );
    expect(parsed?.draft.exams).toEqual([
      { id: "e0", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chem" },
      // A subject Jami was never offered is dropped from the exam, not the exam from the plan.
      { id: "e1", label: "Biology Paper 1", dayKey: "2026-11-20" },
    ]);
    // Jami is shown them again next turn, so changing one thing does not lose the exams.
    expect(describeAssistantPlanDraft(parsed!.draft, SUBJECTS)).toContain('- Exams: "Chemistry Paper 1" 2026-11-12 (S1); "Biology Paper 1" 2026-11-20');
  });
});

describe("telling Jami what the plan already says", () => {
  const OFFERED = [
    { ref: "S1", label: "Chemistry", folderId: "chem" },
    { ref: "S2", label: "Biology", folderId: "bio" },
  ];
  function draft(overrides: Partial<RevisionPlanDraft> = {}): RevisionPlanDraft {
    return normalizeRevisionPlanDraft({
      title: "Summer mocks",
      scopes: [
        { folderId: "chem", weight: 2 },
        { folderId: "bio", weight: 1 },
      ],
      sessions: [
        { id: "a", weekday: 1, minutes: 45, startTime: "16:30", scopeKey: "folder:chem" },
        { id: "b", weekday: 3, minutes: 30 },
      ],
      startDayKey: "2026-09-14",
      endDayKey: "2026-10-12",
      ...overrides,
    }).draft;
  }

  it("describes the draft in the refs the model was given", () => {
    // Refs rather than names, so there is nothing in here the model could
    // mistake for a new subject it is allowed to invent.
    const described = describeAssistantPlanDraft(draft(), OFFERED);
    expect(described).toContain("S1 weight 2");
    expect(described).toContain("S2 weight 1");
    expect(described).toContain("Mon 16:30 45 min (S1)");
    expect(described).toContain("Wed 30 min");
    expect(described).toContain("2026-09-14 to 2026-10-12");
    expect(described).not.toContain("Chemistry");
  });

  it("says a subject is unknown rather than quietly dropping it", () => {
    expect(describeAssistantPlanDraft(draft(), [OFFERED[0]!])).toContain("unknown");
  });

  it("says nothing at all about an empty draft, and something about one holding only exams", () => {
    expect(describeAssistantPlanDraft(normalizeRevisionPlanDraft(null).draft, OFFERED)).toBeNull();
    const examsOnly = normalizeRevisionPlanDraft({
      title: "Mocks",
      exams: [{ id: "e1", label: "Chemistry Paper 1", dayKey: "2026-11-12" }],
    }).draft;
    expect(describeAssistantPlanDraft(examsOnly, OFFERED)).toContain("Chemistry Paper 1");
  });
});
