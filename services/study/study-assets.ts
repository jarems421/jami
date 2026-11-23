import {
  collection,
  documentId,
  getDocs,
  query,
  where,
  type QuerySnapshot,
} from "firebase/firestore";
import { auth, db } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";
import type { StudyAsset } from "@/lib/ai/study-assets";
import type { CardStudySettings, StudyVariantReportReason } from "@/lib/study/study-modes";
import { hasCurrentStudySource } from "@/lib/study/asset-freshness";
import type { Card } from "@/lib/study/cards";
import { STUDY_ASSET_PROMPT_VERSION, STUDY_ASSET_SCHEMA_VERSION, STUDY_ASSET_VALIDATOR_VERSION } from "@/lib/study/study-asset-versions";

const LOAD_MS = 1_500;
/** Firestore's `in` filter takes at most thirty values per query. */
const ID_QUERY_CHUNK = 30;

export type StudyAssetPreparation = {
  jobId: string;
  status: "completed" | "failed" | "running";
  requested: number;
  prepared: number;
  reused: number;
  failed: number;
  validatedMcqVariants?: number;
  validatedGapVariants?: number;
};

async function authHeaders() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await user.getIdToken()}`,
  };
}

/**
 * Why preparation was refused, in the terms the caller acts on.
 *
 * Only one of these means stop: the day's allowance is spent, and every
 * further request will be refused the same way. Being asked to slow down is
 * a wait, not an end, and treating it as the end is what left a session's
 * later cards unprepared -- the first refusal stopped the whole background
 * pass, and every card after it arrived with no question.
 */
export class StudyAssetPreparationError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, code: string | null, retryAfterSeconds: unknown) {
    super(message);
    this.name = "StudyAssetPreparationError";
    this.status = status;
    this.code = code;
    this.retryAfterMs =
      typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : null;
  }

  /** Worth trying again after a pause: too many at once, or the provider stumbled. */
  get isTemporary() {
    return this.code === "burst_limit" || this.status >= 500 || this.status === 0;
  }
}

/**
 * Ask the server to prepare study material for a deck.
 *
 * Only ever called from an explicit Prepare action. Nothing about editing or
 * creating a card reaches this.
 */
export async function prepareStudyAssets(input: {
  deckId: string;
  cardIds: string[];
  /** A session pinned to multiple choice: cards prepared with no question get one more try. */
  purpose?: "multiple-choice";
  refreshCardIds?: string[];
}, onReady?: (assets: Record<string, StudyAsset>) => void): Promise<StudyAssetPreparation> {
  let response: Response;
  try {
    response = await fetch("/api/ai/study-assets/jobs", {
      method: "POST",
      headers: { ...await authHeaders(), ...(onReady ? { Accept: "application/x-ndjson" } : {}) },
      body: JSON.stringify(input),
    });
  } catch {
    throw new StudyAssetPreparationError("Jami could not reach the server.", 0, null, null);
  }

  if (response.ok && response.headers.get("content-type")?.includes("application/x-ndjson")) {
    return readStudyAssetUpdates(response, onReady);
  }
  const data = (await response.json().catch(() => null)) as
    | (StudyAssetPreparation & { error?: string; code?: string; retryAfterSeconds?: number })
    | null;
  if (!response.ok || !data) {
    throw new StudyAssetPreparationError(
      data?.error ?? "Jami could not prepare these cards.",
      response.status,
      typeof data?.code === "string" ? data.code : null,
      data?.retryAfterSeconds
    );
  }
  return data;
}

async function readStudyAssetUpdates(response: Response, onReady?: (assets: Record<string, StudyAsset>) => void) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let summary: StudyAssetPreparation | undefined;
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "asset" && typeof event.asset?.cardId === "string") {
          onReady?.({ [event.asset.cardId]: event.asset as StudyAsset });
        } else if (event.type === "complete") {
          summary = event.summary;
        }
      }
    }
  } catch {
    // Assets already delivered are still usable. A missing summary permits a retry.
  } finally {
    reader?.releaseLock();
  }
  if (!summary) throw new StudyAssetPreparationError("Jami could not finish preparing these cards.", 503, "preparation_incomplete", null);
  return summary;
}

/**
 * Read the prepared assets for a set of cards.
 *
 * Failure is not an error worth surfacing: without assets the modes fall back
 * to what can be built deterministically, which is most of them.
 */
function assetQueries(cards: Card[], uid: string) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const unique = [...byId.keys()];
  const queries = [];
  for (let start = 0; start < unique.length; start += ID_QUERY_CHUNK) {
    queries.push(query(
      collection(db, "cardStudyAssets"),
      where("userId", "==", uid),
      where(documentId(), "in", unique.slice(start, start + ID_QUERY_CHUNK)),
    ));
  }
  return { queries, byId };
}

function readAssets(snapshot: QuerySnapshot, cards: ReadonlyMap<string, Card>, uid: string) {
  const assets: Record<string, StudyAsset> = {};
  if (auth.currentUser?.uid !== uid) return assets;
  snapshot.forEach((entry) => {
    const data = entry.data();
    const card = cards.get(entry.id);
    if (card && data.asset && hasCurrentStudySource(data, card) && !data.generationFailed
      && data.schemaVersion === STUDY_ASSET_SCHEMA_VERSION && data.promptVersion === STUDY_ASSET_PROMPT_VERSION
      && data.validatorVersion === STUDY_ASSET_VALIDATOR_VERSION && typeof data.bundleRevision === "string") {
      assets[entry.id] = {
        ...data.asset,
        retiredVariantIds: [...new Set([...(data.asset.retiredVariantIds ?? []), ...(data.retiredVariantIds ?? [])])],
        cacheKey: data.cacheKey,
        sourceFingerprint: data.sourceFingerprint,
        bundleRevision: data.bundleRevision,
        validatorVersion: data.validatorVersion,
        repairRequested: data.repairRequested === true && data.repairAttemptedForPromptVersion !== STUDY_ASSET_PROMPT_VERSION,
        mcqRetried: data.mcqRetryPromptVersion === STUDY_ASSET_PROMPT_VERSION,
        mcqOnly: data.mcqOnly === true,
        mcqRefreshAfter: typeof data.mcqRefreshAfter === "number" ? data.mcqRefreshAfter : 0,
      } as StudyAsset;
    }
  });
  return assets;
}

export async function loadStudyAssets(cards: Card[]): Promise<Record<string, StudyAsset>> {
  const uid = auth.currentUser?.uid;
  if (!uid) return {};
  const { queries, byId } = assetQueries(cards, uid);
  const deadline = Date.now() + LOAD_MS;
  const assets: Record<string, StudyAsset> = {};
  for (let index = 0; index < queries.length && Date.now() < deadline; index += 4) {
    await Promise.all(queries.slice(index, index + 4).map(async (request) => {
      try {
        const snapshot = await withTimeout(getDocs(request), Math.max(1, deadline - Date.now()), "Load study assets");
        Object.assign(assets, readAssets(snapshot, byId, uid));
      } catch {
        // The bounded startup read is best effort; preparation streams new assets.
      }
    }));
  }
  return assets;
}


/**
 * Ask a marker to judge prose that local marking could not decide.
 *
 * Returns null on every kind of failure, which the caller reads as
 * "needs-self-grade". The student's response is sent and not kept: nothing
 * here writes, logs or caches it.
 */
export async function checkTypedAnswer(input: {
  cardId: string;
  response: string;
  sourceHash: string;
  presentationId: string;
  assetKey?: string;
  bundleRevision?: string;
  gapResponses?: Record<string, string>;
  variantId?: string;
}) {
  try {
    const headers = await authHeaders();
    const response = await fetch("/api/ai/study-answer/check", {
      method: "POST",
      headers: { ...headers, "x-idempotency-key": input.presentationId },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      verdict: "correct" | "partial" | "incorrect" | "needs-self-grade";
      feedback?: string;
      missingConcepts?: string[];
      gapResults?: import("@/lib/study/answer-marking").MarkedAnswer["gapResults"];
    };
    return data.verdict === "needs-self-grade" ? null : data;
  } catch (error) {
    console.warn("Semantic answer check was unavailable.", error);
    return null;
  }
}

/** Fold a prepared asset into the settings the deterministic markers read. */
export function retireStudyAsset(assets: Record<string, StudyAsset>, cardId: string, variantId: string) {
  const asset = assets[cardId];
  return asset ? { ...assets, [cardId]: { ...asset, retiredVariantIds: [...new Set([...(asset.retiredVariantIds ?? []), variantId])], repairRequested: true } } : assets;
}

export function cardWithStudyAsset(card: Card, assets: Record<string, StudyAsset>): Card {
  const asset = assets[card.id];
  const settings = mergeAssetIntoSettings(hasCurrentStudySource(asset, card) ? asset : undefined, card.studySettings);
  return settings === card.studySettings ? card : { ...card, studySettings: settings };
}

export function mergeAssetIntoSettings(
  asset: StudyAsset | undefined,
  settings: CardStudySettings | undefined
): CardStudySettings | undefined {
  if (!asset) return settings;
  const toGaps = (variant: NonNullable<StudyAsset["gapVariants"]>[number]) => {
    return variant.gaps.flatMap((gap, index) => {
      return [{ id: `${variant.id}-${index + 1}`, start: gap.start, end: gap.end, answer: gap.answer, acceptedAnswers: gap.acceptedAnswers, concept: gap.concept }];
    });
  };
  const generatedGaps = (asset.gapVariants ?? []).map((variant) => ({ id: variant.id, gaps: toGaps(variant) })).filter((variant) => variant.gaps.length > 0);
  const generatedMcqs = asset.mcqVariants ?? [];
  return {
    ...settings,
    acceptedAnswers:
      settings?.acceptedAnswers !== undefined
        ? settings.acceptedAnswers
        : asset.acceptedAliases,
    requiredConcepts:
      settings?.requiredConcepts !== undefined
        ? settings.requiredConcepts
        : asset.requiredConcepts,
    // Only authors own these overrides. Legacy generated fields are never
    // promoted into author settings or used to bypass variant validation.
    mcqExplanations: {
      ...asset.misconceptions,
      ...settings?.mcqExplanations,
    },
    generatedStudy: {
      bundleVersion: STUDY_ASSET_SCHEMA_VERSION,
      sourceHash: asset.cacheKey ?? "legacy",
      ...(asset.bundleRevision ? { bundleRevision: asset.bundleRevision } : {}),
      ...(asset.validatorVersion ? { validatorVersion: asset.validatorVersion } : {}),
      ...(asset.task ? { taskProfile: {
        task: asset.task,
        preferredModes: asset.preferredModes?.length ? asset.preferredModes : ["classic"],
        suitableModes: asset.suitableModes?.length ? asset.suitableModes : ["classic"],
        reasons: ["prepared-classification"],
        source: "prepared" as const,
      } } : {}),
      gapVariants: generatedGaps,
      mcqVariants: generatedMcqs,
      retiredVariantIds: Array.from(new Set([...(asset.retiredVariantIds ?? []), ...(settings?.generatedStudy?.retiredVariantIds ?? [])])),
    },
  };
}

export async function reportStudyVariant(input: {
  cardId: string;
  variantId: string;
  bundleVersion: number;
  reason: StudyVariantReportReason;
}) {
  const response = await fetch("/api/ai/study-assets/report", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Jami could not save that report.");
}
