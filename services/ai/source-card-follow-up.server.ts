import "server-only";

import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import type { AiBudgetGrant } from "@/lib/ai/budgets";
import { refundAiBudget } from "@/services/ai/budgets";
import { getAdminStorageBucket } from "@/services/firebase/admin";

export async function expireSourceCardReviewInput(ref: DocumentReference, data: FirebaseFirestore.DocumentData) {
  if (data.sourceKind !== "file" && data.sourceKind !== "text") return;
  if (!data.expiresAt || data.expiresAt.toMillis() > Date.now() || data.status !== "ready") return;
  if (typeof data.storagePath === "string") {
    await getAdminStorageBucket().file(data.storagePath).delete({ ignoreNotFound: true });
  }
  await ref.update({ storagePath: FieldValue.delete(), contentText: FieldValue.delete(), evidence: [] });
}

export async function failSourceCardFollowUp(ref: DocumentReference, requestId: string, message: string, stalledBefore?: number) {
  const result = await ref.firestore.runTransaction(async (transaction) => {
    const job = (await transaction.get(ref)).data();
    const request = job?.followUp;
    if (job?.status !== "ready" || request?.id !== requestId || request.status !== "running"
      || (stalledBefore !== undefined && Number(request.progressAt ?? request.requestedAt) > stalledBefore)) return null;
    const update = { followUp: { id: requestId, status: "failed", message }, updatedAt: Date.now() };
    transaction.update(ref, update);
    return { job: { ...job, ...update }, refund: !request.startedAt ? request.grant as AiBudgetGrant | undefined : undefined };
  });
  if (result?.refund) await refundAiBudget(result.refund).catch(() => undefined);
  return result?.job;
}

export function sourceCardFollowUpError(reason: string) {
  if (reason === "source_card_review_too_large") return "This review is full. Add the cards you want to keep before starting another batch.";
  if (reason === "source_card_page_unavailable") return "Jami couldn’t read the requested slide or page. Check the number or try a clearer PDF.";
  if (reason === "source_card_no_usable_cards" || reason === "source_card_no_focus_match") {
    return "Jami found no additional cards for that request. Try a different page or topic.";
  }
  return "Jami couldn’t finish checking the source. Try again.";
}
