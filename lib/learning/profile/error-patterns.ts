import type {
  LearningErrorCategory,
  LearningErrorCheck,
  LearningErrorDetection,
} from "@/lib/learning/types";

type LearningErrorDefinition = {
  category: LearningErrorCategory;
  /** What the tutor and the student read. Fixed text, never marker prose. */
  label: string;
  /** Criterion or note wording that names this way of losing a mark. */
  wording: RegExp;
};

/**
 * The recurring errors the engine can recognise from wording.
 *
 * Deliberately narrow. A great many criteria are called "Method", "Mark 2" or
 * "Knowledge", which say nothing about *how* a mark was lost, and a loose
 * pattern that swept those in would report "not showing working" to a student
 * who simply got the question wrong. A criterion that matches nothing here is
 * not an error the engine knows how to name, and it stays unnamed.
 */
export const LEARNING_ERROR_DEFINITIONS: readonly LearningErrorDefinition[] = [
  {
    category: "missing_units",
    label: "Missing or incorrect units",
    wording: /\bunits?\b/i,
  },
  {
    category: "incorrect_precision",
    label: "Rounding, significant figures or degree of accuracy",
    wording:
      /significant fig|\bs\.f\.|decimal places|\bd\.p\.|\bround(?:s|ed|ing)?\b|degree of accuracy/i,
  },
  {
    category: "insufficient_justification",
    label: "Not justifying the answer or stating the conclusion",
    wording: /justif|conclu|\bverdict\b|explains? why|gives? (?:a )?reasons?\b/i,
  },
  {
    category: "missing_working",
    label: "Not showing enough working",
    wording:
      /\bshow(?:s|ing|n)? (?:your |the |all |clear |full )?(?:working|method|substitution|steps)\b|working (?:is )?shown|method (?:is )?shown/i,
  },
  {
    category: "terminology_misuse",
    label: "Imprecise terminology, definitions or notation",
    wording:
      /terminolog|key (?:term|word)s?\b|technical (?:term|vocabulary|language)|scientific (?:term|vocabulary)|\bdefin(?:e|es|ition)|\bnotation\b/i,
  },
  {
    category: "graph_error",
    label: "Graph or diagram conventions (axes, labels, plotting)",
    wording:
      /\baxes\b|\baxis\b|\blabel(?:s|led|ling)? (?:the |both )?(?:diagram|graph|axes|axis)|line of best fit|\bplot(?:s|ted|ting)?\b/i,
  },
  {
    category: "comparison_error",
    label: "Incomplete comparisons",
    wording: /\bcompar(?:e|es|ing|ison|isons)\b/i,
  },
];

export function learningErrorLabel(category: LearningErrorCategory) {
  return (
    LEARNING_ERROR_DEFINITIONS.find((definition) => definition.category === category)?.label ??
    category
  );
}

export function classifyMarkingText(text: string): LearningErrorCategory[] {
  if (!text.trim()) return [];
  return LEARNING_ERROR_DEFINITIONS.filter((definition) => definition.wording.test(text)).map(
    (definition) => definition.category
  );
}

type ParsedMarkingValue = { number: number; decimals: number; unit: string };

/** A plain number with an optional trailing unit: "12", "3.14", "12 m/s", "4.5cm²". */
const MARKING_VALUE_PATTERN = /^\s*([-+]?\d+(?:\.(\d+))?)\s*([^\d\s][^\d]*)?$/u;
const MAX_UNIT_LENGTH = 15;
/** Typeset answers and schemes often write a negative with U+2212 rather than a hyphen. */
const UNICODE_MINUS = String.fromCharCode(0x2212);

/**
 * A scheme or candidate value, when it is simple enough to compare exactly.
 *
 * Anything else -- an expression, a fraction, thousands separators, a
 * currency symbol in front -- returns null, and no error is inferred from it.
 */
export function parseMarkingValue(text: string): ParsedMarkingValue | null {
  const match = MARKING_VALUE_PATTERN.exec(text.split(UNICODE_MINUS).join("-"));
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[3] ?? "").trim();
  if (!Number.isFinite(number) || unit.length > MAX_UNIT_LENGTH) return null;
  return { number, decimals: match[2]?.length ?? 0, unit };
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Errors read straight from the marker's structured values.
 *
 * The strongest evidence there is, because it is a comparison rather than a
 * reading of wording: the scheme wanted "12 m/s", the candidate wrote "12".
 * A scheme value with a unit is a units opportunity; one with decimals is a
 * precision opportunity. Each counts as missed only when the criterion lost
 * credit *and* the values show that specific slip.
 */
export function markingValueChecks(input: {
  schemeValue?: string;
  candidateValue?: string;
  lostCredit: boolean;
}): LearningErrorCheck[] {
  const scheme = input.schemeValue ? parseMarkingValue(input.schemeValue) : null;
  if (!scheme) return [];
  const candidate = input.candidateValue ? parseMarkingValue(input.candidateValue) : null;
  const checks: LearningErrorCheck[] = [];
  if (scheme.unit) {
    checks.push({
      category: "missing_units",
      missed:
        input.lostCredit &&
        candidate !== null &&
        candidate.unit === "" &&
        sameNumber(candidate.number, scheme.number),
      detection: "marking-values",
    });
  }
  if (scheme.decimals > 0) {
    const decimals = candidate ? Math.min(candidate.decimals, scheme.decimals) : 0;
    checks.push({
      category: "incorrect_precision",
      missed:
        input.lostCredit &&
        candidate !== null &&
        !sameNumber(candidate.number, scheme.number) &&
        sameNumber(roundTo(candidate.number, decimals), roundTo(scheme.number, decimals)),
      detection: "marking-values",
    });
  }
  return checks;
}

export type MarkedCriterion = {
  criterion: string;
  awarded: boolean;
  awardedMarks?: number;
  maxMarks?: number;
  schemeValue?: string;
  candidateValue?: string;
  /**
   * The marker's own reading of why a point was lost, from the fixed list.
   * Notebook marking keeps this instead of the student's writing, which is
   * what the structured values above would otherwise be read from.
   */
  errorCategory?: LearningErrorCategory;
};

/**
 * Whether a criterion lost credit.
 *
 * A multi-mark criterion reports its marks, and six of ten is credit lost even
 * though `awarded` is true; a one-mark criterion only has the boolean.
 */
export function criterionLostCredit(criterion: MarkedCriterion) {
  if (
    typeof criterion.awardedMarks === "number" &&
    typeof criterion.maxMarks === "number" &&
    criterion.maxMarks > 0
  ) {
    return criterion.awardedMarks < criterion.maxMarks;
  }
  return !criterion.awarded;
}

const DETECTION_STRENGTH: Record<LearningErrorDetection, number> = {
  "marking-values": 3,
  "criterion-wording": 2,
  "marker-note": 1,
};

/** One criterion's checks: structured values decide any category they cover. */
function criterionChecks(criterion: MarkedCriterion): LearningErrorCheck[] {
  const lostCredit = criterionLostCredit(criterion);
  const checks = markingValueChecks({
    ...(criterion.schemeValue !== undefined ? { schemeValue: criterion.schemeValue } : {}),
    ...(criterion.candidateValue !== undefined ? { candidateValue: criterion.candidateValue } : {}),
    lostCredit,
  });
  const covered = new Set(checks.map((check) => check.category));
  for (const category of classifyMarkingText(criterion.criterion)) {
    if (!covered.has(category)) {
      covered.add(category);
      checks.push({ category, missed: lostCredit, detection: "criterion-wording" });
    }
  }
  // Only ever on a point that lost credit; on one that earned it, it says nothing.
  if (lostCredit && criterion.errorCategory && !covered.has(criterion.errorCategory)) {
    checks.push({ category: criterion.errorCategory, missed: true, detection: "marker-note" });
  }
  return checks;
}

/**
 * The recurring-error chances one marked answer offered, and which it missed.
 *
 * Criteria come first because they come from the mark scheme: within one
 * criterion structured values outrank wording, and across criteria any lost
 * chance counts. The marker's improvement notes only speak for categories no
 * criterion covered, and only on an answer that actually dropped marks -- on
 * full marks an improvement note is advice, not a lost mark.
 */
export function errorChecksForMarkedAnswer(input: {
  criterionResults: readonly MarkedCriterion[];
  improvements: readonly string[];
  lostMarks: boolean;
}): LearningErrorCheck[] {
  const merged = new Map<LearningErrorCategory, LearningErrorCheck>();
  for (const criterion of input.criterionResults) {
    for (const check of criterionChecks(criterion)) {
      const existing = merged.get(check.category);
      if (!existing) {
        merged.set(check.category, check);
        continue;
      }
      merged.set(check.category, {
        category: check.category,
        missed: existing.missed || check.missed,
        detection:
          DETECTION_STRENGTH[check.detection] > DETECTION_STRENGTH[existing.detection]
            ? check.detection
            : existing.detection,
      });
    }
  }
  if (input.lostMarks) {
    for (const improvement of input.improvements) {
      for (const category of classifyMarkingText(improvement)) {
        if (!merged.has(category)) {
          merged.set(category, { category, missed: true, detection: "marker-note" });
        }
      }
    }
  }
  return Array.from(merged.values());
}

export function compareErrorDetection(
  left: LearningErrorDetection,
  right: LearningErrorDetection
) {
  return DETECTION_STRENGTH[right] - DETECTION_STRENGTH[left];
}
