import type { NextRequest } from "next/server";
import { featureFlags } from "@/lib/app/feature-flags";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { loadNotebookPageLearningView } from "@/services/learning/notebook-page-view.server";

export const runtime = "nodejs";

const log = createLogger({ route: "learning.notebook-page" });

// A document id: anything Firestore allows in one path segment.
const ID_PATTERN = /^[^/\s]{1,1500}$/;

/**
 * Where the student's open notebook page sits in the Learning Engine, and the
 * engine's starting point for it, for the notebook's Tutor. Reads only; no AI.
 */
export async function GET(request: NextRequest) {
  if (!featureFlags.enableLearnerProfile) return apiFailure("Not found", 404, "not_found");
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  const notebookId = request.nextUrl.searchParams.get("notebookId") ?? "";
  const pageId = request.nextUrl.searchParams.get("pageId") ?? "";
  if (!ID_PATTERN.test(notebookId) || !ID_PATTERN.test(pageId)) {
    return apiFailure("Choose a notebook page.", 400, "invalid_request");
  }

  try {
    const view = await loadNotebookPageLearningView({ uid, notebookId, pageId });
    if (!view) return apiFailure("This notebook page could not be found.", 404, "not_found");
    return Response.json(view);
  } catch (error) {
    log.warn("notebook_page.failed", { error });
    return apiFailure("This page's learning view is unavailable right now.", 503, "unavailable");
  }
}
