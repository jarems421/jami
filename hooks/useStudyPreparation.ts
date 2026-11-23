"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudyAsset } from "@/lib/ai/study-assets";
import type { Card } from "@/lib/study/cards";
import { needsStudyAssetPreparation } from "@/lib/study/mode-eligibility";
import { needsFreshMcq } from "@/lib/study/mcq-rotation";
import type { StudyModePolicy } from "@/lib/study/study-modes";
import {
  cardWithStudyAsset,
  loadStudyAssets,
  prepareStudyAssets,
  StudyAssetPreparationError,
} from "@/services/study/study-assets";
import { getPlayableMcqVariantIds } from "@/lib/study/mcq";

export type StudyPreparationProgress = {
  prepared: number;
  total: number;
};

/*
 * Preparation is a head start, not a wait for the whole queue.
 *
 * Measured on the worker (scripts/eval/study-mcq-readiness.ts, 30 Sep 2026),
 * one card takes a median of fifteen seconds to be written and checked, and
 * the slowest take forty. No batch size makes a whole session ready while
 * somebody watches. The server saves each card as it lands, and preparation
 * receives those updates directly. Multiple Choice opens on the bounded cache
 * read while questions continue to arrive.
 */
/** The visible wait for a pinned session's first card, and the only clock a student sees. */
const PREPARATION_BUDGET_MS = 25_000;
/**
 * Cards a request, in queue order.
 *
 * The server writes each on its own call, eight at a time, so a request of
 * eight is eight cards landing separately rather than a batch landing at once.
 * Fewer, larger requests also keep a session inside the per-minute request
 * limit, which it used to hit -- and hitting it stopped preparation outright.
 */
const PREPARATION_CHUNK_SIZE = 8;
const PREPARATION_CONCURRENCY = 2;
/** A queue longer than this is prepared as far as it goes and no further. */
const MAX_PREPARED_CARDS_PER_SESSION = 100;
/** A request refused for being one too many is tried again this many times. */
const TEMPORARY_RETRIES = 2;
const TEMPORARY_RETRY_DELAY_MS = 8_000;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

type PreparationRequest = {
  deckId: string;
  cards: Card[];
};

/**
 * Split cards into requests, in queue order.
 *
 * Grouped by deck because the endpoint verifies ownership one deck at a time;
 * the order is kept so the cards a student reaches first are asked for first.
 */
function toRequests(cards: readonly Card[], size: number): PreparationRequest[] {
  const requests: PreparationRequest[] = [];
  const open = new Map<string, PreparationRequest>();
  for (const card of cards) {
    let request = open.get(card.deckId);
    if (!request || request.cards.length >= size) {
      request = { deckId: card.deckId, cards: [] };
      open.set(card.deckId, request);
      requests.push(request);
    }
    request.cards.push(card);
  }
  return requests;
}

/**
 * Getting cards ready to be asked well, without making anyone wait for it.
 *
 * Lifted out of the study page because it is a self-contained job with its own
 * clock, its own concurrency and its own reasons, and the page was long enough
 * that none of that was findable inside it.
 *
 * The caller does two things with this: it awaits `prepareSessionAssets` before
 * building the queue, and it starts `prepareRemainingAssets` afterwards without
 * awaiting. `progress` is non-null only while somebody is actually being kept
 * waiting, so a session with nothing to prepare renders no panel at all.
 */
export function useStudyPreparation(input: {
  enabled: boolean;
  modePolicy: StudyModePolicy;
  /** Called whenever prepared assets land. */
  onAssetsReady: (assets: Record<string, StudyAsset>) => void;
}) {
  const { enabled: studyModesEnabled, modePolicy, onAssetsReady } = input;
  const [preparation, setPreparation] = useState<StudyPreparationProgress | null>(
    null
  );
  /** Set while preparing so Start now can stop the wait without cancelling it. */
  const skipPreparationRef = useRef<(() => void) | null>(null);
  const jobsRef = useRef(new Set<{ value: boolean }>());
  const epochRef = useRef(0);
  const stoppedRef = useRef(false);
  /** Cards with a request in flight, and how many requests each is in. */
  const inFlightRef = useRef(new Map<string, number>());
  const refreshRef = useRef(new Set<string>());
  /** Set once the day's allowance is spent: nothing more is sent this session. */
  const exhaustedRef = useRef(false);
  const onAssetsReadyRef = useRef(onAssetsReady);
  useEffect(() => {
    onAssetsReadyRef.current = onAssetsReady;
  }, [onAssetsReady]);

  const cancel = useCallback(() => {
    stoppedRef.current = true;
    epochRef.current += 1;
    for (const stop of jobsRef.current) stop.value = true;
    jobsRef.current.clear();
    inFlightRef.current.clear();
    refreshRef.current.clear();
    exhaustedRef.current = false;
    skipPreparationRef.current?.();
  }, []);
  useEffect(() => { stoppedRef.current = false; return cancel; }, [cancel]);



  const purpose =
    modePolicy.kind === "fixed" && modePolicy.mode === "multiple-choice"
      ? ("multiple-choice" as const)
      : undefined;

  /**
   * Send one request, trying again when the refusal was only about timing.
   *
   * Being asked to slow down is a wait, not an end: treating it as the end is
   * what left a session's later cards with no question, because the first
   * refusal stopped the whole background pass. Only a spent daily allowance,
   * or a failure no wait fixes, stops preparation. Returns whether the request
   * went through.
   */
  const send = useCallback(
    async (request: PreparationRequest, stop: { value: boolean }) => {
      if (exhaustedRef.current || stop.value) return false;
      const epoch = epochRef.current;
      for (const card of request.cards) {
        inFlightRef.current.set(card.id, (inFlightRef.current.get(card.id) ?? 0) + 1);
      }
      const delivered = new Set<string>();
      const onReady = (assets: Record<string, StudyAsset>) => {
        const ids = Object.keys(assets);
        if (epoch !== epochRef.current || !ids.length) return;
        for (const id of ids) delivered.add(id);
        onAssetsReadyRef.current(assets);
      };
      const refreshCardIds = request.cards.filter((card) => refreshRef.current.has(card.id)).map((card) => card.id);
      try {
        for (let attempt = 0; ; attempt += 1) {
          if (stop.value || epoch !== epochRef.current) return false;
          try {
            await prepareStudyAssets({
              deckId: request.deckId,
              cardIds: request.cards.map((card) => card.id),
              ...(purpose ? { purpose } : {}),
              ...(refreshCardIds.length ? { refreshCardIds } : {}),
            }, onReady);
            return true;
          } catch (error) {
            const temporary = error instanceof StudyAssetPreparationError && error.isTemporary;
            if (!temporary || attempt >= TEMPORARY_RETRIES) {
              console.warn("Study preparation was cut short.", error);
              if (
                error instanceof StudyAssetPreparationError &&
                (error.code === "daily_limit" ||
                  error.code === "allowance_used" ||
                  error.code === "email_unconfirmed")
              ) {
                exhaustedRef.current = true;
              }
              return false;
            }
            await wait(
              (error instanceof StudyAssetPreparationError ? error.retryAfterMs : null) ??
                TEMPORARY_RETRY_DELAY_MS
            );
          }
        }
      } finally {
        if (epoch === epochRef.current) {
          for (const card of request.cards) {
            const count = (inFlightRef.current.get(card.id) ?? 1) - 1;
            if (count <= 0) inFlightRef.current.delete(card.id);
            else inFlightRef.current.set(card.id, count);
          }
          const undelivered = request.cards.filter(({ id }) => !delivered.has(id));
          if (undelivered.length) void loadStudyAssets(undelivered).then(onReady).catch(() => undefined);
        }
      }
    },
    [purpose]
  );

  /**
   * Keep preparing after the session has opened.
   *
   * Nothing waits on this. Cards are asked for in queue order, a few requests
   * at a time, and handed to the page as each one lands.
   */
  const prepareRemainingAssets = useCallback(async (remainder: Card[], headStart: Card[] = []) => {
    const pending = [...headStart, ...remainder].filter(
      (card) => !inFlightRef.current.has(card.id)
    );
    if (pending.length === 0 || stoppedRef.current) return;
    const stop = { value: false };
    jobsRef.current.add(stop);
    const requests = toRequests(pending, PREPARATION_CHUNK_SIZE);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const position = cursor;
        cursor += 1;
        if (stop.value || position >= requests.length) return;
        const kept = await send(requests[position], stop);
        if (!kept && exhaustedRef.current) stop.value = true;
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(PREPARATION_CONCURRENCY, requests.length) }, worker)
      );
    } catch (error) {
      console.warn("Background study preparation stopped.", error);
    } finally {
      jobsRef.current.delete(stop);
    }
  }, [send]);

  /**
   * Read cached cards before the session opens and identify the cards worth
   * preparing while the student works.
   *
   * Everything good about the non-Classic modes comes from here. Without it a
   * gap is chosen by a rule that can only see which words look important, and a
   * multiple-choice question has no wrong answers worth offering -- which is
   * why multiple choice is not built at all for an unprepared card rather than
   * being built badly.
   *
   * Cached cards never leave the browser, so a deck studied before returns
   * instantly and this does no work at all.
   */
  const prepareSessionAssets = useCallback(
    async (
      queue: Card[],
      history?: Promise<{ variants: Record<string, string[]> }>,
    ): Promise<{
      assets: Record<string, StudyAsset>;
      /** For the caller to start behind the session with prepareRemainingAssets. */
      headStart: Card[];
      remainder: Card[];
    }> => {
      const empty = { assets: {}, headStart: [] as Card[], remainder: [] as Card[] };
      cancel();
      stoppedRef.current = false;
      const epoch = epochRef.current;
      if (!studyModesEnabled || queue.length === 0) return empty;
      if (typeof navigator !== "undefined" && !navigator.onLine) return empty;

      // Only cards a model would actually improve. A deck of formulas or
      // numeric answers passes straight through here, spends nothing, and
      // starts with no wait at all.
      const worthPreparing = queue.filter((card) =>
        needsStudyAssetPreparation(card, modePolicy)
      );
      if (worthPreparing.length === 0) return empty;

      const [known, seen] = await Promise.all([loadStudyAssets(worthPreparing), purpose ? history : undefined]);
      if (epoch !== epochRef.current) return empty;
      if (purpose) {
        const now = Date.now();
        for (const card of worthPreparing) {
          const asset = known[card.id];
          if (!asset?.mcqVariants?.length) continue;
          const playable = getPlayableMcqVariantIds(cardWithStudyAsset(card, known));
          const refreshAfter = asset.mcqRefreshAfter ?? 0;
          if ((!playable.length && refreshAfter === 0)
            || needsFreshMcq(playable, seen?.variants[card.id] ?? [], refreshAfter, now)) refreshRef.current.add(card.id);
        }
      }
      const missing = worthPreparing
        .filter((card) => {
          const asset = known[card.id];
          if (!asset || asset.repairRequested) return true;
          if (purpose && refreshRef.current.has(card.id)) return true;
          if (!purpose && asset.mcqOnly) return true;
          // Prepared with no question: a session that wants one asks once more.
          return purpose === "multiple-choice" && !asset.mcqVariants?.length && !asset.mcqRetried;
        })
        .slice(0, MAX_PREPARED_CARDS_PER_SESSION);
      if (missing.length === 0) return { assets: known, headStart: [], remainder: [] };

      // Smart Mix never waits: a card reached before its assets is asked a way
      // that needs none.
      if (modePolicy.kind === "smart" || purpose) {
        // Multiple Choice opens on cached material or the bounded question stage.
        // Generate cold cards before enriching ones that already have options.
        const needed = missing.filter((card) => !refreshRef.current.has(card.id));
        const refresh = missing.filter((card) => refreshRef.current.has(card.id));
        return { assets: known, headStart: [], remainder: [...needed, ...refresh] };
      }

      /*
       * A pinned session waits for its first card, and only that one.
       *
       * The rest start at the same moment rather than after it: they used to be
       * sent once the session had opened, so every card after the first began
       * its fifteen seconds only when the student was already answering, and a
       * quick student reached the second card before it had been asked for.
       */
      const [first, ...rest] = missing;
      const stop = { value: false };
      jobsRef.current.add(stop);
      setPreparation({ prepared: 0, total: 1 });
      const firstRequest = send({ deckId: first.deckId, cards: [first] }, stop);
      void prepareRemainingAssets(rest);

      let expiryTimer = 0;
      const expiry = new Promise<void>((resolve) => {
        expiryTimer = window.setTimeout(resolve, PREPARATION_BUDGET_MS);
      });
      const skipped = new Promise<void>((resolve) => {
        skipPreparationRef.current = resolve;
      });

      try {
        await Promise.race([firstRequest, expiry, skipped]);
      } finally {
        // The first card's request is left to finish: the reader hands it to
        // the session whenever it lands.
        window.clearTimeout(expiryTimer);
        skipPreparationRef.current = null;
        /*
         * Take the panel down here rather than leaving it to the caller.
         *
         * The caller clears it once this whole function returns, which is one
         * read of the cache later -- so pressing Start now left the overlay up
         * for a further round trip while the button appeared to have done
         * nothing. The waiting is over the moment the race settles, whether it
         * settled by finishing, by expiring or by being skipped.
         */
        setPreparation(null);
        jobsRef.current.delete(stop);
      }

      const refreshed = await loadStudyAssets(missing);
      if (epoch !== epochRef.current) return empty;
      return { assets: { ...known, ...refreshed }, headStart: [], remainder: [] };
    },
    [modePolicy, studyModesEnabled, cancel, prepareRemainingAssets, purpose, send]
  );

  /**
   * Prepare the card a student is waiting on, and the next few behind it.
   *
   * The background pass is usually well ahead, but a student can still reach a
   * card before it. That card is sent on its own, because a request's reply
   * waits for every card in it and a student is watching this one; the next
   * two go in a request of their own beside it. A card already on its way is
   * not asked for twice -- the reader hands it over when it lands.
   *
   * Resolves to the card's asset, or null when none could be made now.
   * "pending" means it is still on its way from an earlier request.
   */
  const prepareCardNow = useCallback(
    async (card: Card, lookAhead: readonly Card[] = []): Promise<StudyAsset | null | "pending"> => {
      if (!studyModesEnabled) return null;
      if (typeof navigator !== "undefined" && !navigator.onLine) return null;
      const stop = { value: false };
      const epoch = epochRef.current;
      jobsRef.current.add(stop);

      const ahead = lookAhead
        .filter(
          (next) =>
            next.deckId === card.deckId && next.id !== card.id && !inFlightRef.current.has(next.id)
        )
        .slice(0, 2);
      try {
        if (ahead.length > 0) void send({ deckId: card.deckId, cards: ahead }, stop);
        if (inFlightRef.current.has(card.id)) return "pending";
        const kept = await send({ deckId: card.deckId, cards: [card] }, stop);
        if (!kept) return null;
        const refreshed = await loadStudyAssets([card]);
        if (stop.value || epoch !== epochRef.current) return null;
        onAssetsReadyRef.current(refreshed);
        return refreshed[card.id] ?? null;
      } catch (error) {
        console.warn("Jami could not prepare this card in time.", error);
        return null;
      } finally {
        jobsRef.current.delete(stop);
      }
    },
    [send, studyModesEnabled]
  );

  return {
    cancel,
    /** Non-null only while a student is being kept waiting. */
    progress: preparation,
    clearProgress: useCallback(() => setPreparation(null), []),
    skip: useCallback(() => skipPreparationRef.current?.(), []),
    prepareSessionAssets,
    prepareRemainingAssets,
    prepareCardNow,
  };
}
