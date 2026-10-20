import type { NextRequest } from "next/server";
import { featureFlags } from "@/lib/app/feature-flags";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import {
  MAX_PLAN_ACTION_SCOPES,
  loadStudyActions,
  loadStudyActionsForScopes,
} from "@/services/learning/study-actions.server";

export const runtime = "nodejs";

const log = createLogger({ route: "learning.study-actions" });

/**
 * The signed-in student's next study actions. Reads only; no AI.
 *
 * Without `scopes`, Today's short list across their recent folders. With
 * `scopes=folder:a,deck:b`, a revision plan's: each named subject's own
 * actions, decided from that subject's evidence alone. Only the student's own
 * folders and decks can be read -- the scope keys are looked up under their uid.
 */
export async function GET(request: NextRequest) {
  if (!featureFlags.enableLearnerProfile || !featureFlags.enableStudyActions) {
    return apiFailure("Not found", 404, "not_found");
  }
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  const startedAt = Date.now();
  const scopesParam = request.nextUrl.searchParams.get("scopes");
  try {
    if (scopesParam !== null) {
      const scopeKeys = scopesParam
        .split(",")
        .map((scopeKey) => scopeKey.trim())
        .filter(Boolean)
        .slice(0, MAX_PLAN_ACTION_SCOPES);
      const result = await loadStudyActionsForScopes({ uid, scopeKeys });
      log.info("study_actions.completed", {
        consumer: "plan",
        latencyMs: Date.now() - startedAt,
        scopes: result.scopes.length,
        failedScopes: result.scopes.filter((scope) => scope.status === "failed").length,
        actions: result.scopes.reduce((total, scope) => total + scope.actions.length, 0),
      });
      return Response.json({
        scopes: result.scopes,
        folders: result.folders.map((folder) => ({ id: folder.id, name: folder.name })),
        generatedAt: result.generatedAt,
      });
    }

    const result = await loadStudyActions({ uid });
    log.info("study_actions.completed", {
      consumer: "today",
      latencyMs: Date.now() - startedAt,
      folders: result.evaluatedFolders,
      failedFolders: result.failedFolders,
      actions: result.actions.length,
      reasons: result.actions.map((action) => action.reason),
    });
    return Response.json({
      ...result,
      // Narrowed at the boundary. `loadStudyActions` carries whole folder
      // documents now for the callers that need a course or a study level, and
      // Today needs a name to label a recommendation with -- there is no reason
      // to put the rest of a folder on the wire.
      folders: result.folders.map((folder) => ({ id: folder.id, name: folder.name })),
    });
  } catch (error) {
    log.warn("study_actions.failed", {
      consumer: scopesParam !== null ? "plan" : "today",
      latencyMs: Date.now() - startedAt,
      error,
    });
    return apiFailure("Recommendations are unavailable right now.", 503, "study_actions_unavailable");
  }
}
