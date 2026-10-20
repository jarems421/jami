import { describeStudyAction } from "@/lib/dashboard/today-plan";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import type { LearnerProfile, LearningDemonstration } from "@/lib/learning/types";

/**
 * A folder's topics as a topic goal reads them: where the engine puts each one,
 * and the engine's own next step for it.
 *
 * Nothing is estimated here. The demonstration is the profile's, decided by
 * the engine's thresholds from recorded evidence, and the step is a study
 * action the engine already built. This only puts them side by side for a
 * goal to show.
 */

export type TopicStanding = {
  key: string;
  label: string;
  demonstration: LearningDemonstration;
  /** The engine's recommendation for this topic, when it has one that leads somewhere. */
  action?: { label: string; href: string };
};

export const TOPIC_STANDING_LIMIT = 80;

/** Topics worth aiming at first; strong ones last, as there is nothing left to reach. */
const AIM_ORDER: Record<LearningDemonstration, number> = {
  weak: 0,
  developing: 1,
  insufficient: 2,
  none: 3,
  strong: 4,
};

export function topicStandingsFromProfile(
  profile: Pick<LearnerProfile, "topics">,
  actions: readonly StudyAction[],
  limit = TOPIC_STANDING_LIMIT
): TopicStanding[] {
  const actionByKey = new Map<string, StudyAction>();
  for (const action of actions) {
    if (action.target.kind !== "topic" || !action.destination) continue;
    if (!actionByKey.has(action.target.topicKey)) actionByKey.set(action.target.topicKey, action);
  }

  return profile.topics
    .filter(
      (state) =>
        state.declared ||
        Boolean(state.signal) ||
        state.exposure.cards + state.exposure.notebooks + state.exposure.sources > 0
    )
    .map((state) => {
      // A topic too thinly evidenced to judge alone defers to a broader one, whose step is the right one to take.
      const action =
        actionByKey.get(state.topicKey) ?? (state.deferredTo ? actionByKey.get(state.deferredTo) : undefined);
      return {
        key: state.topicKey,
        label: state.label,
        demonstration: state.demonstration,
        ...(action?.destination
          ? { action: { label: describeStudyAction(action).label, href: action.destination.href } }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        AIM_ORDER[left.demonstration] - AIM_ORDER[right.demonstration] || left.label.localeCompare(right.label)
    )
    .slice(0, limit);
}

/** Reads a route's answer back, keeping only well-formed entries. */
export function readTopicStandings(value: unknown): TopicStanding[] {
  if (!Array.isArray(value)) return [];
  const standings: TopicStanding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const demonstration = record.demonstration;
    if (
      typeof record.key !== "string" ||
      typeof record.label !== "string" ||
      !(typeof demonstration === "string" && demonstration in AIM_ORDER)
    ) {
      continue;
    }
    const action = record.action as Record<string, unknown> | undefined;
    standings.push({
      key: record.key,
      label: record.label,
      demonstration: demonstration as LearningDemonstration,
      ...(action && typeof action.label === "string" && typeof action.href === "string" && action.href.startsWith("/dashboard/")
        ? { action: { label: action.label, href: action.href } }
        : {}),
    });
  }
  return standings;
}
