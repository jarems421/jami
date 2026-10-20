"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GoalMeasureIcon } from "@/components/goals/GoalIcons";
import { GoalPaceLine } from "@/components/goals/GoalProgress";
import { goalIntentHref } from "@/lib/goals/intent";
import { getGoalDisplayName, type Goal } from "@/lib/goals/model";
import { goalStanding, sortGoalsForDisplay } from "@/lib/goals/standing";
import { upcomingPlanExams } from "@/lib/goals/suggestions";
import type { RevisionPlan } from "@/lib/planning/types";
import { getStudyDayKey } from "@/lib/study/day";
import { getActiveGoalsWithCurrentStatuses } from "@/services/study/goals";

/** A plan's side column shows a few goals; the rest are on Goals. */
const PLAN_GOAL_LIMIT = 3;

/**
 * The goals that belong to a plan, beside it: any set for one of its exams,
 * and any counting work in one of its subjects.
 *
 * A plan says when there is time to study; a goal says what the student wants
 * that time to add up to. Seeing them together is the point -- and an exam in
 * the plan with no goal yet gets a link that sets one up for it, filled in.
 */
export default function PlanGoals({
  uid,
  plan,
  folders,
}: {
  uid: string;
  plan: RevisionPlan;
  folders: readonly { id: string; name: string }[];
}) {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    // The plan draws without goals; a failed read just leaves this card quiet.
    void getActiveGoalsWithCurrentStatuses(uid).then(
      (loaded) => {
        if (live) setGoals(loaded);
      },
      () => {
        if (live) setGoals([]);
      }
    );
    return () => {
      live = false;
    };
  }, [uid]);

  const { related, nextExam } = useMemo(() => {
    const folderIds = new Set(plan.scopes.flatMap((scope) => (scope.folderId ? [scope.folderId] : [])));
    const belonging = (goals ?? []).filter(
      (goal) =>
        goal.exam?.planId === plan.id ||
        (goal.scope.type === "folder" && goal.scope.id !== undefined && folderIds.has(goal.scope.id))
    );
    const exam = upcomingPlanExams(plan, getStudyDayKey(now), folders)[0];
    return {
      related: sortGoalsForDisplay(belonging).slice(0, PLAN_GOAL_LIMIT),
      nextExam: exam && !belonging.some((goal) => goal.exam?.examId === exam.examId) ? exam : undefined,
    };
  }, [folders, goals, now, plan]);

  if (goals === null) return null;

  return (
    <section aria-labelledby="plan-goals-title" className="app-subtle-panel space-y-3 rounded-2xl p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="plan-goals-title" className="text-base font-bold text-text-primary">
          Goals
        </h2>
        <Link href="/dashboard/goals" className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
          All goals
        </Link>
      </div>
      {related.length > 0 ? (
        <ul className="space-y-3">
          {related.map((goal) => {
            const standing = goalStanding(goal, now);
            return (
              <li key={goal.id} className="space-y-1.5">
                <p className="flex items-center gap-2">
                  <GoalMeasureIcon measure={goal.measure} className="h-4 w-4 shrink-0 text-text-muted" />
                  <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{getGoalDisplayName(goal)}</span>
                </p>
                <p className="text-xs tabular-nums text-text-muted">{standing.headline}</p>
                <GoalPaceLine standing={standing} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm leading-6 text-text-muted">
          Goals for this plan&apos;s subjects show here, so you can see what the time is adding up to.
        </p>
      )}
      {nextExam ? (
        <Link
          href={goalIntentHref({ exam: nextExam })}
          className="inline-flex text-sm font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
        >
          Set a goal for {nextExam.label} <span aria-hidden="true" className="ml-1">→</span>
        </Link>
      ) : null}
    </section>
  );
}
