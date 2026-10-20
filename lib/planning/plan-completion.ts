import type { PlanActivity, PlanActivityDone } from "@/lib/planning/types";

/**
 * Which planned activities were done, and how Jami can honestly say so.
 *
 * A task ticking itself is half the point of a plan: a student who did the work
 * should never also have to say so. But the tick has to mean the task, not
 * merely that something happened in the same subject. Version 2 crossed off
 * slots by subject, so reviewing any Biology card ticked "10 homeostasis exam
 * questions". Now each kind of evidence completes only what it is evidence of:
 *
 * - The session opened from a task was finished. Every link Jami puts on a
 *   task it chose carries the engine action's id, and finishing that session
 *   records a completed study action event for it. That event completes that
 *   task and nothing else.
 * - Flashcard tasks complete from reviews of their own cards: the topic's, the
 *   deck's, or the subject's -- never another subject's, and never a practice,
 *   notebook or student-written task.
 * - Everything else is the student's word: the tick.
 *
 * None of this is evidence about learning. That a card was reviewed is already
 * known to the learner profile, far more precisely, from the answer itself.
 */

export type PlanCompletionCard = {
  id: string;
  deckId: string;
  topicIds?: readonly string[];
  lastReview?: number;
};

export type PlanCompletionDeck = {
  id: string;
  folderIds?: readonly string[];
};

/** What Jami can see was done. */
export type PlanCompletionEvidence = {
  /**
   * The one study day whose card reviews are known. A card keeps only its
   * latest review, so yesterday's reviews of cards seen again today are gone;
   * reading them for any other day would un-tick work that was done. Work seen
   * today is written down today (`by: "activity"`), which is what keeps it.
   */
  reviewDayKey: string;
  reviewedCardIds: ReadonlySet<string>;
  cards: readonly PlanCompletionCard[];
  deckFolders: ReadonlyMap<string, readonly string[]>;
  /** Engine actions whose sessions were finished, by study day. Durable, so any day can read them. */
  completedActionIds: ReadonlyMap<string, ReadonlySet<string>>;
};

/** How many reviews make a flashcard task done when it names no number. */
export const REVIEWS_PER_FLASHCARD_ACTIVITY = 10;

export function buildPlanCompletionEvidence(input: {
  cards: readonly PlanCompletionCard[];
  decks: readonly PlanCompletionDeck[];
  reviewDayKey: string;
  /** The study day of a timestamp, as the rest of the app counts days. */
  dayOf: (timestamp: number) => string;
  completedActionIds?: ReadonlyMap<string, ReadonlySet<string>>;
}): PlanCompletionEvidence {
  const reviewedCardIds = new Set<string>();
  for (const card of input.cards) {
    if (typeof card.lastReview === "number" && input.dayOf(card.lastReview) === input.reviewDayKey) {
      reviewedCardIds.add(card.id);
    }
  }
  return {
    reviewDayKey: input.reviewDayKey,
    reviewedCardIds,
    cards: input.cards,
    deckFolders: new Map(input.decks.map((deck) => [deck.id, deck.folderIds ?? []])),
    completedActionIds: input.completedActionIds ?? new Map(),
  };
}

/** Whether a card is one of the cards a flashcard task is about. */
function isCardOf(
  activity: Pick<PlanActivity, "topic" | "scopeKey">,
  card: PlanCompletionCard,
  deckFolders: ReadonlyMap<string, readonly string[]>
) {
  const topic = activity.topic;
  if (topic?.kind === "topic") return card.topicIds?.includes(topic.id) ?? false;
  if (topic?.kind === "deck") return card.deckId === topic.id;
  const scopeKey = activity.scopeKey;
  if (!scopeKey) return true;
  if (scopeKey.startsWith("deck:")) return card.deckId === scopeKey.slice(5);
  if (scopeKey.startsWith("folder:")) return (deckFolders.get(card.deckId) ?? []).includes(scopeKey.slice(7));
  return false;
}

/** The narrower a task, the earlier it is given reviews: a topic's task before its subject's. */
function specificity(activity: Pick<PlanActivity, "topic" | "scopeKey">) {
  if (activity.topic?.kind === "topic" || activity.topic?.kind === "deck") return 0;
  return activity.scopeKey ? 1 : 2;
}

export type PlanActivityCompletion = PlanActivityDone & {
  /** Seen in the evidence on this read and not yet written down. */
  observed?: true;
};

/**
 * What was done on one day: what is written down, and what the evidence now
 * shows that is not written down yet.
 */
export function planDayCompletion(
  dayKey: string,
  activities: readonly PlanActivity[],
  stored: Readonly<Record<string, PlanActivityDone>> | undefined,
  evidence: PlanCompletionEvidence | undefined,
  now = Date.now()
): Map<string, PlanActivityCompletion> {
  const done = new Map<string, PlanActivityCompletion>();
  for (const activity of activities) {
    const record = stored?.[activity.id];
    if (record && !activity.open) done.set(activity.id, record);
  }
  if (!evidence) return done;

  const finished = evidence.completedActionIds.get(dayKey);
  for (const activity of activities) {
    if (done.has(activity.id) || activity.open || !activity.actionId) continue;
    if (finished?.has(activity.actionId)) done.set(activity.id, { by: "activity", at: now, observed: true });
  }

  if (dayKey !== evidence.reviewDayKey || evidence.reviewedCardIds.size === 0) return done;

  /*
   * Reviews are shared out, never counted twice: twenty Biology cards reviewed
   * complete one twenty-card Biology task, or a ten-card homeostasis task and a
   * ten-card Biology task, but not both twenty-card tasks.
   */
  const spent = new Set<string>();
  const flashcardTasks = activities
    .map((activity, index) => ({ activity, index }))
    .filter(({ activity }) => activity.method === "flashcards" && !activity.open && !done.has(activity.id))
    .sort((left, right) => specificity(left.activity) - specificity(right.activity) || left.index - right.index);

  for (const { activity } of flashcardTasks) {
    const own = evidence.cards.filter((card) => isCardOf(activity, card, evidence.deckFolders));
    // A deck of six cards is finished after six, not never.
    const needed = Math.max(1, Math.min(activity.targetItems ?? REVIEWS_PER_FLASHCARD_ACTIVITY, own.length));
    const reviewed = own.filter((card) => evidence.reviewedCardIds.has(card.id) && !spent.has(card.id));
    if (reviewed.length < needed) continue;
    for (const card of reviewed.slice(0, needed)) spent.add(card.id);
    done.set(activity.id, { by: "activity", at: now, observed: true });
  }
  return done;
}
