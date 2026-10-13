import "server-only";

import {
  AI_BUDGETS,
  type AiBudgetAction,
  type AiBudgetDecision,
  type AiBudgetGrant,
} from "@/lib/ai/budgets";
import { ACTION_ALLOWANCE, type AllowanceKey } from "@/lib/billing/plans";
import { emailAllowsAi } from "@/services/auth/email-confirmation.server";
import {
  checkAllowanceInTransaction,
  refundAllowanceInTransaction,
  resolveAllowanceContext,
} from "@/services/billing/allowances.server";
import { getAdminDb } from "@/services/firebase/admin";

const DAY_MS = 24 * 60 * 60 * 1000;

function getBudgetDayKey(now = Date.now()) {
  return Math.floor(now / DAY_MS).toString();
}

function getNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function getRetryAfterSeconds(target: number, now: number) {
  return Math.max(1, Math.ceil((target - now) / 1000));
}

export async function checkAiBudget(input: {
  uid: string;
  action: AiBudgetAction;
  now?: number;
  /** Durable jobs may queue the remaining daily allowance in one interaction. */
  skipBurstLimit?: boolean;
  /**
   * The monthly plan allowance this request spends. Left out, it is the one
   * `ACTION_ALLOWANCE` names for the action; null spends none (a Jami paper's
   * first marking, which came with the paper). An amount of 0 only checks that
   * something is left -- for pages, which are counted once a source is read.
   */
  allowance?: { key: AllowanceKey; amount?: number } | null;
}): Promise<AiBudgetDecision> {
  const now = input.now ?? Date.now();

  // Before anything is counted: a throwaway account made around the sign-up
  // form gets no allowance. Existing students are never refused here.
  if (!(await emailAllowsAi(input.uid, now))) {
    return { allowed: false, reason: "email_unconfirmed", retryAfterSeconds: 0 };
  }

  const config = AI_BUDGETS[input.action];
  // Null unless billing is on and this plan limits this allowance, so with
  // billing off nothing below changes from before plans existed.
  const allowance = await resolveAllowanceContext({
    uid: input.uid,
    key: input.allowance === null ? null : input.allowance?.key ?? ACTION_ALLOWANCE[input.action],
    amount: input.allowance?.amount,
    now,
  });
  const db = getAdminDb();
  const dayKey = getBudgetDayKey(now);
  const budgets = db.collection("aiBudgets");
  const dailyDocId = `${input.uid}:${input.action}:${dayKey}`;
  const burstDocId = `${input.uid}:${config.burstScope}:${dayKey}`;
  const dailyRef = budgets.doc(dailyDocId);
  const burstRef = budgets.doc(burstDocId);

  return db.runTransaction(async (transaction) => {
    const dailySnapshot = await transaction.get(dailyRef);
    const dailyData = dailySnapshot.data();
    const count = getNonNegativeInteger(dailyData?.count);

    if (count >= config.dailyRequestLimit) {
      return {
        allowed: false,
        reason: "daily_limit",
        retryAfterSeconds: getRetryAfterSeconds(
          (Number(dayKey) + 1) * DAY_MS,
          now
        ),
      };
    }

    const burstSnapshot = input.skipBurstLimit
      ? null
      : burstDocId === dailyDocId
        ? dailySnapshot
        : await transaction.get(burstRef);
    const burstData = burstSnapshot?.data();
    const storedWindowStartedAt =
      typeof burstData?.burstWindowStartedAt === "number" &&
      Number.isFinite(burstData.burstWindowStartedAt)
        ? burstData.burstWindowStartedAt
        : null;
    const isCurrentWindow =
      storedWindowStartedAt !== null &&
      now >= storedWindowStartedAt &&
      now - storedWindowStartedAt < config.burstWindowMs;
    const burstWindowStartedAt = isCurrentWindow
      ? storedWindowStartedAt
      : now;
    const burstCount = isCurrentWindow
      ? getNonNegativeInteger(burstData?.burstCount)
      : 0;

    if (!input.skipBurstLimit && burstCount >= config.burstRequestLimit) {
      return {
        allowed: false,
        reason: "burst_limit",
        retryAfterSeconds: getRetryAfterSeconds(
          burstWindowStartedAt + config.burstWindowMs,
          now
        ),
      };
    }

    // The month's allowance, read in this same transaction so the last one
    // cannot be taken twice. Read before any write, written after every check.
    const allowanceCheck = allowance
      ? await checkAllowanceInTransaction({ transaction, db, uid: input.uid, context: allowance, now })
      : null;
    if (allowanceCheck?.refusal) {
      return {
        allowed: false,
        reason: "allowance_used",
        retryAfterSeconds: allowanceCheck.refusal.retryAfterSeconds,
        message: allowanceCheck.refusal.message,
        ...(allowance ? { allowanceKey: allowance.key } : {}),
      };
    }

    const dailyUpdate = {
      uid: input.uid,
      action: input.action,
      dayKey,
      count: count + 1,
      updatedAt: now,
      ...(!input.skipBurstLimit && burstDocId === dailyDocId
        ? {
            burstScope: config.burstScope,
            burstCount: burstCount + 1,
            burstWindowStartedAt,
          }
        : {}),
    };
    transaction.set(dailyRef, dailyUpdate, { merge: true });

    if (!input.skipBurstLimit && burstDocId !== dailyDocId) {
      transaction.set(
        burstRef,
        {
          uid: input.uid,
          burstScope: config.burstScope,
          dayKey,
          burstCount: burstCount + 1,
          burstWindowStartedAt,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    allowanceCheck?.write();

    return {
      allowed: true,
      reason: null,
      retryAfterSeconds: 0,
      grant: {
        uid: input.uid,
        action: input.action,
        dayKey,
        burstWindowStartedAt,
        burstCharged: !input.skipBurstLimit,
        ...(allowance && allowance.amount > 0
          ? {
              allowance: {
                periodKey: allowance.period.key,
                key: allowance.key,
                amount: allowance.amount,
              },
            }
          : {}),
      },
    };
  });
}

/**
 * Gives a charged request back.
 *
 * A request was charged the moment it was allowed, and nothing ever handed it
 * back -- so a provider timeout or a reader who closed the drawer still cost
 * one of the day's forty, with nothing to show for it. Only counters that
 * still match the grant are touched, so a refund arriving after the burst
 * window has rolled cannot put the new window into credit.
 */
export async function refundAiBudget(grant: AiBudgetGrant) {
  const config = AI_BUDGETS[grant.action];
  const db = getAdminDb();
  const budgets = db.collection("aiBudgets");
  const dailyDocId = `${grant.uid}:${grant.action}:${grant.dayKey}`;
  const burstDocId = `${grant.uid}:${config.burstScope}:${grant.dayKey}`;
  const dailyRef = budgets.doc(dailyDocId);
  const burstRef = budgets.doc(burstDocId);

  await db.runTransaction(async (transaction) => {
    const dailySnapshot = await transaction.get(dailyRef);
    const burstSnapshot =
      burstDocId === dailyDocId
        ? dailySnapshot
        : await transaction.get(burstRef);
    const dailyData = dailySnapshot.data();
    const burstData = burstSnapshot.data();
    const applyAllowanceRefund = grant.allowance
      ? await refundAllowanceInTransaction({
          transaction,
          db,
          uid: grant.uid,
          allowance: grant.allowance,
        })
      : null;

    const count = getNonNegativeInteger(dailyData?.count);
    const burstCount = getNonNegativeInteger(burstData?.burstCount);
    const refundsBurst =
      grant.burstCharged !== false &&
      burstData?.burstWindowStartedAt === grant.burstWindowStartedAt &&
      burstCount > 0;

    if (count > 0) {
      transaction.set(
        dailyRef,
        {
          count: count - 1,
          updatedAt: Date.now(),
          ...(refundsBurst && burstDocId === dailyDocId
            ? { burstCount: burstCount - 1 }
            : {}),
        },
        { merge: true }
      );
    }

    if (refundsBurst && burstDocId !== dailyDocId) {
      transaction.set(
        burstRef,
        { burstCount: burstCount - 1, updatedAt: Date.now() },
        { merge: true }
      );
    }
    applyAllowanceRefund?.();
  });
}

const DAILY_LIMIT_MESSAGES: Record<AiBudgetAction, string> = {
  planDraft:
    "Jami has helped shape as many plans as it can today. You can still build one yourself.",
  studyAssetGeneration:
    "Jami has prepared as many decks as it can today. Try again tomorrow.",
  // Deliberately not phrased as a failure: running out costs a self-grade tap,
  // and the session carries on exactly as it would have.
  studyAnswerCheck:
    "Jami has checked as many written answers as it can today. You can still mark your own.",
  assistant: "Jami has reached today's AI limit. Try again tomorrow.",
  tutorIllustration:
    "Jami has reached today's illustration limit. Try again tomorrow.",
  practicePaperGeneration:
    "Jami has reached today's practice-paper generation limit. Try again tomorrow.",
  practicePaperMarking:
    "Jami has reached today's paper-marking limit. Try again tomorrow.",
  examQuestionMarking:
    "Jami has marked as many answers as it can today. Your work is still saved.",
  examQuestionReview:
    "Jami has checked as many marks as it can today. Try again tomorrow.",
  videoCardImport:
    "Jami has reached today's video import limit. Try again tomorrow.",
  autocompleteCard: "Jami has reached today's AI limit. Try again tomorrow.",
  diagramLabelDetection:
    "Jami has found labels on as many pictures as it can today. You can still draw the boxes yourself.",
  constellationPattern:
    "Jami has arranged as many skies as it can today. You can still move stars yourself.",
  sourceFlashcardDrafts: "AI budget reached for source drafts today.",
  sourceIndexing:
    "Jami has prepared as many sources for searching as it can today. The Tutor can still read them.",
  sourcePracticeDrafts: "AI budget reached for source drafts today.",
  photoBackgroundRestore:
    "Jami has sharpened as many photos as it can today. Your photo was still saved.",
  // Says what is still possible, because the recommendation itself has not
  // gone away -- only Jami's offer to write the material for it.
  interventionMaterial:
    "Jami has written as much study material as it can today. You can still make cards and questions yourself.",
  revisionLesson:
    "Jami has done a lot of teaching today. Try another session tomorrow.",
  // Marking running out mid-session costs a self-grade tap, not the session.
  revisionMarking:
    "Jami has checked as many answers as it can today. You can still mark your own.",
  revisionQuestion:
    "Jami has answered as many questions as it can today. The session carries on as it was.",
};

/**
 * Shown wherever AI is refused over an unconfirmed email. Only an account made
 * around Jami's sign-up form can see it, so there is nothing to offer beyond
 * saying what is needed.
 */
export const EMAIL_UNCONFIRMED_AI_MESSAGE =
  "Jami's AI needs an account with a confirmed email address. Create one through Jami's sign-up to use it.";

export function createAiBudgetLimitResponse(
  action: AiBudgetAction,
  decision: Extract<AiBudgetDecision, { allowed: false }>
) {
  if (decision.reason === "allowance_used") {
    return Response.json(
      {
        error: decision.message ?? "You've used this month's allowance for this.",
        code: decision.reason,
        ...(decision.allowanceKey ? { allowance: decision.allowanceKey } : {}),
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } }
    );
  }

  if (decision.reason === "email_unconfirmed") {
    return Response.json(
      {
        error: EMAIL_UNCONFIRMED_AI_MESSAGE,
        code: decision.reason,
        retryAfterSeconds: 0,
      },
      { status: 403 }
    );
  }

  const isBurstLimit = decision.reason === "burst_limit";
  return Response.json(
    {
      error: isBurstLimit
        ? "Jami is receiving requests too quickly. Try again in a moment."
        : DAILY_LIMIT_MESSAGES[action],
      code: decision.reason,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    {
      status: 429,
      headers: isBurstLimit
        ? { "Retry-After": String(decision.retryAfterSeconds) }
        : undefined,
    }
  );
}

/** Re-exported so a route reads its budget cap and its limit from one module. */
export { getAiTokenCap } from "@/lib/ai/budgets";
export type { AiBudgetAction, AiBudgetDecision };
