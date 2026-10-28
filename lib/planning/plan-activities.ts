import { describeStudyAction } from "@/lib/dashboard/today-plan";
import type { StudyAction, StudyActionDestinationKind } from "@/lib/learning/actions/study-actions";
import {
  isPlanTime,
  planTimeFromMinutes,
  planTimeMinutes,
  studyDayMinutes,
} from "@/lib/planning/plan-schedule";
import {
  PLAN_ACTIVITY_METHODS,
  type PlanActivity,
  type PlanActivityDone,
  type PlanActivityMethod,
  type PlanActivityTopic,
} from "@/lib/planning/types";

/**
 * One activity on the timetable: its bounds, its words, and how it is made.
 *
 * Every activity that reaches storage or the screen goes through
 * `normalizePlanActivity`, whether the student typed it, Jami drafted it or a
 * conversation proposed it -- the same gate for all three, so an editor control
 * is never the only thing between a bad value and Firestore.
 */

export const PLAN_ACTIVITY_MINUTES_MIN = 5;
export const PLAN_ACTIVITY_MINUTES_MAX = 240;
export const DEFAULT_PLAN_ACTIVITY_MINUTES = 30;
export const MAX_PLAN_ACTIVITY_TITLE_LENGTH = 80;
/** More than this on one day is a backlog, not a timetable. */
export const MAX_PLAN_ACTIVITIES_PER_DAY = 12;
const MAX_TARGET_ITEMS = 200;

/** What each way of working is called on the timetable. */
export const PLAN_ACTIVITY_METHOD_LABELS: Record<PlanActivityMethod, string> = {
  practice: "Practice questions",
  flashcards: "Flashcards",
  revision: "Revision session",
  notebook: "Notebook work",
  notes: "Go over notes",
  other: "Your own task",
};

/** What the button that starts it says. */
export const PLAN_ACTIVITY_START_LABELS: Record<PlanActivityMethod, string> = {
  practice: "Practice",
  flashcards: "Review",
  revision: "Start",
  notebook: "Open",
  notes: "Open",
  other: "Open",
};

export function isPlanActivityMethod(value: unknown): value is PlanActivityMethod {
  return typeof value === "string" && (PLAN_ACTIVITY_METHODS as readonly string[]).includes(value);
}

export function clampActivityMinutes(minutes: number) {
  if (!Number.isFinite(minutes)) return DEFAULT_PLAN_ACTIVITY_MINUTES;
  return Math.round(Math.min(PLAN_ACTIVITY_MINUTES_MAX, Math.max(PLAN_ACTIVITY_MINUTES_MIN, minutes)));
}

/** A short random id, unique within a day for all practical purposes. */
export function newPlanActivityId(random: () => number = Math.random) {
  return `a${Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0")}`;
}

/** The text of a title, cleaned the way every one is. */
export function cleanActivityTitle(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, MAX_PLAN_ACTIVITY_TITLE_LENGTH)
    : "";
}

/**
 * A link this app may follow. Anything else in a stored activity is dropped
 * rather than rendered: a timetable entry must never become a way off the app.
 */
function cleanHref(value: unknown) {
  return typeof value === "string" &&
    value.startsWith("/dashboard") &&
    !value.startsWith("//") &&
    value.length <= 600
    ? value
    : undefined;
}

function cleanTopic(value: unknown): PlanActivityTopic | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === "deck" || raw.kind === "spec" || raw.kind === "topic" ? raw.kind : null;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 160) : "";
  const label = cleanActivityTitle(raw.label);
  return kind && id && label ? { kind, id, label } : undefined;
}

/** A document id, as a notebook's is written: no path, nothing that could address something else. */
function cleanDocumentId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id && id.length <= 128 && !id.includes("/") ? id : undefined;
}

function cleanScopeKey(value: unknown, allowed?: ReadonlySet<string>) {
  if (typeof value !== "string") return undefined;
  const key = value.trim().slice(0, 160);
  if (!/^(folder|deck):.+/.test(key)) return undefined;
  return allowed && !allowed.has(key) ? undefined : key;
}

/**
 * Anything at all, as an activity, or null when it cannot be one.
 *
 * Lenient about what can be repaired -- a bad time costs the time, a stray
 * subject costs the subject -- and strict about what cannot: an activity needs
 * an id and either a title or to be honestly open.
 */
export function normalizePlanActivity(
  input: unknown,
  options: { allowedScopeKeys?: ReadonlySet<string> } = {}
): PlanActivity | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 64) : "";
  if (!id) return null;
  const open = raw.open === true;
  const title = cleanActivityTitle(raw.title);
  if (!title && !open) return null;
  const method = isPlanActivityMethod(raw.method) ? raw.method : "other";
  const scopeKey = cleanScopeKey(raw.scopeKey, options.allowedScopeKeys);
  const topic = cleanTopic(raw.topic);
  const href = cleanHref(raw.href);
  const actionId = typeof raw.actionId === "string" ? raw.actionId.trim().slice(0, 200) : "";
  const routineId = typeof raw.routineId === "string" ? raw.routineId.trim().slice(0, 64) : "";
  const notebookId = method === "notebook" && !open ? cleanDocumentId(raw.notebookId) : undefined;
  const targetItems = Number(raw.targetItems);
  return {
    id,
    title: open ? "" : title,
    method,
    minutes: clampActivityMinutes(Number(raw.minutes)),
    ...(isPlanTime(raw.startTime) ? { startTime: raw.startTime } : {}),
    ...(scopeKey ? { scopeKey } : {}),
    // Only Jami's own picks adapt, and only when there is a subject to adapt within.
    mode: raw.mode === "adaptive" && scopeKey ? "adaptive" : "fixed",
    origin: raw.origin === "jami" ? "jami" : "student",
    ...(open ? { open: true } : {}),
    ...(topic && !open ? { topic } : {}),
    ...(href && !open ? { href } : {}),
    ...(actionId && !open ? { actionId } : {}),
    ...(Number.isFinite(targetItems) && targetItems > 0 && !open
      ? { targetItems: Math.min(MAX_TARGET_ITEMS, Math.round(targetItems)) }
      : {}),
    ...(raw.writtenOnStart === true && !open ? { writtenOnStart: true } : {}),
    ...(routineId ? { routineId } : {}),
    ...(notebookId ? { notebookId } : {}),
  };
}

/** The longest a timed session is believed to have run: a notebook left open overnight did not take ten hours. */
export const MAX_PLAN_SESSION_MINUTES = 6 * 60;

/** A day's record of what was done, kept only where it reads as one. */
export function normalizePlanActivityDone(input: unknown): Record<string, PlanActivityDone> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const done: Record<string, PlanActivityDone> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!id || id.length > 64 || typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const at = Number(record.at);
    const minutes = Math.round(Number(record.minutes));
    done[id] = {
      by: record.by === "activity" ? "activity" : "manual",
      at: Number.isFinite(at) && at > 0 ? at : 0,
      ...(Number.isFinite(minutes) && minutes >= 1 ? { minutes: Math.min(MAX_PLAN_SESSION_MINUTES, minutes) } : {}),
    };
  }
  return done;
}

/**
 * What an activity is called when the student did not name it: the notebook
 * it is done in, the topic it is about, or simply how it is done. A student
 * who picks "Notebook work, 30 minutes" has said enough to plan it.
 */
export function defaultPlanActivityTitle(input: {
  method: PlanActivityMethod;
  topic?: Pick<PlanActivityTopic, "label">;
  notebookTitle?: string;
}) {
  const named = cleanActivityTitle(input.notebookTitle) || cleanActivityTitle(input.topic?.label);
  if (named) return named;
  return input.method === "other" ? "Study session" : PLAN_ACTIVITY_METHOD_LABELS[input.method];
}

/** A day's activities, cleaned, de-duplicated by id, bounded and in the order the day runs. */
export function normalizePlanActivities(
  input: unknown,
  options: { allowedScopeKeys?: ReadonlySet<string> } = {}
): PlanActivity[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const activities: PlanActivity[] = [];
  for (const raw of input) {
    const activity = normalizePlanActivity(raw, options);
    if (!activity || seen.has(activity.id)) continue;
    seen.add(activity.id);
    activities.push(activity);
    if (activities.length >= MAX_PLAN_ACTIVITIES_PER_DAY) break;
  }
  return sortPlanActivities(activities);
}

/**
 * The order a day is worked through: timed activities by the study day's clock
 * (so 00:30 comes after 23:00), then untimed ones in the order they were added.
 */
export function sortPlanActivities<T extends Pick<PlanActivity, "startTime">>(activities: readonly T[]): T[] {
  return activities
    .map((activity, index) => ({ activity, index }))
    .sort((left, right) => {
      const leftTimed = isPlanTime(left.activity.startTime);
      const rightTimed = isPlanTime(right.activity.startTime);
      if (leftTimed && rightTimed) {
        const difference =
          studyDayMinutes(left.activity.startTime as string) - studyDayMinutes(right.activity.startTime as string);
        return difference !== 0 ? difference : left.index - right.index;
      }
      if (leftTimed !== rightTimed) return leftTimed ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ activity }) => activity);
}

/** When it finishes, for reading: "17:30". */
export function planActivityEndTime(activity: Pick<PlanActivity, "startTime" | "minutes">) {
  if (!isPlanTime(activity.startTime)) return undefined;
  return planTimeFromMinutes(planTimeMinutes(activity.startTime) + activity.minutes);
}

/** A clock time moved on by some minutes, for laying activities end to end. */
export function planTimeAfter(startTime: string | undefined, minutes: number) {
  return isPlanTime(startTime) ? planTimeFromMinutes(planTimeMinutes(startTime) + minutes) : undefined;
}

/** How long a list of activities asks for. Free sessions count: they are time set aside. */
export function planActivitiesMinutes(activities: readonly Pick<PlanActivity, "minutes">[]) {
  return activities.reduce((total, activity) => total + activity.minutes, 0);
}

/** Whether two timed activities on the same day overlap. Untimed ones never do. */
export function planActivitiesClash(
  left: Pick<PlanActivity, "startTime" | "minutes">,
  right: Pick<PlanActivity, "startTime" | "minutes">
) {
  if (!isPlanTime(left.startTime) || !isPlanTime(right.startTime)) return false;
  const leftStart = studyDayMinutes(left.startTime);
  const rightStart = studyDayMinutes(right.startTime);
  return leftStart < rightStart + right.minutes && rightStart < leftStart + left.minutes;
}

/** How each of the engine's destinations is done. */
export function methodForDestination(kind: StudyActionDestinationKind | undefined): PlanActivityMethod {
  switch (kind) {
    case "flashcards":
      return "flashcards";
    case "question-practice":
    case "practice-papers":
      return "practice";
    case "revision-session":
      return "revision";
    case "notebook":
      return "notebook";
    case "topic":
    case "deck":
      return "notes";
    default:
      return "other";
  }
}

function capitalise(text: string) {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/** The Learning Engine's action as the task part of an activity. */
export type PlanActivityTask = Pick<
  PlanActivity,
  "title" | "method" | "topic" | "href" | "actionId" | "targetItems" | "writtenOnStart"
>;

/**
 * One of the engine's actions, as a task on the timetable.
 *
 * Named by its topic, with the method beside it: "Homeostasis" and "Practice
 * questions", not "Stop losing marks: homeostasis". The engine's reasons are
 * the right sentence once, on the one thing to do next; down a whole week they
 * were the same alarm twenty times over.
 */
export function planActivityTaskFromAction(action: StudyAction): PlanActivityTask {
  const destination = action.destination;
  const method = methodForDestination(destination?.kind);
  const target = action.target;
  const label = target.kind === "topic" ? target.label : describeStudyAction(action).title;
  const topicId = target.kind === "topic" ? target.topicKey.slice(target.topicKey.indexOf(":") + 1) : "";
  const topic: PlanActivityTopic | undefined =
    target.kind === "topic" && topicId
      ? {
          kind: target.source === "deck" ? "deck" : target.source === "specification" ? "spec" : "topic",
          id: topicId,
          label: cleanActivityTitle(target.label),
        }
      : undefined;
  const writes =
    action.intervention?.type === "create_flashcards" ||
    action.intervention?.type === "create_practice" ||
    action.intervention?.type === "fill_specification_gap";
  const counted = destination && destination.kind !== "revision-session" && destination.kind !== "notebook";
  return {
    title: cleanActivityTitle(capitalise(label)) || "Study",
    method,
    ...(topic && topic.label ? { topic } : {}),
    ...(destination?.href ? { href: destination.href } : {}),
    actionId: action.id,
    ...(counted && action.spec?.targetItems ? { targetItems: action.spec.targetItems } : {}),
    ...(writes ? { writtenOnStart: true } : {}),
  };
}

/** Whether a change to an activity changes what it is, rather than when or how long. */
export function changesPlanActivityTask(patch: Partial<PlanActivity>) {
  return (
    patch.title !== undefined ||
    patch.method !== undefined ||
    patch.topic !== undefined ||
    patch.href !== undefined ||
    patch.actionId !== undefined ||
    patch.notebookId !== undefined
  );
}

/** The task fields of an activity, cleared, for one whose task is being replaced. */
export const CLEARED_PLAN_ACTIVITY_TASK = {
  topic: undefined,
  href: undefined,
  actionId: undefined,
  targetItems: undefined,
  writtenOnStart: undefined,
  notebookId: undefined,
} as const satisfies Partial<PlanActivity>;
