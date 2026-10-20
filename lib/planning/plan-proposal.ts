import {
  DEFAULT_PLAN_ACTIVITY_MINUTES,
  PLAN_ACTIVITY_METHOD_LABELS,
  clampActivityMinutes,
  cleanActivityTitle,
  isPlanActivityMethod,
  newPlanActivityId,
} from "@/lib/planning/plan-activities";
import {
  fillFreeSessions,
  planFillOps,
  plannedActionIds,
  studentTaskHref,
  type PlanDraftingContext,
} from "@/lib/planning/plan-drafting";
import { shortPlanDate } from "@/lib/planning/plan-format";
import { isPlanDayKey, isPlanTime, planDayKeysBetween, planDaysBetween } from "@/lib/planning/plan-schedule";
import type { TimetableOp } from "@/lib/planning/timetable-ops";
import { PLAN_MAX_HORIZON_DAYS, type PlanActivity, type PlanActivityMethod, type PlanActivityMode } from "@/lib/planning/types";

/**
 * Changes to the timetable that Jami proposes and the student applies.
 *
 * Jami can be asked to move Monday's Biology to Wednesday, add twenty minutes
 * of homeostasis practice, clear a day or fill a week -- and every one of those
 * arrives as a proposal the student sees in full before anything changes. When
 * they apply it, it becomes the same ops the timetable's own controls produce
 * (`timetable-ops.ts`), so a chat instruction and a tap cannot disagree.
 *
 * The model is held to what it may decide. It refers to activities only by the
 * refs it was shown and to subjects only by theirs, so it cannot invent either.
 * It may write a task's title only in the student's own words: a title whose
 * topic the student never mentioned is dropped, and the task is Jami's pick
 * from the Learning Engine instead. And it never chooses what fills a free
 * session -- a fill is done by `fillFreeSessions`, from recorded evidence.
 */

export const MAX_PLAN_PROPOSAL_CHANGES = 30;
/** The longest a single fill may reach, so one sentence cannot write a term of tasks. */
export const MAX_PLAN_FILL_DAYS = 42;

export type PlanProposalChange =
  | {
      kind: "add";
      dayKey: string;
      startTime?: string;
      minutes: number;
      scopeKey?: string;
      /** Absent: Jami's pick for the subject, or a free session when there is no subject. */
      title?: string;
      method?: PlanActivityMethod;
    }
  | { kind: "move"; dayKey: string; activityId: string; toDayKey: string; startTime?: string }
  | {
      kind: "update";
      dayKey: string;
      activityId: string;
      startTime?: string;
      minutes?: number;
      title?: string;
      method?: PlanActivityMethod;
      mode?: PlanActivityMode;
    }
  | { kind: "remove"; dayKey: string; activityId: string }
  | { kind: "clear"; dayKey: string }
  | { kind: "fill"; fromDayKey: string; toDayKey: string };

/* ------------------------------------------------------------------ */
/* The student's own words.                                            */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "then", "that", "this", "some", "your", "you", "our",
  "my", "mine", "of", "on", "in", "at", "to", "a", "an", "do", "doing", "bit", "lot", "more", "less",
]);
/**
 * Words that say how, not what. A title made only of these -- "Practice
 * questions" -- names no topic, so it cannot have invented one.
 */
const METHOD_WORDS = new Set([
  "practice", "practise", "practising", "practicing", "question", "questions", "review", "reviewing", "revise",
  "revising", "revision", "session", "sessions", "study", "studying", "flashcard", "flashcards", "card", "cards",
  "note", "notes", "exam", "exams", "past", "paper", "papers", "work", "time", "minutes", "minute", "lesson",
  "learn", "learning", "reading", "read", "go", "over", "quick", "short", "long", "test", "quiz", "due",
]);

function wordsOf(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

function root(word: string) {
  const stripped = word.replace(/(ies|es|s|ing|ed)$/, "");
  return stripped.length >= 4 ? stripped : word;
}

/**
 * Whether a proposed title is in the student's words.
 *
 * Every word in it that names something -- not "practice" or "questions" --
 * must be a word the student said (or a plural, or a tense, of one). So
 * "Homeostasis practice" stands when they asked for homeostasis, and
 * "Photosynthesis questions" does not when they said "some Biology".
 */
export function isInStudentWords(title: string, studentText: string) {
  const said = wordsOf(studentText).map(root);
  const content = wordsOf(title).filter((word) => !METHOD_WORDS.has(word));
  return content.every((word) => {
    const stem = root(word);
    return said.some(
      (candidate) => candidate === stem || (stem.length >= 5 && candidate.length >= 5 && (candidate.startsWith(stem) || stem.startsWith(candidate)))
    );
  });
}

/** How a task the student named is done, read from its words when nobody said. */
export function methodFromTitle(title: string): PlanActivityMethod {
  const text = title.toLowerCase();
  if (/\b(question|questions|past paper|paper|practi[cs]e|exam)\b/.test(text)) return "practice";
  if (/\b(flashcards?|cards?)\b/.test(text)) return "flashcards";
  if (/\b(lesson|learn|teach)\b/.test(text)) return "revision";
  if (/\bnotebook\b/.test(text)) return "notebook";
  if (/\b(notes?|read|reading)\b/.test(text)) return "notes";
  return "other";
}

/* ------------------------------------------------------------------ */
/* Reading what the model proposed.                                    */
/* ------------------------------------------------------------------ */

export type PlanProposalParseContext = {
  /** Activity refs the model was shown: "A3" → where it is. */
  activityRefs: ReadonlyMap<string, { dayKey: string; activityId: string; done: boolean }>;
  /** Subject refs the model was offered: "S1" → scope key. */
  subjectRefs: ReadonlyMap<string, string>;
  todayDayKey: string;
  /** Everything the student said in this conversation, for `isInStudentWords`. */
  studentText: string;
};

function readDay(value: unknown, todayDayKey: string) {
  if (!isPlanDayKey(value)) return undefined;
  const ahead = planDaysBetween(todayDayKey, value);
  return ahead >= 0 && ahead < PLAN_MAX_HORIZON_DAYS ? value : undefined;
}

function readTime(value: unknown) {
  return typeof value === "string" && isPlanTime(value.trim()) ? value.trim() : undefined;
}

function readRef(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function readTitle(value: unknown, studentText: string) {
  const title = cleanActivityTitle(value);
  return title && isInStudentWords(title, studentText) ? title : undefined;
}

/**
 * The model's changes, kept only where every reference resolves and every date
 * is real. A change that fails is dropped on its own; the rest stand.
 */
export function parsePlanProposalChanges(raw: unknown, context: PlanProposalParseContext): PlanProposalChange[] {
  if (!Array.isArray(raw)) return [];
  const changes: PlanProposalChange[] = [];
  for (const item of raw) {
    if (changes.length >= MAX_PLAN_PROPOSAL_CHANGES) break;
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const op = typeof entry.op === "string" ? entry.op.trim().toLowerCase() : "";
    const target = context.activityRefs.get(readRef(entry.id ?? entry.ref));

    if (op === "add") {
      const dayKey = readDay(entry.date, context.todayDayKey);
      if (!dayKey) continue;
      const scopeKey = context.subjectRefs.get(readRef(entry.subject ?? entry.ref));
      const title = readTitle(entry.title, context.studentText);
      const method = isPlanActivityMethod(entry.method) ? entry.method : title ? methodFromTitle(title) : undefined;
      const startTime = readTime(entry.time);
      const minutes = Number(entry.minutes);
      changes.push({
        kind: "add",
        dayKey,
        minutes: Number.isFinite(minutes) ? clampActivityMinutes(minutes) : DEFAULT_PLAN_ACTIVITY_MINUTES,
        ...(startTime ? { startTime } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        ...(title ? { title } : {}),
        ...(method && title ? { method } : {}),
      });
    } else if (op === "move") {
      const toDayKey = readDay(entry.date, context.todayDayKey);
      // Work already done stays on the day it was done.
      if (!target || target.done || !toDayKey) continue;
      const startTime = readTime(entry.time);
      if (toDayKey === target.dayKey && !startTime) continue;
      changes.push({ kind: "move", dayKey: target.dayKey, activityId: target.activityId, toDayKey, ...(startTime ? { startTime } : {}) });
    } else if (op === "update") {
      if (!target || target.done) continue;
      const startTime = readTime(entry.time);
      const minutes = Number(entry.minutes);
      const title = readTitle(entry.title, context.studentText);
      const method = isPlanActivityMethod(entry.method) ? entry.method : undefined;
      const mode = entry.mode === "fixed" || entry.mode === "adaptive" ? entry.mode : undefined;
      const change: PlanProposalChange = {
        kind: "update",
        dayKey: target.dayKey,
        activityId: target.activityId,
        ...(startTime ? { startTime } : {}),
        ...(Number.isFinite(minutes) ? { minutes: clampActivityMinutes(minutes) } : {}),
        ...(title ? { title } : {}),
        ...(method ? { method } : {}),
        ...(mode ? { mode } : {}),
      };
      if (Object.keys(change).length > 3) changes.push(change);
    } else if (op === "remove" || op === "delete") {
      if (!target || target.done) continue;
      changes.push({ kind: "remove", dayKey: target.dayKey, activityId: target.activityId });
    } else if (op === "clear") {
      const dayKey = readDay(entry.date, context.todayDayKey);
      if (dayKey) changes.push({ kind: "clear", dayKey });
    } else if (op === "fill") {
      const fromDayKey = readDay(entry.from ?? entry.date, context.todayDayKey);
      const toDayKey = readDay(entry.to ?? entry.from ?? entry.date, context.todayDayKey);
      if (!fromDayKey || !toDayKey || planDaysBetween(fromDayKey, toDayKey) < 0) continue;
      if (planDaysBetween(fromDayKey, toDayKey) >= MAX_PLAN_FILL_DAYS) continue;
      changes.push({ kind: "fill", fromDayKey, toDayKey });
    }
  }
  return changes;
}

/**
 * Changes as the server sent them, read back into shape on arrival.
 *
 * Already checked against the timetable and the student's words on the
 * server; this only makes sure what reaches the planner's state is a change it
 * can apply, whatever happened on the way.
 */
export function readPlanProposalChanges(raw: unknown): PlanProposalChange[] {
  if (!Array.isArray(raw)) return [];
  const changes: PlanProposalChange[] = [];
  for (const item of raw.slice(0, MAX_PLAN_PROPOSAL_CHANGES)) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const startTime = readTime(entry.startTime);
    const activityId = typeof entry.activityId === "string" ? entry.activityId.slice(0, 64) : "";
    const dayKey = isPlanDayKey(entry.dayKey) ? entry.dayKey : "";
    const minutes = Number(entry.minutes);
    const title = cleanActivityTitle(entry.title);
    const method = isPlanActivityMethod(entry.method) ? entry.method : undefined;
    switch (entry.kind) {
      case "add": {
        const scopeKey = typeof entry.scopeKey === "string" && /^(folder|deck):.+/.test(entry.scopeKey) ? entry.scopeKey : "";
        if (!dayKey) break;
        changes.push({
          kind: "add",
          dayKey,
          minutes: Number.isFinite(minutes) ? clampActivityMinutes(minutes) : DEFAULT_PLAN_ACTIVITY_MINUTES,
          ...(startTime ? { startTime } : {}),
          ...(scopeKey ? { scopeKey } : {}),
          ...(title ? { title } : {}),
          ...(title && method ? { method } : {}),
        });
        break;
      }
      case "move":
        if (dayKey && activityId && isPlanDayKey(entry.toDayKey)) {
          changes.push({ kind: "move", dayKey, activityId, toDayKey: entry.toDayKey, ...(startTime ? { startTime } : {}) });
        }
        break;
      case "update":
        if (dayKey && activityId) {
          changes.push({
            kind: "update",
            dayKey,
            activityId,
            ...(startTime ? { startTime } : {}),
            ...(Number.isFinite(minutes) && minutes > 0 ? { minutes: clampActivityMinutes(minutes) } : {}),
            ...(title ? { title } : {}),
            ...(method ? { method } : {}),
            ...(entry.mode === "fixed" || entry.mode === "adaptive" ? { mode: entry.mode } : {}),
          });
        }
        break;
      case "remove":
        if (dayKey && activityId) changes.push({ kind: "remove", dayKey, activityId });
        break;
      case "clear":
        if (dayKey) changes.push({ kind: "clear", dayKey });
        break;
      case "fill":
        if (isPlanDayKey(entry.fromDayKey) && isPlanDayKey(entry.toDayKey)) {
          changes.push({ kind: "fill", fromDayKey: entry.fromDayKey, toDayKey: entry.toDayKey });
        }
        break;
    }
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* Saying what a proposal would do.                                    */
/* ------------------------------------------------------------------ */

export type PlanProposalSummaryContext = {
  activityOf: (dayKey: string, activityId: string) => Pick<PlanActivity, "title" | "open" | "scopeKey"> | undefined;
  scopeName: (scopeKey: string) => string;
};

function weekdayName(dayKey: string) {
  return shortPlanDate(dayKey).split(" ")[0] ?? dayKey;
}

function activityName(activity: Pick<PlanActivity, "title" | "open" | "scopeKey"> | undefined, context: PlanProposalSummaryContext) {
  if (!activity) return "an activity";
  if (activity.open) return activity.scopeKey ? `${context.scopeName(activity.scopeKey)} free session` : "a free session";
  return activity.title;
}

/**
 * A proposal in a headline and a line per change, as the student reads it
 * before choosing: "Move 2 sessions · Monday → Wednesday".
 */
export function summarizePlanProposal(changes: readonly PlanProposalChange[], context: PlanProposalSummaryContext) {
  const lines: string[] = [];
  const moves = new Map<string, number>();
  for (const change of changes) {
    switch (change.kind) {
      case "add": {
        const what = change.title
          ? change.title
          : change.scopeKey
            ? `${context.scopeName(change.scopeKey)} (Jami's pick)`
            : "A free session";
        lines.push(`Add ${what} · ${shortPlanDate(change.dayKey)}${change.startTime ? `, ${change.startTime}` : ""} · ${change.minutes} min`);
        break;
      }
      case "move": {
        const name = activityName(context.activityOf(change.dayKey, change.activityId), context);
        lines.push(
          change.toDayKey === change.dayKey
            ? `Move ${name} to ${change.startTime}`
            : `Move ${name} · ${shortPlanDate(change.dayKey)} → ${shortPlanDate(change.toDayKey)}${change.startTime ? `, ${change.startTime}` : ""}`
        );
        const key = `${change.dayKey}>${change.toDayKey}`;
        moves.set(key, (moves.get(key) ?? 0) + 1);
        break;
      }
      case "update": {
        const name = activityName(context.activityOf(change.dayKey, change.activityId), context);
        const parts = [
          change.title ? `call it ${change.title}` : "",
          change.method ? PLAN_ACTIVITY_METHOD_LABELS[change.method].toLowerCase() : "",
          change.startTime ? `at ${change.startTime}` : "",
          change.minutes ? `${change.minutes} min` : "",
          change.mode === "fixed" ? "keep it fixed" : change.mode === "adaptive" ? "let Jami adapt it" : "",
        ].filter(Boolean);
        lines.push(`Change ${name}: ${parts.join(", ")}`);
        break;
      }
      case "remove":
        lines.push(`Remove ${activityName(context.activityOf(change.dayKey, change.activityId), context)} · ${shortPlanDate(change.dayKey)}`);
        break;
      case "clear":
        lines.push(`Clear ${shortPlanDate(change.dayKey)} — a rest day`);
        break;
      case "fill":
        lines.push(
          change.fromDayKey === change.toDayKey
            ? `Fill the free sessions on ${shortPlanDate(change.fromDayKey)} with Jami's picks`
            : `Fill free sessions ${shortPlanDate(change.fromDayKey)} – ${shortPlanDate(change.toDayKey)} with Jami's picks`
        );
        break;
    }
  }

  const onlyMoves = changes.length > 0 && changes.every((change) => change.kind === "move");
  const [firstMove] = [...moves.entries()];
  const headline =
    onlyMoves && moves.size === 1 && firstMove
      ? (() => {
          const [days, count] = firstMove;
          const [from, to] = days.split(">") as [string, string];
          return from === to
            ? `Re-time ${count} ${count === 1 ? "activity" : "activities"}`
            : `Move ${count} ${count === 1 ? "activity" : "activities"} · ${weekdayName(from)} → ${weekdayName(to)}`;
        })()
      : changes.length === 1
        ? (lines[0] ?? "One change")
        : `${changes.length} changes`;
  return { headline, lines };
}

/* ------------------------------------------------------------------ */
/* Applying it: the same ops the timetable's own controls make.        */
/* ------------------------------------------------------------------ */

export type PlanProposalApplyContext = {
  /** Every day's activities as they stand, own or from the usual week. */
  activitiesOn: (dayKey: string) => readonly PlanActivity[];
  drafting: PlanDraftingContext;
  random?: () => number;
};

export function planProposalOps(changes: readonly PlanProposalChange[], context: PlanProposalApplyContext): TimetableOp[] {
  const random = context.random ?? context.drafting.random ?? Math.random;
  const ops: TimetableOp[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "add": {
        const base = {
          id: newPlanActivityId(random),
          minutes: change.minutes,
          ...(change.startTime ? { startTime: change.startTime } : {}),
          ...(change.scopeKey ? { scopeKey: change.scopeKey } : {}),
        };
        if (change.title) {
          const method = change.method ?? methodFromTitle(change.title);
          const href = studentTaskHref({ method, scopeKey: change.scopeKey, support: context.drafting.support });
          ops.push({
            type: "add",
            dayKey: change.dayKey,
            activity: { ...base, title: change.title, method, mode: "fixed", origin: "student", ...(href ? { href } : {}) },
          });
          break;
        }
        const open: PlanActivity = {
          ...base,
          title: "",
          method: "other",
          mode: change.scopeKey ? "adaptive" : "fixed",
          origin: "student",
          open: true,
        };
        const nearby = plannedActionIds([{ activities: context.activitiesOn(change.dayKey) }]);
        const filled = change.scopeKey
          ? fillFreeSessions({
              days: [{ dayKey: change.dayKey, activities: [open] }],
              context: context.drafting,
              alreadyPlanned: nearby,
            }).get(change.dayKey)
          : undefined;
        for (const activity of filled ?? [open]) ops.push({ type: "add", dayKey: change.dayKey, activity });
        break;
      }
      case "move":
        ops.push({
          type: "move",
          fromDayKey: change.dayKey,
          toDayKey: change.toDayKey,
          activityId: change.activityId,
          ...(change.startTime ? { startTime: change.startTime } : {}),
          fallbackId: newPlanActivityId(random),
        });
        break;
      case "update": {
        const href =
          change.title || change.method
            ? studentTaskHref({
                method: change.method ?? methodFromTitle(change.title ?? ""),
                scopeKey: context.activitiesOn(change.dayKey).find((activity) => activity.id === change.activityId)?.scopeKey,
                support: context.drafting.support,
              })
            : undefined;
        ops.push({
          type: "update",
          dayKey: change.dayKey,
          activityId: change.activityId,
          patch: {
            ...(change.startTime ? { startTime: change.startTime } : {}),
            ...(change.minutes ? { minutes: change.minutes } : {}),
            ...(change.title ? { title: change.title } : {}),
            ...(change.method ? { method: change.method } : {}),
            ...(href ? { href } : {}),
            ...(change.mode ? { mode: change.mode } : {}),
          },
        });
        break;
      }
      case "remove":
        ops.push({ type: "remove", dayKey: change.dayKey, activityId: change.activityId });
        break;
      case "clear":
        ops.push({ type: "clearDay", dayKey: change.dayKey });
        break;
      case "fill": {
        const dayKeys = planDayKeysBetween(change.fromDayKey, change.toDayKey, MAX_PLAN_FILL_DAYS);
        ops.push(...planFillOps(dayKeys.map((dayKey) => ({ dayKey, activities: context.activitiesOn(dayKey) })), context.drafting));
        break;
      }
    }
  }
  return ops;
}
