import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";
import type { DailyStudyActivity } from "@/lib/study/activity";

/**
 * Seven days, as dots.
 *
 * The whole of Today's statistics, on purpose. Reviews, accuracy, streaks,
 * time studied and decks completed are all real numbers Jami holds, and a
 * student who opens their home page to a wall of them is being asked to audit
 * themselves before they have done anything.
 *
 * So this says one thing: you have been here. A lit dot is a day with at least
 * one review, and nothing about the dot changes with how many -- forty reviews
 * and one are the same dot, because the point being made is the habit rather
 * than the volume, and a dot that grew would quietly turn a calm strip back
 * into a metric.
 */

export const MOMENTUM_DAYS = 7;
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

export type MomentumDay = {
  dayKey: string;
  initial: string;
  reviews: number;
  isToday: boolean;
};

/**
 * The student's week, ending today.
 *
 * Built from day keys rather than dates so it lines up with the day boundary
 * the rest of the app schedules against -- a review at one in the morning
 * belongs to the night before, and the strip has to agree with the queue.
 */
export function buildMomentumWeek(
  activity: readonly DailyStudyActivity[],
  now = Date.now()
): MomentumDay[] {
  const todayKey = getStudyDayKey(now);
  const byDay = new Map(activity.map((entry) => [entry.dayKey, entry.reviewCount]));
  return Array.from({ length: MOMENTUM_DAYS }, (_, index) => {
    const dayKey = shiftStudyDayKey(todayKey, index - (MOMENTUM_DAYS - 1));
    const date = new Date(`${dayKey}T00:00:00`);
    const initial = Number.isNaN(date.getTime())
      ? "·"
      : WEEKDAY_INITIALS[date.getDay()] ?? "·";
    return {
      dayKey,
      initial,
      reviews: byDay.get(dayKey) ?? 0,
      isToday: dayKey === todayKey,
    };
  });
}

function summarise(week: readonly MomentumDay[]) {
  const days = week.filter((day) => day.reviews > 0).length;
  const reviews = week.reduce((total, day) => total + day.reviews, 0);
  if (reviews === 0) return "Nothing reviewed this week yet.";
  return `${days} ${days === 1 ? "day" : "days"} · ${reviews} ${
    reviews === 1 ? "review" : "reviews"
  }`;
}

export default function MomentumStrip({
  week,
  unavailable = false,
}: {
  week: MomentumDay[];
  unavailable?: boolean;
}) {
  return (
    <div className="app-panel rounded-3xl p-4">
      <h2 className="px-1 text-sm font-bold tracking-tight text-text-primary">This week</h2>
      {unavailable ? (
        // Silence rather than noughts: a week of empty dots is a claim about
        // the student, and not being able to read their activity is not one.
        <p className="mt-3 text-sm leading-6 text-text-muted">
          Your recent study history could not be read just now.
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-end justify-between gap-1">
            {week.map((day) => (
              <div key={day.dayKey} className="flex flex-1 flex-col items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full transition duration-normal ${
                    day.reviews > 0
                      ? "bg-warm-accent"
                      : "border border-[var(--color-border-strong)]"
                  } ${day.isToday && day.reviews === 0 ? "border-[var(--color-accent)]" : ""}`}
                />
                <span
                  className={`text-2xs ${
                    day.isToday ? "font-semibold text-text-secondary" : "text-text-muted"
                  }`}
                >
                  {day.initial}
                </span>
                <span className="sr-only">
                  {day.reviews > 0
                    ? `${day.reviews} ${day.reviews === 1 ? "review" : "reviews"} on ${day.dayKey}`
                    : `No reviews on ${day.dayKey}`}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm tabular-nums text-text-secondary">{summarise(week)}</p>
        </>
      )}
    </div>
  );
}
