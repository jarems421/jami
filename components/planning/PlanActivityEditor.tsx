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
  Select,
  SettingSwitch,
} from "@/components/ui";
import PlanJamiNote from "@/components/planning/PlanJamiNote";
import type { PlanEditOutcome, PlannerActivityInput } from "@/hooks/usePlanEdits";
import { usePlanNotebookOptions } from "@/hooks/usePlanNotebookOptions";
import {
  DEFAULT_PLAN_ACTIVITY_MINUTES,
  MAX_PLAN_ACTIVITY_TITLE_LENGTH,
  PLAN_ACTIVITY_METHOD_LABELS,
  clampActivityMinutes,
  cleanActivityTitle,
  defaultPlanActivityTitle,
} from "@/lib/planning/plan-activities";
import { planFillNotice } from "@/lib/planning/plan-drafting";
import { longPlanDate, shortPlanDate } from "@/lib/planning/plan-format";
import type { PlanActivityPatch } from "@/lib/planning/timetable-ops";
import type { TimetableActivity } from "@/lib/planning/timetable";
import { PLAN_ACTIVITY_METHODS, type PlanActivityMethod, type PlanActivityTopic } from "@/lib/planning/types";

/**
 * Adding or changing one activity, without a word to Jami.
 *
 * In the order a student thinks it: what kind of work, what it is about, when
 * and for how long. Every kind is one tap, Jami's pick among them, and nothing
 * else is required -- "Notebook work, 30 minutes" is a whole plan, named after
 * its notebook or simply "Notebook work". Notebook work can name the notebook,
 * which then offers the session to start and finish inside it. When Jami is
 * asked to pick and has nothing to pick from, it says so here, and the time can
 * be kept free or given a task instead.
 */

const LENGTHS = [15, 20, 30, 45, 60, 90] as const;

const KIND_DETAILS: Record<PlanActivityMethod, string> = {
  practice: "Answer questions",
  flashcards: "Review your cards",
  revision: "A lesson with Jami",
  notebook: "Work in a notebook",
  notes: "Read over your notes",
  other: "Anything else",
};

type Kind = PlanActivityMethod | "jami";

export type PlanEditorSubject = { key: string; label: string };
export type PlanEditorTopic = { id: string; label: string; scopeKey: string };

export type PlanActivityEditorProps = {
  uid: string;
  dayKey: string;
  /** Absent: adding a new activity to `dayKey`. */
  activity?: TimetableActivity;
  todayDayKey: string;
  subjects: readonly PlanEditorSubject[];
  topics: readonly PlanEditorTopic[];
  /** Whether Revision Sessions exist here, so "Revision session" is a kind on offer. */
  revisionSessions: boolean;
  onClose: () => void;
  onAdd: (dayKey: string, input: PlannerActivityInput) => Promise<PlanEditOutcome>;
  onSave: (dayKey: string, activity: TimetableActivity, patch: PlanActivityPatch & { dayKey?: string }) => void;
  onDuplicate: (dayKey: string, activity: TimetableActivity, toDayKey: string) => void;
  onRemove: (dayKey: string, activity: TimetableActivity) => void;
};

function FieldLabel({ children }: { children: string }) {
  return <p className="mb-2 text-sm font-medium tracking-[0.01em] text-text-secondary">{children}</p>;
}

function KindTile({ kind, selected, onSelect }: { kind: Kind; selected: boolean; onSelect: () => void }) {
  const label = kind === "jami" ? "Jami picks" : PLAN_ACTIVITY_METHOD_LABELS[kind];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onSelect}
      className={`flex min-h-[4.25rem] flex-col items-start justify-center gap-0.5 rounded-2xl border px-3.5 py-2.5 text-left transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
        selected
          ? kind === "jami"
            ? "border-warm-border bg-warm-glow text-text-primary"
            : "app-selected"
          : "border-[var(--color-border)] bg-[var(--color-glass-subtle)] text-text-primary hover:border-[var(--color-border-strong)]"
      }`}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold leading-snug">
        {kind === "jami" ? <JamiTutorIcon className="h-3.5 w-3.5 shrink-0 text-warm-accent" /> : null}
        {label}
      </span>
      <span className="text-2xs leading-4 text-text-muted">{kind === "jami" ? "From your recent work" : KIND_DETAILS[kind]}</span>
    </button>
  );
}

export default function PlanActivityEditor(props: PlanActivityEditorProps) {
  const { activity, dayKey, todayDayKey, subjects } = props;
  const editing = Boolean(activity);
  const free = Boolean(activity?.open);
  const [kind, setKind] = useState<Kind>(() =>
    activity && !activity.open ? activity.method : subjects.length > 0 || activity?.scopeKey ? "jami" : "other"
  );
  const [title, setTitle] = useState(activity?.open ? "" : (activity?.title ?? ""));
  // An activity keeps the subject it has, none included; only a new one starts on the plan's first subject.
  const [scopeKey, setScopeKey] = useState(activity ? (activity.scopeKey ?? "") : (subjects[0]?.key ?? ""));
  const [topicId, setTopicId] = useState(activity?.topic?.kind === "topic" ? activity.topic.id : "");
  const [notebookId, setNotebookId] = useState(activity?.notebookId ?? "");
  const [date, setDate] = useState(dayKey);
  const [time, setTime] = useState(activity?.startTime ?? "");
  const [minutes, setMinutes] = useState(activity?.minutes ?? DEFAULT_PLAN_ACTIVITY_MINUTES);
  const [adaptive, setAdaptive] = useState(activity ? activity.mode === "adaptive" && !activity.open : false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [nothingToPick, setNothingToPick] = useState("");

  const notebooks = usePlanNotebookOptions(props.uid, kind === "notebook");
  const jami = kind === "jami";
  const method: PlanActivityMethod = jami ? "other" : kind;
  const kinds: Kind[] = [
    ...(!editing || free ? (["jami"] as const) : []),
    ...PLAN_ACTIVITY_METHODS.filter((value) => value !== "revision" || props.revisionSessions || kind === "revision"),
  ];
  const subjectName = (key: string) => subjects.find((subject) => subject.key === key)?.label ?? "that subject";
  const subjectTopics = useMemo(() => props.topics.filter((topic) => topic.scopeKey === scopeKey), [props.topics, scopeKey]);
  const folderId = scopeKey.startsWith("folder:") ? scopeKey.slice(7) : "";
  const notebookChoices = (notebooks ?? []).filter((notebook) => !folderId || notebook.folderId === folderId);
  const chosenNotebook = (notebooks ?? []).find((notebook) => notebook.id === notebookId);

  const topic: PlanActivityTopic | undefined = (() => {
    const chosen = subjectTopics.find((candidate) => candidate.id === topicId);
    return chosen ? { kind: "topic", id: chosen.id, label: chosen.label } : undefined;
  })();
  const fallbackTitle =
    method === "notebook" && notebookId && !chosenNotebook && activity?.notebookId === notebookId
      ? activity.title
      : defaultPlanActivityTitle({ method, ...(topic ? { topic } : {}), ...(chosenNotebook ? { notebookTitle: chosenNotebook.title } : {}) });
  const finalTitle = cleanActivityTitle(title) || fallbackTitle;
  const notebookChosen = method === "notebook" && notebookId ? notebookId : undefined;
  const taskChanged =
    editing &&
    !free &&
    !jami &&
    (finalTitle !== activity?.title ||
      method !== activity?.method ||
      (topicId || "") !== (activity?.topic?.kind === "topic" ? activity.topic.id : "") ||
      (notebookChosen ?? "") !== (activity?.notebookId ?? ""));
  const past = date < todayDayKey;

  const chooseKind = (next: Kind) => {
    setKind(next);
    setProblem("");
    setNothingToPick("");
  };

  const pick = async (length: number) => {
    if (!scopeKey) {
      setProblem("Choose a subject for Jami to pick from.");
      return;
    }
    setBusy(true);
    const outcome = await props.onAdd(date, {
      title: "",
      method: "other",
      minutes: length,
      ...(time ? { startTime: time } : {}),
      scopeKey,
      mode: "adaptive",
      pick: "jami",
      // A free session handed to Jami is replaced by its pick, in one change.
      ...(free && activity ? { replacing: { dayKey, activityId: activity.id, ...(activity.routineId ? { routineId: activity.routineId } : {}) } } : {}),
    });
    setBusy(false);
    if (outcome.changed) {
      props.onClose();
      return;
    }
    setNothingToPick(planFillNotice({ picked: 0, unfilledScopeKeys: [scopeKey] }, subjectName) ?? "");
  };

  const keepFree = async () => {
    if (activity) {
      props.onClose();
      return;
    }
    await props.onAdd(date, {
      title: "",
      method: "other",
      minutes: clampActivityMinutes(minutes),
      ...(time ? { startTime: time } : {}),
      ...(scopeKey ? { scopeKey } : {}),
      mode: "adaptive",
      pick: "free",
    });
    props.onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (past && !editing) {
      setProblem("Pick today or a day to come.");
      return;
    }
    const length = clampActivityMinutes(minutes);
    if (jami) {
      await pick(length);
      return;
    }
    if (!activity) {
      setBusy(true);
      await props.onAdd(date, {
        title: finalTitle,
        method,
        minutes: length,
        ...(time ? { startTime: time } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        ...(topic ? { topic } : {}),
        ...(notebookChosen ? { notebookId: notebookChosen } : {}),
        mode: adaptive ? "adaptive" : "fixed",
      });
      setBusy(false);
      props.onClose();
      return;
    }
    const patch: PlanActivityPatch & { dayKey?: string } = {};
    if (length !== activity.minutes) patch.minutes = length;
    if ((time || undefined) !== activity.startTime) patch.startTime = time || null;
    if ((scopeKey || undefined) !== activity.scopeKey) patch.scopeKey = scopeKey || null;
    if (free || taskChanged) {
      patch.title = finalTitle;
      patch.method = method;
      patch.topic = topic ?? null;
      patch.notebookId = notebookChosen ?? null;
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
      <DialogPanel className="app-panel relative max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-b-none p-5 shadow-e3 sm:rounded-2xl sm:p-7">
        <form onSubmit={(event) => void submit(event)} className="space-y-6">
          <div>
            <DialogTitle className="text-xl font-semibold text-text-primary">{heading}</DialogTitle>
            <DialogDescription className="mt-1.5 text-sm leading-6 text-text-secondary">
              {free
                ? "Time from your usual week with nothing in it yet. Let Jami pick something from your work, or choose what it's for."
                : activity?.origin === "jami" && activity.mode === "adaptive"
                  ? "Jami picked this from your recent work and may suggest something better as you go. Change what it is and it becomes yours, fixed."
                  : editing
                    ? "Change anything. Move it by changing the day."
                    : "Choose the kind of work and when. Nothing else is needed."}
            </DialogDescription>
          </div>

          <div>
            <FieldLabel>What kind of work</FieldLabel>
            <div role="radiogroup" aria-label="What kind of work" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {kinds.map((value) => (
                <KindTile key={value} kind={value} selected={kind === value} onSelect={() => chooseKind(value)} />
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <Select
              label="Subject"
              value={scopeKey}
              onChange={(event) => {
                setScopeKey(event.target.value);
                setTopicId("");
                setProblem("");
                setNothingToPick("");
              }}
            >
              <option value="">{jami ? "Choose a subject" : "No subject"}</option>
              {subjects.map((subject) => (
                <option key={subject.key} value={subject.key}>
                  {subject.label}
                </option>
              ))}
            </Select>

            {jami && !nothingToPick ? (
              <PlanJamiNote>
                Jami puts a real task here from what your recent work says needs it, and suggests a better one if that changes.
              </PlanJamiNote>
            ) : jami ? null : (
              <>
                {method === "notebook" ? (
                  <Select
                    label="Which notebook"
                    value={notebookId}
                    onChange={(event) => {
                      const next = event.target.value;
                      setNotebookId(next);
                      // A notebook belongs to a folder: choosing it says the subject too.
                      const owner = (notebooks ?? []).find((notebook) => notebook.id === next);
                      const ownerKey = owner ? `folder:${owner.folderId}` : "";
                      if (ownerKey && ownerKey !== scopeKey && subjects.some((subject) => subject.key === ownerKey)) setScopeKey(ownerKey);
                    }}
                  >
                    <option value="">{folderId ? `Any notebook in ${subjectName(scopeKey)}` : "Any notebook"}</option>
                    {notebooks === null ? (
                      <option disabled value="loading">
                        Loading your notebooks…
                      </option>
                    ) : null}
                    {notebookId && !chosenNotebook && activity?.notebookId === notebookId ? (
                      <option value={notebookId}>{activity.title}</option>
                    ) : null}
                    {notebookChoices.map((notebook) => (
                      <option key={notebook.id} value={notebook.id}>
                        {folderId ? notebook.title : `${notebook.title} · ${subjectName(`folder:${notebook.folderId}`)}`}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {subjectTopics.length > 0 && method !== "other" ? (
                  <Select label="Topic (optional)" value={topicId} onChange={(event) => setTopicId(event.target.value)}>
                    <option value="">Any topic</option>
                    {subjectTopics.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : null}
                <Input
                  label="What you'll do (optional)"
                  value={title}
                  maxLength={MAX_PLAN_ACTIVITY_TITLE_LENGTH}
                  placeholder={method === "other" ? "e.g. Finish my homework" : fallbackTitle}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </>
            )}
          </div>

          <div className="space-y-4">
            <div className="plan-dates-layout">
              <div className="plan-dates-grid grid gap-3">
                <DateField label="Day" value={date} min={editing ? undefined : todayDayKey} onValueChange={(value) => value && setDate(value)} />
                <DateField type="time" label="Starts" value={time} placeholder="Any time" onValueChange={setTime} />
              </div>
            </div>
            <div>
              <FieldLabel>How long</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                {LENGTHS.map((length) => (
                  <button
                    key={length}
                    type="button"
                    aria-pressed={minutes === length}
                    onClick={() => setMinutes(length)}
                    className={`min-h-10 rounded-full border px-3.5 text-sm font-semibold tabular-nums transition duration-fast ${
                      minutes === length ? "app-selected" : "app-chip"
                    }`}
                  >
                    {length} min
                  </button>
                ))}
                <label className="ml-1 inline-flex items-center gap-1.5 text-sm text-text-muted">
                  <span className="sr-only">Minutes</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={5}
                    max={240}
                    value={minutes}
                    onChange={(event) => setMinutes(Number(event.target.value))}
                    className="app-field h-10 w-16 rounded-lg px-2 text-center text-sm tabular-nums"
                  />
                  min
                </label>
              </div>
            </div>
          </div>

          {!jami && !free && scopeKey ? (
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

          {nothingToPick ? (
            <PlanJamiNote>
              <p>{nothingToPick}</p>
              <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void keepFree()}>
                {free ? "Leave it free" : "Keep it as free time"}
              </Button>
            </PlanJamiNote>
          ) : null}
          {problem ? (
            <p role="alert" className="text-sm text-[var(--color-error-text)]">
              {problem}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-center">
            {activity ? (
              <div className="flex flex-wrap items-center gap-1 sm:mr-auto">
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
            <Button type="submit" disabled={busy}>
              {busy && jami ? "Jami is choosing…" : jami ? (free ? "Let Jami pick" : "Add Jami's pick") : activity ? "Save" : "Add"}
            </Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  );
}
