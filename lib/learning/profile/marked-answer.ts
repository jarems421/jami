import {
  errorChecksForMarkedAnswer,
  type MarkedCriterion,
} from "@/lib/learning/profile/error-patterns";
import { clampUnit } from "@/lib/learning/scoring/mastery-score";
import { isLearningErrorCategory, type LearningErrorCheck } from "@/lib/learning/types";

/**
 * A marked answer as it is stored, read defensively.
 *
 * Past-paper attempts and practice-paper questions both carry this shape, and
 * both have results written by several generations of the marking pipeline, so
 * every field is checked rather than trusted.
 */
export type StoredMarkedAnswer = {
  attempted?: unknown;
  counted?: unknown;
  awardedMarks?: unknown;
  maxMarks?: unknown;
  criterionResults?: unknown;
  improvements?: unknown;
};

export type ReadMarkedAnswer = {
  score: number;
  maxMarks: number;
  errorChecks: LearningErrorCheck[];
};

const MAX_CRITERIA = 60;
const MAX_TEXT_LENGTH = 500;

function readText(value: unknown) {
  return typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function readCriteria(value: unknown): MarkedCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CRITERIA).flatMap((item): MarkedCriterion[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const criterion = readText(record.criterion);
    if (criterion === undefined || typeof record.awarded !== "boolean") return [];
    const schemeValue = readText(record.schemeValue);
    const candidateValue = readText(record.candidateValue);
    return [
      {
        criterion,
        awarded: record.awarded,
        ...(typeof record.awardedMarks === "number" && Number.isFinite(record.awardedMarks)
          ? { awardedMarks: record.awardedMarks }
          : {}),
        ...(typeof record.maxMarks === "number" && Number.isFinite(record.maxMarks)
          ? { maxMarks: record.maxMarks }
          : {}),
        ...(schemeValue !== undefined ? { schemeValue } : {}),
        ...(candidateValue !== undefined ? { candidateValue } : {}),
        ...(isLearningErrorCategory(record.errorCategory) ? { errorCategory: record.errorCategory } : {}),
      },
    ];
  });
}

function readTextList(value: unknown) {
  return Array.isArray(value)
    ? value
        .slice(0, MAX_CRITERIA)
        .flatMap((item) => (typeof item === "string" ? [item.slice(0, MAX_TEXT_LENGTH)] : []))
    : [];
}

/**
 * The score and error chances of one marked answer, or null when it is not
 * evidence.
 *
 * A question the student left blank, or one a choice rule excluded from the
 * total, says nothing about what they know and is skipped rather than scored
 * as zero.
 */
export function readMarkedAnswer(
  result: StoredMarkedAnswer | undefined
): ReadMarkedAnswer | null {
  if (!result || typeof result !== "object") return null;
  if (result.attempted === false || result.counted === false) return null;
  const maxMarks =
    typeof result.maxMarks === "number" && Number.isFinite(result.maxMarks) ? result.maxMarks : 0;
  const awardedMarks = typeof result.awardedMarks === "number" ? result.awardedMarks : NaN;
  if (!(maxMarks > 0) || !Number.isFinite(awardedMarks)) return null;
  const score = clampUnit(awardedMarks / maxMarks);
  return {
    score,
    maxMarks,
    errorChecks: errorChecksForMarkedAnswer({
      criterionResults: readCriteria(result.criterionResults),
      improvements: readTextList(result.improvements),
      lostMarks: score < 1,
    }),
  };
}

/**
 * How much one marked answer counts: more for a bigger question, but not in
 * proportion, so one six-mark answer does not outweigh five one-mark answers.
 */
export function markedAnswerWeight(maxMarks: number) {
  return Math.sqrt(Math.max(1, maxMarks));
}
