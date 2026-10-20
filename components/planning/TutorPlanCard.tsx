"use client";

import TutorDoor from "@/components/ai/TutorDoor";
import { Skeleton } from "@/components/ui";
import { planDaysBetween } from "@/lib/planning/plan-schedule";
import { PLAN_WEEKDAY_LABELS, PLAN_WEEKDAYS, type RevisionPlan } from "@/lib/planning/types";
import { getRevisionPlanHref } from "@/lib/app/routes";
import { getStudyDayKey } from "@/lib/study/day";

/**
 * The revision plan, as one of the Tutor page's doors.
 *
 * Two states. Without a plan it says what making one is like and invites it;
 * with one it says how far there is to go and which days it studies. Nothing
 * on it looks pressable except the door itself: the study days used to be a
 * row of chips, and what Jami had noticed a row of pills, and students tapped
 * both expecting something to happen.
 */

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function TutorPlanCard({
  plan,
  loading = false,
}: {
  plan: RevisionPlan | null;
  loading?: boolean;
}) {
  const href = getRevisionPlanHref();

  /*
   * Nothing is claimed while the plan is still being read.
   *
   * Without this the door renders its invitation first and swaps to a plan a
   * moment later, which reads as the plan having just been created.
   */
  if (loading) return <Skeleton className="h-56 w-full rounded-3xl" />;

  if (!plan) {
    return (
      <TutorDoor
        href={href}
        tone="success"
        icon={<CalendarIcon />}
        title="Plan your revision"
        description="Jami asks about your exams, subjects and week, and builds the plan in front of you."
        action="Make a plan"
      />
    );
  }

  const daysLeft = Math.max(0, planDaysBetween(getStudyDayKey(), plan.endDayKey));
  const perWeek = plan.sessions.reduce((total, session) => total + session.minutes, 0);
  const studyDays = PLAN_WEEKDAYS.filter((weekday) =>
    plan.sessions.some((session) => session.weekday === weekday)
  ).map((weekday) => PLAN_WEEKDAY_LABELS[weekday]);

  return (
    <TutorDoor
      href={href}
      tone="success"
      icon={<CalendarIcon />}
      title={plan.title}
      description={
        // A plan can be nothing but activities placed by hand, with no usual week to describe.
        studyDays.length > 0
          ? `About ${perWeek >= 60 ? `${Math.round(perWeek / 60)}h` : `${perWeek} min`} a week, usually on ${studyDays.join(", ")}.`
          : "Your timetable, planned day by day."
      }
      status={daysLeft > 0 ? `${daysLeft} days to go` : "Finishing today"}
      action="Open your plan"
    />
  );
}
