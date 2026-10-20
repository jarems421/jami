import { ProgressBar } from "@/components/ui";
import { GOAL_TOPIC_LADDER, type GoalStanding, type GoalTone } from "@/lib/goals/standing";

/**
 * How a goal's progress is drawn: a bar for a total, a row of days for a
 * habit, and the engine's own ladder for a topic. Each shape says something
 * the others cannot -- a habit is days, not a percentage, and a topic climbs
 * through named states rather than filling up.
 */

const TONE_CLASS: Record<GoalTone, string> = {
  done: "app-success",
  done_today: "app-success",
  ahead: "app-success",
  on_track: "app-success",
  behind: "app-warning",
  due_today: "app-warning",
  out_of_reach: "app-danger",
  open: "app-chip",
  unchecked: "app-chip",
};

/** The pace line, coloured by how it is going. */
export function GoalPaceLine({ standing }: { standing: Pick<GoalStanding, "pace" | "tone"> }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[standing.tone]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" />
      <span className="truncate">{standing.pace}</span>
    </span>
  );
}

/** More than this and a row of days becomes a bar: fourteen dots is already a lot to read. */
const MAX_DOTS = 14;

function TodayRing({ percent }: { percent: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="h-4 w-4 -rotate-90">
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.4" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray={`${(circumference * percent) / 100} ${circumference}`}
      />
    </svg>
  );
}

/** A habit's days: one mark per day asked for, filled as each is hit, today's drawn as it fills. */
export function GoalDayDots({ days }: { days: NonNullable<GoalStanding["days"]> }) {
  const label = `${days.hit} of ${days.of} ${days.of === 1 ? "day" : "days"} done${days.doneToday ? ", including today" : ""}`;
  if (days.of > MAX_DOTS) {
    return (
      <div className="space-y-1.5">
        <ProgressBar grow progress={(days.hit / days.of) * 100} size="sm" variant="warm" />
        <p className="text-xs text-text-muted">{label}</p>
      </div>
    );
  }
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {Array.from({ length: days.of }, (_, index) => {
        const hit = index < days.hit;
        const isToday = !days.doneToday && index === days.hit;
        return (
          <li key={index} className="grid h-4 w-4 place-items-center">
            {hit ? (
              <span className="h-3.5 w-3.5 rounded-full bg-gradient-to-br from-warm-accent to-success shadow-warm" />
            ) : isToday ? (
              <span className="text-warm-accent">
                <TodayRing percent={days.todayPercent} />
              </span>
            ) : (
              <span className="h-3 w-3 rounded-full border border-[var(--color-border-strong)]" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** A topic's place on the engine's ladder, from not tested to strong. */
export function GoalLadder({ step }: { step: number | null }) {
  const current = step ?? -1;
  return (
    <div>
      <ol className="grid grid-cols-5 gap-1" aria-label={current >= 0 ? `Now: ${GOAL_TOPIC_LADDER[current]?.label}` : "Not checked yet"}>
        {GOAL_TOPIC_LADDER.map((item, index) => (
          <li
            key={item.demonstration}
            className={`h-2 rounded-full ${
              index <= current
                ? index === GOAL_TOPIC_LADDER.length - 1
                  ? "bg-success"
                  : "bg-gradient-to-r from-accent to-warm-accent"
                : "bg-glass-medium"
            }`}
          />
        ))}
      </ol>
      {/* On a phone the goal's headline already names the step; five labels in a row do not fit there. */}
      <div aria-hidden="true" className="mt-1.5 hidden grid-cols-5 gap-1 text-2xs text-text-muted sm:grid">
        {GOAL_TOPIC_LADDER.map((item, index) => (
          <span
            key={item.demonstration}
            className={`truncate ${index === current ? "font-semibold text-text-primary" : ""} ${
              index === GOAL_TOPIC_LADDER.length - 1 ? "text-right" : ""
            }`}
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The right drawing for a goal's standing. */
export function GoalProgressVisual({ standing }: { standing: GoalStanding }) {
  if (standing.ladder || standing.tone === "unchecked") return <GoalLadder step={standing.ladder?.step ?? null} />;
  if (standing.days) return <GoalDayDots days={standing.days} />;
  return <ProgressBar grow progress={standing.percent} size="sm" variant="warm" />;
}
