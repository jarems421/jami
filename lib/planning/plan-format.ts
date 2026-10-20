/**
 * How a plan's dates and durations are written, the same everywhere.
 *
 * Every date here is a day key read as the calendar date it prints, through
 * UTC, so "Monday 19 October" is what every device shows for 2026-10-19
 * whatever its own timezone.
 */

function utcDate(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

/** "45m", "1h", "1h 30m". */
export function formatPlanMinutes(minutes: number) {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** "Monday 19 October". */
export function longPlanDate(dayKey: string) {
  return utcDate(dayKey).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** "Mon 19 Oct". */
export function shortPlanDate(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return dayKey;
  return utcDate(dayKey).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "October 2026". */
export function planMonthLabel(dayKey: string) {
  return utcDate(dayKey).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "19–25 October", or "28 October – 3 November" across a month's end. */
export function planRangeLabel(fromDayKey: string, toDayKey: string) {
  const from = utcDate(fromDayKey);
  const to = utcDate(toDayKey);
  const month = (date: Date) => date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  if (from.getUTCMonth() === to.getUTCMonth()) {
    return `${from.getUTCDate()}–${to.getUTCDate()} ${month(to)}`;
  }
  return `${from.getUTCDate()} ${month(from)} – ${to.getUTCDate()} ${month(to)}`;
}
