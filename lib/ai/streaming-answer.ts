/**
 * Reads the "answer" field out of a JSON object that is still being written.
 *
 * The assistant asks the provider for structured JSON, so a streamed response
 * arrives as a partial document: `{"answer":"Photosynthesis is` and so on. This
 * pulls out however much of that string has arrived, so the prose can be shown
 * while the rest of the object, including the source references, is still on
 * its way.
 *
 * Deliberately not a JSON parser. It finds the field, scans to the first
 * unescaped quote, and lets JSON.parse handle unescaping the fragment, which is
 * enough for one known string field and cannot go wrong on the rest of the
 * document.
 */

import { repairModelJsonBackslashes } from "@/lib/ai/model-json";

const ANSWER_KEY_PATTERN = /"answer"\s*:\s*"/;

/**
 * How far past a backslash the repair can look before it decides what the
 * backslash meant: the longest n-command name, or a unicode escape.
 */
const BACKSLASH_LOOKAHEAD = 16;

/**
 * The buffer up to the first backslash the repair cannot decide yet.
 *
 * Whether `\t` is a tab or the start of `\times` depends on what follows it.
 * Read at a chunk boundary, it was a tab, and the route had already sent it on
 * by the time "imes" arrived -- the student watched `\times` arrive as a gap
 * and "imes". Holding back the last few characters after a backslash costs
 * nothing visible and means nothing shown is ever taken back.
 */
function settledPrefix(rawBuffer: string) {
  const undecidedFrom = rawBuffer.length - BACKSLASH_LOOKAHEAD;
  for (let at = rawBuffer.indexOf("\\"); at >= 0; at = rawBuffer.indexOf("\\", at)) {
    const next = rawBuffer[at + 1];
    if (next === undefined) return rawBuffer.slice(0, at);
    // `\"`, `\\` and `\/` mean one thing whatever follows.
    if (next === '"' || next === "\\" || next === "/") {
      at += 2;
      continue;
    }
    if ("bfnrtu".includes(next) && at > undecidedFrom) return rawBuffer.slice(0, at);
    at += 1;
  }
  return rawBuffer;
}

/** The answer string's raw JSON text so far, and whether its closing quote has arrived. */
function scanAnswerString(buffer: string) {
  const opening = buffer.match(ANSWER_KEY_PATTERN);
  if (!opening || opening.index === undefined) return null;

  const start = opening.index + opening[0].length;
  let end = start;

  // Walk to the closing quote, skipping any that are escaped. A backslash
  // always consumes the character after it, so escaped quotes and escaped
  // backslashes are both handled by the same step.
  while (end < buffer.length) {
    const char = buffer[end];
    if (char === "\\") {
      end += 2;
      continue;
    }
    if (char === '"') break;
    end += 1;
  }

  return {
    fragment: buffer.slice(start, Math.min(end, buffer.length)),
    /** The closing quote's index, once it has arrived. */
    closedAt: end < buffer.length ? end : null,
  };
}

/**
 * The document closed after each whole field from the answer on, latest first:
 * `{..."answer":"..."}`, then the same with the next field, and so on, ending
 * with the whole object if it closed. Whatever the reply did after the answer --
 * broke off, stalled, or looped on one field -- one of these still parses, and
 * keeps every field that arrived whole, the ones before the answer included.
 */
function closedReadings(buffer: string, answerClosedAt: number) {
  const readings = [`${buffer.slice(0, answerClosedAt + 1)}}`];
  let depth = 1;
  let inString = false;
  for (let at = answerClosedAt + 1; at < buffer.length; at += 1) {
    const char = buffer[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        readings.push(buffer.slice(0, at + 1));
        break;
      }
    } else if (char === "," && depth === 1) readings.push(`${buffer.slice(0, at)}}`);
  }
  // The comma straight after the answer closes the same document as the answer.
  return [...new Set(readings)].reverse();
}

/**
 * The whole answer, once its closing quote has arrived; null while it is still
 * being written or if it was cut off.
 *
 * Read from a stream: exactly the text the student watched arrive, whatever
 * became of the fields after it, with `closedReadings` the document cut short
 * at each field after it.
 */
export function readCompletedStreamingAnswer(
  rawBuffer: string
): { answer: string; closedReadings: string[] } | null {
  const scanned = scanAnswerString(repairModelJsonBackslashes(rawBuffer));
  const raw = scanAnswerString(rawBuffer);
  if (scanned?.closedAt == null || raw?.closedAt == null) return null;
  try {
    return {
      answer: JSON.parse(`"${scanned.fragment}"`) as string,
      closedReadings: closedReadings(rawBuffer, raw.closedAt),
    };
  } catch {
    return null;
  }
}

/** What the reply has written since its answer closed; null until it has. */
export function readStreamingAnswerTail(rawBuffer: string) {
  const closedAt = scanAnswerString(rawBuffer)?.closedAt;
  return closedAt == null ? null : rawBuffer.slice(closedAt + 1);
}

/** How much a reply may write after its answer: three graphs and the used flags, with room to spare. */
const MAX_ANSWER_TAIL_CHARACTERS = 8_000;
/** The same item written this many times running is a model stuck in a loop, never a list. */
const RUNAWAY_REPEATS = 6;
const RUNAWAY_ITEM_PATTERN = new RegExp(
  `("(?:[^"\\\\]|\\\\.){0,400}"|\\[\\]|\\{\\})(?:\\s*,\\s*\\1){${RUNAWAY_REPEATS - 1}}`
);

/**
 * Whether what a reply wrote after its answer is no longer worth waiting for.
 *
 * Measured on the worker (GLM 5.3 Flash), 19 Oct 2026: with the answer already
 * on screen, some replies filled `graphs` with `"[]"` -- or one sentence -- over
 * and over until the token limit, twenty to forty seconds of nothing the
 * student could see, and an object that never parsed at the end of it.
 */
export function isRunawayAnswerTail(tail: string) {
  return tail.length > MAX_ANSWER_TAIL_CHARACTERS || RUNAWAY_ITEM_PATTERN.test(tail);
}

export function extractStreamingAnswer(rawBuffer: string): string {
  // Unescaped LaTeX backslashes would otherwise be unescaped into control
  // characters here, mid-stream, before anything else can notice.
  const fragment = scanAnswerString(repairModelJsonBackslashes(settledPrefix(rawBuffer)))?.fragment ?? "";
  if (!fragment) return "";

  try {
    return JSON.parse(`"${fragment}"`) as string;
  } catch {
    // A trailing partial escape such as "\u00e" is not yet valid on its own.
    // Drop back to the last safe boundary rather than showing nothing.
    for (let cut = fragment.length - 1; cut > 0; cut -= 1) {
      if (fragment[cut - 1] === "\\") continue;
      try {
        return JSON.parse(`"${fragment.slice(0, cut)}"`) as string;
      } catch {
        // This cut still lands inside an escape sequence. Keep walking back;
        // the loop ends at "" if no boundary is valid yet.
        continue;
      }
    }
    return "";
  }
}
