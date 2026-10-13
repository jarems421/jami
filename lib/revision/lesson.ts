import { repairModelLatex } from "@/lib/ai/model-json";
import { isLearningErrorCategory, type LearningErrorCategory } from "@/lib/learning/types";
import {
  isRevisionMistake,
  type RevisionLesson,
  type RevisionMistake,
  type RevisionTask,
  type RevisionVerdict,
} from "@/lib/revision/types";

/**
 * What the model writes for a Revision Session, read without trusting it.
 *
 * Every field is required, trimmed and length-capped, and a lesson missing any
 * part of itself is refused whole rather than patched: a session that teaches
 * an idea and then has nothing to ask about it is worse than one that says it
 * could not be prepared. The caps are generous against what the prompt asks
 * for, so a model that runs a little long is not thrown away, while one that
 * writes an essay is.
 */

export const REVISION_TEXT_LIMITS = {
  goal: 120,
  orientation: 400,
  explanation: 1_400,
  exampleProblem: 300,
  exampleStep: 300,
  prompt: 700,
  hint: 300,
  answer: 300,
  markPoint: 240,
  solution: 1_000,
  feedback: 300,
} as const;

const GOAL_COUNT = 3;
const MAX_EXAMPLE_STEPS = 6;
const MAX_MARK_POINTS = 4;
const MAX_SOLUTION_LINES = 6;

function readText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = repairModelLatex(value.replace(/\r\n?/g, "\n").trim());
  if (!text || text.length > max) return null;
  return text;
}

function readTextList(value: unknown, max: number, limit: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => readText(item, max))
    .filter((item): item is string => item !== null)
    .slice(0, limit);
  return items.length > 0 ? items : null;
}

/**
 * A worked solution, asked for as a list of lines and kept as one text.
 *
 * A worked solution is naturally a few steps, and asked for it as one string
 * the model kept writing those steps as separate strings with no list around
 * them -- `"solution":"Half of 6 is 3.","So $(x+3)^2$."` -- which is not JSON,
 * so the whole lesson was thrown away. It is asked for as a list now, the way
 * the example's steps are, and a single string is still read, as lessons
 * already written have one.
 */
function readSolution(value: unknown): string | null {
  if (typeof value === "string") return readText(value, REVISION_TEXT_LIMITS.solution);
  const lines = readTextList(value, REVISION_TEXT_LIMITS.solution, MAX_SOLUTION_LINES);
  return lines ? readText(lines.join("\n"), REVISION_TEXT_LIMITS.solution) : null;
}

export function readRevisionTask(value: unknown): RevisionTask | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const prompt = readText(record.prompt, REVISION_TEXT_LIMITS.prompt);
  const hint = readText(record.hint, REVISION_TEXT_LIMITS.hint);
  const answer = readText(record.answer, REVISION_TEXT_LIMITS.answer);
  const markScheme = readTextList(record.markScheme, REVISION_TEXT_LIMITS.markPoint, MAX_MARK_POINTS);
  const solution = readSolution(record.solution);
  if (!prompt || !hint || !answer || !markScheme || !solution) return null;
  return { prompt, hint, answer, markScheme, solution };
}

/**
 * The explanation and its worked example, from either shape.
 *
 * The model is asked for `"explanation":"…","example":{…}` side by side. It was
 * first asked to nest the example inside the explanation, and on nearly every
 * lesson it closed the example and not the explanation -- `]}` where `]}}`
 * belonged -- so the four questions landed inside the explanation and the
 * reply was one brace short of JSON. The nested shape is still read: it is how
 * a lesson is stored.
 */
function explanationParts(record: Record<string, unknown>): { body: unknown; example: unknown } {
  const explanation = record.explanation;
  if (explanation && typeof explanation === "object") {
    const nested = explanation as Record<string, unknown>;
    return { body: nested.body, example: nested.example };
  }
  return { body: explanation, example: record.example };
}

/** The lesson, or null if any part of it is missing, empty or too long. */
export function readRevisionLesson(value: unknown): RevisionLesson | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const goals = readTextList(record.goals, REVISION_TEXT_LIMITS.goal, GOAL_COUNT);
  const orientation = readText(record.orientation, REVISION_TEXT_LIMITS.orientation);
  const { body: rawBody, example: rawExample } = explanationParts(record);
  const body = readText(rawBody, REVISION_TEXT_LIMITS.explanation);
  const example =
    rawExample && typeof rawExample === "object" ? (rawExample as Record<string, unknown>) : null;
  const problem = readText(example?.problem, REVISION_TEXT_LIMITS.exampleProblem);
  const steps = readTextList(example?.steps, REVISION_TEXT_LIMITS.exampleStep, MAX_EXAMPLE_STEPS);
  const guided = readRevisionTask(record.guided);
  const independent = readRevisionTask(record.independent);
  const apply = readRevisionTask(record.apply);
  const retrieve = readRevisionTask(record.retrieve);

  if (
    !goals ||
    goals.length < GOAL_COUNT ||
    !orientation ||
    !body ||
    !problem ||
    !steps ||
    !guided ||
    !independent ||
    !apply ||
    !retrieve
  ) {
    return null;
  }
  return {
    goals,
    orientation,
    explanation: { body, example: { problem, steps } },
    guided,
    independent,
    apply,
    retrieve,
  };
}

/**
 * Why a lesson was refused, as field names and nothing the model wrote.
 *
 * For the logs and the evaluation script: "retrieve.hint missing" says what to
 * fix in the prompt or the limits, without putting teaching content in a log.
 */
export function explainRevisionLessonRejection(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["not an object"];
  const record = value as Record<string, unknown>;
  const problems = rejectionCollector();
  problems.list("goals", record.goals, REVISION_TEXT_LIMITS.goal, GOAL_COUNT);
  problems.text("orientation", record.orientation, REVISION_TEXT_LIMITS.orientation);
  const parts = explanationParts(record);
  problems.text("explanation", parts.body, REVISION_TEXT_LIMITS.explanation);
  const example = (parts.example ?? {}) as Record<string, unknown>;
  problems.text("example.problem", example.problem, REVISION_TEXT_LIMITS.exampleProblem);
  problems.list("example.steps", example.steps, REVISION_TEXT_LIMITS.exampleStep);
  for (const key of ["guided", "independent", "apply", "retrieve"] as const) {
    problems.task(key, record[key]);
  }
  return problems.found;
}

/** Why a second explanation was refused, in the same terms. */
export function explainRevisionRetryRejection(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["not an object"];
  const record = value as Record<string, unknown>;
  const problems = rejectionCollector();
  problems.text("explanation", record.explanation, REVISION_TEXT_LIMITS.explanation);
  problems.task("task", record.task);
  return problems.found;
}

function rejectionCollector() {
  const found: string[] = [];
  const text = (path: string, raw: unknown, max: number) => {
    if (typeof raw !== "string") found.push(`${path} ${raw === undefined ? "missing" : `is ${typeof raw}`}`);
    else if (!raw.trim()) found.push(`${path} empty`);
    else if (raw.trim().length > max) found.push(`${path} too long (${raw.trim().length}/${max})`);
  };
  const list = (path: string, raw: unknown, max: number, minimum = 1) => {
    if (!Array.isArray(raw)) {
      found.push(`${path} ${raw === undefined ? "missing" : `is ${typeof raw}, not a list`}`);
      return;
    }
    const usable = raw.filter((item) => typeof item === "string" && item.trim() && item.trim().length <= max);
    if (usable.length < minimum) found.push(`${path} has ${usable.length} usable of ${raw.length}`);
  };
  const task = (path: string, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      found.push(`${path} ${raw === undefined ? "missing" : "is not an object"}`);
      return;
    }
    const record = raw as Record<string, unknown>;
    text(`${path}.prompt`, record.prompt, REVISION_TEXT_LIMITS.prompt);
    text(`${path}.hint`, record.hint, REVISION_TEXT_LIMITS.hint);
    text(`${path}.answer`, record.answer, REVISION_TEXT_LIMITS.answer);
    list(`${path}.markScheme`, record.markScheme, REVISION_TEXT_LIMITS.markPoint);
    if (Array.isArray(record.solution)) list(`${path}.solution`, record.solution, REVISION_TEXT_LIMITS.solution);
    else text(`${path}.solution`, record.solution, REVISION_TEXT_LIMITS.solution);
  };
  return { found, text, list, task };
}

/** The second go at the guided step: a different way in, and a new question. */
export function readRevisionRetry(value: unknown): RevisionLesson["retry"] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const explanation = readText(record.explanation, REVISION_TEXT_LIMITS.explanation);
  const task = readRevisionTask(record.task);
  return explanation && task ? { explanation, task } : null;
}

export type RevisionMarking = {
  verdict: RevisionVerdict;
  score: number;
  feedback: string;
  errorCategory?: LearningErrorCategory;
  /** What kind of mistake it was, when it was one. Never set on a correct answer. */
  mistake?: RevisionMistake;
};

const SCORE_RANGE: Record<RevisionVerdict, [number, number]> = {
  correct: [0.8, 1],
  partial: [0.2, 0.8],
  incorrect: [0, 0.2],
};
const DEFAULT_SCORE: Record<RevisionVerdict, number> = {
  correct: 1,
  partial: 0.5,
  incorrect: 0,
};

function isVerdict(value: unknown): value is RevisionVerdict {
  return value === "correct" || value === "partial" || value === "incorrect";
}

/**
 * A mark, or null when the marker did not give one.
 *
 * The score is held inside the band its verdict allows, so "correct, 0.1" and
 * "incorrect, 0.9" cannot reach the engine. An error category outside the
 * engine's fixed list is dropped rather than refused: the verdict still
 * stands, and inventing categories is exactly what the fixed list prevents.
 */
export function readRevisionMarking(value: unknown): RevisionMarking | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isVerdict(record.verdict)) return null;
  const verdict = record.verdict;
  const feedback = readText(record.feedback, REVISION_TEXT_LIMITS.feedback);
  if (!feedback) return null;
  const [low, high] = SCORE_RANGE[verdict];
  const raw = typeof record.score === "number" && Number.isFinite(record.score)
    ? record.score
    : DEFAULT_SCORE[verdict];
  const score = Math.min(high, Math.max(low, raw));
  return {
    verdict,
    score,
    feedback,
    ...(verdict !== "correct" && isLearningErrorCategory(record.errorCategory)
      ? { errorCategory: record.errorCategory }
      : {}),
    ...(verdict !== "correct" && isRevisionMistake(record.mistake) ? { mistake: record.mistake } : {}),
  };
}

/** Spacing, case and the harmless ways of writing the same symbol, removed. */
function normaliseAnswer(value: string) {
  return value
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/[−–]/g, "-")
    .replace(/×|\\times/g, "*")
    .replace(/\^\{?2\}?|²/g, "^2")
    .replace(/\^\{?3\}?|³/g, "^3")
    .replace(/\s+/g, "")
    .replace(/[.,;]+$/, "");
}

/**
 * Whether an answer is the expected answer, character for character once
 * spacing and notation are set aside.
 *
 * Only ever says yes. An exact match needs no model to mark it -- saving the
 * student a wait on the answers they get cleanly right -- but a mismatch
 * proves nothing, since a correct answer can be written a hundred ways, so a
 * mismatch always goes to the marker.
 */
export function matchesExpectedAnswer(answer: string, expected: string) {
  const given = normaliseAnswer(answer);
  return given.length > 0 && given === normaliseAnswer(expected);
}
