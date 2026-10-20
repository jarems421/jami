import Link from "next/link";
import { longPlanDate } from "@/lib/planning/plan-format";
import type { PlanCountdownItem } from "@/lib/planning/plan-countdown";

/**
 * The top of Today, read like the top of a planner page: who and when, how
 * much the day holds, and how long until the exams.
 *
 * The countdown sits here rather than in a panel of its own at the bottom,
 * because it is part of the answer to "what does today need to be?" -- with
 * forty-eight days to go, today is steady work; with four, it is not. Without
 * a plan there are no exam dates to count to, so it says where to add them
 * rather than drawing an empty row.
 */
export default function TodayHeader({
  greeting,
  dayKey,
  planTitle,
  summary,
  countdown,
  planHref,
  offerExamDates = false,
  scopeColor,
}: {
  greeting: string;
  dayKey: string;
  planTitle?: string;
  /** How much the day holds, or what is happening while it is read. */
  summary?: string;
  countdown: readonly PlanCountdownItem[];
  planHref: string;
  /** Whether to point a student with no plan at adding their exam dates. */
  offerExamDates?: boolean;
  scopeColor: (scopeKey: string) => string;
}) {
  return (
    <header className="flex flex-col gap-2 pt-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-xl font-semibold tracking-[-0.01em] text-text-primary sm:text-2xl">{greeting}</p>
        {planTitle ? (
          <Link
            href={planHref}
            className="text-sm font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
          >
            Open your plan
          </Link>
        ) : null}
      </div>
      <p className="text-sm text-text-muted">
        {[longPlanDate(dayKey), planTitle, summary].filter(Boolean).join(" · ")}
      </p>
      {countdown.length > 0 ? (
        <p aria-label="Counting down" className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-secondary">
          {countdown.map((item) => (
            <span key={item.id} className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.scopeKey ? scopeColor(item.scopeKey) : "var(--color-accent)" }}
              />
              <span>
                <strong className="font-bold tabular-nums text-text-primary">
                  {item.daysLeft === 0 ? "Today" : `${item.daysLeft} ${item.daysLeft === 1 ? "day" : "days"}`}
                </strong>{" "}
                {item.daysLeft === 0 ? "" : "to "}
                {item.label}
              </span>
            </span>
          ))}
        </p>
      ) : offerExamDates ? (
        <p className="text-sm text-text-muted">
          No exam dates yet —{" "}
          <Link href={planHref} className="font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
            add them
          </Link>{" "}
          and Jami counts down to each.
        </p>
      ) : null}
    </header>
  );
}
