import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { start } from "workflow/api";
import { canStoreSourceCardReview, mapVideoCardJobData, readCardReviewEdits } from "@/lib/ai/video-card-jobs";
import { checkAiBudget, createAiBudgetLimitResponse, refundAiBudget } from "@/services/ai/budgets";
import { failSourceCardFollowUp } from "@/services/ai/source-card-follow-up.server";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { getAdminDb } from "@/services/firebase/admin";
import { generateVideoCardWorkflow } from "@/workflows/video-card-generation";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");
  const { jobId } = await params;
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(jobId)) return apiFailure("Drafts not found.", 404, "not_found");
  const body = await request.json().catch(() => null);
  const focus = typeof body?.focus === "string" ? body.focus.trim() : "";
  const submitted = body?.drafts;
  if (!focus || focus.length > 500 || !Array.isArray(submitted) || typeof body.updatedAt !== "number") {
    return apiFailure("Describe the material you want Jami to revisit.", 400, "invalid_request");
  }
  const db = getAdminDb();
  const ref = db.collection("users").doc(uid).collection("videoCardJobs").doc(jobId);
  const snapshot = await ref.get();
  const raw = snapshot.data();
  if (!raw) return apiFailure("Drafts not found.", 404, "not_found");
  const job = mapVideoCardJobData(jobId, raw);
  const expiresAt = raw.expiresAt?.toMillis?.();
  if (job.status !== "ready" || !job.canRequestMore || job.followUp?.status === "running"
    || job.updatedAt !== body.updatedAt || (typeof expiresAt === "number" && expiresAt <= Date.now() + 6 * 60_000)) {
    return apiFailure("This review has changed or its source has expired. Reopen the review to see the latest drafts.", 409, "review_unavailable");
  }
  const drafts = readCardReviewEdits(job, submitted);
  if (!drafts || drafts.length !== job.drafts.length || !canStoreSourceCardReview(drafts, job.evidence)) {
    return apiFailure("Finish editing the current drafts before asking for more cards.", 400, "invalid_drafts");
  }

  const budget = await checkAiBudget({ uid, action: "videoCardImport", skipBurstLimit: true }).catch(() => null);
  if (!budget) return apiFailure("AI usage limits are temporarily unavailable.", 503, "budget_unavailable");
  if (!budget.allowed) return createAiBudgetLimitResponse("videoCardImport", budget);
  const now = Date.now();
  const followUp = { id: randomUUID(), status: "running", focus, requestedAt: now, grant: budget.grant };
  const changes = { drafts, followUp, updatedAt: now };
  const claimed = await db.runTransaction(async (transaction) => {
    const latest = (await transaction.get(ref)).data();
    if (latest?.status !== "ready" || latest.updatedAt !== job.updatedAt || latest.followUp?.status === "running") return false;
    transaction.update(ref, changes);
    return true;
  }).catch(() => false);
  if (!claimed) {
    await refundAiBudget(budget.grant).catch(() => undefined);
    return apiFailure("This review has changed. Reopen it to see the latest drafts.", 409, "review_changed");
  }
  try {
    await start(generateVideoCardWorkflow, [uid, jobId, followUp.id]);
    return Response.json(mapVideoCardJobData(jobId, { ...raw, ...changes }), { status: 202 });
  } catch {
    const failed = await failSourceCardFollowUp(ref, followUp.id, "Jami couldn’t start checking the source. Try again.");
    return Response.json(mapVideoCardJobData(jobId, failed ?? { ...raw, ...changes }));
  }
}
