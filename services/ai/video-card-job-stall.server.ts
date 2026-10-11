import type { DocumentReference } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import type { AiBudgetGrant } from "@/lib/ai/budgets";
import { isStalledVideoCardJob } from "@/lib/ai/video-card-jobs";
import { refundAiBudget } from "@/services/ai/budgets";
import { getAdminStorageBucket } from "@/services/firebase/admin";

export const STALLED_IMPORT_MESSAGE = "Jami could not start that import. Please try again.";

/**
 * Fails an import whose workflow never started, so the student gets an answer
 * instead of a bar stuck at 5%. Nothing was read or paid for, so the budget is
 * refunded and the upload freed. `cancellationRequested` stops a late-starting
 * workflow from picking the job back up.
 *
 * Returns the job data to show: the failed version if it was stalled, the
 * original otherwise.
 */
export async function failVideoCardJobIfStalled(
  ref: DocumentReference,
  data: Record<string, unknown>,
  now = Date.now()
): Promise<Record<string, unknown>> {
  if (!isStalledVideoCardJob(data, now)) return data;
  const refund = data.budgetRefunded !== true && data.budgetGrant && typeof data.budgetGrant === "object";
  const update = {
    status: "failed",
    failureMessage: STALLED_IMPORT_MESSAGE,
    cancellationRequested: true,
    budgetRefunded: refund || data.budgetRefunded === true,
    completedAt: now,
    expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000),
    updatedAt: now,
  };
  await ref.update(update);
  if (refund) await refundAiBudget(data.budgetGrant as AiBudgetGrant).catch(() => undefined);
  if (typeof data.storagePath === "string" && data.storagePath) {
    await getAdminStorageBucket().file(data.storagePath).delete({ ignoreNotFound: true }).catch(() => undefined);
  }
  return { ...data, ...update };
}
