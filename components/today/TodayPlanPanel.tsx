"use client";

import { useMemo, useState } from "react";
import PlanActivityEditor, { type PlanEditorTopic } from "@/components/planning/PlanActivityEditor";
import { PlanActivityRow } from "@/components/planning/PlanActivityItem";
import { Button, JamiTutorIcon } from "@/components/ui";
import { JAMI_FILL_LABEL } from "@/hooks/usePlanAutoFill";
import { usePlanEdits } from "@/hooks/usePlanEdits";
import type { RevisionPlanTodayState } from "@/hooks/useRevisionPlanToday";
import { featureFlags } from "@/lib/app/feature-flags";
import { getGoalDisplayName, type Goal } from "@/lib/goals/model";
import { planScopeColor } from "@/lib/planning/plan-colors";
import { planRefreshSuggestions } from "@/lib/planning/plan-drafting";
import { formatPlanMinutes } from "@/lib/planning/plan-format";
import { planActivityGoal } from "@/lib/planning/plan-goals";
import { timetableUpNext, type TimetableActivity, type TimetableDay } from "@/lib/planning/timetable";
import { planScopeKey, type RevisionPlan } from "@/lib/planning/types";

/**
 * Today's part of the revision plan, as one contained list.
 *
 * Exactly what was planned for today -- the student's own tasks where they put
 * them, Jami's picks as it put them there -- with the next one to do lit and
 * its Start button beside it. Free time from the usual week says so, with the
 * way to fill it. Everything the planner can do to a day, Today can do to
 * today, through the same edits.
 */

type Props = {
  planToday: RevisionPlanTodayState;
  folders: readonly { id: string; name: string; topicIds?: readonly string[] }[];
  topics: readonly { id: string; name: string }[];
  /** Running goals, so a task can say which one doing it moves. */
  goals?: readonly Goal[];
};

function summary(day: TimetableDay) {
  if (day.taskCount === 0) return day.openCount > 0 ? `${day.openCount} free · ${formatPlanMinutes(day.minutes)}` : null;
  if (day.doneCount >= day.taskCount) return "All done";
  if (day.doneCount > 0) return `${day.doneCount} of ${day.taskCount} done`;
  return `${day.taskCount} ${day.taskCount === 1 ? "task" : "tasks"} · about ${formatPlanMinutes(day.minutes)}`;
}

function TodayPlanDay({ planToday, folders, topics, goals = [], plan, day }: Props & { plan: RevisionPlan; day: TimetableDay }) {
  const { scopeNames, timetable, drafting, todayDayKey } = planToday;
  const edits = usePlanEdits({ plan, timetable, days: [day], drafting, todayDayKey, changePlan: planToday.changePlan });
  const [editing, setEditing] = useState<{ activity?: TimetableActivity } | null>(null);
  const upNext = timetableUpNext(day);
  const suggestions = useMemo(
    () =>
      drafting.context
        ? new Map(
            planRefreshSuggestions({ days: [day], actionsByScope: drafting.context.actionsByScope, answeredScopes: drafting.answered }).map(
              (suggestion) => [suggestion.activityId, suggestion]
            )
          )
        : new Map(),
    [day, drafting.answered, drafting.context]
  );
  const subjects = useMemo(() => {
    const inPlan = new Set(plan.scopes.map(planScopeKey));
    return [...scopeNames]
      .map(([key, label]) => ({ key, label }))
      .sort((left, right) => Number(inPlan.has(right.key)) - Number(inPlan.has(left.key)));
  }, [plan.scopes, scopeNames]);
  const editorTopics = useMemo<PlanEditorTopic[]>(() => {
    const names = new Map(topics.map((topic) => [topic.id, topic.name]));
    return folders.flatMap((folder) =>
      (folder.topicIds ?? []).flatMap((id) => {
        const label = names.get(id);
        return label ? [{ id, label, scopeKey: `folder:${folder.id}` }] : [];
      })
    );
  }, [folders, topics]);
  const line = summary(day);

  return (
    <section aria-labelledby="today-plan-title" className="app-panel rounded-3xl p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 px-1 pb-3">
        <h2 id="today-plan-title" className="text-base font-bold tracking-tight text-text-primary">
          Today&rsquo;s plan
        </h2>
        {line ? <span className="text-xs tabular-nums text-text-muted">{line}</span> : null}
      </div>

      {day.exams.map((exam) => (
        <p key={exam.id} className="app-warning mb-3 rounded-2xl px-4 py-2.5 text-sm font-semibold">
          Exam today · {exam.label}
        </p>
      ))}

      {day.activities.length === 0 ? (
        <p className="px-1 text-sm leading-6 text-text-secondary">
          Nothing planned today. Rest counts — or add something, or pick from what Jami suggests below.
        </p>
      ) : (
        <ol className="space-y-1">
          {day.activities.map((activity) => {
            const suggestion = suggestions.get(activity.id);
            const goal = planActivityGoal(activity, goals);
            return (
              <PlanActivityRow
                key={activity.id}
                activity={activity}
                subject={activity.scopeKey ? scopeNames.get(activity.scopeKey) : undefined}
                color={activity.scopeKey ? planScopeColor(plan, activity.scopeKey) : "var(--color-text-muted)"}
                canTick
                upNext={activity.id === upNext?.id}
                {...(goal ? { goal: getGoalDisplayName(goal) } : {})}
                {...(suggestion ? { suggestion, onAcceptSuggestion: () => edits.ops.acceptSuggestion(suggestion) } : {})}
                onOpen={() => setEditing({ activity })}
                onToggle={(done) => edits.ops.toggleDone(day, activity.id, done)}
                onFill={() => edits.ops.fill([day.dayKey])}
                onKeep={() => edits.ops.setMode(day.dayKey, activity.id, "fixed")}
              />
            );
          })}
        </ol>
      )}

      {timetable.undoLabel === JAMI_FILL_LABEL ? (
        // Said, not done quietly: the student sees that Jami put these here.
        <p className="mt-3 flex items-center gap-2 px-1 text-xs text-text-muted" role="status">
          <JamiTutorIcon className="h-3 w-3 shrink-0 text-warm-accent" />
          Jami filled your free time from your recent work. Change anything, or undo it.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
        <Button type="button" size="sm" variant="secondary" onClick={() => setEditing({})}>
          Add to today
        </Button>
        {timetable.undoLabel ? (
          <Button type="button" size="sm" variant="ghost" onClick={timetable.undo} aria-label={`Undo ${timetable.undoLabel}`}>
            Undo
          </Button>
        ) : null}
        {timetable.problem ? (
          <p className="text-xs text-[var(--color-error-text)]" role="alert">
            {timetable.problem}
          </p>
        ) : null}
      </div>

      {editing ? (
        <PlanActivityEditor
          key={editing.activity?.id ?? "new"}
          dayKey={day.dayKey}
          {...(editing.activity ? { activity: editing.activity } : {})}
          todayDayKey={todayDayKey}
          subjects={subjects}
          topics={editorTopics}
          revisionSessions={featureFlags.enableRevisionSessions}
          onClose={() => setEditing(null)}
          onAdd={(dayKey, activity) => edits.ops.add(dayKey, activity)}
          onSave={(dayKey, activity, patch) => edits.ops.update(dayKey, activity, patch)}
          onDuplicate={(dayKey, activity, toDayKey) => edits.ops.duplicate(dayKey, activity.id, toDayKey)}
          onRemove={(dayKey, activity) => edits.ops.remove(dayKey, activity.id)}
          onFill={(dayKey) => edits.ops.fill([dayKey])}
        />
      ) : null}
    </section>
  );
}

export default function TodayPlanPanel(props: Props) {
  const { plan, today } = props.planToday;
  if (!plan || !today) return null;
  return <TodayPlanDay {...props} plan={plan} day={today} />;
}
