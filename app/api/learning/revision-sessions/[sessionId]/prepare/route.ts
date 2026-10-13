import type { NextRequest } from "next/server";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { prepareRevisionLesson } from "@/services/ai/revision-session.server";
import {
  checkAiBudget,
  createAiBudgetLimitResponse,
  refundAiBudget,
} from "@/services/ai/budgets";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import {
  loadRevisionConceptContext,
  revisionSessionResponse,
  revisionSessionsUnavailable,
} from "@/services/learning/revision-session-context.server";
import {
  claimRevisionWork,
  failRevisionSession,
  loadRevisionSession,
  releaseRevisionWork,
  saveRevisionSession,
} from "@/services/learning/revision-sessions.server";

export const runtime = "nodejs";
/** The lesson call allows eighty seconds; the platform must allow more, at the shared 120. */
export const maxDuration = 120;

const log = createLogger({ route: "learning.revision-sessions.prepare" });

/**
 * Write the lesson for a session that has none yet.
 *
 * Idempotent: a session that is already prepared answers with itself, and one
 * being prepared by another request answers 202 so the screen waits for it
 * rather than paying for a second lesson.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const unavailable = revisionSessionsUnavailable();
  if (unavailable) return unavailable;
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");
  const { sessionId } = await params;

  const existing = await loadRevisionSession(uid, sessionId.slice(0, 120));
  if (!existing) return apiFailure("That session could not be found.", 404, "not_found");
  if (existing.status !== "preparing") return revisionSessionResponse(existing);

  const claim = await claimRevisionWork(uid, existing.id);
  if (claim.kind === "missing") return apiFailure("That session could not be found.", 404, "not_found");
  if (claim.kind === "busy") return revisionSessionResponse(existing, {}, 202);
  const record = claim.record;

  const budget = await checkAiBudget({ uid, action: "revisionLesson" });
  if (!budget.allowed) {
    await releaseRevisionWork(uid, record.id);
    return createAiBudgetLimitResponse("revisionLesson", budget);
  }
  enterAiSpendContext(aiSpendContextFor(uid, "revisionLesson"));

  const startedAt = Date.now();
  try {
    // Taught in their course's terms where their folder's material covers the concept.
    const lesson = await prepareRevisionLesson(
      await loadRevisionConceptContext(uid, record.target, { materialQuery: record.target.conceptLabel })
    );
    const saved = await saveRevisionSession(
      uid,
      { ...record, lesson, status: "active" },
      record.updatedAt
    );
    if (saved === "conflict") {
      const current = await loadRevisionSession(uid, record.id);
      return current
        ? revisionSessionResponse(current, {}, 409)
        : apiFailure("That session could not be found.", 404, "not_found");
    }
    log.info("session.prepared", { sessionId: record.id, latencyMs: Date.now() - startedAt });
    return revisionSessionResponse(saved);
  } catch (error) {
    await refundAiBudget(budget.grant).catch(() => undefined);
    await failRevisionSession(uid, record).catch(() => undefined);
    log.warn("session.prepare_failed", {
      sessionId: record.id,
      latencyMs: Date.now() - startedAt,
      error,
    });
    return apiFailure("Jami couldn't prepare this session just now.", 503, "prepare_failed");
  }
}
