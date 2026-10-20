import {
  collection,
  deleteField,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";
import { migrateStoredRevisionPlan } from "@/lib/planning/migrate-plan";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import { normalizePlanActivities, normalizePlanActivityDone } from "@/lib/planning/plan-activities";
import { openActivityFromFreeSession, planFreeSessionsOn, storedPlanDay } from "@/lib/planning/timetable";
import { applyTimetableOps, timetableOpDays, type TimetableOp } from "@/lib/planning/timetable-ops";
import {
  REVISION_PLAN_SCHEMA_VERSION,
  planAutoFills,
  type PinnedPlanItem,
  type PlanActivity,
  type PlanActivityDone,
  type RevisionPlan,
  type RevisionPlanDraft,
  type RevisionPlanEntry,
} from "@/lib/planning/types";
import { reportTutorialAction } from "@/lib/onboarding/tutorial";

/**
 * Where a student's revision plans live.
 *
 * A plan is the student's own writing, not learner evidence: it says what they
 * intend to do, never what they know. Nothing here is read by the Learning
 * Engine, and a tick recorded here must never reach a learner profile -- see
 * `lib/planning/types.ts`.
 *
 * The plan document holds the plan; `entries/{dayKey}` holds each day that has
 * a timetable of its own, its activities in one array and what was done in a
 * map beside it. Days nobody planned store nothing.
 */

export const MAX_PLANS_PER_STUDENT = 8;
/** How long a timetable write may take before the student is told it did not save. */
const PLAN_WRITE_MS = 12_000;

const plansPath = (uid: string) => collection(db, "users", uid, "revisionPlans");
const planPath = (uid: string, planId: string) => doc(db, "users", uid, "revisionPlans", planId);
const entriesPath = (uid: string, planId: string) =>
  collection(db, "users", uid, "revisionPlans", planId, "entries");
const entryPath = (uid: string, planId: string, dayKey: string) =>
  doc(db, "users", uid, "revisionPlans", planId, "entries", dayKey);

function readPlan(id: string, data: Record<string, unknown>): RevisionPlan {
  // Normalised on the way out as well as in: a document written by an older
  // build, or edited in the console, still has to come back as a usable plan.
  // Migrated first, so a version 1 `cadence` arrives as sessions rather than as
  // a plan with no days at all.
  const { draft } = normalizeRevisionPlanDraft(
    migrateStoredRevisionPlan(data) as Partial<RevisionPlanDraft>
  );
  const schemaVersion =
    typeof data.schemaVersion === "number" ? data.schemaVersion : REVISION_PLAN_SCHEMA_VERSION;
  return {
    ...draft,
    id,
    schemaVersion,
    // Settled here, once, so a version 2 plan saved by this build keeps Jami
    // filling its days rather than quietly losing it on its first edit.
    autoFill: planAutoFills({ ...draft, schemaVersion }),
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

function readEntry(dayKey: string, data: Record<string, unknown>): RevisionPlanEntry {
  const pinned = Array.isArray(data.pinned)
    ? (data.pinned as PinnedPlanItem[]).filter(
        (item) => item && typeof item.actionId === "string" && typeof item.label === "string"
      )
    : undefined;
  const completedSlotIds = Array.isArray(data.completedSlotIds)
    ? (data.completedSlotIds as unknown[]).filter((id): id is string => typeof id === "string")
    : undefined;
  const done = normalizePlanActivityDone(data.done);
  return {
    dayKey,
    ...(Array.isArray(data.activities) ? { activities: normalizePlanActivities(data.activities) } : {}),
    ...(Object.keys(done).length > 0 ? { done } : {}),
    ...(pinned && pinned.length > 0 ? { pinned } : {}),
    ...(data.skipped === true ? { skipped: true } : {}),
    ...(completedSlotIds && completedSlotIds.length > 0 ? { completedSlotIds } : {}),
    ...(typeof data.updatedAt === "number" ? { updatedAt: data.updatedAt } : {}),
  };
}

/**
 * Today's plan as last read, kept on this device for the next launch.
 *
 * Today will not draw its first card until it knows whether there is a plan,
 * so the plan's two reads -- the plan, then its week -- sat in front of the
 * whole page on every launch, plan or none. The kept copy answers at once and
 * is read again behind it. Only the week it was read for is kept, and it comes
 * back through the same normalising as a stored document does.
 */
const STORED_TODAY_PLAN_PREFIX = "jami:today-plan:";
/** 2: days carry activities. A version 1 copy is from a build that cannot read them. */
const STORED_TODAY_PLAN_VERSION = 2;

export type StoredTodayRevisionPlan = {
  plan: RevisionPlan | null;
  entries: RevisionPlanEntry[];
};

export function readStoredTodayRevisionPlan(
  uid: string,
  weekStartDayKey: string
): StoredTodayRevisionPlan | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${STORED_TODAY_PLAN_PREFIX}${uid}`);
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return null;
    const { version, weekStartDayKey: storedWeek, plan, entries } = stored as Record<string, unknown>;
    if (version !== STORED_TODAY_PLAN_VERSION || storedWeek !== weekStartDayKey) return null;
    if (!Array.isArray(entries)) return null;
    if (plan === null) return { plan: null, entries: [] };
    if (typeof plan !== "object" || typeof (plan as { id?: unknown }).id !== "string") {
      return null;
    }
    const planData = plan as Record<string, unknown>;
    return {
      plan: readPlan(planData.id as string, planData),
      entries: entries
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && typeof entry.dayKey === "string"
        )
        .map((entry) => readEntry(entry.dayKey as string, entry)),
    };
  } catch {
    return null;
  }
}

export function storeTodayRevisionPlan(
  uid: string,
  weekStartDayKey: string,
  value: StoredTodayRevisionPlan
) {
  try {
    window.localStorage.setItem(
      `${STORED_TODAY_PLAN_PREFIX}${uid}`,
      JSON.stringify({ version: STORED_TODAY_PLAN_VERSION, weekStartDayKey, ...value })
    );
  } catch {
    // Only a head start for the next launch.
  }
}

/** Forgets every kept plan on this device, at sign-out. */
export function clearStoredTodayRevisionPlans() {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORED_TODAY_PLAN_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage that cannot be read holds nothing to clear.
  }
}

export async function loadRevisionPlans(uid: string): Promise<RevisionPlan[]> {
  const snapshot = await getDocs(
    query(plansPath(uid), orderBy("updatedAt", "desc"), limit(MAX_PLANS_PER_STUDENT))
  );
  return snapshot.docs.map((entry) => readPlan(entry.id, entry.data()));
}

/**
 * The plan Today should show, or null.
 *
 * One active plan is shown at a time. Two timetables competing for the top of
 * Today is the thing the strip exists to prevent.
 */
export async function loadActiveRevisionPlan(uid: string): Promise<RevisionPlan | null> {
  const snapshot = await getDocs(
    query(plansPath(uid), where("status", "==", "active"), orderBy("updatedAt", "desc"), limit(1))
  );
  const first = snapshot.docs[0];
  return first ? readPlan(first.id, first.data()) : null;
}

export async function loadRevisionPlanEntries(
  uid: string,
  planId: string,
  options: { fromDayKey?: string; toDayKey?: string; max?: number } = {}
): Promise<RevisionPlanEntry[]> {
  const constraints = [
    ...(options.fromDayKey ? [where("dayKey", ">=", options.fromDayKey)] : []),
    ...(options.toDayKey ? [where("dayKey", "<=", options.toDayKey)] : []),
    orderBy("dayKey", "asc"),
    limit(Math.max(1, options.max ?? 120)),
  ];
  const snapshot = await getDocs(query(entriesPath(uid, planId), ...constraints));
  return snapshot.docs.map((entry) => readEntry(entry.id, entry.data()));
}

function planDocument(safe: RevisionPlanDraft, now: number) {
  return {
    ...safe,
    // The draft leaves out an empty exam list, and a merge keeps whatever it
    // leaves out -- so removing the last exam has to delete it by name.
    exams: safe.exams ?? deleteField(),
    autoFill: safe.autoFill ?? false,
    schemaVersion: REVISION_PLAN_SCHEMA_VERSION,
    updatedAt: now,
    // Written alongside the client clock so a device with the wrong time
    // cannot silently reorder somebody's plans.
    serverUpdatedAt: serverTimestamp(),
  };
}

/**
 * A day's activities as they are written. The normaliser builds every field
 * conditionally, so nothing reaches Firestore as `undefined`, which it refuses.
 */
const writableActivities = (activities: readonly PlanActivity[]) => normalizePlanActivities(activities);

export async function saveRevisionPlan(
  uid: string,
  planId: string,
  draft: RevisionPlanDraft,
  options: { activityCount?: number } = {}
): Promise<RevisionPlan> {
  const { draft: safe, valid } = normalizeRevisionPlanDraft(draft, Date.now(), options);
  if (!valid) throw new Error("This plan is missing something Jami needs.");
  const now = Date.now();
  await setDoc(planPath(uid, planId), planDocument(safe, now), { merge: true });
  reportTutorialAction("plan-week");
  return { ...safe, autoFill: safe.autoFill ?? false, id: planId, schemaVersion: REVISION_PLAN_SCHEMA_VERSION, createdAt: now, updatedAt: now };
}

/**
 * A new plan and every day already on its timetable, in one write.
 *
 * One batch, so a plan never exists without the days the student watched it
 * fill with -- or those days without it.
 */
export async function createRevisionPlan(
  uid: string,
  planId: string,
  draft: RevisionPlanDraft,
  days: ReadonlyMap<string, readonly PlanActivity[]>
): Promise<RevisionPlan> {
  const activityCount = [...days.values()].reduce((total, activities) => total + activities.length, 0);
  const { draft: safe, valid } = normalizeRevisionPlanDraft(draft, Date.now(), { activityCount });
  if (!valid) throw new Error("This plan is missing something Jami needs.");
  const now = Date.now();
  const batch = writeBatch(db);
  batch.set(planPath(uid, planId), { ...planDocument(safe, now), createdAt: now }, { merge: true });
  for (const [dayKey, activities] of days) {
    batch.set(entryPath(uid, planId, dayKey), {
      dayKey,
      activities: writableActivities(activities),
      updatedAt: now,
    });
  }
  await withTimeout(batch.commit(), PLAN_WRITE_MS, "Save revision plan");
  reportTutorialAction("plan-week");
  return { ...safe, autoFill: safe.autoFill ?? false, id: planId, schemaVersion: REVISION_PLAN_SCHEMA_VERSION, createdAt: now, updatedAt: now };
}

export async function archiveRevisionPlan(uid: string, planId: string) {
  await updateDoc(planPath(uid, planId), {
    status: "archived",
    updatedAt: Date.now(),
    serverUpdatedAt: serverTimestamp(),
  });
}

/**
 * Changes to the timetable, applied to the copy on the server.
 *
 * The same ops the screen already applied, run again inside a transaction on
 * what is stored now -- so an edit made on another device a moment ago is kept,
 * and two edits to the same day cannot overwrite each other. A day that goes
 * back to the usual week loses its activities, and a version 2 day written for
 * the first time keeps the ticks it was read with.
 *
 * Returns every day the ops named, as it now stands -- changed or not, so a
 * screen that applied a change the server then refused (a fill of a day that
 * had been planned elsewhere) is put right.
 */
export async function applyRevisionPlanOps(
  uid: string,
  plan: RevisionPlan,
  ops: readonly TimetableOp[]
): Promise<RevisionPlanEntry[]> {
  const dayKeys = [...new Set(ops.flatMap(timetableOpDays))];
  if (dayKeys.length === 0) return [];
  const now = Date.now();
  const run = runTransaction(db, async (transaction) => {
    const snapshots = await Promise.all(dayKeys.map((dayKey) => transaction.get(entryPath(uid, plan.id, dayKey))));
    const stored = new Map<string, PlanActivity[]>();
    const carriedDone = new Map<string, Record<string, PlanActivityDone>>();
    const existing = new Map<string, RevisionPlanEntry>();
    snapshots.forEach((snapshot, index) => {
      const dayKey = dayKeys[index] as string;
      const entry = snapshot.exists() ? readEntry(dayKey, snapshot.data()) : null;
      if (entry) existing.set(dayKey, entry);
      const own = storedPlanDay(plan, entry);
      if (!own) return;
      stored.set(dayKey, own.activities);
      if (entry && !entry.activities) carriedDone.set(dayKey, own.done);
    });

    const { touched } = applyTimetableOps(stored, ops, {
      freeSessionsFor: (dayKey) => planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession),
    });

    const written: RevisionPlanEntry[] = [];
    for (const [dayKey, activities] of touched) {
      const ref = entryPath(uid, plan.id, dayKey);
      const before = existing.get(dayKey);
      const done = { ...(before?.done ?? {}), ...(carriedDone.get(dayKey) ?? {}) };
      if (activities === null) {
        if (before) {
          transaction.set(
            ref,
            { dayKey, activities: deleteField(), pinned: deleteField(), completedSlotIds: deleteField(), skipped: deleteField(), updatedAt: now },
            { merge: true }
          );
        }
        written.push({ dayKey, ...(Object.keys(done).length > 0 ? { done } : {}), updatedAt: now });
        continue;
      }
      const cleaned = writableActivities(activities);
      transaction.set(
        ref,
        {
          dayKey,
          activities: cleaned,
          ...(carriedDone.has(dayKey) ? { done } : {}),
          // Read into activities now, so the version 2 fields have said all they can.
          pinned: deleteField(),
          completedSlotIds: deleteField(),
          skipped: deleteField(),
          updatedAt: now,
        },
        { merge: true }
      );
      written.push({ dayKey, activities: cleaned, ...(Object.keys(done).length > 0 ? { done } : {}), updatedAt: now });
    }
    for (const dayKey of dayKeys) {
      if (!touched.has(dayKey)) written.push(existing.get(dayKey) ?? { dayKey });
    }
    return written;
  });
  return withTimeout(run, PLAN_WRITE_MS, "Save revision plan days");
}

/**
 * That an activity was done, or no longer is.
 *
 * One key of the day's `done` map, merged in -- no transaction, so it works
 * offline and never rewrites the day's activities. A day still on its usual
 * week gets an entry holding only this, which leaves it on its usual week.
 */
export async function setRevisionPlanActivityDone(
  uid: string,
  planId: string,
  dayKey: string,
  activityId: string,
  done: PlanActivityDone | null
) {
  await setDoc(
    entryPath(uid, planId, dayKey),
    { dayKey, done: { [activityId]: done ?? deleteField() }, updatedAt: Date.now() },
    { merge: true }
  );
}

/** Work Jami saw done today, written down so it stays done when the same cards come round again. */
export async function recordRevisionPlanActivitiesSeen(
  uid: string,
  planId: string,
  dayKey: string,
  activityIds: readonly string[],
  at = Date.now()
) {
  if (activityIds.length === 0) return;
  const done = Object.fromEntries(activityIds.map((id) => [id, { by: "activity", at }]));
  await setDoc(entryPath(uid, planId, dayKey), { dayKey, done, updatedAt: at }, { merge: true });
}
