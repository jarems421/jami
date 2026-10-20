"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, DialogBackdrop, DialogPanel, DialogTitle, FeedbackBanner, JamiTutorIcon, Skeleton } from "@/components/ui";
import PlanActivityEditor, { type PlanEditorSubject, type PlanEditorTopic } from "@/components/planning/PlanActivityEditor";
import PlanDayView, { type PlanDayHandlers } from "@/components/planning/PlanDayView";
import PlanGoals from "@/components/planning/PlanGoals";
import PlanHeader from "@/components/planning/PlanHeader";
import PlanJamiNote from "@/components/planning/PlanJamiNote";
import PlanMonthView from "@/components/planning/PlanMonthView";
import PlanSettingsDialog from "@/components/planning/PlanSettingsDialog";
import PlanSummaryBar from "@/components/planning/PlanSummaryBar";
import PlanWeekView from "@/components/planning/PlanWeekView";
import PlanWithJami from "@/components/planning/PlanWithJami";
import type { PlanScopeOption } from "@/components/planning/RevisionPlanBuilder";
import { JAMI_FILL_LABEL } from "@/hooks/usePlanAutoFill";
import type { PlanEditOutcome } from "@/hooks/usePlanEdits";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePlanInterview, type PlanAssistantProposal } from "@/hooks/usePlanInterview";
import { useRevisionPlanner } from "@/hooks/useRevisionPlanner";
import type { PlanNotice } from "@/lib/ai/assistant-plan";
import { featureFlags } from "@/lib/app/feature-flags";
import { getGoalDisplayName, type Goal } from "@/lib/goals/model";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import { planScopeColor } from "@/lib/planning/plan-colors";
import { planCountdown, planWeekOfPlan } from "@/lib/planning/plan-countdown";
import { planFillNotice } from "@/lib/planning/plan-drafting";
import { planActivityGoal } from "@/lib/planning/plan-goals";
import { describePlanShapeChanges } from "@/lib/planning/plan-interview";
import { MAX_PLAN_FILL_DAYS, summarizePlanProposal } from "@/lib/planning/plan-proposal";
import {
  planDayKeysBetween,
  planDaysBetween,
  planSessionsOn,
  planWeekdayOf,
} from "@/lib/planning/plan-schedule";
import { plannerStep, plannerTitle } from "@/lib/planning/planner-view";
import { timetableUpNext, type TimetableActivity } from "@/lib/planning/timetable";
import {
  PLAN_WEEKDAY_FULL_LABELS,
  type PlanActivity,
  type RevisionPlan,
  type RevisionPlanEntry,
} from "@/lib/planning/types";
import { getMinutesIntoLocalDay, shiftStudyDayKey } from "@/lib/study/day";
import { getActiveGoalsWithCurrentStatuses } from "@/services/study/goals";

/**
 * The revision planner: the student's timetable, with Jami beside it.
 *
 * One screen whether the plan is being built or is running. The timetable is
 * the centre of it, and every part of it can be changed directly -- added to,
 * edited, moved, copied, cleared, fixed -- without asking anybody. Jami sits
 * beside it (in a drawer on smaller screens) as an assistant: building a plan,
 * its questions fill the timetable in; running one, anything it would change
 * arrives as a proposal to apply or discard. Both make the same edits.
 */

const WIDE_LAYOUT_QUERY = "(min-width: 1280px)";

type EditorTarget = { dayKey: string; activity?: TimetableActivity };

export default function RevisionPlanner({
  uid,
  savedPlan,
  initialEntries,
  options,
  folders,
  decks,
  cards,
  topics,
  notices,
  onPlanSaved,
  onArchive,
}: {
  uid: string;
  savedPlan: RevisionPlan | null;
  initialEntries?: readonly RevisionPlanEntry[];
  options: readonly PlanScopeOption[];
  folders: readonly { id: string; name: string; examCourse?: unknown; topicIds?: readonly string[] }[];
  decks: readonly { id: string; folderIds?: readonly string[] }[];
  cards: readonly { id: string; deckId: string; topicIds?: readonly string[]; lastReview?: number }[];
  topics: readonly { id: string; name: string }[];
  notices: readonly PlanNotice[];
  onPlanSaved: (plan: RevisionPlan, days?: ReadonlyMap<string, PlanActivity[]>) => void;
  onArchive: () => void;
}) {
  const scopeNames = useMemo(() => new Map(options.map((option) => [option.key, option.label])), [options]);
  const interviewContext = useMemo(() => ({ notices, scopeNames }), [notices, scopeNames]);
  const promptDaysRef = useRef<ReturnType<typeof useRevisionPlanner>["promptDays"]>([]);
  const readPromptDays = useCallback(() => promptDaysRef.current, []);
  const [startFrom] = useState(() => (savedPlan ? normalizeRevisionPlanDraft(savedPlan).draft : undefined));
  const interview = usePlanInterview(interviewContext, {
    mode: savedPlan ? "change" : "build",
    timetable: readPromptDays,
    ...(startFrom ? { startFrom } : {}),
  });

  const { setDraft } = interview;
  const handleSaved = useCallback(
    (plan: RevisionPlan, days?: ReadonlyMap<string, PlanActivity[]>) => {
      onPlanSaved(plan, days);
      if (savedPlan) setDraft(normalizeRevisionPlanDraft(plan).draft);
    },
    [onPlanSaved, savedPlan, setDraft]
  );

  const planner = useRevisionPlanner({
    uid,
    savedPlan,
    ...(initialEntries ? { initialEntries } : {}),
    draft: interview.draft,
    onDraftChange: setDraft,
    onPlanSaved: handleSaved,
    folders,
    decks,
    cards,
  });
  useEffect(() => {
    promptDaysRef.current = planner.promptDays;
  }, [planner.promptDays]);

  /*
   * Running goals, read once: the goals card beside the plan, and the line on
   * a task saying which goal doing it moves. The planner draws without them.
   */
  const [goals, setGoals] = useState<readonly Goal[] | null>(null);
  const savedPlanId = savedPlan?.id;
  useEffect(() => {
    if (!savedPlanId) return;
    let live = true;
    void getActiveGoalsWithCurrentStatuses(uid).then(
      (loaded) => live && setGoals(loaded),
      () => live && setGoals([])
    );
    return () => {
      live = false;
    };
  }, [savedPlanId, uid]);

  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const asideRef = useRef<HTMLElement | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantCued, setAssistantCued] = useState(false);
  /*
   * Beside the timetable Jami is already open, so asking for it shows where:
   * the panel is brought into view, lit for a moment, and its first answer
   * (or the box to type in) takes the focus.
   */
  const openAssistant = () => {
    if (!wide) {
      setAssistantOpen(true);
      return;
    }
    const aside = asideRef.current;
    aside?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    const first = ["[data-plan-answers] input", "[data-plan-answers] button", "textarea"]
      .map((selector) => aside?.querySelector<HTMLElement>(selector))
      .find(Boolean);
    first?.focus({ preventScroll: true });
    setAssistantCued(true);
    window.setTimeout(() => setAssistantCued(false), 1600);
  };
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const { plan, view, anchor, days, todayDayKey, ops } = planner;
  const building = planner.mode === "draft";

  const scopeName = useCallback((scopeKey?: string) => (scopeKey ? scopeNames.get(scopeKey) : undefined), [scopeNames]);
  /** A fill that left time free says which subjects Jami had nothing for, instead of looking like a dead button. */
  const report = useCallback(
    (outcome: PlanEditOutcome) => setFillNote(planFillNotice(outcome, (scopeKey) => scopeNames.get(scopeKey) ?? "that subject")),
    [scopeNames]
  );
  const fill = (dayKeys: readonly string[], only?: readonly string[]) => {
    setFillNote(null);
    void ops.fill(dayKeys, only ? { only } : {}).then(report);
  };
  const scopeColor = useCallback(
    (scopeKey?: string) => (scopeKey ? planScopeColor(plan, scopeKey) : "var(--color-text-muted)"),
    [plan]
  );

  const editorSubjects = useMemo<PlanEditorSubject[]>(() => {
    const inPlan = new Set(plan.scopes.map((scope) => (scope.folderId ? `folder:${scope.folderId}` : `deck:${scope.deckId}`)));
    return [...options]
      .sort((left, right) => Number(inPlan.has(right.key)) - Number(inPlan.has(left.key)))
      .map((option) => ({ key: option.key, label: option.label }));
  }, [options, plan.scopes]);
  const editorTopics = useMemo<PlanEditorTopic[]>(() => {
    const names = new Map(topics.map((topic) => [topic.id, topic.name]));
    return folders.flatMap((folder) =>
      (folder.topicIds ?? []).flatMap((id) => {
        const label = names.get(id);
        return label ? [{ id, label, scopeKey: `folder:${folder.id}` }] : [];
      })
    );
  }, [folders, topics]);

  const today = days.find((day) => day.isToday);
  const upNextId = timetableUpNext(today)?.id;
  const handlers: PlanDayHandlers = {
    scopeName,
    scopeColor,
    suggestions: planner.suggestions,
    ...(upNextId ? { upNextId } : {}),
    onOpenDay: (dayKey) => {
      planner.setAnchor(dayKey);
      planner.setView("day");
    },
    onOpenActivity: (dayKey, activity) => setEditor({ dayKey, activity }),
    onAdd: (dayKey) => setEditor({ dayKey }),
    onToggle: (day, activity, done) => ops.toggleDone(day, activity.id, done),
    onFillDay: (dayKey) => fill([dayKey]),
    onPick: (dayKey, activity) => fill([dayKey], [activity.id]),
    onAcceptSuggestion: (suggestion) => ops.acceptSuggestion(suggestion),
    onKeep: (dayKey, activityId) => ops.setMode(dayKey, activityId, "fixed"),
    onClearDay: ops.clearDay,
    onResetDay: ops.resetDay,
    hasUsualWeek: (dayKey) => planSessionsOn(plan.sessions, dayKey).length > 0,
    goalFor: (activity) => {
      const goal = planActivityGoal(activity, goals ?? []);
      return goal ? getGoalDisplayName(goal) : undefined;
    },
  };

  /*
   * Filling more than a day: the free sessions in view, or every one from
   * today to the plan's end (six weeks at a time). The same fill as a day's,
   * and as undoable.
   */
  const fillable = days.filter((day) => !day.isPast && day.activities.some((activity) => activity.open && activity.scopeKey));
  const freeInView = fillable.reduce(
    (total, day) => total + day.activities.filter((activity) => activity.open && activity.scopeKey).length,
    0
  );
  const restFrom = planDaysBetween(todayDayKey, plan.startDayKey) > 0 ? plan.startDayKey : todayDayKey;
  const restTo = (() => {
    const cap = shiftStudyDayKey(restFrom, MAX_PLAN_FILL_DAYS - 1);
    return cap < plan.endDayKey ? cap : plan.endDayKey;
  })();
  const restIsWholePlan = restTo === plan.endDayKey;

  const describeProposal = useCallback(
    (proposal: PlanAssistantProposal) => {
      const summary = summarizePlanProposal(proposal.changes, {
        activityOf: (dayKey, activityId) =>
          days.find((day) => day.dayKey === dayKey)?.activities.find((activity) => activity.id === activityId),
        scopeName: (scopeKey) => scopeNames.get(scopeKey) ?? "A subject",
      });
      const planLines = proposal.plan && proposal.planBefore ? describePlanShapeChanges(proposal.planBefore, proposal.plan, scopeNames) : [];
      const headline =
        proposal.changes.length > 0
          ? planLines.length > 0
            ? `${summary.headline}, and your plan`
            : summary.headline
          : planLines.length === 1
            ? (planLines[0] as string)
            : "Changes to your plan";
      return { headline, lines: [...planLines, ...summary.lines] };
    },
    [days, scopeNames]
  );

  const assistant = (
    <PlanWithJami
      interview={interview}
      options={options}
      notices={notices}
      saving={planner.saving}
      canSave={planner.canSave}
      onSave={() => void planner.savePlan()}
      onOpenSettings={() => setSettingsOpen(true)}
      describeProposal={describeProposal}
      onApplyProposal={planner.applyProposal}
      onDiscardProposal={() => undefined}
    />
  );

  const week = planWeekOfPlan(plan, anchor);
  const month = anchor.slice(0, 7);
  const summaryDays = view === "month" ? days.filter((day) => day.dayKey.startsWith(month)) : days;
  const ownDays = days.some((day) => day.kind === "planned");
  const empty = building && !ownDays && plan.sessions.length === 0;
  // Between midnight and 4am the study day is still yesterday's (`lib/study/day.ts`), which the page says.
  const [lateNight] = useState(() => getMinutesIntoLocalDay(Date.now()) < 240);
  const selectedDay = days.find((day) => day.dayKey === anchor) ?? days[0];

  return (
    <div className="space-y-5 sm:space-y-6">
      <PlanHeader
        eyebrow={building ? "Building your plan" : `Week ${week.current} of ${week.total}`}
        title={building && plan.title === "Revision plan" ? "Your revision plan" : plan.title}
        rangeTitle={plannerTitle(view, anchor)}
        view={view}
        onViewChange={planner.setView}
        onPrevious={() => planner.setAnchor(plannerStep(view, anchor, -1))}
        onNext={() => planner.setAnchor(plannerStep(view, anchor, 1))}
        onToday={() => planner.setAnchor(todayDayKey)}
        showingToday={days.some((day) => day.isToday) && (view !== "day" || anchor === todayDayKey)}
        onOpenSettings={() => setSettingsOpen(true)}
        {...(!wide ? { onOpenAssistant: openAssistant } : {})}
        countdown={planCountdown(plan, todayDayKey)}
        scopeColor={scopeColor}
        {...(lateNight
          ? { note: `It's after midnight, so this is still ${PLAN_WEEKDAY_FULL_LABELS[planWeekdayOf(todayDayKey)]}'s plan until 4am.` }
          : {})}
      />

      {planner.problem ? <FeedbackBanner type="error" message={planner.problem} onDismiss={planner.clearProblem} /> : null}

      {/* Building, Jami's questions get the room their answers need; running, the timetable gets it back. */}
      <div className={`grid items-start gap-6 ${building ? "xl:grid-cols-[minmax(0,1fr)_27rem]" : "xl:grid-cols-[minmax(0,1fr)_23rem]"}`}>
        <div className="min-w-0 space-y-5">
          <section aria-label="Your timetable" className="app-panel relative p-2.5 sm:p-4">
            <div className="relative space-y-4">
              {empty ? (
                <div className="space-y-3 rounded-2xl border border-dashed border-[var(--color-border-strong)] px-5 py-6 text-center">
                  <h3 className="text-lg font-bold tracking-tight text-text-primary">Your timetable starts here</h3>
                  <p className="mx-auto max-w-md text-sm leading-6 text-text-secondary">
                    Add exactly what you want to any day, or tell Jami about your exams and your week and watch it
                    build one you can change.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2 pt-1">
                    <Button type="button" onClick={() => setEditor({ dayKey: todayDayKey })}>
                      Add a study session
                    </Button>
                    <Button type="button" variant="warm" onClick={openAssistant}>
                      <JamiTutorIcon className="mr-1.5 h-3.5 w-3.5" />
                      Plan with Jami
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setSettingsOpen(true)}>
                      Set your usual week
                    </Button>
                  </div>
                </div>
              ) : null}
              {!empty && (freeInView > 0 || plan.sessions.length > 0) ? (
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <p className="text-xs text-text-muted">
                    {freeInView > 0
                      ? `${freeInView} free ${freeInView === 1 ? "session" : "sessions"} here, nothing chosen yet`
                      : "Everything here is planned"}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {freeInView > 0 ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => fill(fillable.map((day) => day.dayKey))}>
                        <JamiTutorIcon className="mr-1.5 h-3.5 w-3.5 text-warm-accent" />
                        Let Jami fill them
                      </Button>
                    ) : null}
                    {plan.sessions.length > 0 && restFrom <= restTo ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => fill(planDayKeysBetween(restFrom, restTo, MAX_PLAN_FILL_DAYS))}
                      >
                        {restIsWholePlan ? "Fill the rest of the plan" : "Fill the next six weeks"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {fillNote ? <PlanJamiNote onDismiss={() => setFillNote(null)}>{fillNote}</PlanJamiNote> : null}
              {planner.loading ? (
                <Skeleton className="h-72 w-full rounded-2xl" />
              ) : view === "week" ? (
                <PlanWeekView days={days} handlers={handlers} />
              ) : view === "day" && selectedDay ? (
                <PlanDayView day={selectedDay} handlers={handlers} />
              ) : (
                <PlanMonthView days={days} month={month} scopeColor={scopeColor} onOpenDay={handlers.onOpenDay} />
              )}
            </div>
          </section>

          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <JamiTutorIcon className="h-3 w-3 text-warm-accent" />
              Jami&rsquo;s pick — may change as your work does, and you see every change first
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-3 w-4 rounded border border-dashed border-[var(--color-border-strong)]" />
              Free session — time from your usual week, nothing chosen yet
            </span>
            <span>Everything else stays exactly as you set it</span>
          </p>

          {!building && savedPlan ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <PlanGoals uid={uid} plan={savedPlan} folders={folders} goals={goals} />
              <p className="px-1 text-xs text-text-muted lg:self-end">
                Done with this plan early?{" "}
                <button
                  type="button"
                  onClick={onArchive}
                  className="rounded font-semibold text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  Finish it
                </button>
              </p>
            </div>
          ) : null}
        </div>

        {wide ? (
          <aside ref={asideRef} aria-label="Plan with Jami" className="xl:sticky xl:top-4">
            <section
              className={`app-panel space-y-5 px-6 py-6 transition-shadow duration-slow ${
                assistantCued ? "ring-2 ring-[var(--color-warm-accent)]" : ""
              }`}
            >
              <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-text-primary">
                <JamiTutorIcon className="h-4 w-4 text-warm-accent" />
                Plan with Jami
              </h2>
              {assistant}
            </section>
          </aside>
        ) : null}
      </div>

      <PlanSummaryBar
        days={summaryDays}
        building={building}
        saving={planner.saving}
        canSave={planner.canSave}
        undoLabel={planner.undoLabel}
        {...(planner.undoLabel === JAMI_FILL_LABEL
          ? { note: "Jami filled your free sessions from your recent work. Change anything, or undo it." }
          : {})}
        onUndo={planner.undo}
        onSave={() => void planner.savePlan()}
      />

      {!wide && assistantOpen ? (
        <Dialog open className="fixed inset-0 flex items-end justify-center md:justify-end" onDismiss={() => setAssistantOpen(false)}>
          <DialogBackdrop className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" />
          <DialogPanel className="app-panel relative max-h-[88dvh] w-full overflow-y-auto rounded-b-none px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 md:h-full md:max-h-none md:w-[28rem] md:rounded-none md:px-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <DialogTitle className="flex items-center gap-2 text-base font-bold text-text-primary">
                <JamiTutorIcon className="h-4 w-4 text-warm-accent" />
                Plan with Jami
              </DialogTitle>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAssistantOpen(false)}>
                Done
              </Button>
            </div>
            {assistant}
          </DialogPanel>
        </Dialog>
      ) : null}

      {editor ? (
        <PlanActivityEditor
          key={`${editor.dayKey}|${editor.activity?.id ?? "new"}`}
          uid={uid}
          dayKey={editor.dayKey}
          {...(editor.activity ? { activity: editor.activity } : {})}
          todayDayKey={todayDayKey}
          subjects={editorSubjects}
          topics={editorTopics}
          revisionSessions={featureFlags.enableRevisionSessions}
          onClose={() => setEditor(null)}
          onAdd={ops.add}
          onSave={(dayKey, activity, patch) => ops.update(dayKey, activity, patch)}
          onDuplicate={(dayKey, activity, toDayKey) => ops.duplicate(dayKey, activity.id, toDayKey)}
          onRemove={(dayKey, activity) => ops.remove(dayKey, activity.id)}
        />
      ) : null}

      {settingsOpen ? (
        <PlanSettingsDialog
          options={options}
          plan={interview.draft}
          // A running plan's days are not all in view, so its settings are never refused for want of activities.
          activityCount={building ? days.reduce((total, day) => total + (day.kind === "planned" ? day.taskCount : 0), 0) : 1}
          saving={planner.saving}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            void planner.changePlan(next).then((saved) => {
              if (saved) setSettingsOpen(false);
            });
          }}
        />
      ) : null}
    </div>
  );
}
