import {
  getCustomStudyHref,
  getDeckStudyHref,
  getFolderHref,
  getQuestionPracticeSetupHref,
  getTopicHref,
} from "@/lib/app/routes";
import type { Goal } from "@/lib/goals/model";

/**
 * Where to go to move a goal on.
 *
 * A goal that only counts is a scoreboard. Each one opens the work that counts
 * towards it: a flashcard session over exactly the cards in its scope, Past
 * Paper Practice for its folder, or -- for a topic -- whatever the Learning
 * Engine currently recommends for that topic. The goal never chooses the work
 * itself; for a topic it only carries the engine's own choice through.
 */

export type GoalNextStep = { label: string; href: string };

export type GoalNextStepContext = {
  decks: readonly { id: string; folderIds: readonly string[] }[];
  folders: readonly { id: string; examCourse?: unknown }[];
  /** The engine's current recommendation for a topic goal's topic, when it has one. */
  topicAction?: GoalNextStep;
};

export function goalNextStep(goal: Goal, context: GoalNextStepContext): GoalNextStep | null {
  if (goal.status !== "active") return null;

  if (goal.measure === "cards") {
    const scopeId = goal.scope.id ?? "";
    if (goal.scope.type === "deck" && scopeId) return { label: "Review cards", href: getDeckStudyHref(scopeId) };
    if (goal.scope.type === "topic" && scopeId) {
      return { label: "Review cards", href: getCustomStudyHref({ mode: "custom", topicIds: [scopeId] }) };
    }
    if (goal.scope.type === "folder" && scopeId) {
      const deckIds = context.decks.filter((deck) => deck.folderIds.includes(scopeId)).map((deck) => deck.id);
      return deckIds.length > 0
        ? { label: "Review cards", href: getCustomStudyHref({ mode: "custom", deckIds }) }
        : { label: "Open folder", href: getFolderHref(scopeId, "decks") };
    }
    return { label: "Review cards", href: getCustomStudyHref({ mode: "daily" }) };
  }

  if (goal.measure === "questions") {
    const folderId = goal.scope.type === "folder" ? goal.scope.id : undefined;
    if (!folderId) return { label: "Practice", href: "/dashboard/practice" };
    const folder = context.folders.find((candidate) => candidate.id === folderId);
    return folder?.examCourse
      ? { label: "Practice questions", href: getQuestionPracticeSetupHref({ folderId }) }
      : { label: "Practice", href: getFolderHref(folderId, "practice") };
  }

  if (context.topicAction) return context.topicAction;
  const key = goal.topic?.key ?? "";
  if (key.startsWith("topic:")) return { label: "Open topic", href: getTopicHref(key.slice("topic:".length)) };
  const folderId = goal.scope.type === "folder" ? goal.scope.id : undefined;
  return folderId ? { label: "Open folder", href: getFolderHref(folderId) } : null;
}
