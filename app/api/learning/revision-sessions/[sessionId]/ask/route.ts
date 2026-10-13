import type { NextRequest } from "next/server";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { createLogger } from "@/lib/observability/logger";
import { projectRevisionSession } from "@/lib/revision/view";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { answerRevisionQuestion, MAX_REVISION_QUESTION_LENGTH } from "@/services/ai/revision-session.server";
import {
  checkAiBudget,
  createAiBudgetLimitResponse,
  refundAiBudget,
} from "@/services/ai/budgets";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import {
  loadRevisionConceptContext,
  revisionSessionsUnavailable,
} from "@/services/learning/revision-session-context.server";
import { loadRevisionSession } from "@/services/learning/revision-sessions.server";

export const runtime = "nodejs";
/** The answer allows twenty-five seconds, the material search six. */
export const maxDuration = 40;

const log = createLogger({ route: "learning.revision-sessions.ask" });

/**
 * A question asked in the middle of a session: "why did you divide by two?"
 *
 * Answered from what the student can already see -- the projected view, so a
 * hint or an answer they have not unlocked never reaches the prompt -- and a
 * few passages of their own material. It changes nothing: not the step, not
 * the marks, not the evidence, and neither the question nor the answer is
 * stored anywhere.
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

  const body = (await request.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return apiFailure("Ask Jami a question first.", 400, "invalid_request");
  if (question.length > MAX_REVISION_QUESTION_LENGTH) {
    return apiFailure("That question is too long. Ask it in a sentence or two.", 400, "invalid_request");
  }

  const record = await loadRevisionSession(uid, sessionId.slice(0, 120));
  if (!record) return apiFailure("That session could not be found.", 404, "not_found");
  const step = projectRevisionSession(record).step;
  if (record.status !== "active" || !step) {
    return apiFailure("This session has moved on.", 409, "not_active");
  }

  // Part of a session already counted when it started, so it spends no allowance of its own.
  const budget = await checkAiBudget({ uid, action: "revisionQuestion", allowance: null });
  if (!budget.allowed) return createAiBudgetLimitResponse("revisionQuestion", budget);
  enterAiSpendContext(aiSpendContextFor(uid, "revisionQuestion"));

  const context = await loadRevisionConceptContext(uid, record.target, {
    materialQuery: `${record.target.conceptLabel}: ${question}`,
  });
  const answer = await answerRevisionQuestion({ context, step, question });
  if (!answer) {
    await refundAiBudget(budget.grant).catch(() => undefined);
    return apiFailure("Jami couldn't answer that just now. Try again.", 503, "answer_failed");
  }
  log.info("question.answered", { sessionId: record.id, step: step.kind });
  return Response.json({ answer });
}
