import { randomUUID } from "node:crypto";
import { normalizeCardStudySettings } from "@/lib/study/card-study-settings";
import { getCardContentHash, type CardStudySettings } from "@/lib/study/study-modes";
import { STUDY_ASSET_VALIDATOR_VERSION } from "@/lib/study/study-asset-versions";
import { isStudyAssetRecordCurrent } from "@/lib/study/study-asset-cache";
import { MCQ_REFRESH_COOLDOWN_MS, mergeMcqVariants } from "@/lib/study/mcq-rotation";
import type { NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/services/firebase/admin";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import {
  checkAiBudget,
  createAiBudgetLimitResponse,
  refundAiBudget,
} from "@/services/ai/budgets";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { isAnyAiProviderConfigured } from "@/lib/ai/provider-router";
import {
  getStudyAssetCacheKey,
  MAX_CARDS_PER_BATCH,
  MAX_CARDS_PER_JOB,
  MAX_CONCURRENT_BATCHES,
  STUDY_ASSET_PROMPT_VERSION,
  STUDY_ASSET_SCHEMA_VERSION,
  type StudyAsset,
} from "@/lib/ai/study-assets";
import { generateMultipleChoiceBatch, generateStudyAssetBatch } from "@/services/ai/study-asset-generation.server";
import { featureFlags } from "@/lib/app/feature-flags";
import { createLogger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

/*
 * One batch's own patience, and the whole job's.
 *
 * These were twelve and twenty-one seconds, chosen to fit inside the wait a
 * student would tolerate at the start of a session. Measured against the worker
 * model, a batch of six cards takes 18-21s on the fast endpoint and 39-46s on
 * the fallback -- so every batch was being killed before it could answer and
 * first-time preparation produced nothing at all, quietly, while looking like
 * it had merely been unlucky.
 *
 * The fix was not a shorter batch. It was to stop making a student wait for the
 * whole queue: the page blocks on a few cards and prepares the rest while they
 * study, so this can afford to take as long as the work actually takes. What
 * bounds it now is the platform's own function limit, not somebody's patience.
 */
const BATCH_TIMEOUT_MS = 70_000;
const JOB_DEADLINE_MS = 110_000;
/** Below this there is no point starting another call, only finishing one. */
const MIN_USEFUL_MS = 2_500;

const log = createLogger({ route: "api.ai.study-assets" });

type OwnedCard = {
  id: string;
  front: string;
  back: string;
  studySettings?: CardStudySettings;
};

/**
 * Prepare the AI half of the study modes for one deck.
 *
 * Called when a session starts. Reuse current assets and generate only for new
 * or edited cards, requested repairs and occasional Multiple Choice refreshes.
 *
 * Save and publish each card when its own call lands so the session can use it
 * while the remaining cards are still being prepared.
 *
 * Nothing here runs because a card was created or edited. Preparation follows
 * the student into a session; it does not chase them around the app.
 */
export async function POST(request: NextRequest) {
  if (!featureFlags.enableStudyModes) {
    return apiFailure("Study modes are not enabled.", 404, "not_enabled");
  }

  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  if (!isAnyAiProviderConfigured("worker")) {
    return apiFailure(
      "Jami cannot prepare study modes just now.",
      503,
      "provider_unavailable"
    );
  }

  let deckId: string;
  let cardIds: string[];
  let wantsMultipleChoice = false;
  let refreshCardIds = new Set<string>();
  try {
    const body = (await request.json()) as Record<string, unknown>;
    deckId = typeof body.deckId === "string" ? body.deckId.trim().slice(0, 120) : "";
    cardIds = Array.isArray(body.cardIds)
      ? Array.from(
          new Set(
            body.cardIds
              .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
              .map((id) => id.trim().slice(0, 120))
          )
        ).slice(0, MAX_CARDS_PER_JOB)
      : [];
    wantsMultipleChoice = body.purpose === "multiple-choice";
    if (wantsMultipleChoice && Array.isArray(body.refreshCardIds)) {
      const requestedRefresh = new Set(body.refreshCardIds.filter((id): id is string => typeof id === "string"));
      refreshCardIds = new Set(cardIds.filter((id) => requestedRefresh.has(id)));
    }
    if (!deckId || cardIds.length === 0) {
      return apiFailure("deckId and cardIds are required", 400, "invalid_request");
    }
  } catch {
    return apiFailure("Invalid request body", 400, "invalid_request");
  }

  const db = getAdminDb();

  // Ownership is established from the server's own read of the deck and the
  // cards, never from anything the client said about them.
  const deckSnapshot = await db.collection("decks").doc(deckId).get();
  const deckData = deckSnapshot.data() ?? {};
  const deckOwner =
    typeof deckData.userId === "string" ? deckData.userId.trim() : "";
  if (!deckSnapshot.exists || deckOwner !== uid) {
    return apiFailure("Deck not found", 404, "deck_not_found");
  }

  const cardSnapshots = await db.getAll(
    ...cardIds.map((id) => db.collection("cards").doc(id))
  );
  const cards: OwnedCard[] = [];
  for (const snapshot of cardSnapshots) {
    const data = snapshot.data();
    if (!data || data.userId !== uid || data.deckId !== deckId) continue;
    const front = typeof data.front === "string" ? data.front : "";
    const back = typeof data.back === "string" ? data.back : "";
    if (!front.trim() || !back.trim()) continue;
    // Preparation reads words and cannot see a picture, so a card carrying one
    // is never prepared, whatever a client asks for.
    if (data.frontImage || data.backImage || data.occlusion) continue;
    // Read as the browser reads them, so both fingerprint the card alike.
    const studySettings = normalizeCardStudySettings(data.studySettings);
    cards.push({ id: snapshot.id, front, back, ...(studySettings ? { studySettings } : {}) });
  }
  if (cards.length === 0) {
    return apiFailure("No owned cards to prepare", 404, "no_cards");
  }

  // Deterministic analysis before spending anything: a card whose asset is
  // already cached under this exact content and prompt version costs nothing.
  const keyed = cards.map((card) => ({
    card,
    cacheKey: getStudyAssetCacheKey({
      front: card.front,
      back: card.back,
      studySettings: card.studySettings,
    }),
  }));
  const existing = await db.getAll(
    ...keyed.map((entry) => db.collection("cardStudyAssets").doc(entry.card.id))
  );
  const cached = new Set<string>();
  const previousMcqs = new Map<string, NonNullable<StudyAsset["mcqVariants"]>>();
  let cachedMcqVariants = 0;
  let cachedGapVariants = 0;
  existing.forEach((snapshot, position) => {
    const data = snapshot.data();
    const { card, cacheKey } = keyed[position];
    const usable = isStudyAssetRecordCurrent(data, { uid, card, cacheKey, wantsMultipleChoice });
    const refresh = usable && Array.isArray(data?.asset?.mcqVariants) && data.asset.mcqVariants.length > 0
      && refreshCardIds.has(card.id) && !(typeof data.mcqRefreshAfter === "number" && data.mcqRefreshAfter > Date.now());
    if (refresh) previousMcqs.set(card.id, data.asset.mcqVariants);
    if (usable && !refresh) {
      cached.add(card.id);
      cachedMcqVariants += Array.isArray(data?.asset?.mcqVariants) ? data.asset.mcqVariants.length : 0;
      cachedGapVariants += Array.isArray(data?.asset?.gapVariants) ? data.asset.gapVariants.length : 0;
    }
  });

  let pending = keyed.filter((entry) => !cached.has(entry.card.id));
  const jobId = randomUUID();
  const jobRef = db.collection("cardStudyAssetJobs").doc(jobId);

  if (pending.length === 0) {
    await jobRef.set({
      userId: uid,
      deckId,
      status: "completed",
      requested: cards.length,
      prepared: 0,
      reused: cached.size,
      failed: 0,
      validatedMcqVariants: cachedMcqVariants,
      validatedGapVariants: cachedGapVariants,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return Response.json({
      jobId,
      status: "completed",
      requested: cards.length,
      prepared: 0,
      reused: cached.size,
      failed: 0,
      validatedMcqVariants: cachedMcqVariants,
      validatedGapVariants: cachedGapVariants,
    });
  }

  let budgetDecision;
  try {
    budgetDecision = await checkAiBudget({ uid, action: "studyAssetGeneration" });
    enterAiSpendContext(aiSpendContextFor(uid, "studyAssetGeneration"));
  } catch (error) {
    log.error("budget.check_failed", { error });
    return apiFailure(
      "AI usage limits are temporarily unavailable.",
      503,
      "budget_unavailable"
    );
  }
  if (!budgetDecision.allowed) {
    return createAiBudgetLimitResponse("studyAssetGeneration", budgetDecision);
  }
  const grant = budgetDecision.grant;

  await jobRef.set({
    userId: uid,
    deckId,
    status: "running",
    requested: cards.length,
    prepared: 0,
    reused: cached.size,
    failed: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Claim repairs atomically: two tabs may both report/start preparation.
  // A failed attempt stays claimed until a new report or prompt version.
  const claims = await Promise.all(pending.map(async (entry) => {
    const ref = db.collection("cardStudyAssets").doc(entry.card.id);
    return db.runTransaction(async (transaction) => {
      const data = (await transaction.get(ref)).data();
      if (previousMcqs.has(entry.card.id)) {
        if (typeof data?.mcqRefreshAfter === "number" && data.mcqRefreshAfter > Date.now()) return false;
        // Two sessions arriving together share the refresh. Allow a later retry after a provider failure.
        transaction.set(ref, { mcqRefreshAfter: Date.now() + 5 * 60_000 }, { merge: true });
        return true;
      }
      if (data?.repairRequested !== true) return true;
      if (data.repairAttemptedForPromptVersion === STUDY_ASSET_PROMPT_VERSION) return false;
      transaction.set(ref, { repairAttemptedForPromptVersion: STUDY_ASSET_PROMPT_VERSION }, { merge: true });
      return true;
    });
  }));
  pending = pending.filter((_, index) => claims[index]);

  const batches: (typeof pending)[] = [];
  for (let start = 0; start < pending.length; start += MAX_CARDS_PER_BATCH) {
    batches.push(pending.slice(start, start + MAX_CARDS_PER_BATCH));
  }

  /** Merge what finished using the current document, even if another job landed first. */
  const saveBatch = async (
    batch: typeof pending,
    assets: StudyAsset[],
    declinedCardIds: readonly string[],
    publish?: (asset: StudyAsset) => void,
  ) => {
    await Promise.all(batch.map(async ({ card, cacheKey }) => {
      const generated = assets.find((asset) => asset.cardId === card.id);
      if (!generated && !declinedCardIds.includes(card.id)) return;

      const ref = db.collection("cardStudyAssets").doc(card.id);
      const ready = await db.runTransaction(async (transaction) => {
        const stored = (await transaction.get(ref)).data();
        const sourceFingerprint = getCardContentHash(card);
        const current = (await transaction.get(db.collection("cards").doc(card.id))).data();
        if (!current || current.userId !== uid || current.deckId !== deckId
          || getCardContentHash({
            front: current.front, back: current.back, studySettings: normalizeCardStudySettings(current.studySettings),
            frontImage: current.frontImage, backImage: current.backImage, occlusion: current.occlusion,
          }) !== sourceFingerprint) return;
        const matches = stored?.userId === uid && stored.cacheKey === cacheKey
          && stored.sourceFingerprint === sourceFingerprint
          && stored.validatorVersion === STUDY_ASSET_VALIDATOR_VERSION;
        const prior = matches && !stored?.generationFailed ? stored?.asset as StudyAsset | undefined : undefined;
        const retiredIds = new Set<string>(matches && Array.isArray(stored?.retiredVariantIds) ? stored.retiredVariantIds : []);
        const previousMcqs = (prior?.mcqVariants ?? []).filter(({ id }) => !retiredIds.has(id));
        const proposedMcqs = (generated?.mcqVariants ?? []).map((variant) => ({ ...variant, id: `${jobId}:${variant.id}` }));
        const mcqVariants = mergeMcqVariants(previousMcqs, proposedMcqs);
        const base = {
          userId: uid, deckId, cardId: card.id, cacheKey, sourceFingerprint,
          schemaVersion: STUDY_ASSET_SCHEMA_VERSION,
          promptVersion: STUDY_ASSET_PROMPT_VERSION,
          validatorVersion: STUDY_ASSET_VALIDATOR_VERSION,
          updatedAt: FieldValue.serverTimestamp(),
        };

        if (!generated && !prior && !wantsMultipleChoice) {
          transaction.set(ref, { ...base, generationFailed: true, failureKind: "declined", generationAttemptedAt: FieldValue.serverTimestamp() }, { merge: true });
          return;
        }

        const empty: StudyAsset = {
          cardId: card.id, answerShape: "short", acceptedAliases: [], requiredConcepts: [],
          clozeCandidates: [], distractors: [], misconceptions: {}, confidence: 0, ambiguous: false,
          gapVariants: [],
        };
        const retained = wantsMultipleChoice ? prior ?? empty : generated ?? prior ?? empty;
        const asset = {
          ...retained,
          mcqVariants,
          gapVariants: !wantsMultipleChoice && generated
            ? generated.gapVariants?.map((variant) => ({ ...variant, id: `${jobId}:${variant.id}` })) ?? []
            : retained.gapVariants ?? [],
        };
        const mcqOnly = wantsMultipleChoice && (!prior || stored?.mcqOnly === true);
        const bundleRevision = wantsMultipleChoice && prior ? stored?.bundleRevision ?? jobId : jobId;
        const mcqRefreshAfter = wantsMultipleChoice
          ? refreshCardIds.has(card.id) || mcqVariants.length === 0 ? Date.now() + MCQ_REFRESH_COOLDOWN_MS : 0
          : typeof stored?.mcqRefreshAfter === "number" && matches ? stored.mcqRefreshAfter : 0;
        transaction.set(ref, {
          ...base, asset,
          mcqOnly, bundleRevision, mcqRefreshAfter,
          generationFailed: false,
          failureKind: FieldValue.delete(),
          repairRequested: false,
          ...(wantsMultipleChoice ? {
            mcqRetryPromptVersion: STUDY_ASSET_PROMPT_VERSION,
          } : {}),
        }, { merge: true });
        return {
          ...asset, cacheKey, sourceFingerprint, bundleRevision, validatorVersion: STUDY_ASSET_VALIDATOR_VERSION,
          retiredVariantIds: [...retiredIds], repairRequested: false, mcqOnly, mcqRefreshAfter,
          mcqRetried: wantsMultipleChoice || stored?.mcqRetryPromptVersion === STUDY_ASSET_PROMPT_VERSION,
        };
      });
      if (ready) publish?.(ready);
    }));
  };

  /*
   * A fixed pool of workers pulling from one queue, under a shared deadline.
   *
   * Firing every batch at once was fine at twenty cards a batch, when a hundred
   * cards was five calls. At six a batch it is seventeen, and seventeen
   * simultaneous requests is a way to be rate-limited rather than a way to be
   * fast. Eight in flight is the width that keeps the provider busy without
   * queueing behind itself.
   *
   * Each worker checks the clock before starting anything: a batch that cannot
   * finish is never begun, so the job ends near its deadline instead of one
   * batch timeout past it.
   */
  const generate = async (publish?: (asset: StudyAsset) => void) => {
    const deadlineAt = Date.now() + JOB_DEADLINE_MS;
    const msLeft = () => deadlineAt - Date.now();

    let prepared = 0;
    let producedMcqVariants = 0;
    let producedGapVariants = 0;
    let failedBatches = 0;
    let skippedBatches = 0;
    let cursor = 0;

    const attempt = async (batch: typeof pending) => {
      const cards = batch.map(({ card }) => ({
        id: card.id, front: card.front, back: card.back, previousMcqs: previousMcqs.get(card.id),
      }));
      const timeoutMs = Math.min(BATCH_TIMEOUT_MS, msLeft());
      const result = wantsMultipleChoice
        ? await generateMultipleChoiceBatch(cards, timeoutMs)
        : await generateStudyAssetBatch(cards, { timeoutMs });
      await saveBatch(batch, result.assets, result.declinedCardIds, publish);
      prepared += result.assets.length;
      for (const asset of result.assets) {
        producedMcqVariants += asset.mcqVariants?.length ?? 0;
        producedGapVariants += asset.gapVariants?.length ?? 0;
      }
    };

    const worker = async () => {
      for (;;) {
        const position = cursor;
        cursor += 1;
        if (position >= batches.length) return;
        const batch = batches[position];

        if (msLeft() < MIN_USEFUL_MS) {
          skippedBatches += 1;
          continue;
        }

        try {
          await attempt(batch);
        } catch (error) {
          log.warn("batch.failed", { size: batch.length, error });
          // One retry, and only if there is still time for it to land. Retrying
          // into the deadline just spends the student's wait twice.
          if (msLeft() < MIN_USEFUL_MS) {
            failedBatches += 1;
            continue;
          }
          try {
            await attempt(batch);
          } catch (retryError) {
            log.warn("batch.retry_failed", { size: batch.length, error: retryError });
            failedBatches += 1;
          }
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) },
        worker
      )
    );

    // Nothing was produced and no provider work landed, so the request is handed
    // back. A partial success is not refunded: work was done and kept.
    if (prepared === 0) {
      try {
        await refundAiBudget(grant);
      } catch (error) {
        log.warn("budget.refund_failed", { error });
      }
    }

    const summary = {
      status:
        failedBatches + skippedBatches === batches.length ? "failed" : "completed",
      requested: cards.length,
      prepared,
      reused: cached.size,
      failed: pending.length - prepared,
      validatedMcqVariants: cachedMcqVariants + producedMcqVariants,
      validatedGapVariants: cachedGapVariants + producedGapVariants,
    };
    await jobRef.set(
      { ...summary, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    return { jobId, ...summary };
  };

  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    return Response.json(await generate());
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      send({ type: "started" });
      void generate((asset) => send({ type: "asset", asset })).then(
        (summary) => send({ type: "complete", summary }),
        (error: unknown) => log.error("stream.failed", { error }),
      ).finally(() => {
        if (!cancelled) controller.close();
      });
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" },
  });
}
