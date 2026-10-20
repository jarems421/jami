import { collection, doc, getDocs, limit, query, setDoc, where } from "firebase/firestore";
import { featureFlags } from "@/lib/app/feature-flags";
import {
  STUDY_ACTION_EVENTS_COLLECTION,
  buildStudyActionEventWrite,
  decodeStudyActionEvent,
  parseStudyActionId,
  studyActionEventId,
  type StudyActionOutcome,
} from "@/lib/learning/events/study-action-event";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import { db } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";

const RECORD_MS = 15_000;

export type StudyActionEventOutcome = "recorded" | "already-recorded" | "skipped";

/**
 * Records what became of one piece of the engine's advice.
 *
 * Best-effort in the strongest sense: this must never decide whether a student
 * gets to open a study session. Every caller fires it without waiting and
 * swallows the result -- losing the record that advice was shown is a smaller
 * harm by far than a link that hesitates.
 *
 * The id is deterministic per action, outcome and study day, and the rules
 * forbid updates, so a second write of the same thing is refused rather than
 * duplicated. That is what keeps `shown` from turning into a page-view counter
 * as the student comes back to Today through the day.
 */
export async function recordStudyActionEvent(
  userId: string,
  action: Pick<StudyAction, "id" | "reason" | "target" | "scope">,
  outcome: StudyActionOutcome,
  studyDayKey: string,
  now = Date.now()
): Promise<StudyActionEventOutcome> {
  if (!featureFlags.enableStudyActions) return "skipped";
  const targetKey =
    action.target.kind === "topic" ? action.target.topicKey : `error:${action.target.category}`;
  const eventId = studyActionEventId({ actionId: action.id, outcome, studyDayKey });
  const write = buildStudyActionEventWrite(
    {
      actionId: action.id,
      reason: action.reason,
      targetKey,
      ...(action.scope.folderId ? { folderId: action.scope.folderId } : {}),
      ...(action.scope.deckId ? { deckId: action.scope.deckId } : {}),
      outcome,
      at: now,
      studyDayKey,
    },
    now
  );
  if (!userId.trim() || !eventId || !write) return "skipped";

  try {
    await withTimeout(
      setDoc(doc(db, "users", userId, STUDY_ACTION_EVENTS_COLLECTION, eventId), write),
      RECORD_MS,
      "Record study action event"
    );
    return "recorded";
  } catch (error) {
    // Refused as an update: this outcome is already recorded for today.
    if ((error as { code?: unknown } | null)?.code === "permission-denied") return "already-recorded";
    throw error;
  }
}

/** A fortnight of a busy student's finished sessions, and then some. */
const COMPLETED_READ_LIMIT = 300;

/**
 * Which of the engine's actions were finished, on each study day of a range.
 *
 * What lets a revision plan tick a task because its own session was finished
 * -- the one piece of evidence that is about exactly that task. Read with one
 * range on the day key, which needs no index of its own. An empty answer on
 * any failure: the plan then shows only what was ticked by hand.
 */
export async function loadCompletedStudyActions(
  userId: string,
  fromDayKey: string,
  toDayKey: string
): Promise<Map<string, Set<string>>> {
  const byDay = new Map<string, Set<string>>();
  if (!featureFlags.enableStudyActions || !userId.trim()) return byDay;
  try {
    const snapshot = await withTimeout(
      getDocs(
        query(
          collection(db, "users", userId, STUDY_ACTION_EVENTS_COLLECTION),
          where("studyDayKey", ">=", fromDayKey),
          where("studyDayKey", "<=", toDayKey),
          limit(COMPLETED_READ_LIMIT)
        )
      ),
      RECORD_MS,
      "Load finished study actions"
    );
    for (const document of snapshot.docs) {
      const event = decodeStudyActionEvent(document.id, document.data() as Record<string, unknown>);
      if (!event || event.outcome !== "completed") continue;
      const ids = byDay.get(event.studyDayKey) ?? new Set<string>();
      ids.add(event.actionId);
      byDay.set(event.studyDayKey, ids);
    }
  } catch {
    // The plan draws without it.
  }
  return byDay;
}

/**
 * Record without waiting, and without ever throwing.
 *
 * What every UI caller wants: the student is mid-click, and a failure to note
 * what they did must not surface to them or block the navigation.
 */
export function noteStudyActionEvent(
  userId: string,
  action: Pick<StudyAction, "id" | "reason" | "target" | "scope">,
  outcome: StudyActionOutcome,
  studyDayKey: string
) {
  void recordStudyActionEvent(userId, action, outcome, studyDayKey).catch((error: unknown) => {
    console.warn("Could not record what became of a study action.", error);
  });
}

/**
 * Record an outcome for an action known only by its id.
 *
 * What a study session has: it was opened from a recommendation, it knows
 * which one, and it has just been finished. Everything else the record needs
 * is recovered from the id itself. Silent and non-throwing like its sibling
 * above -- finishing a session must never fail because a note about it could
 * not be written.
 */
export function noteStudyActionOutcomeById(
  userId: string,
  actionId: string,
  outcome: StudyActionOutcome,
  studyDayKey: string
) {
  const parsed = parseStudyActionId(actionId);
  if (!parsed || !userId.trim()) return;
  const now = Date.now();
  const eventId = studyActionEventId({ actionId: parsed.actionId, outcome, studyDayKey });
  const write = buildStudyActionEventWrite({ ...parsed, outcome, at: now, studyDayKey }, now);
  if (!eventId || !write) return;
  void withTimeout(
    setDoc(doc(db, "users", userId, STUDY_ACTION_EVENTS_COLLECTION, eventId), write),
    RECORD_MS,
    "Record study action outcome"
  ).catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    // Refused as an update: already recorded for today, which is the point.
    if (code === "permission-denied") return;
    console.warn("Could not record a finished study action.", error);
  });
}
