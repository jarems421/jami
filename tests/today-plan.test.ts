import { describe, expect, it } from "vitest";
import { buildTodayPlan } from "@/lib/dashboard/today-plan";
import type { Card } from "@/lib/study/cards";
import { normalizeGoal } from "@/lib/goals/model";
import type { Topic } from "@/lib/material/topics";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import type { Notebook } from "@/lib/workspace/notebooks";

const NOW = 1_000_000;

function card(input: Partial<Card> & Pick<Card, "id" | "deckId" | "front" | "back">): Card {
  return {
    userId: "user-1",
    tags: [],
    createdAt: 1,
    ...input,
  };
}

const decks = [
  { id: "deck-a", name: "Biology deck" },
  { id: "deck-b", name: "History deck" },
];

const topic: Topic = {
  id: "topic-photosynthesis",
  name: "Photosynthesis",
  slug: "photosynthesis",
  subject: "Biology",
  status: "active",
  createdBy: "user",
  createdAt: 1,
  updatedAt: 1,
};

const folder: StudyFolder = {
  id: "folder-science",
  name: "Science",
  subject: "Science",
  topicIds: [topic.id],
  tutorInstructions: "",
  tutorInstructionsUpdatedAt: 0,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
};

const notebook: Notebook = {
  id: "notebook-1",
  folderId: folder.id,
  title: "Photosynthesis working",
  type: "general_working",
  topicIds: [topic.id],
  sourceIds: [],
  pageColor: "white",
  pageStyle: "plain",
  archived: false,
  createdAt: 1,
  updatedAt: 3,
};

function basePlanInput() {
  return {
    decks,
    cards: [
      card({
        id: "card-1",
        deckId: "deck-a",
        front: "What does chlorophyll do?",
        back: "Absorbs light energy.",
        topicIds: [topic.id],
      }),
    ],
    dueCards: [],
    topics: [topic],
    drafts: [],
    studyFolders: [folder],
    notebooks: [],
    sources: [],
    activeGoals: [],
    reviewedToday: 0,
    progressVisited: false,
    hasEarnedStars: false,
    now: NOW,
  };
}

describe("today plan", () => {
  it("starts new users by creating a study folder", () => {
    const plan = buildTodayPlan({ ...basePlanInput(), studyFolders: [], notebooks: [], decks: [], cards: [] });

    expect(plan.nextAction.type).toBe("create_first_folder");
  });

  it("recommends a goal after reviewing when no active goal exists", () => {
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [],
      topics: [],
      reviewedToday: 4,
    });

    expect(plan.nextAction.type).toBe("set_goal");
    expect(plan.nextAction.href).toBe("/dashboard/goals");
  });

  it("surfaces an earned star before suggesting another goal", () => {
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [],
      topics: [],
      reviewedToday: 4,
      hasEarnedStars: true,
    });

    expect(plan.nextAction.type).toBe("view_star");
  });

  it("continues the most recent notebook before flashcard setup", () => {
    const plan = buildTodayPlan({ ...basePlanInput(), notebooks: [notebook] });

    expect(plan.nextAction.type).toBe("continue_notebook");
    expect(plan.nextAction.href).toBe("/dashboard/notebooks/notebook-1");
    expect(plan.nextAction.title).toBe("Continue Photosynthesis working");
    expect(plan.workspace.recentNotebook?.title).toBe("Photosynthesis working");
  });

  it("prioritizes due cards over recent notebook work", () => {
    const dueCards = [
      card({ id: "due-1", deckId: "deck-b", front: "A", back: "B", dueDate: NOW - 1 }),
      card({ id: "due-2", deckId: "deck-b", front: "C", back: "D", dueDate: NOW - 1 }),
      card({ id: "due-3", deckId: "deck-a", front: "E", back: "F", dueDate: NOW - 1 }),
    ];
    const plan = buildTodayPlan({
      ...basePlanInput(),
      cards: dueCards,
      dueCards,
      notebooks: [notebook],
    });

    expect(plan.nextAction.type).toBe("review_due_cards");
    expect(plan.nextAction.title).toBe("Review 3 due flashcards in History deck");
    expect(plan.dueCards.primaryDeckName).toBe("History deck");
  });

  it("resumes an unfinished study session before other work", () => {
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [notebook],
      dueCards: [
        card({ id: "due-1", deckId: "deck-a", front: "A", back: "B", dueDate: NOW - 1 }),
      ],
      hasActiveStudySession: true,
    });

    expect(plan.nextAction.type).toBe("resume_study_session");
    expect(plan.nextAction.label).toBe("Resume session");
  });

  it("surfaces flashcard and notebook page drafts that are still draft status", () => {
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [],
      sources: [
        {
          id: "source-1",
          title: "Plant notes",
          type: "pasted_text",
          subject: "Biology",
          folderIds: [folder.id],
          topicIds: [topic.id],
          contentText: "Photosynthesis notes",
          status: "active",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      drafts: [
        {
          id: "draft-1",
          kind: "flashcard",
          contentStatus: "draft",
          front: "What is chlorophyll?",
          back: "The green pigment that absorbs light.",
          topicIds: [topic.id],
          sourceType: "source",
          sourceId: "source-1",
        },
        {
          id: "draft-2",
          kind: "practice-question",
          contentStatus: "draft",
          questionText: "Explain photosynthesis.",
          answerText: "Light energy is used to make glucose.",
          topicIds: [topic.id],
          sourceType: "source",
          sourceId: "source-1",
        },
        {
          id: "draft-3",
          kind: "flashcard",
          contentStatus: "approved",
          front: "Approved",
          back: "Done",
          topicIds: [topic.id],
        },
      ],
    });

    expect(plan.nextAction.type).toBe("review_drafts");
    expect(plan.drafts).toHaveLength(2);
    expect(plan.drafts[0].suggestedTopic).toBe("Photosynthesis");
    expect(plan.drafts[1].front).toBe("Explain photosynthesis.");
  });

  it("uses weak topic summaries from the cards linked to each topic", () => {
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [],
      cards: [
        card({
          id: "card-due",
          deckId: "deck-a",
          front: "Where does photosynthesis happen?",
          back: "In the chloroplasts.",
          topicIds: [topic.id],
          dueDate: NOW - 1,
        }),
      ],
    });

    expect(plan.nextAction.type).toBe("practice_weak_topic");
    expect(plan.weakTopics[0]).toMatchObject({ topicId: topic.id, name: "Photosynthesis" });
  });

  it("continues an active goal before card setup once folders exist", () => {
    // A goal stored before kinds, read through the same compatibility path as Firestore.
    const goal = normalizeGoal("goal-1", {
      name: "Biology review",
      scope: { type: "all" },
      targetCards: 10,
      targetAccuracy: 0.8,
      deadline: NOW + 1000,
      progress: { cardsCompleted: 3, correctAnswers: 3, totalAnswers: 4 },
      status: "active",
      createdAt: 1,
    });
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [],
      topics: [],
      cards: [],
      decks: [],
      activeGoals: [goal],
    });

    expect(plan.nextAction.type).toBe("continue_goal");
    expect(plan.goalSummary?.progressPercent).toBe(30);
  });

  it("surfaces a near-deadline goal before notebook continuity", () => {
    const goal = normalizeGoal("goal-urgent", {
      name: "Finish biology",
      scope: { type: "deck", id: "deck-a", label: "Biology deck" },
      targetCards: 10,
      targetAccuracy: 0.8,
      deadline: NOW + 60 * 60 * 1000,
      progress: { cardsCompleted: 3, correctAnswers: 3, totalAnswers: 3 },
      status: "active",
      createdAt: 1,
    });
    const plan = buildTodayPlan({
      ...basePlanInput(),
      notebooks: [notebook],
      topics: [],
      activeGoals: [goal],
    });

    expect(plan.nextAction.type).toBe("continue_goal");
    expect(plan.goalSummary?.isAtRisk).toBe(true);
    expect(plan.nextAction.description).toBe("Finish biology: 3 of 10 cards. 7 to go today.");
  });

  it("leads its goal list with the one at risk, wherever its deadline sits", () => {
    const calm = normalizeGoal("calm", {
      schemaVersion: 2,
      measure: "cards",
      cadence: "total",
      target: 10,
      deadline: NOW + 30 * 60 * 1000,
      progress: { count: 10 },
      status: "active",
      createdAt: 1,
    });
    const slipping = normalizeGoal("slipping", {
      schemaVersion: 2,
      measure: "questions",
      cadence: "total",
      target: 20,
      deadline: NOW + 40 * 60 * 1000,
      progress: { count: 2 },
      status: "active",
      createdAt: 1,
    });
    const plan = buildTodayPlan({ ...basePlanInput(), notebooks: [notebook], topics: [], activeGoals: [calm, slipping] });
    expect(plan.goals.map((goal) => goal.goalId)).toEqual(["slipping", "calm"]);
    expect(plan.goals[0]).toMatchObject({ measure: "questions", headline: "2 of 20 questions", tone: "due_today" });
  });

  it("falls back to deck setup after the folder/workspace path exists", () => {
    const plan = buildTodayPlan({ ...basePlanInput(), notebooks: [], topics: [], decks: [], cards: [] });

    expect(plan.nextAction.type).toBe("create_first_deck");
  });
});
