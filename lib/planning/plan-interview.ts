import type { PlanNotice } from "@/lib/ai/assistant-plan";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import { shortPlanDate } from "@/lib/planning/plan-format";
import { clampPlanMinutes, planDaysBetween } from "@/lib/planning/plan-schedule";
import {
  PLAN_WEEKDAY_LABELS,
  PLAN_WEEKDAYS,
  planScopeFromKey,
  planScopeKey,
  type PlanWeekday,
  type RevisionPlanDraft,
  type RevisionPlanExam,
  type RevisionPlanScope,
} from "@/lib/planning/types";
import { shiftStudyDayKey } from "@/lib/study/day";

/**
 * Making a revision plan with Jami, as a fixed sequence of questions.
 *
 * It used to be an open conversation: the student said something, and the
 * model decided whether that was enough to propose a whole plan. It usually
 * decided yes after one message, so plans arrived all at once, built on
 * guesses, and came out generic. Nothing asked about exams before choosing
 * subjects, or about the week before filling it, and nothing asked "anything
 * else?" before the plan started.
 *
 * So the structure lives here, not in a prompt. Four questions in the order
 * anyone would plan -- what you're working towards, which subjects, when you
 * can study, anything else -- then a last check before it starts. Every step
 * can be answered by tapping, which needs no model at all, or in the student's
 * own words, which the model reads. Either way, a step may only change the
 * parts of the plan it asks about, so the plan fills in one piece at a time
 * and an answer about Tuesdays cannot quietly rewrite the exams.
 *
 * The model never decides which question comes next or when the plan is done.
 */

export const PLAN_INTERVIEW_STEPS = ["goal", "subjects", "time", "extras", "review"] as const;
export type PlanInterviewStep = (typeof PLAN_INTERVIEW_STEPS)[number];

/** The steps that ask something; review is where the questions end. */
export const PLAN_QUESTION_STEPS = ["goal", "subjects", "time", "extras"] as const;

export const PLAN_STEP_TITLES: Record<PlanInterviewStep, string> = {
  goal: "Working towards",
  subjects: "Subjects",
  time: "Your week",
  extras: "Anything else",
  review: "Last check",
};

/** 0 leaves a subject out; 1 to 3 is how much of the week it gets. */
export const PLAN_PRIORITY_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: "Skip",
  1: "Light",
  2: "Normal",
  3: "Most",
};

export const PLAN_SESSION_LENGTHS = [20, 30, 45, 60, 90] as const;
export const DEFAULT_PLAN_SESSION_MINUTES = 45;

/** How long a plan with no exams runs: four weeks, the same as the builder's default. */
const NO_EXAM_SPAN_DAYS = 27;
/**
 * How many times Jami may ask again on a step that can be skipped.
 *
 * "Not sure" about exams is an answer too. Past this the interview moves on
 * rather than asking the same thing a third time.
 */
const MAX_FOLLOW_UPS = 2;

export function isPlanInterviewStep(value: unknown): value is PlanInterviewStep {
  return typeof value === "string" && (PLAN_INTERVIEW_STEPS as readonly string[]).includes(value);
}

export function nextPlanStep(step: PlanInterviewStep): PlanInterviewStep {
  const index = PLAN_INTERVIEW_STEPS.indexOf(step);
  return PLAN_INTERVIEW_STEPS[Math.min(index + 1, PLAN_INTERVIEW_STEPS.length - 1)] ?? "review";
}

/** Which question steps are behind, on and ahead of the current one. */
export function planStepStatus(
  step: PlanInterviewStep,
  current: PlanInterviewStep
): "done" | "current" | "waiting" {
  const at = PLAN_INTERVIEW_STEPS.indexOf(current);
  const index = PLAN_INTERVIEW_STEPS.indexOf(step);
  if (index < at) return "done";
  return index === at ? "current" : "waiting";
}

/**
 * Whether the plan holds what this step exists to find out.
 *
 * Working towards and anything else are satisfied by being answered at all:
 * "no exams" and "nothing else" are both answers. Subjects and the week are
 * not -- a plan with neither cannot start.
 */
export function planStepSatisfied(step: PlanInterviewStep, draft: RevisionPlanDraft) {
  if (step === "subjects") return draft.scopes.length > 0;
  if (step === "time") return draft.sessions.length > 0;
  if (step === "review") return normalizeRevisionPlanDraft(draft).valid;
  return true;
}

/** A plan nobody has named yet, so a name from an answer may replace it. */
function hasDefaultTitle(draft: Pick<RevisionPlanDraft, "title">) {
  return draft.title.trim() === "" || draft.title === "Revision plan";
}

/**
 * Jami's proposal, kept to the parts of the plan this step is about.
 *
 * The model is sent the whole plan and asked for the whole plan back, and
 * sometimes returns less than it was given. Taking only this step's fields
 * means a forgotten subject list on the question about Tuesdays is a no-op,
 * not a deleted subject list. The last two steps may change anything -- that
 * is what they are for -- but still cannot empty the plan of subjects, days or
 * exams by leaving them out.
 */
export function mergePlanStepProposal(
  step: PlanInterviewStep,
  current: RevisionPlanDraft,
  proposed: RevisionPlanDraft
): RevisionPlanDraft {
  let merged: RevisionPlanDraft;
  if (step === "goal") {
    merged = {
      ...current,
      title: hasDefaultTitle(proposed) && !hasDefaultTitle(current) ? current.title : proposed.title,
      startDayKey: proposed.startDayKey,
      endDayKey: proposed.endDayKey,
      scopes: withExamSubjects(current.scopes, proposed.exams ?? [], proposed.scopes),
      // Exams typed into the rows survive a reply that left them out; clearing
      // them is what "No exams coming up" is for.
      exams: (proposed.exams?.length ?? 0) > 0 ? (proposed.exams ?? []) : (current.exams ?? []),
    };
  } else if (step === "subjects") {
    merged =
      proposed.scopes.length > 0
        ? { ...current, scopes: proposed.scopes, emphasis: proposed.emphasis }
        : current;
  } else if (step === "time") {
    merged = proposed.sessions.length > 0 ? { ...current, sessions: proposed.sessions } : current;
  } else {
    merged = {
      ...proposed,
      title: hasDefaultTitle(proposed) && !hasDefaultTitle(current) ? current.title : proposed.title,
      scopes: proposed.scopes.length > 0 ? proposed.scopes : current.scopes,
      emphasis: proposed.scopes.length > 0 ? proposed.emphasis : current.emphasis,
      sessions: proposed.sessions.length > 0 ? proposed.sessions : current.sessions,
      ...((proposed.exams?.length ?? 0) > 0
        ? { exams: proposed.exams }
        : (current.exams?.length ?? 0) > 0
          ? { exams: current.exams }
          : {}),
    };
  }
  return normalizeRevisionPlanDraft({ ...merged, origin: "tutor" }).draft;
}

/**
 * The plan's subjects, plus any the exams belong to.
 *
 * A subject somebody named an exam in is in their plan -- they would not be
 * asked -- and an exam can only keep its subject if the plan covers it, so
 * leaving it out would also silently untie the exam.
 */
function withExamSubjects(
  scopes: readonly RevisionPlanScope[],
  exams: readonly RevisionPlanExam[],
  offered: readonly RevisionPlanScope[] = []
): RevisionPlanScope[] {
  const next = [...scopes];
  const have = new Set(next.map(planScopeKey));
  for (const exam of exams) {
    if (!exam.scopeKey || have.has(exam.scopeKey)) continue;
    const scope =
      offered.find((candidate) => planScopeKey(candidate) === exam.scopeKey) ??
      planScopeFromKey(exam.scopeKey);
    if (!scope) continue;
    next.push({ ...scope, weight: 2 });
    have.add(exam.scopeKey);
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Tapped answers. Each is a plan in, a plan out, and needs no model. */
/* ------------------------------------------------------------------ */

/** No exams: four weeks from the plan's start, under whatever it is called. */
export function planWithNoExams(draft: RevisionPlanDraft): RevisionPlanDraft {
  return normalizeRevisionPlanDraft({
    ...draft,
    exams: [],
    endDayKey: shiftStudyDayKey(draft.startDayKey, NO_EXAM_SPAN_DAYS),
    title: hasDefaultTitle(draft) ? "Staying on top" : draft.title,
    origin: "tutor",
  }).draft;
}

/**
 * The exams the student typed in, and a plan that runs until the last one.
 *
 * Rows without a name or a date are left out, which is what saving them would
 * do; the editor keeps its own rows, so a half-typed one does not vanish.
 */
export function planWithExams(
  draft: RevisionPlanDraft,
  exams: readonly RevisionPlanExam[]
): RevisionPlanDraft {
  const complete = exams.filter((exam) => exam.label.trim() && exam.dayKey);
  if (complete.length === 0) return planWithNoExams(draft);
  const last = complete.reduce(
    (latest, exam) => (exam.dayKey > latest ? exam.dayKey : latest),
    complete[0]?.dayKey ?? draft.endDayKey
  );
  const first = complete[0];
  return normalizeRevisionPlanDraft({
    ...draft,
    exams: complete,
    scopes: withExamSubjects(draft.scopes, complete),
    endDayKey: planDaysBetween(draft.startDayKey, last) >= 0 ? last : draft.endDayKey,
    title: hasDefaultTitle(draft)
      ? complete.length === 1 && first
        ? first.label.trim()
        : `${complete.length} exams from ${shortPlanDate(firstExamDay(complete))}`
      : draft.title,
    origin: "tutor",
  }).draft;
}

function firstExamDay(exams: readonly RevisionPlanExam[]) {
  return exams.reduce(
    (earliest, exam) => (exam.dayKey < earliest ? exam.dayKey : earliest),
    exams[0]?.dayKey ?? ""
  );
}

/** One subject in or out of the plan, or weighted differently. */
export function planWithSubjectPriority(
  draft: RevisionPlanDraft,
  scope: Pick<RevisionPlanScope, "folderId" | "deckId">,
  priority: 0 | 1 | 2 | 3
): RevisionPlanDraft {
  const key = planScopeKey(scope);
  const without = draft.scopes.filter((candidate) => planScopeKey(candidate) !== key);
  const existingIndex = draft.scopes.findIndex((candidate) => planScopeKey(candidate) === key);
  const scopes =
    priority === 0
      ? without
      : existingIndex >= 0
        ? draft.scopes.map((candidate, index) =>
            index === existingIndex ? { ...candidate, weight: priority } : candidate
          )
        : [
            ...draft.scopes,
            scope.folderId
              ? { folderId: scope.folderId, weight: priority }
              : { deckId: scope.deckId as string, weight: priority },
          ];
  return normalizeRevisionPlanDraft({ ...draft, scopes, origin: "tutor" }).draft;
}

/** The days the plan studies on, as the week row reads them. */
export function planStudyDays(draft: Pick<RevisionPlanDraft, "sessions">) {
  return new Set(draft.sessions.map((session) => session.weekday));
}

/**
 * The most common sitting length, which is what the length choice shows.
 *
 * Several lengths can exist once a student has described a real timetable;
 * the choice then reads as the usual one and pressing it sets them all.
 */
export function planUsualMinutes(draft: Pick<RevisionPlanDraft, "sessions">) {
  const counts = new Map<number, number>();
  for (const session of draft.sessions) {
    counts.set(session.minutes, (counts.get(session.minutes) ?? 0) + 1);
  }
  let best = DEFAULT_PLAN_SESSION_MINUTES;
  let bestCount = 0;
  for (const [minutes, count] of counts) {
    if (count > bestCount) {
      best = minutes;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A day switched on or off.
 *
 * Off takes every sitting that day; on adds one of the usual length, or of
 * `minutes` when the student chose a length before choosing any day. A day
 * that already has sittings -- times the student typed earlier -- keeps them.
 */
export function planWithDayToggled(
  draft: RevisionPlanDraft,
  weekday: PlanWeekday,
  minutes?: number
): RevisionPlanDraft {
  const on = planStudyDays(draft).has(weekday);
  const sessions = on
    ? draft.sessions.filter((session) => session.weekday !== weekday)
    : [
        ...draft.sessions,
        {
          id: `day-${weekday}-${draft.sessions.length}`,
          weekday,
          minutes: minutes ?? planUsualMinutes(draft),
        },
      ];
  return normalizeRevisionPlanDraft({ ...draft, sessions, origin: "tutor" }).draft;
}

/** Every sitting set to one length. */
export function planWithSessionLength(draft: RevisionPlanDraft, minutes: number): RevisionPlanDraft {
  const length = clampPlanMinutes(minutes);
  return normalizeRevisionPlanDraft({
    ...draft,
    sessions: draft.sessions.map((session) => ({ ...session, minutes: length })),
    origin: "tutor",
  }).draft;
}

/* ------------------------------------------------------------------ */
/* What Jami says. Fixed words, so every plan is asked the same things. */
/* ------------------------------------------------------------------ */

export type PlanInterviewContext = {
  notices: readonly PlanNotice[];
  /** Folder or deck names by scope key, for saying which subjects are in. */
  scopeNames: ReadonlyMap<string, string>;
};

function listNames(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The question for a step, in Jami's voice.
 *
 * The subjects question is the one place the Learning Engine speaks: what it
 * has counted is said as a sentence, where it bears on the choice, instead of
 * sitting above the conversation as a row of chips nobody could press.
 */
export function planStepQuestion(
  step: PlanInterviewStep,
  draft: RevisionPlanDraft,
  context: PlanInterviewContext,
  options: { again?: boolean; reshaping?: boolean } = {}
) {
  if (options.reshaping) {
    return "What would you like to change? I can move, add or clear sessions, fill your free time, or change your usual week.";
  }
  if (step === "goal") {
    return options.again
      ? "What are you working towards now? Change the exams or the date you want to be ready by."
      : "What are you working towards? Tell me your exams and when they are, or add them below. No exams is fine too — I'll plan the next four weeks.";
  }
  if (step === "subjects") {
    const included = draft.scopes
      .map((scope) => context.scopeNames.get(planScopeKey(scope)))
      .filter((name): name is string => Boolean(name));
    const parts = [
      "Which subjects should this cover? Give the ones that need the most time a higher priority.",
    ];
    if (included.length > 0 && !options.again) {
      parts.push(`I've put ${listNames(included)} in because of your exams.`);
    }
    const notice = context.notices[0];
    if (notice) parts.push(`From your answers in ${notice.subject}: ${notice.detail}.`);
    return parts.join(" ");
  }
  if (step === "time") {
    return "When can you study? Pick your days and how long you can manage in one go — or tell me your week, with times if you have them.";
  }
  if (step === "extras") {
    return "Anything else I should fit around? A subject to start with, a day off, coursework that's due — or nothing, and we're nearly done.";
  }
  return options.again
    ? "Anything else to change, or is it ready to save?"
    : "There's your timetable. Change anything on it directly, or tell me what to move — then save it.";
}

/** What a tapped subjects answer said, for the conversation to show. */
export function describeSubjectChoice(draft: RevisionPlanDraft, scopeNames: ReadonlyMap<string, string>) {
  const named = [...draft.scopes]
    .sort((left, right) => right.weight - left.weight)
    .map((scope) => {
      const name = scopeNames.get(planScopeKey(scope)) ?? "A subject";
      return scope.weight >= 3 ? `${name} (most)` : scope.weight <= 1 ? `${name} (light)` : name;
    });
  return named.join(", ");
}

/** What a tapped week said: "Mon, Wed, Fri · 45 min". */
export function describeWeekChoice(draft: RevisionPlanDraft) {
  const days = PLAN_WEEKDAYS.filter((weekday) => planStudyDays(draft).has(weekday)).map(
    (weekday) => PLAN_WEEKDAY_LABELS[weekday]
  );
  return `${days.join(", ")} · ${planUsualMinutes(draft)} min`;
}

/** What a tapped exams answer said: "Chemistry Paper 1 on Thu 12 Nov". */
export function describeExamChoice(draft: RevisionPlanDraft) {
  const exams = draft.exams ?? [];
  if (exams.length === 0) return "No exams coming up";
  return exams.map((exam) => `${exam.label} on ${shortPlanDate(exam.dayKey)}`).join(", ");
}

/* ------------------------------------------------------------------ */
/* The conversation as state.                                          */
/* ------------------------------------------------------------------ */

export type PlanInterviewTurn = {
  role: "student" | "jami";
  text: string;
  step: PlanInterviewStep;
  /** A step's fixed question, as opposed to Jami answering something said. */
  question?: boolean;
  /** Changes Jami proposed in this reply, shown under it for the student to apply or not. */
  proposalId?: string;
};

export type PlanInterviewState = {
  step: PlanInterviewStep;
  draft: RevisionPlanDraft;
  turns: PlanInterviewTurn[];
  /** Times Jami has asked again on this step without the plan moving. */
  followUps: number;
};

function asked(
  step: PlanInterviewStep,
  draft: RevisionPlanDraft,
  context: PlanInterviewContext,
  options: { again?: boolean; reshaping?: boolean } = {}
): PlanInterviewTurn {
  return { role: "jami", text: planStepQuestion(step, draft, context, options), step, question: true };
}

/**
 * A new interview, from the first question -- or, for a plan that is already
 * running, from the last check, because the plan exists and the only question
 * left is what to change about it.
 */
export function startPlanInterview(input: {
  draft?: RevisionPlanDraft | null;
  reshaping?: boolean;
  context: PlanInterviewContext;
}): PlanInterviewState {
  const draft = input.draft ?? normalizeRevisionPlanDraft({ origin: "tutor" }).draft;
  const step: PlanInterviewStep = input.reshaping ? "review" : "goal";
  return {
    step,
    draft,
    turns: [asked(step, draft, input.context, { reshaping: input.reshaping ?? false })],
    followUps: 0,
  };
}

/** The student said something; the plan waits for Jami's answer. */
export function recordStudentMessage(state: PlanInterviewState, text: string): PlanInterviewState {
  return { ...state, turns: [...state.turns, { role: "student", text, step: state.step }] };
}

function advance(
  state: PlanInterviewState,
  draft: RevisionPlanDraft,
  turns: PlanInterviewTurn[],
  context: PlanInterviewContext
): PlanInterviewState {
  const step = nextPlanStep(state.step);
  return {
    step,
    draft,
    turns: [...turns, asked(step, draft, context, { again: state.step === "review" })],
    followUps: 0,
  };
}

/**
 * A tapped answer: the plan as the taps left it, said back in words, and the
 * next question.
 */
export function answerPlanStep(
  state: PlanInterviewState,
  summary: string,
  draft: RevisionPlanDraft,
  context: PlanInterviewContext
): PlanInterviewState {
  const turns: PlanInterviewTurn[] = [...state.turns, { role: "student", text: summary, step: state.step }];
  return advance({ ...state, draft }, draft, turns, context);
}

/**
 * Jami's answer to something the student typed.
 *
 * A reply with a plan moves the step on once the step has what it needs. A
 * reply without one is Jami asking again, and a step that can be skipped is
 * moved past after a couple of those rather than circling.
 */
export function applyJamiReply(
  state: PlanInterviewState,
  reply: { text: string; proposal: RevisionPlanDraft | null; proposalId?: string },
  context: PlanInterviewContext
): PlanInterviewState {
  const turns: PlanInterviewTurn[] = [
    ...state.turns,
    ...(reply.text || reply.proposalId
      ? [{ role: "jami" as const, text: reply.text, step: state.step, ...(reply.proposalId ? { proposalId: reply.proposalId } : {}) }]
      : []),
  ];

  if (!reply.proposal) {
    const followUps = state.followUps + 1;
    const skippable = state.step === "goal" || state.step === "extras";
    if (skippable && followUps >= MAX_FOLLOW_UPS) {
      const draft = state.step === "goal" ? planWithNoExams(state.draft) : state.draft;
      return advance(state, draft, turns, context);
    }
    return { ...state, turns, followUps };
  }

  const draft = mergePlanStepProposal(state.step, state.draft, reply.proposal);
  if (state.step === "review") {
    return { ...state, draft, turns: [...turns, asked("review", draft, context, { again: true })], followUps: 0 };
  }
  if (planStepSatisfied(state.step, draft)) return advance(state, draft, turns, context);
  return { ...state, draft, turns, followUps: state.followUps + 1 };
}

/** Back to an earlier question, to change what it decided. */
export function jumpToPlanStep(
  state: PlanInterviewState,
  step: PlanInterviewStep,
  context: PlanInterviewContext
): PlanInterviewState {
  if (step === state.step) return state;
  return {
    ...state,
    step,
    turns: [...state.turns, asked(step, state.draft, context, { again: true })],
    followUps: 0,
  };
}

/** The draft changed by hand -- a tap, or the full builder -- without a turn. */
export function withPlanDraft(state: PlanInterviewState, draft: RevisionPlanDraft): PlanInterviewState {
  return { ...state, draft };
}

/**
 * Jami's answer about a plan that is already running.
 *
 * Nothing moves on its own here: whatever Jami would change is a proposal the
 * student applies or discards, so the reply is recorded with the proposal it
 * carries and the plan stays exactly as it is.
 */
export function recordJamiTurn(state: PlanInterviewState, text: string, proposalId?: string): PlanInterviewState {
  if (!text && !proposalId) return state;
  return {
    ...state,
    turns: [...state.turns, { role: "jami", text, step: state.step, ...(proposalId ? { proposalId } : {}) }],
  };
}

/** An item without its id: two sittings or exams that differ only in id are the same one. */
function withoutId<T extends { id: string }>(item: T) {
  const copy: Partial<T> = { ...item };
  delete copy.id;
  return copy;
}

function usualWeekKey(draft: RevisionPlanDraft) {
  return JSON.stringify(
    [...draft.sessions].sort((left, right) => left.weekday - right.weekday).map(withoutId)
  );
}

/** Whether two drafts describe the same plan, so an unchanged one is not proposed as a change. */
export function samePlanShape(left: RevisionPlanDraft, right: RevisionPlanDraft) {
  const shape = (draft: RevisionPlanDraft) => {
    const { draft: normal } = normalizeRevisionPlanDraft(draft);
    return JSON.stringify({
      title: normal.title,
      startDayKey: normal.startDayKey,
      endDayKey: normal.endDayKey,
      scopes: normal.scopes,
      sessions: usualWeekKey(normal),
      exams: (normal.exams ?? []).map(withoutId),
    });
  };
  return shape(left) === shape(right);
}

/**
 * What a proposed change to the plan itself would do, a line a change: the
 * dates, the exams, the subjects, the usual week.
 */
export function describePlanShapeChanges(
  before: RevisionPlanDraft,
  after: RevisionPlanDraft,
  scopeNames: ReadonlyMap<string, string>
): string[] {
  const lines: string[] = [];
  if (after.title !== before.title) lines.push(`Call it "${after.title}"`);
  if (after.startDayKey !== before.startDayKey || after.endDayKey !== before.endDayKey) {
    lines.push(`Run ${shortPlanDate(after.startDayKey)} – ${shortPlanDate(after.endDayKey)}`);
  }
  const examKey = (exam: RevisionPlanExam) => `${exam.label}|${exam.dayKey}`;
  const beforeExams = new Set((before.exams ?? []).map(examKey));
  const afterExams = new Set((after.exams ?? []).map(examKey));
  for (const exam of after.exams ?? []) {
    if (!beforeExams.has(examKey(exam))) lines.push(`Count down to ${exam.label} on ${shortPlanDate(exam.dayKey)}`);
  }
  for (const exam of before.exams ?? []) {
    if (!afterExams.has(examKey(exam))) lines.push(`Stop counting down to ${exam.label} on ${shortPlanDate(exam.dayKey)}`);
  }
  const weights = new Map(before.scopes.map((scope) => [planScopeKey(scope), scope.weight]));
  const name = (key: string) => scopeNames.get(key) ?? "A subject";
  for (const scope of after.scopes) {
    const key = planScopeKey(scope);
    const was = weights.get(key);
    if (was === undefined) lines.push(`Add ${name(key)} (${PLAN_PRIORITY_LABELS[scope.weight as 1 | 2 | 3].toLowerCase()})`);
    else if (was !== scope.weight) lines.push(`Give ${name(key)} ${scope.weight >= 3 ? "the most time" : scope.weight <= 1 ? "a light touch" : "a normal share"}`);
    weights.delete(key);
  }
  for (const key of weights.keys()) lines.push(`Take ${name(key)} out of the plan`);
  if (usualWeekKey(before) !== usualWeekKey(after)) {
    lines.push(after.sessions.length > 0 ? `Usual week: ${describeWeekChoice(after)}` : "No usual week: only what is on the timetable");
  }
  return lines;
}
