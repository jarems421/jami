import "server-only";

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { JamiAssistantRequest } from "@/lib/ai/jami-assistant";
import { parseJamiAssistantRequest } from "@/lib/ai/jami-assistant-request";
import { describeUnmetAiProviderRequirements } from "@/lib/ai/provider-policy";
import { isAnyAiProviderConfigured } from "@/lib/ai/provider-router";
import { createLogger, type Logger } from "@/lib/observability/logger";
import { authenticateRequest } from "@/services/auth/authenticate-request.server";

/**
 * The gate a Tutor turn passes before anything is read or charged: an AI
 * provider to answer with, a signed-in student, and a request that parses.
 */

/** A refusal sent before the answer starts, as JSON with a code the drawer reads. */
export function tutorFailureResponse(error: string, status: number, code: string) {
  return Response.json({ error, code }, { status });
}

/** A turn that passed the gate: who is asking, when, and what. */
export type OpenedTutorTurn = {
  caller: { uid: string };
  startedAt: number;
  log: Logger;
  parsedRequest: JamiAssistantRequest;
};

/** The opened turn, or the response that refuses it. */
export async function openTutorTurn(request: NextRequest): Promise<OpenedTutorTurn | Response> {
  if (!isAnyAiProviderConfigured()) {
    /*
     * Say which requirement is unmet, because this refusal used to say nothing.
     *
     * The check ran before the logger was created, so the single most common AI
     * failure in this app produced no server-side line at all -- and the reply
     * a student saw was the same whether the key was absent, the key was fine
     * and a flag was missing, or a kill switch was on. Production ran for a day
     * with `GEMINI_API_KEY` set and its three flags unset, which looks
     * identical from the outside to having no key.
     *
     * Names only, never values, so this is safe in any log sink.
     */
    createLogger({ route: "ai.assistant", requestId: randomUUID() }).error(
      "provider.not_configured",
      { unmet: describeUnmetAiProviderRequirements(process.env) }
    );
    return tutorFailureResponse(
      "AI features are not configured",
      503,
      "not_configured"
    );
  }

  const uid = await authenticateRequest(request);
  if (!uid) return tutorFailureResponse("Unauthorized", 401, "unauthorized");

  const startedAt = Date.now();
  const log = createLogger({
    route: "ai.assistant",
    requestId: randomUUID(),
    uid,
  });

  let parsedRequest;
  try {
    parsedRequest = parseJamiAssistantRequest(await request.json());
  } catch {
    // Rejected before any quota is charged. The validator's message describes
    // the caller's own payload, so there is nothing here worth logging.
    return tutorFailureResponse("Invalid request body", 400, "invalid_request");
  }
  if (!parsedRequest) {
    return tutorFailureResponse("Invalid assistant request", 400, "invalid_request");
  }
  return { caller: { uid }, startedAt, log, parsedRequest };
}
