import { getCardContentHash } from "@/lib/study/study-modes";
import {
  STUDY_ASSET_PROMPT_VERSION,
  STUDY_ASSET_VALIDATOR_VERSION,
} from "@/lib/study/study-asset-versions";

type StoredStudyAsset = {
  userId?: unknown;
  sourceFingerprint?: unknown;
  cacheKey?: unknown;
  repairRequested?: unknown;
  repairAttemptedForPromptVersion?: unknown;
  generationFailed?: unknown;
  failureKind?: unknown;
  validatorVersion?: unknown;
  mcqRetryPromptVersion?: unknown;
  mcqOnly?: unknown;
  asset?: { mcqVariants?: unknown };
};

/**
 * Whether a stored document already answers for this card, so preparing it
 * again would buy nothing.
 *
 * A success under the current content does, and so does a card the model
 * turned down -- asking again would pay for the same refusal. A failure that
 * was not a refusal does not: a timeout, a provider error or a reply that could
 * not be read says nothing about the card. Those used to be stored exactly like
 * refusals, and a card that met one blip then could not be asked as multiple
 * choice until its text was edited. Records from before the distinction carry
 * no kind, and are asked again for the same reason.
 *
 * A session pinned to multiple choice also asks once more about a card that
 * was prepared with no question: the review may simply have turned down both
 * of the first attempt's variants. Once per prompt version, so a card that
 * genuinely suits no multiple choice costs one second try and no more.
 */
export function isStudyAssetRecordCurrent(
  data: StoredStudyAsset | undefined,
  input: {
    uid: string;
    card: Parameters<typeof getCardContentHash>[0];
    cacheKey: string;
    wantsMultipleChoice: boolean;
  }
) {
  if (!data || data.userId !== input.uid) return false;
  if (data.sourceFingerprint !== getCardContentHash(input.card)) return false;
  if (data.cacheKey !== input.cacheKey) return false;
  if (
    data.repairRequested === true &&
    data.repairAttemptedForPromptVersion !== STUDY_ASSET_PROMPT_VERSION
  ) {
    return false;
  }
  if (data.generationFailed) return data.failureKind === "declined";
  if (!input.wantsMultipleChoice && data.mcqOnly === true) return false;
  if (data.validatorVersion !== STUDY_ASSET_VALIDATOR_VERSION) return false;
  const hasQuestion =
    Array.isArray(data.asset?.mcqVariants) && data.asset.mcqVariants.length > 0;
  if (
    input.wantsMultipleChoice &&
    !hasQuestion &&
    data.mcqRetryPromptVersion !== STUDY_ASSET_PROMPT_VERSION
  ) {
    return false;
  }
  return true;
}
