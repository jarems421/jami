import { getCustomStudyHref, getNotebookHref, getTopicHref } from "@/lib/app/routes";
import { DAILY_REVIEW_MISSION_ID } from "@/lib/learning/mission-handoff";
import type { StudyAction, StudyActionDestinationKind } from "@/lib/learning/actions/study-actions";
import type { LearningRecommendationReason } from "@/lib/learning/types";
import { buildTopicProgress, type TopicProgressSummary } from "@/lib/material/progress";
import type { Topic } from "@/lib/material/topics";
import { getGoalDisplayName, type Goal } from "@/lib/study/goals";
import type { Card } from "@/lib/study/cards";
import { getMemoryRiskInfo } from "@/lib/study/memory-risk";
import type { Source } from "@/lib/material/sources";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import type { Notebook } from "@/lib/workspace/notebooks";

export type TodayNextActionType =
  | "resume_study_session"
  | "create_first_deck"
  | "add_first_cards"
  | "review_due_cards"
  | "review_drafts"
  | "practice_weak_topic"
  | "continue_goal"
  | "continue_notebook"
  | "create_first_folder"
  | "set_goal"
  | "view_star"
  | "focused_review"
  | "learning_action";

export type TodayNextAction = {
  type: TodayNextActionType;
  title: string;
  description: string;
  href: string;
  label: string;
  priority: number;
  secondaryHref?: string;
  secondaryLabel?: string;
  /**
   * The study action this came from, when the engine's advice is what leads.
   *
   * Carried so a surface can find the rest of it -- the evidence, the
   * intervention, whether Jami can write the material -- without matching on
   * wording, and so the same recommendation is not then listed again below.
   */
  actionId?: string;
};

export type TodayDueCardsSummary = {
  count: number;
  weakCount: number;
  primaryDeckId?: string;
  primaryDeckName?: string;
};

export type TodayWeakTopic = {
  topicId: string;
  name: string;
  subject: string;
  reason: string;
  href: string;
};

export type TodayDraft = {
  id: string;
  front: string;
  back: string;
  suggestedTopic?: string;
  sourceId?: string;
  sourceTitle?: string;
  href: string;
};

export type TodayGoalSummary = {
  goalId: string;
  title: string;
  detail: string;
  progressPercent: number;
  isAtRisk: boolean;
  href: string;
};

export type TodayWorkspaceSummary = {
  folderCount: number;
  notebookCount: number;
  sourceCount: number;
  recentNotebook?: {
    id: string;
    title: string;
    folderId: string;
    href: string;
  };
};

/** A Learning Engine study action, worded for Today. */
export type TodayStudyAction = {
  id: string;
  reason: LearningRecommendationReason;
  action: StudyAction["action"];
  title: string;
  description: string;
  label: string;
  href: string;
  /** What the link opens, so the copy can say so -- a Revision Session reads differently from a page. */
  destinationKind?: StudyActionDestinationKind;
  folderName?: string;
  /**
   * What this action is about and which scope decided it, carried through so
   * the card can record what the student did with it. Kept as the engine's own
   * shapes rather than flattened, so the recording path and the ranking path
   * cannot drift apart.
   */
  target: StudyAction["target"];
  scope: StudyAction["scope"];
  /**
   * What was counted, and where it came from.
   *
   * Carried so a surface can account for the recommendation without asking the
   * engine a second question. The engine's own shape, not a flattened copy:
   * "Why this?" and the ranking must be reading the same numbers.
   */
  evidence: StudyAction["evidence"];
  /**
   * What can be done about this, given the material that exists.
   *
   * Absent whenever the catalogue had no action to offer -- for an error
   * target, and for a decision no available intervention fits. A surface with
   * no intervention still has the engine's own wording to fall back on.
   */
  intervention?: StudyAction["intervention"];
  /** How many items the engine thinks this is worth, when a surface can honour it. */
  targetItems?: number;
  /**
   * What Jami can do about this, when the answer is to make something.
   *
   * Only the generating kinds travel this far: the others already have a
   * destination, and a link is the whole of the action. Present, the card
   * offers to write the material rather than sending the student somewhere.
   */
  generate?: { kind: "create_flashcards" | "create_practice"; conceptId: string };
};

export type TodayPlan = {
  nextAction: TodayNextAction;
  dueCards: TodayDueCardsSummary;
  /** Evidence-backed next steps, each with somewhere to go. Empty until the engine has answered. */
  studyActions: TodayStudyAction[];
  weakTopics: TodayWeakTopic[];
  drafts: TodayDraft[];
  goalSummary?: TodayGoalSummary;
  workspace: TodayWorkspaceSummary;
  topicProgress: TopicProgressSummary[];
};

type TodayDeckInput = {
  id: string;
  name: string;
};

type TodayDraftInput = {
  id: string;
  kind: string;
  contentStatus: string;
  front?: string;
  back?: string;
  questionText?: string;
  answerText?: string;
  topicIds?: string[];
  sourceType?: string;
  sourceId?: string;
};

export type BuildTodayPlanInput = {
  decks: TodayDeckInput[];
  cards: Card[];
  dueCards?: Card[];
  topics: Topic[];
  drafts: TodayDraftInput[];
  sources?: Source[];
  studyFolders?: StudyFolder[];
  notebooks?: Notebook[];
  activeGoals?: Goal[];
  reviewedToday?: number;
  progressVisited?: boolean;
  hasEarnedStars?: boolean;
  hasActiveStudySession?: boolean;
  /** From the Learning Engine, when it has answered. */
  studyActions?: readonly StudyAction[];
  studyActionFolders?: readonly { id: string; name: string }[];
  now?: number;
};

const TODAY_STUDY_ACTION_LIMIT = 4;

/**
 * Reasons strong enough to lead Today when nothing more time-sensitive does.
 *
 * A recurring error still costing marks, a topic in decline, a strong topic
 * slipping and a well-evidenced weakness are all worth more than reopening the
 * last notebook. Checks, retrieval and reinforcement stay in the list below
 * without taking over the page.
 */
const LEADING_STUDY_REASONS: ReadonlySet<LearningRecommendationReason> = new Set([
  "persistent_error",
  "declining_mastery",
  "knowledge_decay",
  "low_mastery",
]);

function lowerFirst(value: string) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function pluralize(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getDeckName(decks: TodayDeckInput[], deckId: string | undefined) {
  if (!deckId) return undefined;
  return decks.find((deck) => deck.id === deckId)?.name;
}

function getPrimaryDeckId(cards: Card[]) {
  const counts = new Map<string, number>();
  for (const card of cards) {
    counts.set(card.deckId, (counts.get(card.deckId) ?? 0) + 1);
  }

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
}

function buildDueSummary(input: BuildTodayPlanInput, now: number): TodayDueCardsSummary {
  const dueCards =
    input.dueCards ??
    input.cards.filter((card) => typeof card.dueDate === "number" && card.dueDate <= now);
  const weakCards = input.cards.filter((card) => getMemoryRiskInfo(card, now).tier === "high");
  const primaryDeckId = getPrimaryDeckId(dueCards);

  return {
    count: dueCards.length,
    weakCount: weakCards.length,
    primaryDeckId,
    primaryDeckName: getDeckName(input.decks, primaryDeckId),
  };
}

function buildDrafts(input: BuildTodayPlanInput): TodayDraft[] {
  const topicsById = new Map(input.topics.map((topic) => [topic.id, topic]));
  const sourcesById = new Map((input.sources ?? []).map((source) => [source.id, source]));

  return input.drafts
    .filter((draft) => draft.contentStatus === "draft")
    .map((draft) => {
      const source = draft.sourceId ? sourcesById.get(draft.sourceId) : undefined;
      const isFlashcard = draft.kind === "flashcard";
      return {
        id: draft.id,
        front: isFlashcard
          ? draft.front?.trim() || "Untitled flashcard draft"
          : draft.questionText?.trim() || "Question notebook page draft",
        back: isFlashcard
          ? draft.back?.trim() || "No answer yet"
          : draft.answerText?.trim() || "Approve into a notebook page before working.",
        suggestedTopic: draft.topicIds?.map((topicId) => topicsById.get(topicId)?.name).find(Boolean),
        sourceId: draft.sourceId,
        sourceTitle: source?.title,
        href: draft.sourceType === "source" ? "/dashboard/library" : "/dashboard/progress",
      };
    })
    .slice(0, 4);
}

function buildWeakTopics(input: BuildTodayPlanInput, now: number) {
  const topicProgress = buildTopicProgress({
    topics: input.topics,
    cards: input.cards,
    sources: input.sources,
    notebooks: input.notebooks,
    now,
  });

  const weakTopics = topicProgress
    .filter((summary) => summary.weakCardCount > 0 || summary.dueCardCount > 0)
    .map((summary) => {
      const reason =
        summary.weakCardCount > 0
          ? `${pluralize(summary.weakCardCount, "weak card")} linked to this topic.`
          : `${pluralize(summary.dueCardCount, "due card")} linked to this topic.`;

      return {
        topicId: summary.topic.id,
        name: summary.topic.name,
        subject: summary.topic.subject,
        reason,
        href: getTopicHref(summary.topic.id),
      };
    })
    .slice(0, 3);

  return { topicProgress, weakTopics };
}

/**
 * Copy for one study action.
 *
 * Every sentence says only what the evidence supports: "not enough evidence
 * yet" for a check, "unknown rather than weak" for an untested topic. Topic
 * names are the student's own, rendered as text.
 */
export function describeStudyAction(action: StudyAction): Pick<TodayStudyAction, "title" | "description" | "label"> {
  const name = action.target.label;
  switch (action.reason) {
    case "persistent_error":
      return {
        title: `Stop losing marks: ${lowerFirst(name)}`,
        description: `This has cost marks ${pluralize(action.evidence.count, "time")} in recent marked answers. A few questions on getting it right will help.`,
        label: "Practise",
      };
    case "declining_mastery":
      return {
        title: `Revisit ${name}`,
        description: "Recent answers on this have slipped.",
        label: "Review",
      };
    case "knowledge_decay":
      return {
        title: `Refresh ${name}`,
        description: "You knew this well, but recent answers suggest it is fading.",
        label: action.action === "retrieve" ? "Refresh" : "Practise",
      };
    case "low_mastery":
      /*
       * A practice decision on a weak concept means the engine found recall
       * holding up and application failing. "Consistently difficult" would be
       * false: the cards on it are going well.
       */
      if (action.action === "practice") {
        return {
          title: `Put ${name} into practice`,
          description: "Recall looks fine, but exam-style answers on this keep losing marks.",
          label: "Practise",
        };
      }
      return {
        title: `Work on ${name}`,
        description: `Consistently difficult across ${pluralize(action.evidence.count, "answer")}.`,
        label:
          action.destination?.kind === "topic" ||
          action.destination?.kind === "deck" ||
          action.destination?.kind === "notebook"
            ? "Open"
            : "Study",
      };
    case "low_confidence":
      if (action.action === "practice") {
        return {
          title: `Check ${name} in exam questions`,
          description: "Recall looks fine, but your first exam-style answers on this went wrong.",
          label: "Practise",
        };
      }
      return {
        title: `Check ${name}`,
        description: "It might need attention, but there is not enough evidence yet. A few questions will tell.",
        label: "Check",
      };
    case "due_for_retrieval":
      return {
        title: `Review ${name}`,
        description: `${pluralize(action.evidence.dueCards ?? 0, "card")} due now.`,
        label: "Review",
      };
    case "recent_improvement_needs_reinforcement":
      return action.target.kind === "error"
        ? {
            title: `Keep it up: ${lowerFirst(name)}`,
            description: "Recent answers have got this right. A little more practice makes it stick.",
            label: "Practise",
          }
        : {
            title: `Lock in ${name}`,
            description: "This is improving. A short session keeps the gain.",
            label: "Practise",
          };
    case "untested_exposure":
      return {
        title: `Test yourself on ${name}`,
        description: "You have material on this but haven't been tested on it yet.",
        label: "Test yourself",
      };
    case "not_yet_assessed":
      return {
        title: `Try ${name}`,
        description: "Not tested yet, so it is unknown rather than weak.",
        label: "Try questions",
      };
  }
}

/**
 * The action as something to make, when that is what it is.
 *
 * `fill_specification_gap` resolves to cards: a concept with nothing behind it
 * needs something to study from before it needs testing on, and cards are the
 * cheapest useful thing to build. The other intervention kinds lead somewhere
 * that already exists, so they keep their link.
 */
function generating(action: StudyAction) {
  const type = action.intervention?.type;
  if (!type) return undefined;
  const conceptId = action.target.kind === "topic" ? action.target.topicKey : "";
  if (!conceptId.startsWith("spec:")) return undefined;
  const id = conceptId.slice("spec:".length);
  if (type === "create_flashcards" || type === "fill_specification_gap") {
    return { kind: "create_flashcards" as const, conceptId: id };
  }
  if (type === "create_practice") return { kind: "create_practice" as const, conceptId: id };
  return undefined;
}

function buildStudyActions(input: BuildTodayPlanInput): TodayStudyAction[] {
  const folderNames = new Map((input.studyActionFolders ?? []).map((folder) => [folder.id, folder.name]));
  return (input.studyActions ?? [])
    .flatMap((action) => {
      if (!action.destination) return [];
      const folderName = action.scope.folderId ? folderNames.get(action.scope.folderId) : undefined;
      return [
        {
          id: action.id,
          reason: action.reason,
          action: action.action,
          ...describeStudyAction(action),
          href: action.destination.href,
          destinationKind: action.destination.kind,
          ...(folderName ? { folderName } : {}),
          target: action.target,
          scope: action.scope,
          evidence: action.evidence,
          ...(action.intervention ? { intervention: action.intervention } : {}),
          ...(generating(action) ? { generate: generating(action)! } : {}),
          // A session or a page is not a number of items: finishing it is the whole of it.
          ...(action.spec &&
          action.destination.kind !== "revision-session" &&
          action.destination.kind !== "notebook"
            ? { targetItems: action.spec.targetItems }
            : {}),
        },
      ];
    })
    .slice(0, TODAY_STUDY_ACTION_LIMIT);
}

function buildGoalSummary(input: BuildTodayPlanInput, now: number): TodayGoalSummary | undefined {
  const goal = (input.activeGoals ?? [])
    .filter(
      (item) =>
        item.status === "active" &&
        (item.deadline <= 0 || item.deadline > now)
    )
    .sort(
      (left, right) =>
        (left.deadline > 0 ? left.deadline : Number.MAX_SAFE_INTEGER) -
        (right.deadline > 0 ? right.deadline : Number.MAX_SAFE_INTEGER)
    )[0];

  if (!goal) return undefined;

  const progressPercent =
    goal.targetCards > 0
      ? Math.min(100, Math.round((goal.progress.cardsCompleted / goal.targetCards) * 100))
      : 0;
  const remainingCards = Math.max(0, goal.targetCards - goal.progress.cardsCompleted);
  const timeRemaining = goal.deadline > 0 ? goal.deadline - now : Number.POSITIVE_INFINITY;
  const isAtRisk = remainingCards > 0 && timeRemaining <= 48 * 60 * 60 * 1000;

  return {
    goalId: goal.id,
    title: getGoalDisplayName(goal),
    detail: `${goal.progress.cardsCompleted} / ${goal.targetCards} cards complete.`,
    progressPercent,
    isAtRisk,
    href: "/dashboard/goals",
  };
}

function buildWorkspaceSummary(input: BuildTodayPlanInput): TodayWorkspaceSummary {
  const recentNotebook = (input.notebooks ?? [])
    .filter((notebook) => !notebook.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];

  return {
    folderCount: (input.studyFolders ?? []).filter((folder) => !folder.archived).length,
    notebookCount: (input.notebooks ?? []).filter((notebook) => !notebook.archived).length,
    sourceCount: (input.sources ?? []).filter((source) => source.status === "active").length,
    recentNotebook: recentNotebook
      ? {
          id: recentNotebook.id,
          title: recentNotebook.title,
          folderId: recentNotebook.folderId,
          href: getNotebookHref(recentNotebook.id),
        }
      : undefined,
  };
}

function buildNextAction(input: {
  decks: TodayDeckInput[];
  cards: Card[];
  dueCards: TodayDueCardsSummary;
  drafts: TodayDraft[];
  weakTopics: TodayWeakTopic[];
  studyActions: TodayStudyAction[];
  goalSummary?: TodayGoalSummary;
  workspace: TodayWorkspaceSummary;
  reviewedToday: number;
  hasEarnedStars: boolean;
  hasActiveStudySession: boolean;
}): TodayNextAction {
  if (input.hasActiveStudySession) {
    return {
      type: "resume_study_session",
      title: "Resume your study session.",
      description: "Continue from the exact card where you stopped.",
      href: getCustomStudyHref({ mode: "daily" }),
      label: "Resume session",
      priority: 1,
    };
  }

  if (input.dueCards.count > 0) {
    const deckText = input.dueCards.primaryDeckName ? ` in ${input.dueCards.primaryDeckName}` : "";
    return {
      type: "review_due_cards",
      title: `Review ${pluralize(input.dueCards.count, "due flashcard")}${deckText}${input.dueCards.primaryDeckName ? "" : "."}`,
      description: "Due cards are time-sensitive. Review them, then return to notebook work.",
      /*
       * Carries the day-review marker so Today can tell, when the student
       * comes back, that they went and did the thing it asked for. It is not
       * a recommendation id and cannot be read as one -- see
       * `DAILY_REVIEW_MISSION_ID`.
       */
      href: getCustomStudyHref({ mode: "daily", fromActionId: DAILY_REVIEW_MISSION_ID }),
      label: "Start review",
      priority: 2,
      secondaryHref: "/dashboard/folders",
      secondaryLabel: "Open folders",
    };
  }

  if (input.goalSummary?.isAtRisk) {
    return {
      type: "continue_goal",
      title: "Keep this goal within reach.",
      description: input.goalSummary.detail,
      href: input.goalSummary.href,
      label: "Open goal",
      priority: 3,
    };
  }

  const leadingStudyAction = input.studyActions[0];
  if (leadingStudyAction && LEADING_STUDY_REASONS.has(leadingStudyAction.reason)) {
    return {
      type: "learning_action",
      title: leadingStudyAction.title,
      description: leadingStudyAction.description,
      href: leadingStudyAction.href,
      label: leadingStudyAction.label,
      priority: 3,
      actionId: leadingStudyAction.id,
    };
  }

  if (input.workspace.folderCount === 0) {
    return {
      type: "create_first_folder",
      title: "Create your first study folder.",
      description: "Folders are where notebooks, decks, and sources come together.",
      href: "/dashboard/folders",
      label: "Create folder",
      priority: 4,
    };
  }

  if (input.workspace.recentNotebook) {
    return {
      type: "continue_notebook",
      title: `Continue ${input.workspace.recentNotebook.title}`,
      description: "Open the latest notebook page and keep working naturally.",
      href: input.workspace.recentNotebook.href,
      label: "Continue notebook",
      priority: 5,
      secondaryHref: "/dashboard/folders",
      secondaryLabel: "Open folders",
    };
  }

  if (input.drafts.length > 0) {
    return {
      type: "review_drafts",
      title: `Review ${pluralize(input.drafts.length, "draft")}.`,
      description: "Generated drafts stay separate until you approve them into Learn or a notebook.",
      href: input.drafts[0]?.href ?? "/dashboard/library",
      label: "Review drafts",
      priority: 6,
    };
  }

  if (input.weakTopics.length > 0) {
    const topic = input.weakTopics[0];
    return {
      type: "practice_weak_topic",
      title: `Open work linked to ${topic.name}.`,
      description: topic.reason,
      href: topic.href,
      label: "Open topic",
      priority: 7,
      secondaryHref: "/dashboard/study",
      secondaryLabel: "Review linked cards",
    };
  }

  if (input.goalSummary) {
    return {
      type: "continue_goal",
      title: "Keep your current goal moving.",
      description: input.goalSummary.detail,
      href: input.goalSummary.href,
      label: "Open goal",
      priority: 8,
    };
  }

  if (input.hasEarnedStars) {
    return {
      type: "view_star",
      title: "Your latest goal reward is waiting.",
      description: "Open Stars to see the reward earned from your completed goal.",
      href: "/dashboard/constellation",
      label: "View star",
      priority: 9,
      secondaryHref: "/dashboard/goals",
      secondaryLabel: "Set another goal",
    };
  }

  if (input.reviewedToday > 0) {
    return {
      type: "set_goal",
      title: "Turn today’s review into a clear target.",
      description: "Set a small goal while today’s study rhythm is still fresh.",
      href: "/dashboard/goals",
      label: "Set a goal",
      priority: 10,
    };
  }

  if (input.decks.length === 0) {
    return {
      type: "create_first_deck",
      title: "Create your first flashcard deck.",
      description: "Decks still power quick review, especially on mobile.",
      href: "/dashboard/decks",
      label: "Create deck",
      priority: 11,
    };
  }

  if (input.cards.length === 0) {
    return {
      type: "add_first_cards",
      title: "Add your first flashcards.",
      description: "Your workspace is ready. Add a few cards so Jami can schedule reviews.",
      href: "/dashboard/cards",
      label: "Add cards",
      priority: 12,
      secondaryHref: "/dashboard/decks",
      secondaryLabel: "Open decks",
    };
  }

  return {
    type: "focused_review",
    title: "Choose a focused study session.",
    description: "Open a notebook, review cards, or organise a folder.",
    href: getCustomStudyHref({ mode: "custom" }),
    label: "Focused review",
    priority: 13,
    secondaryHref: "/dashboard/folders",
    secondaryLabel: "Open folders",
  };
}

export function buildTodayPlan(input: BuildTodayPlanInput): TodayPlan {
  const now = input.now ?? Date.now();
  const dueCards = buildDueSummary(input, now);
  const drafts = buildDrafts(input);
  const { topicProgress, weakTopics } = buildWeakTopics(input, now);
  const studyActions = buildStudyActions(input);
  const goalSummary = buildGoalSummary(input, now);
  const workspace = buildWorkspaceSummary(input);
  const nextAction = buildNextAction({
    decks: input.decks,
    cards: input.cards,
    dueCards,
    drafts,
    weakTopics,
    studyActions,
    goalSummary,
    workspace,
    reviewedToday: input.reviewedToday ?? 0,
    hasEarnedStars: input.hasEarnedStars === true,
    hasActiveStudySession: input.hasActiveStudySession === true,
  });

  return {
    nextAction,
    dueCards,
    studyActions,
    weakTopics,
    drafts,
    goalSummary,
    workspace,
    topicProgress,
  };
}
