/**
 * A revision plan: the student's own timetable of dated study activities.
 *
 * Two things live in a plan, and keeping them apart is what makes it both
 * dependable and adaptive.
 *
 * - **The timetable**: real activities on real dates -- "Monday 17:00, 30
 *   minutes, Biology, homeostasis questions". It belongs to the student. They
 *   add, edit, move, remove and fix activities directly, and nothing changes
 *   one behind their back. A day with a timetable shows exactly that.
 * - **The usual week** (`sessions`): when the student can normally study. It
 *   is how new weeks get their shape -- each sitting is a free session until
 *   it is filled, by the student or, when they ask, by Jami.
 *
 * The Learning Engine still owns *what* Jami suggests. When Jami fills a free
 * session it puts a real provisional task in it, chosen from recorded evidence
 * alone, and marks it adaptive: Jami may later suggest something better as the
 * evidence moves, and the student sees and accepts every such change. A fixed
 * activity -- one the student chose, kept or wrote -- is never replaced.
 *
 * Nothing in here is learner evidence. Ticking an activity says a student
 * believes they did something, which is not the same as knowing it, and it must
 * never reach the learner profile. See `lib/learning/types.ts` for what may.
 */

/**
 * 3 is dated activities; 2 was sessions; 1 was cadence.
 *
 * Version 2 resolved every day afresh from the usual week and asked the engine
 * only on the day itself, so every later day read "Jami fills this in on the
 * day" and arrived with whatever the engine had to hand -- often nothing.
 * Version 3 stores the timetable a day at a time in `entries`, and a version 2
 * plan is read forward without a migration: its days simply have no timetable
 * of their own yet. See `lib/planning/timetable.ts`.
 */
export const REVISION_PLAN_SCHEMA_VERSION = 3;

/** Sunday first, matching `Date#getDay`. */
export const PLAN_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type PlanWeekday = (typeof PLAN_WEEKDAYS)[number];

export const PLAN_WEEKDAY_LABELS: Record<PlanWeekday, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

export const PLAN_WEEKDAY_FULL_LABELS: Record<PlanWeekday, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

/** The shortest and longest a sitting in the usual week may be, in minutes. */
export const PLAN_MINUTES_MIN = 10;
export const PLAN_MINUTES_MAX = 240;
/** Roughly how long one thing takes, used where an intervention states its effort. */
export const PLAN_MINUTES_PER_ITEM = 15;
/**
 * How many sittings a day of the usual week may hold.
 *
 * Four sittings is already an unusual day; past that the week stops reading as
 * a plan anybody could keep.
 */
export const PLAN_MAX_SESSIONS_PER_DAY = 4;
/** How far ahead a plan may run. Longer than a school year is a mistake, not a plan. */
export const PLAN_MAX_HORIZON_DAYS = 400;

/** A wall-clock time of day, 24 hour, as it is written. Never a timestamp. */
export const PLAN_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * One subject the plan covers, and how much of it that subject takes.
 *
 * Scoped to a folder or a deck because that is what the Learning Engine scopes
 * a profile to -- there is no account-wide model to draw on, by design.
 */
export type RevisionPlanScope = {
  folderId?: string;
  deckId?: string;
  /** 1 to 3. Relative, not absolute: two subjects at 3 share the time evenly. */
  weight: number;
};

/**
 * One sitting in the student's usual week.
 *
 * Everything past `weekday` and `minutes` is optional. A student who wants to
 * say only "Mondays, 45 minutes" writes exactly that; one who wants "Monday
 * 16:30, 45 minutes, Chemistry" can say so.
 *
 * `startTime` is a time of day as written -- "16:30" -- and never a moment. A
 * plan that said Monday at half four should say that wherever it is read.
 */
export type RevisionPlanSession = {
  /** Stable across edits, so a sitting keeps its identity while it is moved or re-timed. */
  id: string;
  weekday: PlanWeekday;
  minutes: number;
  /** "HH:MM", 24 hour. Absent means a sitting with no fixed time. */
  startTime?: string;
  /**
   * Pins this sitting to one subject. Absent means the plan's weighting
   * decides, rotating the week's sittings between its subjects.
   */
  scopeKey?: string;
  /** The student's own name for it, e.g. "After dinner". */
  label?: string;
};

/**
 * An exam the plan is counting down to.
 *
 * `dayKey` is a study day, like every date in a plan; `scopeKey` ties the exam
 * to one of the plan's subjects where the student said which.
 */
export type RevisionPlanExam = {
  id: string;
  label: string;
  dayKey: string;
  scopeKey?: string;
};

/**
 * What a student said they want from a subject, in their own words.
 *
 * A self-report is not evidence of what somebody knows, and letting it into the
 * learner profile would corrupt the one thing that model is careful about.
 * `note` is kept so the student can read back what they told Jami. It is never
 * sent to the profile and never used to score anything.
 */
export type RevisionPlanEmphasis = {
  scopeKey: string;
  wants: "diagnose" | "practice";
  note?: string;
};

export type RevisionPlan = {
  id: string;
  schemaVersion: number;
  title: string;
  status: "active" | "archived";
  /** Whether Jami drafted it or the student built it themselves. */
  origin: "tutor" | "manual";
  startDayKey: string;
  endDayKey: string;
  scopes: RevisionPlanScope[];
  /** The usual week. May be empty: a plan can be nothing but activities the student placed. */
  sessions: RevisionPlanSession[];
  emphasis: RevisionPlanEmphasis[];
  /** Exams the plan counts down to. Absent on plans made before there was anywhere to say. */
  exams?: RevisionPlanExam[];
  /**
   * "Let Jami fill my free sessions": Jami keeps this week and next filled in
   * from the usual week, with adaptive tasks the student can change.
   *
   * Absent on a version 2 plan, which always had Jami choose each day's work;
   * `planAutoFills` reads that as on, so nothing those students relied on stops.
   */
  autoFill?: boolean;
  createdAt: number;
  updatedAt: number;
};

/** Everything a plan needs before it has an id or timestamps. */
export type RevisionPlanDraft = Omit<
  RevisionPlan,
  "id" | "createdAt" | "updatedAt" | "schemaVersion"
>;

/** Whether Jami keeps the coming days filled in for this plan. */
export function planAutoFills(plan: Pick<RevisionPlan, "autoFill"> & { schemaVersion?: number }) {
  if (typeof plan.autoFill === "boolean") return plan.autoFill;
  return (plan.schemaVersion ?? REVISION_PLAN_SCHEMA_VERSION) < 3;
}

/* ------------------------------------------------------------------ */
/* The timetable.                                                       */
/* ------------------------------------------------------------------ */

/**
 * How a piece of planned work is done.
 *
 * Kept to the ways Jami can actually carry work out, plus the student's own:
 * a task like "finish my homework" is a real part of a revision week, and a
 * planner that could not hold it would send them back to paper.
 */
export const PLAN_ACTIVITY_METHODS = [
  "practice",
  "flashcards",
  "revision",
  "notebook",
  "notes",
  "other",
] as const;
export type PlanActivityMethod = (typeof PLAN_ACTIVITY_METHODS)[number];

/**
 * Fixed: chosen, kept or written by the student. Jami never replaces it.
 * Adaptive: a slot Jami may suggest better work for as the evidence changes --
 * suggest, never swap unseen.
 */
export type PlanActivityMode = "fixed" | "adaptive";

/** What a task is about, where it is about one thing. */
export type PlanActivityTopic = {
  /** A student Topic, a deck, or a verified specification concept. */
  kind: "topic" | "deck" | "spec";
  id: string;
  /** Student-written for topics and decks, so shown as text only. */
  label: string;
};

/**
 * One activity on one day of the timetable.
 *
 * Stored whole inside its day's entry, so a day reads in one document and an
 * edit to it is one write. Ids are unique within the day.
 */
export type PlanActivity = {
  id: string;
  /** What the student reads: "Homeostasis", "Finish my homework". Empty only on a free session. */
  title: string;
  method: PlanActivityMethod;
  minutes: number;
  /** "HH:MM". Absent: some time that day. */
  startTime?: string;
  /** The subject, as a plan scope key. Absent for something that is no subject's. */
  scopeKey?: string;
  mode: PlanActivityMode;
  /** Who put it there. */
  origin: "student" | "jami";
  /**
   * Time set aside with nothing chosen for it yet -- a free session from the
   * usual week. Said plainly rather than filled with a promise: it is time,
   * and the student or Jami still has to decide what it is for.
   */
  open?: boolean;
  topic?: PlanActivityTopic;
  /** Where starting it goes. Stored, because a task is a decision, not a lookup. */
  href?: string;
  /** The Learning Engine action this task came from, when Jami chose it. */
  actionId?: string;
  /** How many cards or questions it is worth, where that is how it is measured. */
  targetItems?: number;
  /**
   * Jami writes the questions or cards when the student starts it, because
   * none exist yet. Said on the task, so it is never presented as ready.
   */
  writtenOnStart?: boolean;
  /** The usual-week sitting it came from, if any. */
  routineId?: string;
  /**
   * The notebook it is done in, when the student chose one. That notebook then
   * offers the session to start, time and finish (`lib/planning/plan-notebook.ts`).
   * Only on notebook work.
   */
  notebookId?: string;
};

/**
 * That an activity was done, and how Jami knows.
 *
 * `manual`: the student ticked it. `activity`: Jami saw the work -- the session
 * opened from it was finished, enough of its own cards were reviewed, or it was
 * started and finished in its notebook -- and wrote that down the day it saw
 * it, so the record does not fade when the same cards are reviewed again
 * tomorrow.
 *
 * Kept beside the day's activities rather than inside them, one key per
 * activity, so a tick merges into the day without rewriting it: two devices
 * ticking different things never lose either, and a tick made offline is kept.
 */
export type PlanActivityDone = {
  by: "manual" | "activity";
  at: number;
  /** How long it took, where it was timed: a session run in its notebook. */
  minutes?: number;
};

/**
 * A task pinned to a day by a version 2 plan, read so it is not lost.
 *
 * `own:` ids are tasks the student wrote; anything else was one of Jami's
 * suggestions they kept. Never written by this version.
 */
export type PinnedPlanItem = {
  actionId: string;
  label: string;
  href?: string;
  sessionId?: string;
};

export const OWN_TASK_PREFIX = "own:";

export function isOwnPlanTask(item: Pick<PinnedPlanItem, "actionId">) {
  return item.actionId.startsWith(OWN_TASK_PREFIX);
}

/**
 * One day of the plan, stored only once something is decided about it.
 *
 * `activities` absent: the day has no timetable of its own, and the usual week
 * applies -- its sittings show as free sessions. Present and empty: the day was
 * deliberately cleared, a rest day. Days nobody touched store nothing, so a
 * six-week plan is not six weeks of documents saying "unchanged".
 */
export type RevisionPlanEntry = {
  dayKey: string;
  activities?: PlanActivity[];
  /** What was done that day, by activity id. */
  done?: Record<string, PlanActivityDone>;
  /** Version 2's day off. Read as a rest day; never written now. */
  skipped?: boolean;
  /** Version 2's pinned tasks and slot ticks. Read once into activities, then cleared. */
  pinned?: PinnedPlanItem[];
  completedSlotIds?: string[];
  updatedAt?: number;
};

/** A scope key that reads the same wherever it is built. */
export function planScopeKey(scope: Pick<RevisionPlanScope, "folderId" | "deckId">) {
  if (scope.folderId) return `folder:${scope.folderId}`;
  if (scope.deckId) return `deck:${scope.deckId}`;
  return "none";
}

/** The scope a key names, or null for one that names nothing. */
export function planScopeFromKey(scopeKey: string): Pick<RevisionPlanScope, "folderId" | "deckId"> | null {
  if (scopeKey.startsWith("folder:") && scopeKey.length > 7) return { folderId: scopeKey.slice(7) };
  if (scopeKey.startsWith("deck:") && scopeKey.length > 5) return { deckId: scopeKey.slice(5) };
  return null;
}
