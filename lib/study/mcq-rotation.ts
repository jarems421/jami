import { normalizeAnswerText } from "@/lib/study/answer-marking";

type Variant = { id: string; distractors: readonly string[] };
const MAX_VARIANTS = 4;
export const MCQ_REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

/** A shuffle or a single changed wrong option does not make a fresh question. */
export function mergeMcqVariants<T extends Variant>(existing: readonly T[], proposals: readonly T[]) {
  const variants = [...existing];
  const keys = (variant: T) => new Set(variant.distractors.map(normalizeAnswerText));
  for (const proposal of proposals) {
    const shown = keys(proposal);
    if (variants.some((prior) => [...keys(prior)].filter((option) => shown.has(option)).length >= 2)) continue;
    variants.push(proposal);
  }
  return variants.slice(-MAX_VARIANTS);
}

export function needsFreshMcq(
  playableIds: readonly string[],
  recent: readonly string[],
  refreshAfter: number,
  now: number,
) {
  return refreshAfter <= now && playableIds.length > 0 && playableIds.every((id) => recent.includes(id));
}
