import { APP_BUILD } from "@/lib/app/app-build";
import type { StudyAction } from "@/lib/learning/actions/study-actions";
import { getStudyDayKey } from "@/lib/study/day";
import { auth } from "@/services/firebase/client";

export type StudyActionsResponse = {
  actions: StudyAction[];
  folders: { id: string; name: string }[];
  generatedAt: number;
};

/**
 * How long one answer is reused within the session.
 *
 * Each request reads several folders' worth of evidence, and Today refreshes
 * on focus and navigation; recommendations do not need to change on every
 * visit. A pull-to-refresh asks again regardless.
 */
const STUDY_ACTIONS_CACHE_MS = 5 * 60_000;

const cache = new Map<string, { storedAt: number; value: StudyActionsResponse }>();

export function getCachedStudyActions(uid: string, now = Date.now()) {
  const entry = cache.get(uid);
  return entry && now - entry.storedAt < STUDY_ACTIONS_CACHE_MS ? entry.value : null;
}

/**
 * The last answer, kept on this device for the next launch.
 *
 * The request behind it is a server calculation over several folders, and on a
 * launch it can also be waiting for the server itself to start: seconds, every
 * time the app is opened, before "Jami suggests" had anything in it. The kept
 * answer is shown at once and replaced when the new one arrives. Kept only for
 * the study day it was given on, and only by the build that asked for it.
 */
const STORED_STUDY_ACTIONS_PREFIX = "jami:today-actions:";
const STORED_STUDY_ACTIONS_VERSION = 1;

type StoredStudyActions = {
  version: typeof STORED_STUDY_ACTIONS_VERSION;
  build: string;
  dayKey: string;
  value: StudyActionsResponse;
};

export function readStoredStudyActions(
  uid: string,
  dayKey = getStudyDayKey()
): StudyActionsResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${STORED_STUDY_ACTIONS_PREFIX}${uid}`);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredStudyActions> | null;
    if (
      !stored ||
      stored.version !== STORED_STUDY_ACTIONS_VERSION ||
      stored.build !== APP_BUILD ||
      stored.dayKey !== dayKey
    ) {
      return null;
    }
    return readResponse(stored.value);
  } catch {
    return null;
  }
}

function storeStudyActions(uid: string, value: StudyActionsResponse) {
  try {
    const stored: StoredStudyActions = {
      version: STORED_STUDY_ACTIONS_VERSION,
      build: APP_BUILD,
      dayKey: getStudyDayKey(value.generatedAt),
      value,
    };
    window.localStorage.setItem(`${STORED_STUDY_ACTIONS_PREFIX}${uid}`, JSON.stringify(stored));
  } catch {
    // Only a head start for the next launch; it loads either way.
  }
}

/** Forgets every kept answer on this device, at sign-out. */
export function clearStoredStudyActions() {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORED_STUDY_ACTIONS_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage that cannot be read holds nothing to clear.
  }
}

function readResponse(body: unknown): StudyActionsResponse {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    actions: Array.isArray(record.actions) ? (record.actions as StudyAction[]) : [],
    folders: Array.isArray(record.folders) ? (record.folders as StudyActionsResponse["folders"]) : [],
    generatedAt: typeof record.generatedAt === "number" ? record.generatedAt : Date.now(),
  };
}

/**
 * The engine's actions for a revision plan's own subjects.
 *
 * Kept per subject and asked for only where this session has no fresh answer,
 * so moving between weeks, or adding a subject, never asks about the others
 * again. `answered` holds the subjects the engine actually spoke for: a subject
 * that failed to load is not one with nothing to do, and the planner must not
 * read its silence as "everything has changed".
 */
export type PlanStudyActions = {
  actionsByScope: Map<string, StudyAction[]>;
  answered: Set<string>;
};

const planCache = new Map<string, { storedAt: number; actions: StudyAction[] }>();

export async function loadPlanStudyActions(
  scopeKeys: readonly string[],
  options: { force?: boolean } = {}
): Promise<PlanStudyActions> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in again to load recommendations.");
  const now = Date.now();
  const cacheKey = (scopeKey: string) => `${user.uid}|${scopeKey}`;
  const unique = [...new Set(scopeKeys)];
  const wanted = unique.filter((scopeKey) => {
    const cached = planCache.get(cacheKey(scopeKey));
    return options.force || !cached || now - cached.storedAt >= STUDY_ACTIONS_CACHE_MS;
  });

  if (wanted.length > 0) {
    const response = await fetch(`/api/learning/study-actions?scopes=${encodeURIComponent(wanted.join(","))}`, {
      headers: { Authorization: `Bearer ${await user.getIdToken()}` },
    });
    if (!response.ok) throw new Error("Recommendations are unavailable right now.");
    const body: unknown = await response.json();
    const scopes = body && typeof body === "object" ? (body as Record<string, unknown>).scopes : null;
    for (const raw of Array.isArray(scopes) ? scopes : []) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      // A subject that could not be read is asked about again next time, never remembered as empty.
      if (typeof entry.scopeKey !== "string" || (entry.status !== "ok" && entry.status !== "missing")) continue;
      planCache.set(cacheKey(entry.scopeKey), {
        storedAt: now,
        actions: Array.isArray(entry.actions) ? (entry.actions as StudyAction[]) : [],
      });
    }
  }

  const actionsByScope = new Map<string, StudyAction[]>();
  const answered = new Set<string>();
  for (const scopeKey of unique) {
    const cached = planCache.get(cacheKey(scopeKey));
    if (!cached) continue;
    actionsByScope.set(scopeKey, cached.actions);
    answered.add(scopeKey);
  }
  return { actionsByScope, answered };
}

export async function loadStudyActionsForToday(
  options: { force?: boolean } = {}
): Promise<StudyActionsResponse> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in again to load recommendations.");
  if (!options.force) {
    const cached = getCachedStudyActions(user.uid);
    if (cached) return cached;
  }
  const response = await fetch("/api/learning/study-actions", {
    headers: { Authorization: `Bearer ${await user.getIdToken()}` },
  });
  if (!response.ok) throw new Error("Recommendations are unavailable right now.");
  const value = readResponse(await response.json());
  cache.set(user.uid, { storedAt: Date.now(), value });
  storeStudyActions(user.uid, value);
  return value;
}
