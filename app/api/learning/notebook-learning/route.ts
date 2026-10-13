import type { NextRequest } from "next/server";
import { featureFlags } from "@/lib/app/feature-flags";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { loadNotebookLearningView } from "@/services/learning/notebook-learning-view.server";

export const runtime = "nodejs";

const log = createLogger({ route: "learning.notebook-learning" });

// A document id: anything Firestore allows in one path segment.
const ID_PATTERN = /^[^/\s]{1,1500}$/;

/**
 * Where every page of one notebook sits in the Learning Engine, and the
 * engine's starting points, for the notebook's Tutor. Reads only; no AI.
 */
export async function GET(request: NextRequest) {
  if (!featureFlags.enableLearnerProfile) return apiFailure("Not found", 404, "not_found");
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  const notebookId = request.nextUrl.searchParams.get("notebookId") ?? "";
  if (!ID_PATTERN.test(notebookId)) return apiFailure("Choose a notebook.", 400, "invalid_request");

  try {
    const view = await loadNotebookLearningView({ uid, notebookId });
    if (!view) return apiFailure("This notebook could not be found.", 404, "not_found");
    return Response.json(view);
  } catch (error) {
    log.warn("notebook_view.failed", { error });
    return apiFailure("This notebook's learning view is unavailable right now.", 503, "unavailable");
  }
}
