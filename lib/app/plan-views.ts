import { featureFlags } from "@/lib/app/feature-flags";

/** Structurally what `ViewTabs` renders, without reaching into it. */
export type PlanView = {
  href: string;
  label: string;
  detail: string;
};

/**
 * Plan: when a student will study, and what they are aiming at.
 *
 * The revision plan and goals are two halves of one job -- the timetable and
 * the targets behind it -- and goals already read the plan's exam dates. They
 * used to live apart, the plan as a tab of Jami and goals as their own
 * sidebar entry. The plan comes first: it is the dated, day-to-day half that
 * Today is built from.
 *
 * The planner is at /dashboard/planner, not /dashboard/plan: the sidebar
 * lights an entry for any address that starts with one of its own, and
 * /dashboard/plans is billing.
 */
export const PLANNER_PATH = "/dashboard/planner";

export const PLAN_VIEWS: PlanView[] = [
  ...(featureFlags.enableRevisionPlans
    ? [
        {
          href: PLANNER_PATH,
          label: "Revision plan",
          detail: "Your timetable, with Jami beside it",
        },
      ]
    : []),
  {
    href: "/dashboard/goals",
    label: "Goals",
    detail: "Targets to aim at",
  },
];

export const PLAN_TITLE = "Plan";

/** Where the sidebar's Plan entry lands: the first of its views. */
export const PLAN_HOME = PLAN_VIEWS[0].href;
