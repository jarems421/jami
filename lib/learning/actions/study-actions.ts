import {
  getCustomStudyHref,
  getDeckHref,
  getFolderHref,
  getNotebookHref,
  getQuestionPracticeSetupHref,
  getRevisionSessionStartHref,
  getTopicHref,
} from "@/lib/app/routes";
import { recommendationTargetKey } from "@/lib/learning/recommendations/recommend-focus";
import {
  actionCooldown,
  type ActionHistory,
  type CooldownReason,
} from "@/lib/learning/actions/action-cooldown";
import {
  locateNotebookMaterial,
  type NotebookMaterialIndex,
  type NotebookMaterialPlace,
} from "@/lib/learning/actions/notebook-material";
import {
  buildStudySessionSpec,
  type StudySessionSelection,
  type StudySessionSpec,
} from "@/lib/learning/actions/session-spec";
import {
  selectIntervention,
  type InterventionAvailability,
  type InterventionChoice,
} from "@/lib/learning/interventions/catalogue";
import type {
  LearnerProfile,
  LearningRecommendation,
  LearningTopicState,
} from "@/lib/learning/types";

/**
 * Recommendations turned into things a student can actually start.
 *
 * Every destination is a surface Jami already has -- a flashcard session, Past
 * Paper Practice narrowed to a topic, a folder's practice papers, a Topic or
 * deck page, or the student's own notebook page on it. When no surface can
 * carry an action out (a diagnosis on a topic with no cards and no question
 * bank), the action has no destination rather than a link that pretends.
 */

export type StudyActionDestinationKind =
  | "flashcards"
  | "question-practice"
  | "practice-papers"
  | "topic"
  | "deck"
  | "notebook"
  | "revision-session";

export type StudyActionDestination = {
  kind: StudyActionDestinationKind;
  href: string;
  /**
   * What the destination should work on, for a surface that can take direction.
   *
   * The href already carries this as query parameters; this is the same choice
   * in a form the engine and its tests can read without parsing a URL.
   */
  selection: StudySessionSelection;
  /** The notebook, and page where known, for a `notebook` destination. */
  notebook?: NotebookMaterialPlace;
};

export type StudyAction = LearningRecommendation & {
  /** Stable across requests for the same scope, reason and target. */
  id: string;
  scope: { folderId?: string; deckId?: string };
  /** `reason.action`, for logs and for copy that must stay in step with the decision. */
  explanationCode: string;
  destination?: StudyActionDestination;
  /** What the engine wants the destination to do; absent when nothing can carry it out. */
  spec?: StudySessionSpec;
  /**
   * What could actually be done about this need, given the material that
   * exists. Absent for an error target, which belongs to no single concept,
   * and for a decision the catalogue has no action for.
   *
   * The engine's decision is unchanged by this. It says what the student
   * needs; the intervention says how that need can be met today.
   */
  intervention?: InterventionChoice;
  /**
   * Why this action is being held back, when it is.
   *
   * Kept on the action rather than filtered out here, so a caller that wants
   * the full picture -- the evaluation, a debug view -- can still see it, and
   * only the surfaces choose to hide it.
   */
  cooldown?: CooldownReason;
};

export type StudyActionContext = {
  /** Past Paper Practice is enabled and the folder has a course it can draw on. */
  questionPracticeAvailable: boolean;
  /** Whether this deployment can write cards and questions for the student. */
  canGenerate?: { flashcards: boolean; practice: boolean };
  /** Whether this deployment can teach a concept in a Revision Session. */
  canRunRevisionSession?: boolean;
  /**
   * Where the student's own notebook material is, by concept. Going back over
   * material opens the page they worked on it, when there is one, rather than
   * the Topic page to look for it.
   */
  notebookMaterial?: NotebookMaterialIndex;
};

/**
 * What can be done for one concept, from signals the profile already holds.
 *
 * Cheap by construction: cards, notebooks and sources come from exposure,
 * which is already counted. The question banks are left undefined because
 * asking them costs more than a whole profile build, and undefined means
 * unknown rather than empty -- see `InterventionAvailability`.
 */
export function cheapAvailability(
  state: LearningTopicState,
  context: StudyActionContext
): InterventionAvailability {
  return {
    hasFlashcards: state.exposure.cards > 0,
    flashcardCount: state.exposure.cards,
    hasMaterial: state.exposure.notebooks + state.exposure.sources > 0,
    canCreateFlashcards: context.canGenerate?.flashcards ?? false,
    canCreatePractice: context.canGenerate?.practice ?? false,
    ...(context.canRunRevisionSession ? { canRunRevisionSession: true } : {}),
    ...(context.questionPracticeAvailable ? {} : { hasPastPaper: false }),
  };
}

function topicIdOf(topicKey: string) {
  const separator = topicKey.indexOf(":");
  return separator > 0 ? topicKey.slice(separator + 1) : "";
}

export function resolveStudyActionDestination(
  recommendation: LearningRecommendation,
  profile: Pick<LearnerProfile, "scope" | "topics">,
  context: StudyActionContext
): StudyActionDestination | undefined {
  const folderId = profile.scope.folderId;
  const { target, action } = recommendation;

  if (target.kind === "error") {
    const sources = recommendation.evidence.sources;
    if (folderId && context.questionPracticeAvailable && sources.includes("past-paper")) {
      return {
        kind: "question-practice",
        href: getQuestionPracticeSetupHref({ folderId }),
        // An error spans topics, so its practice is the folder's own question pool.
        selection: {},
      };
    }
    if (folderId && sources.includes("practice")) {
      return {
        kind: "practice-papers",
        href: getFolderHref(folderId, "practice"),
        selection: {},
      };
    }
    return undefined;
  }

  const id = topicIdOf(target.topicKey);
  if (!id) return undefined;

  const state = profile.topics.find((topic) => topic.topicKey === target.topicKey);

  if (target.source === "specification") {
    // Specification topics are practised through the question bank; there are no cards to retrieve.
    if (!folderId || !context.questionPracticeAvailable || action === "teach" || action === "retrieve") {
      return undefined;
    }
    // A concept sits beneath a topic, so its practice narrows to the concept rather than the whole topic.
    const narrowing = state?.parentKey ? { conceptIds: [id] } : { topicIds: [id] };
    return {
      kind: "question-practice",
      href: getQuestionPracticeSetupHref({ folderId, ...narrowing }),
      selection: narrowing,
    };
  }

  /*
   * Practice on a Topic or deck means using it, and cards would be the wrong
   * work: the decision is only reached when recall is not what is failing.
   * The folder's practice is where that happens; without a folder there is
   * nowhere honest to send it.
   */
  if (action === "practice") {
    return folderId
      ? { kind: "practice-papers", href: getFolderHref(folderId, "practice"), selection: {} }
      : undefined;
  }

  const hasCards =
    (state?.exposure.cards ?? 0) > 0 || recommendation.evidence.sources.includes("flashcards");

  if (target.source === "deck") {
    if (action === "teach") {
      return { kind: "deck", href: getDeckHref(id), selection: { deckIds: [id] } };
    }
    return hasCards
      ? {
          kind: "flashcards",
          href: getCustomStudyHref({ mode: "custom", deckIds: [id] }),
          selection: { deckIds: [id] },
        }
      : undefined;
  }

  if (action === "teach") {
    return { kind: "topic", href: getTopicHref(id), selection: { topicIds: [id] } };
  }
  if (hasCards) {
    return {
      kind: "flashcards",
      href: getCustomStudyHref({ mode: "custom", topicIds: [id] }),
      selection: { topicIds: [id] },
    };
  }
  // Without cards a topic can still be revisited through its material, but not diagnosed.
  return action === "diagnose"
    ? undefined
    : { kind: "topic", href: getTopicHref(id), selection: { topicIds: [id] } };
}

/**
 * Where the chosen intervention is carried out.
 *
 * The button's words come from the intervention, so its link must too. Taking
 * the link from the engine's action instead is how a mission could read "a
 * short review of cards you already have" and open a page of exam questions.
 * `selectIntervention` only offers what `canCarryOut` allows for the kind of
 * concept, so every case here has a page to go to when the scope has one.
 */
export function resolveInterventionDestination(
  intervention: InterventionChoice,
  target: LearningRecommendation["target"],
  profile: Pick<LearnerProfile, "scope" | "topics">,
  context: StudyActionContext
): StudyActionDestination | undefined {
  if (target.kind !== "topic") return undefined;
  const id = topicIdOf(target.topicKey);
  if (!id) return undefined;
  const folderId = profile.scope.folderId;
  const selection: StudySessionSelection =
    target.source === "deck" ? { deckIds: [id] } : { topicIds: [id] };

  switch (intervention.type) {
    case "past_paper":
    case "create_practice":
    case "create_flashcards":
    case "fill_specification_gap": {
      if (target.source !== "specification" || !folderId) return undefined;
      /*
       * Real questions narrowed to the concept, when the folder's course has
       * them. Material Jami writes is made where the student already is and
       * brings its own link once it is agreed to; this is where the concept
       * is practised, for the surfaces that need an address to show.
       */
      if (context.questionPracticeAvailable) {
        // A concept sits beneath a topic, so its practice narrows to the concept rather than the whole topic.
        const state = profile.topics.find((topic) => topic.topicKey === target.topicKey);
        const narrowing = state?.parentKey ? { conceptIds: [id] } : { topicIds: [id] };
        return {
          kind: "question-practice",
          href: getQuestionPracticeSetupHref({ folderId, ...narrowing }),
          selection: narrowing,
        };
      }
      return intervention.type === "past_paper"
        ? undefined
        : { kind: "practice-papers", href: getFolderHref(folderId, "practice"), selection: {} };
    }
    case "retrieve":
      return {
        kind: "flashcards",
        href: getCustomStudyHref({
          mode: "custom",
          ...(selection.deckIds ? { deckIds: selection.deckIds } : {}),
          ...(selection.topicIds ? { topicIds: selection.topicIds } : {}),
        }),
        selection,
      };
    case "teach":
      // Taught in a session when one can run; its link is finished below,
      // once the action has an id to carry.
      if (context.canRunRevisionSession) {
        return { kind: "revision-session", href: getRevisionSessionStartHref(), selection };
      }
      if (target.source === "specification") return undefined;
      return target.source === "deck"
        ? { kind: "deck", href: getDeckHref(id), selection }
        : { kind: "topic", href: getTopicHref(id), selection };
    case "review_material":
    case "reinforce": {
      // Their own page on it first; its link is finished below, once the action has an id to carry.
      const place = context.notebookMaterial
        ? locateNotebookMaterial(context.notebookMaterial, target.topicKey)
        : undefined;
      if (place) {
        return {
          kind: "notebook",
          href: getNotebookHref(place.notebookId, place.pageId ? { pageId: place.pageId } : undefined),
          selection,
          notebook: place,
        };
      }
      return target.source === "deck"
        ? { kind: "deck", href: getDeckHref(id), selection }
        : { kind: "topic", href: getTopicHref(id), selection };
    }
  }
}

export function buildStudyActions(
  profile: LearnerProfile,
  context: StudyActionContext,
  /**
   * What has already become of this student's advice, by action id.
   *
   * Optional: a caller with no history loaded gets the engine's raw opinion,
   * which is the right answer for the evaluation and for a first request.
   */
  history?: ReadonlyMap<string, ActionHistory>,
  now = Date.now()
): StudyAction[] {
  const scope = profile.scope.folderId
    ? { folderId: profile.scope.folderId }
    : profile.scope.deckId
      ? { deckId: profile.scope.deckId }
      : {};
  const scopeKey = scope.folderId ? `folder:${scope.folderId}` : scope.deckId ? `deck:${scope.deckId}` : "none";
  return profile.recommendedFocus.map((recommendation) => {
    const id = `${scopeKey}|${recommendation.reason}|${recommendationTargetKey(recommendation.target)}`;
    /*
     * What could be done about this, as opposed to what the engine decided.
     *
     * Only for a concept: an error spans topics and has no single body of
     * material to ask about. Built from cheap signals alone, so Today pays
     * nothing for it. Chosen before the destination, because the destination
     * is wherever this is carried out.
     */
    const target = recommendation.target;
    const topicState =
      target.kind === "topic"
        ? profile.topics.find((topic) => topic.topicKey === target.topicKey)
        : undefined;
    const intervention = topicState
      ? selectIntervention(topicState, cheapAvailability(topicState, context))
      : undefined;
    const destination = intervention
      ? resolveInterventionDestination(intervention, target, profile, context)
      : resolveStudyActionDestination(recommendation, profile, context);
    const spec = destination
      ? buildStudySessionSpec(recommendation, destination.selection)
      : undefined;
    /*
     * A flashcard session is the one destination that can be told what to do,
     * so its link carries the spec. The others are pages rather than sessions:
     * a Topic page has no queue to shape, and Past Paper Practice picks its own
     * questions from the corpus. Rebuilt here rather than inside the resolver
     * because the spec is derived from the selection the resolver returns.
     */
    const directed =
      destination?.kind === "revision-session"
        ? // A session is made on the server from the action's id, so its link carries it.
          { ...destination, href: getRevisionSessionStartHref(id) }
        : destination?.kind === "notebook" && destination.notebook
          ? // So a marking of the work done there can say it answered this advice.
            {
              ...destination,
              href: getNotebookHref(destination.notebook.notebookId, {
                ...(destination.notebook.pageId ? { pageId: destination.notebook.pageId } : {}),
                fromActionId: id,
              }),
            }
          : destination && spec && destination.kind === "flashcards"
          ? {
              ...destination,
              href: getCustomStudyHref({
                mode: "custom",
                ...(destination.selection.deckIds ? { deckIds: destination.selection.deckIds } : {}),
                ...(destination.selection.topicIds ? { topicIds: destination.selection.topicIds } : {}),
                focus: { emphasis: spec.emphasis, targetItems: spec.targetItems },
                fromActionId: id,
              }),
            }
          : destination;
    const cooldown = actionCooldown(history?.get(id), recommendation.evidence, now);
    return {
      ...recommendation,
      id,
      scope,
      explanationCode: `${recommendation.reason}.${recommendation.action}`,
      ...(directed ? { destination: directed } : {}),
      ...(spec ? { spec } : {}),
      ...(intervention ? { intervention } : {}),
      ...(cooldown ? { cooldown } : {}),
    };
  });
}

/**
 * Actions from several scopes, ranked together without letting one subject win.
 *
 * Each scope's actions were decided from that scope's evidence alone, so this
 * compares decisions and never mixes subjects. But raw priority is not fully
 * comparable across scopes: within a reason band it is scaled by confidence,
 * and confidence grows with how much evidence a folder happens to hold. Ranked
 * on that alone, the folder a student has worked in most takes every slot and
 * their other subjects silently vanish from Today -- which is the opposite of
 * what someone revising four subjects needs.
 *
 * So each scope gets a fair share of the limit first, taken in priority order
 * within the scope. Slots no scope claims are then filled from everything left,
 * highest priority first, so a student with one active subject still gets a
 * full list. Actions in cooldown are skipped unless nothing else can fill the
 * space, and two actions leading to the same place are shown once.
 */
export function mergeStudyActions(
  groups: readonly (readonly StudyAction[])[],
  options: { limit: number; executableOnly?: boolean; includeCooling?: boolean }
): StudyAction[] {
  const limit = Math.max(0, options.limit);
  if (limit === 0) return [];

  const ranked = groups
    .flatMap((group, groupIndex) => group.map((action) => ({ action, groupIndex })))
    .filter(({ action }) => !options.executableOnly || Boolean(action.destination))
    .filter(({ action }) => options.includeCooling || !action.cooldown)
    .sort(
      (left, right) =>
        right.action.priority - left.action.priority ||
        left.groupIndex - right.groupIndex ||
        left.action.id.localeCompare(right.action.id)
    );

  const scopesPresent = new Set(ranked.map(({ groupIndex }) => groupIndex)).size;
  const share = scopesPresent > 1 ? Math.max(1, Math.ceil(limit / scopesPresent)) : limit;

  const seen = new Set<string>();
  const takenPerGroup = new Map<number, number>();
  const merged: StudyAction[] = [];
  const deferred: typeof ranked = [];

  const take = ({ action, groupIndex }: (typeof ranked)[number]) => {
    const key = action.destination?.href ?? action.id;
    if (seen.has(key)) return;
    seen.add(key);
    takenPerGroup.set(groupIndex, (takenPerGroup.get(groupIndex) ?? 0) + 1);
    merged.push(action);
  };

  for (const entry of ranked) {
    if (merged.length >= limit) break;
    if ((takenPerGroup.get(entry.groupIndex) ?? 0) >= share) {
      deferred.push(entry);
      continue;
    }
    take(entry);
  }

  // A student with one active subject still gets a full list.
  for (const entry of deferred) {
    if (merged.length >= limit) break;
    take(entry);
  }

  return merged;
}
