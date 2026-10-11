import type { NextRequest } from "next/server";
import { authenticateRequest } from "@/services/auth/authenticate-request.server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { mapVideoCardJobData, VIDEO_CARD_REVIEW_CEILING } from "@/lib/ai/video-card-jobs";
import type { AiBudgetGrant } from "@/lib/ai/budgets";
import { refundAiBudget } from "@/services/ai/budgets";
import { failVideoCardJobIfStalled } from "@/services/ai/video-card-job-stall.server";
import { getAdminDb, getAdminStorageBucket } from "@/services/firebase/admin";

export const runtime = "nodejs";
function failure(error: string, status: number) { return Response.json({ error }, { status }); }
function valid(id: string) { return /^[A-Za-z0-9_-]{16,160}$/.test(id); }

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const uid = await authenticateRequest(request); if (!uid) return failure("Unauthorized", 401);
  const { jobId } = await params; if (!valid(jobId)) return failure("Job not found", 404);
  const snapshot = await getAdminDb().collection("users").doc(uid).collection("videoCardJobs").doc(jobId).get();
  if (!snapshot.exists) return failure("Job not found", 404);
  const data = await failVideoCardJobIfStalled(snapshot.ref, snapshot.data() ?? {});
  return Response.json(mapVideoCardJobData(jobId, data));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const uid = await authenticateRequest(request); if (!uid) return failure("Unauthorized", 401);
  const { jobId } = await params; if (!valid(jobId)) return failure("Job not found", 404);
  let body: { drafts?: unknown }; try { body = await request.json(); } catch { return failure("Invalid request", 400); }
  if (!Array.isArray(body.drafts) || body.drafts.length > VIDEO_CARD_REVIEW_CEILING) return failure("Invalid cards", 400);
  const ref = getAdminDb().collection("users").doc(uid).collection("videoCardJobs").doc(jobId); const snap = await ref.get();
  if (!snap.exists || snap.data()?.status !== "ready") return failure("This import is not ready to edit.", 409);
  const original = new Map(mapVideoCardJobData(jobId, snap.data() ?? {}).drafts.map((card) => [card.id, card]));
  const drafts = body.drafts.flatMap((item) => { if (!item || typeof item !== "object") return []; const value = item as Record<string, unknown>; const prior = original.get(String(value.id)); const front = typeof value.front === "string" ? value.front.trim().slice(0, 500) : ""; const back = typeof value.back === "string" ? value.back.trim().slice(0, 4000) : ""; return prior && front && back ? [{ ...prior, front, back, selected: value.selected !== false }] : []; });
  if (drafts.length !== body.drafts.length) return failure("One or more cards are invalid.", 400);
  await ref.update({ drafts, updatedAt: Date.now() });
  return Response.json(mapVideoCardJobData(jobId, { ...snap.data(), drafts }));
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const uid = await authenticateRequest(request); if (!uid) return failure("Unauthorized", 401);
  const { jobId } = await params; if (!valid(jobId)) return failure("Job not found", 404);
  const ref = getAdminDb().collection("users").doc(uid).collection("videoCardJobs").doc(jobId); const snap = await ref.get();
  if (!snap.exists) return failure("Job not found", 404); const data = snap.data() ?? {};
  if (!["queued", "running", "ready"].includes(String(data.status))) return Response.json(mapVideoCardJobData(jobId, data));
  const refundable = !data.providerStartedAt && data.budgetRefunded !== true;
  const grant = refundable && data.budgetGrant && typeof data.budgetGrant === "object"
    ? data.budgetGrant as AiBudgetGrant
    : undefined;
  const now = Date.now(); await ref.update({ status: "cancelled", cancellationRequested: true, drafts: [], evidence: [], contentText: FieldValue.delete(), budgetRefunded: refundable || data.budgetRefunded === true, completedAt: now, expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000), updatedAt: now });
  if (grant) await refundAiBudget(grant).catch(() => undefined);
  if (typeof data.storagePath === "string") await getAdminStorageBucket().file(data.storagePath).delete({ ignoreNotFound: true }).catch(() => undefined);
  return Response.json(mapVideoCardJobData(jobId, { ...data, status: "cancelled", drafts: [], updatedAt: now }));
}
