"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { featureFlags } from "@/lib/app/feature-flags";
import {
  notebookPlanActivities,
  planSessionMinutes,
  readPlanNotebookSession,
  type PlanNotebookRef,
  type PlanNotebookSession,
} from "@/lib/planning/plan-notebook";
import { resolveTimetableDay, type TimetableDay } from "@/lib/planning/timetable";
import type { RevisionPlan } from "@/lib/planning/types";
import { getStudyDayKey } from "@/lib/study/day";
import {
  loadActiveRevisionPlan,
  loadRevisionPlanEntries,
  setRevisionPlanActivityDone,
} from "@/services/planning/revision-plans";

/**
 * Today's planned work for one notebook, and the session that runs it.
 *
 * Read once when the notebook opens -- the active plan and today's entry, two
 * small reads -- and never again while it is open. The running session is
 * kept on this device (a page reload or a trip to the folder keeps the clock)
 * and only its finish is written: the tick, with how long it ran, merged into
 * the day the way every other tick is. See `lib/planning/plan-notebook.ts`.
 */

const sessionKey = (uid: string) => `jami:plan-session:${uid}`;

function readStoredSession(uid: string) {
  try {
    const raw = window.localStorage.getItem(sessionKey(uid));
    return raw ? readPlanNotebookSession(JSON.parse(raw), Date.now()) : null;
  } catch {
    return null;
  }
}

function storeSession(uid: string, session: PlanNotebookSession | null) {
  try {
    if (session) window.localStorage.setItem(sessionKey(uid), JSON.stringify(session));
    else window.localStorage.removeItem(sessionKey(uid));
  } catch {
    // A session this device could not keep still runs until the page closes.
  }
}

export function useNotebookPlanSession(input: { uid: string; notebook: PlanNotebookRef; enabled?: boolean }) {
  const { uid } = input;
  const { id: notebookId, folderId } = input.notebook;
  const enabled = (input.enabled ?? true) && featureFlags.enableRevisionPlans && Boolean(uid);
  const [today, setToday] = useState<{ plan: RevisionPlan; day: TimetableDay } | null>(null);
  const [session, setSession] = useState<PlanNotebookSession | null>(() =>
    typeof window === "undefined" || !uid ? null : readStoredSession(uid)
  );
  const [problem, setProblem] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const todayDayKey = getStudyDayKey();
    void (async () => {
      const plan = await loadActiveRevisionPlan(uid);
      if (!plan) return;
      const [entry] = await loadRevisionPlanEntries(uid, plan.id, { fromDayKey: todayDayKey, toDayKey: todayDayKey, max: 1 });
      if (live) setToday({ plan, day: resolveTimetableDay({ plan, dayKey: todayDayKey, entry: entry ?? null, todayDayKey }) });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, uid]);

  const running = Boolean(session);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const activities = useMemo(
    () => notebookPlanActivities(today?.day, { id: notebookId, folderId }),
    [folderId, notebookId, today?.day]
  );
  // The session running now, in whichever notebook it was started: the clock is the work's, not the page's.
  const current =
    session && today && session.planId === today.plan.id && session.dayKey === today.day.dayKey
      ? today.day.activities.find((activity) => activity.id === session.activityId)
      : undefined;

  const start = useCallback(
    (activityId: string) => {
      if (!today) return;
      const started = { planId: today.plan.id, dayKey: today.day.dayKey, activityId, startedAt: Date.now() };
      setProblem("");
      setNow(started.startedAt);
      setSession(started);
      storeSession(uid, started);
    },
    [today, uid]
  );

  const stop = useCallback(() => {
    setSession(null);
    storeSession(uid, null);
  }, [uid]);

  /** Finished: ticked at once, with how long it ran, and written behind it. */
  const finish = useCallback(async () => {
    if (!session || !today) return;
    const at = Date.now();
    const done = { by: "activity" as const, at, minutes: planSessionMinutes(session.startedAt, at) };
    const mark = (completion: typeof done | undefined) =>
      setToday((previous) =>
        previous
          ? {
              ...previous,
              day: {
                ...previous.day,
                activities: previous.day.activities.map((activity) => {
                  if (activity.id !== session.activityId) return activity;
                  const next = { ...activity };
                  if (completion) next.completion = completion;
                  else delete next.completion;
                  return next;
                }),
              },
            }
          : previous
      );
    mark(done);
    stop();
    try {
      await setRevisionPlanActivityDone(uid, session.planId, session.dayKey, session.activityId, done);
    } catch {
      // Put the clock back: the work was done, and the student should be able to say so again.
      mark(undefined);
      setSession(session);
      storeSession(uid, session);
      setProblem("That couldn't be saved to your plan. Try finishing again.");
    }
  }, [session, stop, today, uid]);

  return {
    /** Today's planned work for this notebook, done or not. */
    activities,
    /** The planned activity being worked on now, from this notebook or another. */
    current,
    session: current ? session : null,
    now,
    problem,
    start,
    stop,
    finish,
  };
}

export type NotebookPlanSession = ReturnType<typeof useNotebookPlanSession>;
