"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Button, DateField, Input, OptionSwitch, Select, SettingSwitch } from "@/components/ui";
import PlanExamsEditor from "@/components/planning/PlanExamsEditor";
import PlanWeightDots from "@/components/planning/PlanWeightDots";
import {
  normalizeRevisionPlanDraft,
  PLAN_PROBLEM_MESSAGES,
} from "@/lib/planning/normalize-plan";
import { clampPlanMinutes, planSessionEndTime } from "@/lib/planning/plan-schedule";
import {
  PLAN_MAX_SESSIONS_PER_DAY,
  PLAN_WEEKDAY_FULL_LABELS,
  PLAN_WEEKDAY_LABELS,
  PLAN_WEEKDAYS,
  planScopeKey,
  type PlanWeekday,
  type RevisionPlanDraft,
  type RevisionPlanExam,
  type RevisionPlanScope,
  type RevisionPlanSession,
} from "@/lib/planning/types";

/**
 * The student building their own week.
 *
 * This is the primary way a plan is made, not the fallback. Jami can draft one
 * and often should, but a student knows their own timetable -- when they have
 * football, which exam is first, that Thursdays are useless -- and none of that
 * is in any evidence Jami holds. So the manual path is the one that has to be
 * good, and the drafted one arrives here to be edited anyway.
 *
 * Four decisions, in the order anyone would make them: what am I revising, how
 * precisely do I want to say when, when, and until when. Everything *inside* a
 * session is the Learning Engine's, which is why there is still nothing here
 * about topics.
 *
 * The two modes are the whole point of the redesign. Simple is what this always
 * was -- days and one length -- and it stays the default, because most students
 * do not want to write out a timetable and a plan that demanded one would be
 * abandoned at the first screen. Timetable is for the student who already has a
 * week in their head and wants it back exactly: two sittings on a Monday, the
 * first at half four, Chemistry.
 */

const SESSION_LENGTHS = [20, 30, 45, 60, 90];

export type PlanScopeOption = {
  key: string;
  label: string;
  folderId?: string;
  deckId?: string;
};

type BuilderMode = "simple" | "timetable";

/** Whether a plan says anything Simple mode could not hold. */
function needsTimetableMode(sessions: readonly RevisionPlanSession[]) {
  const perWeekday = new Map<PlanWeekday, number>();
  for (const session of sessions) {
    if (session.startTime || session.scopeKey || session.label) return true;
    const count = (perWeekday.get(session.weekday) ?? 0) + 1;
    if (count > 1) return true;
    perWeekday.set(session.weekday, count);
  }
  return false;
}

function SectionLabel({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">{title}</h3>
      {description ? (
        <p className="mt-1.5 text-sm leading-6 text-text-secondary">{description}</p>
      ) : null}
    </div>
  );
}

/** A day per button, the same here and in the interview's week question. */
export function WeekdayToggles({
  active,
  onToggle,
}: {
  active: ReadonlySet<PlanWeekday>;
  onToggle: (weekday: PlanWeekday) => void;
}) {
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {PLAN_WEEKDAYS.map((weekday) => {
        const on = active.has(weekday);
        return (
          <button
            key={weekday}
            type="button"
            aria-pressed={on}
            aria-label={PLAN_WEEKDAY_FULL_LABELS[weekday]}
            onClick={() => onToggle(weekday)}
            className={`min-h-12 rounded-2xl border text-xs font-semibold transition duration-normal ease-spring active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
              on
                ? "app-selected shadow-accent"
                : "border-dashed border-[var(--color-border-strong)] text-text-muted hover:border-solid hover:text-text-primary"
            }`}
          >
            {/* Three letters: one left two Ts and two Ss to tell apart. */}
            {PLAN_WEEKDAY_LABELS[weekday]}
          </button>
        );
      })}
    </div>
  );
}

/** One sitting, with everything about it optional except how long it is. */
function SessionRow({
  session,
  scopeOptions,
  canRemove,
  onChange,
  onRemove,
}: {
  session: RevisionPlanSession;
  scopeOptions: readonly PlanScopeOption[];
  canRemove: boolean;
  onChange: (next: RevisionPlanSession) => void;
  onRemove: () => void;
}) {
  const endTime = session.startTime
    ? planSessionEndTime(session.startTime, session.minutes)
    : undefined;

  return (
    <li className="app-subtle-panel rounded-xl p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(7rem,0.9fr)_minmax(0,1.1fr)] lg:grid-cols-[minmax(7rem,0.8fr)_minmax(0,1fr)_auto]">
        <DateField
          type="time"
          label="Starts"
          value={session.startTime ?? ""}
          placeholder="Any time"
          onValueChange={(value) =>
            onChange({ ...session, ...(value ? { startTime: value } : { startTime: undefined }) })
          }
        />
        <Select
          label="Subject"
          value={session.scopeKey ?? ""}
          onChange={(event) =>
            onChange({
              ...session,
              scopeKey: event.target.value || undefined,
            })
          }
        >
          {/* The empty option is not "none" -- it is the plan's own weighting,
              which is what a student who has not thought about it wants. */}
          <option value="">Whatever needs it most</option>
          {scopeOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </Select>
        <div className="flex items-end justify-between gap-2 lg:justify-end">
          <p className="text-2xs text-text-muted lg:hidden">
            {endTime ? `Until ${endTime}` : "No fixed time"}
          </p>
          {canRemove ? (
            <button
              type="button"
              aria-label="Remove this session"
              onClick={onRemove}
              className="app-chip min-h-11 shrink-0 rounded-full px-4 text-xs font-semibold transition duration-fast hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-2xs font-semibold uppercase tracking-[0.14em] text-text-muted">
          Length
        </span>
        {SESSION_LENGTHS.map((length) => (
          <button
            key={length}
            type="button"
            aria-pressed={session.minutes === length}
            onClick={() => onChange({ ...session, minutes: length })}
            className={`min-h-9 rounded-full border px-3 text-xs font-semibold transition duration-fast ${
              session.minutes === length ? "app-selected" : "app-chip"
            }`}
          >
            {length}m
          </button>
        ))}
        {endTime ? (
          <span className="ml-auto hidden text-2xs text-text-muted lg:inline">Until {endTime}</span>
        ) : null}
      </div>
    </li>
  );
}

export default function RevisionPlanBuilder({
  options,
  initial,
  saving,
  activityCount = 0,
  submitLabel,
  onSave,
  onCancel,
  onBack,
  backLabel = "Back",
}: {
  options: readonly PlanScopeOption[];
  initial?: RevisionPlanDraft;
  saving?: boolean;
  /** How much is already on the timetable: a plan with activities needs no usual week to be saved. */
  activityCount?: number;
  submitLabel?: string;
  onSave: (draft: RevisionPlanDraft) => void;
  onCancel?: () => void;
  /**
   * Leave the form without discarding what was changed.
   *
   * Distinct from `onCancel`, which throws the edits away. A student who opened
   * this from the conversation is not finished with the plan -- they came to
   * adjust one thing and go back -- and losing their work on the way would make
   * the two surfaces feel like separate products rather than one plan.
   */
  onBack?: (draft: RevisionPlanDraft) => void;
  backLabel?: string;
}) {
  const start = normalizeRevisionPlanDraft(initial).draft;
  const [title, setTitle] = useState(initial ? start.title : "");
  const [scopes, setScopes] = useState<RevisionPlanScope[]>(start.scopes);
  const [sessions, setSessions] = useState<RevisionPlanSession[]>(start.sessions);
  const [startDayKey, setStartDayKey] = useState(start.startDayKey);
  const [endDayKey, setEndDayKey] = useState(start.endDayKey);
  const [exams, setExams] = useState<RevisionPlanExam[]>(start.exams ?? []);
  const [mode, setMode] = useState<BuilderMode>(
    needsTimetableMode(start.sessions) ? "timetable" : "simple"
  );
  /** Simple mode's one length for the whole week. */
  const [minutes, setMinutes] = useState(start.sessions[0]?.minutes ?? 45);
  const [autoFill, setAutoFill] = useState(start.autoFill ?? false);

  // Ids only have to be unique within this form; the plan is written whole.
  const nextId = useRef(start.sessions.length);
  const makeId = useCallback(() => {
    nextId.current += 1;
    return `s${nextId.current}`;
  }, []);

  const chosen = useMemo(() => new Set(scopes.map(planScopeKey)), [scopes]);
  const activeDays = useMemo(
    () => new Set(sessions.map((session) => session.weekday)),
    [sessions]
  );
  const scopeOptions = useMemo(
    () => options.filter((option) => chosen.has(option.key)),
    [chosen, options]
  );

  const draft: RevisionPlanDraft = useMemo(
    () => ({
      title: title.trim() || "Revision plan",
      status: "active",
      origin: initial?.origin ?? "manual",
      startDayKey,
      endDayKey,
      scopes,
      sessions,
      emphasis: start.emphasis,
      // A row still being typed is not an exam yet; the plan keeps only ones with a name.
      ...(exams.some((exam) => exam.label.trim()) ? { exams: exams.filter((exam) => exam.label.trim()) } : {}),
      autoFill,
    }),
    [autoFill, endDayKey, exams, initial?.origin, scopes, sessions, start.emphasis, startDayKey, title]
  );

  const { problems, valid } = normalizeRevisionPlanDraft(draft, undefined, { activityCount });

  const toggleScope = (option: PlanScopeOption) => {
    setScopes((current) => {
      const key = option.key;
      if (current.some((scope) => planScopeKey(scope) === key)) {
        // A sitting pinned to a subject the plan no longer covers would be
        // dropped on save anyway; unpinning it here keeps the form honest.
        setSessions((currentSessions) =>
          currentSessions.map((session) =>
            session.scopeKey === key ? { ...session, scopeKey: undefined } : session
          )
        );
        return current.filter((scope) => planScopeKey(scope) !== key);
      }
      return [
        ...current,
        option.folderId
          ? { folderId: option.folderId, weight: 1 }
          : { deckId: option.deckId as string, weight: 1 },
      ];
    });
  };

  const cycleWeight = (key: string) =>
    setScopes((current) =>
      current.map((scope) =>
        planScopeKey(scope) === key
          ? { ...scope, weight: scope.weight >= 3 ? 1 : scope.weight + 1 }
          : scope
      )
    );

  /** Simple mode: a day is on or off, and every day is the same length. */
  const toggleSimpleDay = (weekday: PlanWeekday) =>
    setSessions((current) =>
      current.some((session) => session.weekday === weekday)
        ? current.filter((session) => session.weekday !== weekday)
        : [...current, { id: makeId(), weekday, minutes: clampPlanMinutes(minutes) }]
    );

  const setSimpleMinutes = (length: number) => {
    setMinutes(length);
    setSessions((current) => current.map((session) => ({ ...session, minutes: length })));
  };

  /** Timetable mode: a day switched on starts with one sitting to edit. */
  const toggleTimetableDay = (weekday: PlanWeekday) =>
    setSessions((current) =>
      current.some((session) => session.weekday === weekday)
        ? current.filter((session) => session.weekday !== weekday)
        : [...current, { id: makeId(), weekday, minutes: clampPlanMinutes(minutes) }]
    );

  const addSession = (weekday: PlanWeekday) =>
    setSessions((current) => [
      ...current,
      { id: makeId(), weekday, minutes: clampPlanMinutes(minutes) },
    ]);

  const updateSession = (id: string, next: RevisionPlanSession) =>
    setSessions((current) => current.map((session) => (session.id === id ? next : session)));

  const removeSession = (id: string) =>
    setSessions((current) => current.filter((session) => session.id !== id));

  /** Every other study day gets this one's sittings, times and all. */
  const copyDayToRest = (weekday: PlanWeekday) =>
    setSessions((current) => {
      const source = current.filter((session) => session.weekday === weekday);
      const targets = [...new Set(current.map((session) => session.weekday))].filter(
        (day) => day !== weekday
      );
      return [
        ...current.filter((session) => session.weekday === weekday),
        ...targets.flatMap((day) =>
          source.map((session) => ({ ...session, id: makeId(), weekday: day }))
        ),
      ];
    });

  const changeMode = (next: BuilderMode) => {
    setMode(next);
    if (next !== "simple") return;
    /*
     * Collapsed as the mode changes rather than quietly kept.
     *
     * Simple mode cannot draw a second sitting or a time, so keeping them
     * hidden in the state would mean saving a week the student can no longer
     * see. One sitting a day at the shared length is what Simple means, and the
     * note beside the switch says so before they press it.
     */
    setSessions((current) => {
      const days = [...new Set(current.map((session) => session.weekday))].sort();
      return days.map((weekday) => ({
        id: makeId(),
        weekday,
        minutes: clampPlanMinutes(minutes),
      }));
    });
  };

  const timetableDays = useMemo(
    () => [...activeDays].sort((left, right) => left - right),
    [activeDays]
  );

  return (
    <div className="space-y-7">
      <section className="space-y-2">
        <label
          htmlFor="plan-title"
          className="block text-xs font-semibold uppercase tracking-[0.18em] text-text-muted"
        >
          What is this for
        </label>
        <Input
          id="plan-title"
          value={title}
          maxLength={80}
          placeholder="Summer exams"
          className="text-lg"
          onChange={(event) => setTitle(event.target.value)}
        />
      </section>

      <section className="space-y-3">
        <SectionLabel
          title="What you're revising"
          description="Tap a subject to include it. Tap its dots to give it more of the week."
        />
        {options.length === 0 ? (
          <p className="app-subtle-panel rounded-xl px-4 py-3 text-sm text-text-secondary">
            Make a folder or a deck first — a plan revises something.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => {
              const active = chosen.has(option.key);
              const weight = scopes.find((scope) => planScopeKey(scope) === option.key)?.weight ?? 1;
              return (
                <span key={option.key} className="inline-flex">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleScope(option)}
                    className={`min-h-11 rounded-full border px-4 text-sm font-semibold transition duration-normal ease-spring active:scale-95 ${
                      active ? "app-selected shadow-accent" : "app-chip"
                    } ${active ? "rounded-r-none border-r-0 pr-3" : ""}`}
                  >
                    {option.label}
                  </button>
                  {active ? (
                    <button
                      type="button"
                      aria-label={`How much of the week ${option.label} takes`}
                      onClick={() => cycleWeight(option.key)}
                      className="app-selected min-h-11 rounded-full rounded-l-none border-l border-l-[var(--color-border-strong)] px-3"
                    >
                      <PlanWeightDots weight={weight} />
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionLabel
          title="Your usual week"
          description="When you can normally study. New weeks start from these as free sessions, and nothing already on your timetable changes."
        />
        <OptionSwitch
          label="How much detail your week needs"
          hideLabel
          value={mode}
          columns={2}
          onChange={changeMode}
          options={[
            {
              value: "simple",
              label: "Simple",
              detail: "Pick your days and one session length.",
            },
            {
              value: "timetable",
              label: "Timetable",
              detail: "Set times, subjects and more than one session a day.",
            },
          ]}
        />

        {mode === "simple" ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-text-secondary">
              Only the days you&rsquo;ll really sit down. An empty day is rest, not failure.
            </p>
            <WeekdayToggles active={activeDays} onToggle={toggleSimpleDay} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-sm text-text-secondary">Each session</span>
              {SESSION_LENGTHS.map((length) => (
                <button
                  key={length}
                  type="button"
                  aria-pressed={minutes === length}
                  onClick={() => setSimpleMinutes(length)}
                  className={`min-h-9 rounded-full border px-3 text-xs font-semibold transition duration-fast ${
                    minutes === length ? "app-selected" : "app-chip"
                  }`}
                >
                  {length} min
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-text-secondary">
              Switch a day on, then say as much or as little as you like about it. A session
              with no time is still a session.
            </p>
            <WeekdayToggles active={activeDays} onToggle={toggleTimetableDay} />

            {timetableDays.length === 0 ? (
              <p className="app-subtle-panel rounded-xl px-4 py-3 text-sm text-text-secondary">
                Pick a day above to start laying it out.
              </p>
            ) : (
              <div className="space-y-4">
                {timetableDays.map((weekday) => {
                  const daySessions = sessions.filter((session) => session.weekday === weekday);
                  const dayMinutes = daySessions.reduce(
                    (total, session) => total + clampPlanMinutes(session.minutes),
                    0
                  );
                  return (
                    <section
                      key={weekday}
                      aria-label={PLAN_WEEKDAY_FULL_LABELS[weekday]}
                      className="rounded-2xl border border-[var(--color-border)] p-3 transition duration-normal hover:border-[var(--color-border-strong)] sm:p-4"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h4 className="text-sm font-semibold text-text-primary">
                          {PLAN_WEEKDAY_FULL_LABELS[weekday]}
                        </h4>
                        <p className="text-2xs text-text-muted">
                          {daySessions.length} session{daySessions.length === 1 ? "" : "s"} ·{" "}
                          {dayMinutes} min
                        </p>
                      </div>

                      <ul className="app-rise mt-3 space-y-2">
                        {daySessions.map((session) => (
                          <SessionRow
                            key={session.id}
                            session={session}
                            scopeOptions={scopeOptions}
                            canRemove={daySessions.length > 1}
                            onChange={(next) => updateSession(session.id, next)}
                            onRemove={() => removeSession(session.id)}
                          />
                        ))}
                      </ul>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={daySessions.length >= PLAN_MAX_SESSIONS_PER_DAY}
                          onClick={() => addSession(weekday)}
                        >
                          Add a session
                        </Button>
                        {timetableDays.length > 1 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => copyDayToRest(weekday)}
                          >
                            Copy to other days
                          </Button>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionLabel title="How long it runs" />
        {/* Its own container, so the two fields go side by side when there is
            room for them rather than when the window is wide -- which is how
            they came to overlap inside a narrower panel on a tablet. */}
        <div className="plan-dates-layout">
          <div className="plan-dates-grid grid gap-3">
            <DateField
              label="Starts"
              value={startDayKey}
              placeholder="Choose a date"
              onValueChange={setStartDayKey}
            />
            <DateField
              label="Finishes"
              value={endDayKey}
              min={startDayKey}
              placeholder="Choose a date"
              onValueChange={setEndDayKey}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <SectionLabel title="Exams to count down to" />
        <PlanExamsEditor
          exams={exams}
          subjects={scopeOptions}
          defaultDayKey={endDayKey}
          onChange={setExams}
        />
      </section>

      <SettingSwitch
        label="Let Jami fill my free sessions"
        description={
          autoFill
            ? "Jami keeps this week and next filled from your usual week, with tasks from your recent work. You can change any of them."
            : "Free sessions stay free until you fill them, or ask Jami to."
        }
        checked={autoFill}
        onChange={setAutoFill}
      />

      {problems.length > 0 ? (
        <ul className="space-y-1.5">
          {problems.map((problem) => (
            <li key={problem} className="text-sm leading-6 text-text-secondary">
              {PLAN_PROBLEM_MESSAGES[problem]}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:justify-end">
        {onBack ? (
          <Button
            type="button"
            variant="secondary"
            className="sm:mr-auto"
            onClick={() => onBack(draft)}
          >
            {backLabel}
          </Button>
        ) : null}
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={!valid || saving}
          onClick={() => onSave(draft)}
        >
          {saving ? "Saving…" : (submitLabel ?? (initial ? "Save changes" : "Start this plan"))}
        </Button>
      </div>
    </div>
  );
}
