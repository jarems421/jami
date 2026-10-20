const STUDY_TIME_ZONE = "Europe/London";
/**
 * When one study day ends and the next begins: 4am.
 *
 * It was 4pm, so until four in the afternoon every part of the app keyed on the
 * study day -- the plan, Daily Review, streaks -- was still on yesterday, and on
 * a Friday morning the plan showed Thursday's work. Early morning keeps the day
 * the student sees, while a session that runs past midnight still counts for
 * the evening it started in.
 */
const STUDY_DAY_BOUNDARY_HOUR = 4;

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type StudyDayWindow = {
  studyDayKey: string;
  start: number;
  end: number;
};

/** One formatter per time zone: building them is the slow part of reading a zoned time. */
const zonedDateFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedDateFormatter(timeZone: string) {
  let formatter = zonedDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zonedDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** What the zone's clock reads at `timestamp`, asked of Intl directly. */
function readZonedDateParts(timestamp: number, timeZone: string): ZonedDateParts {
  const parts = zonedDateFormatter(timeZone).formatToParts(new Date(timestamp));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

/** How far the zone's clock is ahead of UTC at `timestamp`, in milliseconds. */
function readZoneOffset(timestamp: number, timeZone: string) {
  const parts = readZonedDateParts(timestamp, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(timestamp / 1000) * 1000;
}

/**
 * The window a zone's offset is learned for, and how many are remembered.
 *
 * `formatToParts` is slow -- tens of microseconds a call -- and Learn asked it
 * for the study day of every card's due date, several times a card, so a
 * 5,000-card account spent over two seconds of a slowed phone's main thread in
 * it before Learn could show anything. A zone's offset only changes at its
 * clock changes, so it is learned once per window and the clock is worked out
 * from it.
 */
const OFFSET_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_REMEMBERED_WINDOWS = 4_096;
/** Per zone, each window's offset -- or null where the clock changes inside it. */
const zoneOffsets = new Map<string, Map<number, number | null>>();

function getZonedDateParts(timestamp: number, timeZone = STUDY_TIME_ZONE): ZonedDateParts {
  if (!Number.isFinite(timestamp)) return readZonedDateParts(timestamp, timeZone);
  let windows = zoneOffsets.get(timeZone);
  if (!windows) {
    windows = new Map();
    zoneOffsets.set(timeZone, windows);
  }
  const window = Math.floor(timestamp / OFFSET_WINDOW_MS);
  let offset = windows.get(window);
  if (offset === undefined) {
    // Trusted for the window only if it reads the same at both ends: a clock
    // change inside it is read directly, timestamp by timestamp.
    const start = window * OFFSET_WINDOW_MS;
    const atStart = readZoneOffset(start, timeZone);
    offset = atStart === readZoneOffset(start + OFFSET_WINDOW_MS - 1_000, timeZone) ? atStart : null;
    if (windows.size >= MAX_REMEMBERED_WINDOWS) windows.clear();
    windows.set(window, offset);
  }
  if (offset === null) return readZonedDateParts(timestamp, timeZone);

  const wall = new Date(timestamp + offset);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
}

function formatDayKey(year: number, month: number, day: number) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function parseDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return { year, month, day };
}

function shiftCalendarDate(year: number, month: number, day: number, deltaDays: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDateTimeToUtcTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0
) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const parts = getZonedDateParts(guess);
    const diff =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      Date.UTC(year, month - 1, day, hour, minute, second);

    if (diff === 0) {
      return guess;
    }

    guess -= diff;
  }

  return guess;
}

/**
 * The last study day asked for. Sorting a queue asks it of the same moment once
 * per card -- is today's struggle mark still on it? -- thousands of times over.
 */
let lastStudyDay: { timestamp: number; timeZone: string; key: string } | null = null;

/**
 * The study day `timestamp` falls in, as "YYYY-MM-DD".
 *
 * The app keeps every student's days in study time (London). A time zone is
 * passed only where the student's own clock is what matters: a nudge goes out
 * at 4pm where they are, once per day of theirs.
 */
export function getStudyDayKey(timestamp = Date.now(), timeZone = STUDY_TIME_ZONE) {
  if (lastStudyDay?.timestamp === timestamp && lastStudyDay.timeZone === timeZone) return lastStudyDay.key;
  const parts = getZonedDateParts(timestamp, timeZone);
  const boundaryDate =
    parts.hour >= STUDY_DAY_BOUNDARY_HOUR
      ? { year: parts.year, month: parts.month, day: parts.day }
      : shiftCalendarDate(parts.year, parts.month, parts.day, -1);

  const key = formatDayKey(boundaryDate.year, boundaryDate.month, boundaryDate.day);
  lastStudyDay = { timestamp, timeZone, key };
  return key;
}

export function shiftStudyDayKey(dayKey: string, deltaDays: number) {
  const { year, month, day } = parseDayKey(dayKey);
  const shifted = shiftCalendarDate(year, month, day, deltaDays);
  return formatDayKey(shifted.year, shifted.month, shifted.day);
}

/**
 * Whole days from one key to another, negative if the second is earlier.
 *
 * Read as plain calendar dates through `Date.UTC`, never as moments, so a
 * clock change between the two days cannot add or lose one.
 */
export function studyDaysBetween(fromDayKey: string, toDayKey: string) {
  const at = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  };
  return Math.round((at(toDayKey) - at(fromDayKey)) / (24 * 60 * 60 * 1000));
}

export function getStudyDayStartFromKey(dayKey: string) {
  const { year, month, day } = parseDayKey(dayKey);
  return localDateTimeToUtcTimestamp(
    year,
    month,
    day,
    STUDY_DAY_BOUNDARY_HOUR
  );
}

export function getStudyDayWindow(timestamp = Date.now()): StudyDayWindow {
  const studyDayKey = getStudyDayKey(timestamp);
  const start = getStudyDayStartFromKey(studyDayKey);
  const end = getStudyDayStartFromKey(shiftStudyDayKey(studyDayKey, 1));

  return {
    studyDayKey,
    start,
    end,
  };
}

export function getMsUntilNextStudyBoundary(timestamp = Date.now()) {
  return Math.max(0, getStudyDayWindow(timestamp).end - timestamp);
}

/** Minutes since local midnight at `timestamp` in `timeZone`: 16:30 is 990. */
export function getMinutesIntoLocalDay(timestamp: number, timeZone = STUDY_TIME_ZONE) {
  const parts = getZonedDateParts(timestamp, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** Whether `value` names a time zone this runtime knows, such as "Asia/Kolkata". */
export function isKnownTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    zonedDateFormatter(value);
    return true;
  } catch {
    return false;
  }
}

export function formatStudyDayLabel(dayKey: string) {
  const { month, day } = parseDayKey(dayKey);
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

export function getStudyTimeZone() {
  return STUDY_TIME_ZONE;
}

