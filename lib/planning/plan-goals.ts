import type { Goal } from "@/lib/goals/model";
import type { PlanActivity } from "@/lib/planning/types";

/**
 * The running goal a planned activity moves, if one does.
 *
 * A plan says when there is time to study; a goal says what the time should add
 * up to. Doing a planned task moves a goal only through the work it records --
 * flashcard reviews for a card goal, marked answers for a question goal, the
 * engine's judgement for a topic goal (`lib/goals/progress.ts`) -- so this says
 * which goal that will be, by the same measures, and claims nothing more. The
 * first that matches is named: the screen has room for one, and goals arrive in
 * the order Goals shows them.
 */
export function planActivityGoal<G extends Pick<Goal, "status" | "measure" | "scope" | "topic">>(
  activity: Pick<PlanActivity, "method" | "scopeKey" | "topic" | "open">,
  goals: readonly G[]
): G | undefined {
  if (activity.open) return undefined;
  return goals.find((goal) => {
    if (goal.status !== "active") return false;
    if (goal.measure === "topic") {
      const key = goal.topic?.key ?? "";
      return Boolean(activity.topic) && key.slice(key.indexOf(":") + 1) === activity.topic?.id;
    }
    const scope = goal.scope;
    const inScope =
      scope.type === "all" ||
      (scope.type === "folder" && activity.scopeKey === `folder:${scope.id}`) ||
      (scope.type === "deck" &&
        (activity.scopeKey === `deck:${scope.id}` || (activity.topic?.kind === "deck" && activity.topic.id === scope.id))) ||
      (scope.type === "topic" && activity.topic?.kind === "topic" && activity.topic.id === scope.id);
    if (!inScope) return false;
    if (goal.measure === "cards") return activity.method === "flashcards";
    // A question goal counts marked practice, which a folder's own practice is.
    return goal.measure === "questions" && activity.method === "practice" && scope.type !== "deck" && scope.type !== "topic";
  });
}
