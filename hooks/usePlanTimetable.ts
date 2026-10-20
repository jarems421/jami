"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openActivityFromFreeSession, planFreeSessionsOn, storedPlanDay } from "@/lib/planning/timetable";
import { applyTimetableOps, type TimetableOp } from "@/lib/planning/timetable-ops";
import type { PlanActivity, RevisionPlan, RevisionPlanEntry } from "@/lib/planning/types";
import {
  applyRevisionPlanOps,
  loadRevisionPlanEntries,
  recordRevisionPlanActivitiesSeen,
  setRevisionPlanActivityDone,
} from "@/services/planning/revision-plans";

/**
 * A plan's timetable, held where the screen can change it.
 *
 * One controller for a plan still being built and for one that is running.
 * Every change is a list of ops (`lib/planning/timetable-ops.ts`) applied here
 * at once, so the screen never waits on the network. A running plan then writes
 * the same ops, one change at a time and in order, inside a transaction on the
 * stored copy; a plan being built keeps them until it is saved.
 *
 * Every change can be undone, whoever made it: the student, a proposal from
 * Jami they applied, or Jami filling their free sessions.
 */

export type PlanTimetableMode = "live" | "draft";

type UndoEntry = { label: string; restore: TimetableOp[]; planBefore?: RevisionPlan };

const MAX_UNDO = 20;
/** Days read in one go: a month view, and the fortnight Jami keeps filled. */
const MAX_ENTRIES_PER_READ = 60;

export type PlanTimetable = {
  entries: ReadonlyMap<string, RevisionPlanEntry>;
  /** Whether the visible days are still being read for the first time. */
  loading: boolean;
  /** Whether the visible days were read from the server this visit, not only shown from a kept copy. */
  synced: boolean;
  saving: boolean;
  problem: string;
  /** Applies ops; false when they changed nothing. */
  apply: (ops: readonly TimetableOp[], options?: { label?: string; planBefore?: RevisionPlan }) => boolean;
  setDone: (dayKey: string, activityId: string, done: boolean) => void;
  recordSeen: (dayKey: string, activityIds: readonly string[]) => void;
  undo: () => void;
  /** What the next undo would take back, or null. */
  undoLabel: string | null;
  /** Every day with a timetable of its own, for saving a plan being built. */
  ownDays: () => Map<string, PlanActivity[]>;
  clearProblem: () => void;
  reload: () => Promise<void>;
};

function ownActivities(plan: RevisionPlan, entries: ReadonlyMap<string, RevisionPlanEntry>) {
  const own = new Map<string, PlanActivity[]>();
  for (const [dayKey, entry] of entries) {
    const stored = storedPlanDay(plan, entry);
    if (stored) own.set(dayKey, stored.activities);
  }
  return own;
}

export function usePlanTimetable(input: {
  uid: string;
  plan: RevisionPlan | null;
  mode: PlanTimetableMode;
  fromDayKey: string;
  toDayKey: string;
  /** Days already known -- a copy kept on this device -- shown while they are read again. */
  initialEntries?: readonly RevisionPlanEntry[];
  /** Puts a plan back as it was, when an undo reaches a change that also changed the plan. */
  onRestorePlan?: (plan: RevisionPlan) => void;
}): PlanTimetable {
  const { uid, plan, mode, fromDayKey, toDayKey } = input;
  const [entries, setEntries] = useState<Map<string, RevisionPlanEntry>>(
    () => new Map((input.initialEntries ?? []).map((entry) => [entry.dayKey, entry]))
  );
  const entriesRef = useRef(entries);
  const planId = plan?.id ?? null;
  const rangeKey = `${planId}|${fromDayKey}|${toDayKey}`;
  // The range a kept copy was read for counts as shown; any other range is read before it is trusted.
  const [loadedKeys, setLoadedKeys] = useState<ReadonlySet<string>>(
    () => new Set(input.initialEntries ? [rangeKey] : [])
  );
  // Ranges read from the server this visit, as opposed to only shown from a kept copy.
  const [syncedKeys, setSyncedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const restorePlanRef = useRef(input.onRestorePlan);
  useEffect(() => {
    restorePlanRef.current = input.onRestorePlan;
  }, [input.onRestorePlan]);

  const commitEntries = useCallback((next: Map<string, RevisionPlanEntry>) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const read = useCallback(async () => {
    if (mode !== "live" || !uid || !planId) return;
    const key = `${planId}|${fromDayKey}|${toDayKey}`;
    try {
      const loaded = await loadRevisionPlanEntries(uid, planId, { fromDayKey, toDayKey, max: MAX_ENTRIES_PER_READ });
      // A read that left before a change was made cannot be allowed to undo it.
      if (pendingRef.current > 0) return;
      const next = new Map(entriesRef.current);
      for (const [dayKey] of next) {
        if (dayKey >= fromDayKey && dayKey <= toDayKey) next.delete(dayKey);
      }
      for (const entry of loaded) next.set(entry.dayKey, entry);
      commitEntries(next);
      setSyncedKeys((keys) => (keys.has(key) ? keys : new Set([...keys, key])));
    } catch {
      setProblem((current) => current || "Some of your plan could not be read just now.");
    } finally {
      setLoadedKeys((keys) => (keys.has(key) ? keys : new Set([...keys, key])));
    }
  }, [commitEntries, fromDayKey, mode, planId, toDayKey, uid]);

  useEffect(() => {
    void read();
  }, [read]);

  const persist = useCallback(
    (ops: readonly TimetableOp[]) => {
      if (mode !== "live" || !plan) return;
      pendingRef.current += 1;
      setSaving(true);
      const written = plan;
      queueRef.current = queueRef.current.then(async () => {
        try {
          const saved = await applyRevisionPlanOps(uid, written, ops);
          // Later changes are already on screen; only the last write's answer is the latest truth.
          if (pendingRef.current === 1) {
            const next = new Map(entriesRef.current);
            for (const entry of saved) {
              const before = next.get(entry.dayKey);
              next.set(entry.dayKey, { ...entry, ...(before?.done && !entry.done ? { done: before.done } : {}) });
            }
            commitEntries(next);
          }
        } catch {
          setProblem("That change could not be saved. Your plan is shown as it is saved.");
          setUndoStack((stack) => stack.slice(0, -1));
          pendingRef.current -= 1;
          if (pendingRef.current === 0) setSaving(false);
          await read();
          return;
        }
        pendingRef.current -= 1;
        if (pendingRef.current === 0) setSaving(false);
      });
    },
    [commitEntries, mode, plan, read, uid]
  );

  const applyLocal = useCallback(
    (ops: readonly TimetableOp[]): TimetableOp[] | null => {
      if (!plan || ops.length === 0) return null;
      const current = entriesRef.current;
      const own = ownActivities(plan, current);
      const { touched } = applyTimetableOps(own, ops, {
        freeSessionsFor: (dayKey) => planFreeSessionsOn(plan, dayKey).map(openActivityFromFreeSession),
      });
      if (touched.size === 0) return null;
      const restore: TimetableOp[] = [];
      const next = new Map(current);
      for (const [dayKey, activities] of touched) {
        restore.push({ type: "setDay", dayKey, activities: own.get(dayKey) ?? null });
        const before = current.get(dayKey);
        const converted = before && !before.activities ? storedPlanDay(plan, before) : null;
        const done = { ...(before?.done ?? {}), ...(converted?.done ?? {}) };
        next.set(dayKey, {
          dayKey,
          ...(activities ? { activities } : {}),
          ...(Object.keys(done).length > 0 ? { done } : {}),
          updatedAt: Date.now(),
        });
      }
      commitEntries(next);
      return restore;
    },
    [commitEntries, plan]
  );

  const apply = useCallback(
    (ops: readonly TimetableOp[], options: { label?: string; planBefore?: RevisionPlan } = {}) => {
      const restore = applyLocal(ops);
      if (!restore) return false;
      setProblem("");
      setUndoStack((stack) =>
        [...stack, { label: options.label ?? "your change", restore, ...(options.planBefore ? { planBefore: options.planBefore } : {}) }].slice(-MAX_UNDO)
      );
      persist(ops);
      return true;
    },
    [applyLocal, persist]
  );

  const undo = useCallback(() => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((stack) => stack.slice(0, -1));
    if (last.planBefore) restorePlanRef.current?.(last.planBefore);
    if (applyLocal(last.restore)) persist(last.restore);
  }, [applyLocal, persist, undoStack]);

  const setDone = useCallback(
    (dayKey: string, activityId: string, done: boolean) => {
      if (!plan) return;
      const before = entriesRef.current.get(dayKey);
      const marks = { ...(before?.done ?? {}) };
      if (done) marks[activityId] = { by: "manual", at: Date.now() };
      else delete marks[activityId];
      const next = new Map(entriesRef.current);
      next.set(dayKey, { ...(before ?? { dayKey }), dayKey, done: marks });
      commitEntries(next);
      if (mode !== "live") return;
      void setRevisionPlanActivityDone(uid, plan.id, dayKey, activityId, done ? (marks[activityId] ?? null) : null).catch(() => {
        const reverted = new Map(entriesRef.current);
        if (before) reverted.set(dayKey, before);
        else reverted.delete(dayKey);
        commitEntries(reverted);
        setProblem("That tick could not be saved. Try again.");
      });
    },
    [commitEntries, mode, plan, uid]
  );

  const recordSeen = useCallback(
    (dayKey: string, activityIds: readonly string[]) => {
      if (!plan || activityIds.length === 0) return;
      const before = entriesRef.current.get(dayKey);
      const at = Date.now();
      const marks = { ...(before?.done ?? {}) };
      for (const id of activityIds) marks[id] = { by: "activity", at };
      const next = new Map(entriesRef.current);
      next.set(dayKey, { ...(before ?? { dayKey }), dayKey, done: marks });
      commitEntries(next);
      // Written so the record outlives today's evidence; losing the write costs only that.
      if (mode === "live") void recordRevisionPlanActivitiesSeen(uid, plan.id, dayKey, activityIds, at).catch(() => undefined);
    },
    [commitEntries, mode, plan, uid]
  );

  const ownDays = useCallback(() => (plan ? ownActivities(plan, entriesRef.current) : new Map<string, PlanActivity[]>()), [plan]);

  return {
    entries,
    loading: mode === "live" && Boolean(planId) && !loadedKeys.has(rangeKey),
    synced: mode === "draft" || (Boolean(planId) && syncedKeys.has(rangeKey)),
    saving,
    problem,
    apply,
    setDone,
    recordSeen,
    undo,
    undoLabel: undoStack[undoStack.length - 1]?.label ?? null,
    ownDays,
    clearProblem: () => setProblem(""),
    reload: read,
  };
}
