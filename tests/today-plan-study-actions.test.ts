import { describe, expect, it } from "vitest";
import { buildTodayPlan, type BuildTodayPlanInput } from "@/lib/dashboard/today-plan";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import type { Card } from "@/lib/study/cards";
import type { Notebook } from "@/lib/workspace/notebooks";
import type { StudyFolder } from "@/lib/workspace/study-folders";

/**
 * Today, driven by the Learning Engine.
 *
 * The engine's actions join the plan without displacing anything more
 * time-sensitive: an open session and due cards still come first. Only an
 * evidence-backed problem may lead the page; a check or an untested topic stays
 * in the list. With no actions, Today is exactly what it was.
 */

const NOW = 1_000_000;

const folder: StudyFolder = {
  id: "folder-1",
  name: "Maths",
  topicIds: [],
  tutorInstructions: "",
  tutorInstructionsUpdatedAt: 0,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
};

const notebook: Notebook = {
  id: "notebook-1",
  folderId: folder.id,
  title: "Working",
  type: "general_working",
  topicIds: [],
  sourceIds: [],
  pageColor: "white",
  pageStyle: "plain",
  archived: false,
  createdAt: 1,
  updatedAt: 3,
};

function studyAction(
  overrides: Partial<StudyAction> & Pick<StudyAction, "id" | "reason" | "action">
): StudyAction {
  return {
    priority: 5,
    target: { kind: "topic", topicKey: "topic:eigen", label: "Eigenvectors", source: "student-topic" },
    evidence: { count: 12, uniqueItems: 6, sources: ["flashcards"] },
    scope: { folderId: folder.id },
    explanationCode: `${overrides.reason}.${overrides.action}`,
    destination: { kind: "topic" as const, href: "/dashboard/topics/eigen", selection: {} },
    ...overrides,
  };
}

function planInput(overrides: Partial<BuildTodayPlanInput> = {}): BuildTodayPlanInput {
  return {
    decks: [{ id: "deck-1", name: "Deck" }],
    cards: [],
    topics: [],
    drafts: [],
    studyFolders: [folder],
    notebooks: [notebook],
    now: NOW,
    ...overrides,
  };
}

describe("Today with study actions", () => {
  it("lists only actions that can be opened, worded for Today, with their folder", () => {
    const plan = buildTodayPlan(
      planInput({
        studyActions: [
          studyAction({ id: "1", reason: "persistent_error", action: "practice", target: { kind: "error", category: "missing_units", label: "Missing or incorrect units" }, evidence: { count: 3, uniqueItems: 3, sources: ["past-paper"] }, destination: { kind: "question-practice" as const, href: "/dashboard/practice/questions/new?folderId=folder-1", selection: {} } }),
          studyAction({ id: "2", reason: "untested_exposure", action: "diagnose", destination: undefined }),
          studyAction({ id: "3", reason: "low_confidence", action: "diagnose", destination: { kind: "flashcards" as const, href: "/dashboard/study?mode=custom&topics=eigen", selection: {} } }),
          studyAction({ id: "4", reason: "due_for_retrieval", action: "retrieve", evidence: { count: 6, uniqueItems: 6, dueCards: 6, sources: ["flashcards"] } }),
          studyAction({ id: "5", reason: "not_yet_assessed", action: "diagnose" }),
          studyAction({ id: "6", reason: "recent_improvement_needs_reinforcement", action: "reinforce" }),
        ],
        studyActionFolders: [{ id: folder.id, name: "Maths" }],
      })
    );

    expect(plan.studyActions.map((action) => action.id)).toEqual(["1", "3", "4", "5"]);
    expect(plan.studyActions[0]).toEqual({
      id: "1",
      reason: "persistent_error",
      action: "practice",
      title: "Stop losing marks: missing or incorrect units",
      description: "This has cost marks 3 times in recent marked answers. A few questions on getting it right will help.",
      label: "Practice",
      href: "/dashboard/practice/questions/new?folderId=folder-1",
      destinationKind: "question-practice",
      folderName: "Maths",
      // Carried through so the card can record what the student did with it.
      target: { kind: "error", category: "missing_units", label: "Missing or incorrect units" },
      scope: { folderId: "folder-1" },
      // And so a surface can account for the recommendation without asking the
      // engine a second question. No intervention here: an error spans topics,
      // so the catalogue has no single body of material to offer anything for.
      evidence: { count: 3, uniqueItems: 3, sources: ["past-paper"] },
    });
    expect(plan.studyActions[1]?.description).toContain("not enough evidence yet");
    expect(plan.studyActions[2]?.description).toBe("6 cards due now.");
    expect(plan.studyActions[3]?.description).toContain("unknown rather than weak");
  });

  it("lets an evidence-backed problem lead Today when nothing more urgent is waiting", () => {
    const plan = buildTodayPlan(
      planInput({ studyActions: [studyAction({ id: "decay", reason: "knowledge_decay", action: "retrieve" })] })
    );
    expect(plan.nextAction).toMatchObject({
      type: "learning_action",
      title: "Refresh Eigenvectors",
      href: "/dashboard/topics/eigen",
      label: "Refresh",
    });
  });

  it("keeps an open session and due cards ahead of the engine", () => {
    const actions = [studyAction({ id: "weak", reason: "low_mastery", action: "teach" })];
    const dueCard: Card = { id: "c1", deckId: "deck-1", userId: "user-1", front: "Q", back: "A", tags: [], createdAt: 1, dueDate: NOW - 1 };

    expect(buildTodayPlan(planInput({ studyActions: actions, hasActiveStudySession: true })).nextAction.type).toBe(
      "resume_study_session"
    );
    expect(
      buildTodayPlan(planInput({ studyActions: actions, cards: [dueCard], dueCards: [dueCard] })).nextAction.type
    ).toBe("review_due_cards");
  });

  it("does not let a check or an untested topic take over the page", () => {
    const plan = buildTodayPlan(
      planInput({ studyActions: [studyAction({ id: "check", reason: "low_confidence", action: "diagnose" })] })
    );
    expect(plan.nextAction.type).toBe("continue_notebook");
    expect(plan.studyActions).toHaveLength(1);
  });

  it("is unchanged when the engine has not answered", () => {
    const plan = buildTodayPlan(planInput());
    expect(plan.studyActions).toEqual([]);
    expect(plan.nextAction.type).toBe("continue_notebook");
  });
});
