"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  Button,
  DateField,
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  Input,
  JamiTutorIcon,
  OptionSwitch,
  Select,
  SettingSwitch,
} from "@/components/ui";
import type { PlannerActivityInput } from "@/hooks/usePlanEdits";
import {
  DEFAULT_PLAN_ACTIVITY_MINUTES,
  MAX_PLAN_ACTIVITY_TITLE_LENGTH,
  PLAN_ACTIVITY_METHOD_LABELS,
  clampActivityMinutes,
  cleanActivityTitle,
} from "@/lib/planning/plan-activities";
import { longPlanDate, shortPlanDate } from "@/lib/planning/plan-format";
import type { PlanActivityPatch } from "@/lib/planning/timetable-ops";
import type { TimetableActivity } from "@/lib/planning/timetable";
import { PLAN_ACTIVITY_METHODS, type PlanActivityMethod, type PlanActivityTopic } from "@/lib/planning/types";

/**
 * Adding or changing one activity, without a word to Jami.
 *
 * Everything about an activity is here: what it is, which subject, how it is
 * done, when, how long, and whether Jami may adapt it. A student who knows what
 * they want types it; one who would rather Jami chose picks a subject and lets
 * it -- the time is booked and Jami fills it from their recorded work. Moving
 * is changing the date; copying, removing and fixing are one tap each.
 */

const LENGTHS = [15, 20, 30, 45, 60, 90] as const;

export type PlanEditorSubject = { key: string; label: string };
export type PlanEditorTopic = { id: string; label: string; scopeKey: string };

export type PlanActivityEditorProps = {
  dayKey: string;
  /** Absent: adding a new activity to `dayKey`. */
  activity?: TimetableActivity;
  todayDayKey: string;
  subjects: readonly PlanEditorSubject[];
  topics: readonly PlanEditorTopic[];
  /** Whether Revision Sessions exist here, so "Revision session" is a method on offer. */
  revisionSessions: boolean;
  onClose: () => void;
  onAdd: (dayKey: string, input: PlannerActivityInput) => void;
  onSave: (dayKey: string, activity: TimetableActivity, patch: PlanActivityPatch & { dayKey?: string }) => void;
  onDuplicate: (dayKey: string, activity: TimetableActivity, toDayKey: string) => void;
  onRemove: (dayKey: string, activity: TimetableActivity) => void;
  onFill: (dayKey: string) => void;
};

function FieldLabel({ children }: { children: string }) {
  return <p className="mb-2 text-sm font-medium tracking-[0.01em] text-text-secondary">{children}</p>;
}

export default function PlanActivityEditor(props: PlanActivityEditorProps) {
  const { activity, dayKey, todayDayKey, subjects } = props;
  const editing = Boolean(activity);
  const free = Boolean(activity?.open);
  const [title, setTitle] = useState(activity?.title ?? "");
  // An activity keeps the subject it has, none included; only a new one starts on the plan's first subject.
  const [scopeKey, setScopeKey] = useState(activity ? (activity.scopeKey ?? "") : (subjects[0]?.key ?? ""));
  const [method, setMethod] = useState<PlanActivityMethod>(activity && !activity.open ? activity.method : "practice");
  const [topicId, setTopicId] = useState(activity?.topic?.kind === "topic" ? activity.topic.id : "");
  const [date, setDate] = useState(dayKey);
  const [time, setTime] = useState(activity?.startTime ?? "");
  const [minutes, setMinutes] = useState(activity?.minutes ?? DEFAULT_PLAN_ACTIVITY_MINUTES);
  const [adaptive, setAdaptive] = useState(activity ? activity.mode === "adaptive" : false);
  const [picker, setPicker] = useState<"me" | "jami">("me");

  const methods = PLAN_ACTIVITY_METHODS.filter((value) => value !== "revision" || props.revisionSessions || method === "revision");
  const subjectTopics = useMemo(() => props.topics.filter((topic) => topic.scopeKey === scopeKey), [props.topics, scopeKey]);
  const jamiPicks = !editing && picker === "jami" && Boolean(scopeKey);
  const cleanTitle = cleanActivityTitle(title);
  const titleChanged = editing && !free && cleanTitle !== activity?.title;
  const taskChanged =
    !free &&
    editing &&
    (titleChanged || method !== activity?.method || (topicId || "") !== (activity?.topic?.kind === "topic" ? activity.topic.id : ""));
  const canSave = jamiPicks || Boolean(cleanTitle) || free;
  const past = date < todayDayKey;

  const topic: PlanActivityTopic | undefined = (() => {
    const chosen = subjectTopics.find((candidate) => candidate.id === topicId);
    return chosen ? { kind: "topic", id: chosen.id, label: chosen.label } : undefined;
  })();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const length = clampActivityMinutes(minutes);
    if (!activity) {
      props.onAdd(date, {
        title: cleanTitle,
        method,
        minutes: length,
        ...(time ? { startTime: time } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        ...(topic ? { topic } : {}),
        mode: adaptive ? "adaptive" : "fixed",
        ...(jamiPicks ? { jamiPicks: true } : {}),
      });
      props.onClose();
      return;
    }
    const patch: PlanActivityPatch & { dayKey?: string } = {};
    if (length !== activity.minutes) patch.minutes = length;
    if ((time || undefined) !== activity.startTime) patch.startTime = time || null;
    if ((scopeKey || undefined) !== activity.scopeKey) patch.scopeKey = scopeKey || null;
    if (free && cleanTitle) {
      patch.title = cleanTitle;
      patch.method = method;
      if (topic) patch.topic = topic;
    } else if (taskChanged) {
      patch.title = cleanTitle;
      patch.method = method;
      patch.topic = topic ?? null;
    }
    // Changing what it is makes it the student's; otherwise the switch says how it may change.
    if (!taskChanged && !free && (adaptive ? "adaptive" : "fixed") !== activity.mode) patch.mode = adaptive ? "adaptive" : "fixed";
    if (date !== dayKey) patch.dayKey = date;
    props.onSave(dayKey, activity, patch);
    props.onClose();
  };

  const heading = !activity ? `Add to ${longPlanDate(dayKey)}` : free ? "Free session" : "Edit activity";
  const quiet = "text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 rounded-lg px-2 py-1";

  return (
    <Dialog open className="fixed inset-0 flex items-end justify-center p-0 sm:items-center sm:p-4" onDismiss={props.onClose}>
      <DialogBackdrop className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
      <DialogPanel className="app-panel relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 shadow-e3 sm:rounded-2xl sm:p-6">
        <form onSubmit={submit} className="space-y-5">
          <div>
            <DialogTitle className="text-xl font-semibold text-text-primary">{heading}</DialogTitle>
            <DialogDescription className="mt-1.5 text-sm leading-6 text-text-secondary">
              {free
                ? "Time from your usual week with nothing in it yet. Let Jami pick something from your work, or say what it's for."
                : activity?.origin === "jami" && activity.mode === "adaptive"
                  ? "Jami picked this from your recent work and may suggest something better as you go. Change what it is and it becomes yours, fixed."
                  : editing
                    ? "Change anything. Move it by changing the date."
                    : "Say what you'll do, or let Jami pick it from your recent work."}
            </DialogDescription>
          </div>

          <Select label="Subject" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)}>
            <option value="">No subject</option>
            {subjects.map((subject) => (
              <option key={subject.key} value={subject.key}>
                {subject.label}
              </option>
            ))}
          </Select>

          {!editing && scopeKey ? (
            <OptionSwitch
              label="Who chooses the task"
              hideLabel
              value={picker}
              columns={2}
              onChange={setPicker}
              options={[
                { value: "me", label: "I'll choose", detail: "Say exactly what you'll do." },
                { value: "jami", label: "Let Jami pick", detail: "From your recent work, kept current." },
              ]}
            />
          ) : null}

          {jamiPicks ? (
            <p className="flex items-start gap-2 rounded-xl border border-warm-border bg-warm-glow px-3 py-2.5 text-sm leading-6 text-text-secondary">
              <JamiTutorIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-warm-accent" />
              Jami will put a real task here from what your recent answers say needs work, and suggest a better one if that changes.
            </p>
          ) : (
            <>
              <Input
                label="What you'll do"
                value={title}
                maxLength={MAX_PLAN_ACTIVITY_TITLE_LENGTH}
                placeholder={free ? "e.g. Homeostasis questions" : "e.g. 10 algebra questions, finish my homework"}
                onChange={(event) => setTitle(event.target.value)}
              />
              <div>
                <FieldLabel>How</FieldLabel>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How you'll do it">
                  {methods.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={method === value}
                      onClick={() => setMethod(value)}
                      className={`min-h-9 rounded-full border px-3 text-xs font-semibold transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                        method === value ? "app-selected" : "app-chip"
                      }`}
                    >
                      {PLAN_ACTIVITY_METHOD_LABELS[value]}
                    </button>
                  ))}
                </div>
              </div>
              {subjectTopics.length > 0 ? (
                <Select label="Topic (optional)" value={topicId} onChange={(event) => setTopicId(event.target.value)}>
                  <option value="">Any topic</option>
                  {subjectTopics.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              ) : null}
            </>
          )}

          <div className="plan-dates-layout">
            <div className="plan-dates-grid grid gap-3">
              <DateField label="Day" value={date} min={editing ? undefined : todayDayKey} onValueChange={(value) => value && setDate(value)} />
              <DateField type="time" label="Starts" value={time} placeholder="Any time" onValueChange={setTime} />
            </div>
          </div>
          {past && !editing ? <p className="-mt-3 text-xs text-[var(--color-error-text)]">Pick today or a day to come.</p> : null}

          <div>
            <FieldLabel>How long</FieldLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              {LENGTHS.map((length) => (
                <button
                  key={length}
                  type="button"
                  aria-pressed={minutes === length}
                  onClick={() => setMinutes(length)}
                  className={`min-h-9 rounded-full border px-3 text-xs font-semibold tabular-nums transition duration-fast ${
                    minutes === length ? "app-selected" : "app-chip"
                  }`}
                >
                  {length} min
                </button>
              ))}
              <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-text-muted">
                <span className="sr-only">Minutes</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={240}
                  value={minutes}
                  onChange={(event) => setMinutes(Number(event.target.value))}
                  className="app-field h-9 w-16 rounded-lg px-2 text-center text-xs tabular-nums"
                />
                min
              </label>
            </div>
          </div>

          {!jamiPicks && !free && scopeKey ? (
            <SettingSwitch
              label="Let Jami adapt this"
              description={
                adaptive
                  ? "Jami may suggest better work here as your progress changes. You see every suggestion first."
                  : "It stays exactly as you set it."
              }
              checked={adaptive && !taskChanged}
              disabled={taskChanged}
              onChange={setAdaptive}
              density="compact"
            />
          ) : null}

          <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-center">
            {activity ? (
              <div className="flex flex-wrap items-center gap-1 sm:mr-auto">
                {free && activity.scopeKey ? (
                  <button
                    type="button"
                    onClick={() => {
                      props.onFill(dayKey);
                      props.onClose();
                    }}
                    className={`${quiet} inline-flex items-center gap-1.5 text-[var(--color-accent)] hover:bg-[var(--color-glass-subtle)]`}
                  >
                    <JamiTutorIcon className="h-3.5 w-3.5" />
                    Let Jami pick
                  </button>
                ) : null}
                {!free ? (
                  <button
                    type="button"
                    onClick={() => {
                      props.onDuplicate(dayKey, activity, date);
                      props.onClose();
                    }}
                    className={`${quiet} text-text-secondary hover:bg-[var(--color-glass-subtle)] hover:text-text-primary`}
                  >
                    {date === dayKey ? "Duplicate" : `Copy to ${shortPlanDate(date)}`}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    props.onRemove(dayKey, activity);
                    props.onClose();
                  }}
                  className={`${quiet} text-[var(--color-error-text)] hover:bg-[var(--color-glass-subtle)]`}
                >
                  Remove
                </button>
              </div>
            ) : null}
            <Button type="button" variant="secondary" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || (past && !editing)}>
              {activity ? "Save" : jamiPicks ? "Add Jami's pick" : "Add"}
            </Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  );
}
