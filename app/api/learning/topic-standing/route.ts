import type { NextRequest } from "next/server";
import { featureFlags } from "@/lib/app/feature-flags";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { loadTopicStandings } from "@/services/learning/topic-standing.server";

export const runtime = "nodejs";

const log = createLogger({ route: "learning.topic-standing" });

/** Where each topic in one of the student's folders stands, for topic goals. Reads only; no AI. */
export async function GET(request: NextRequest) {
  if (!featureFlags.enableLearnerProfile) {
    return apiFailure("Not found", 404, "not_found");
  }
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  const folderId = request.nextUrl.searchParams.get("folderId")?.trim() ?? "";
  if (!folderId || folderId.length > 160 || folderId.includes("/")) {
    return apiFailure("Choose a folder.", 400, "invalid_folder");
  }

  const startedAt = Date.now();
  try {
    const topics = await loadTopicStandings({ uid, folderId });
    if (!topics) return apiFailure("That folder could not be found.", 404, "folder_not_found");
    log.info("topic_standing.completed", {
      latencyMs: Date.now() - startedAt,
      topics: topics.length,
    });
    return Response.json({ topics, generatedAt: Date.now() });
  } catch (error) {
    log.warn("topic_standing.failed", { latencyMs: Date.now() - startedAt, error });
    return apiFailure("Topic progress is unavailable right now.", 503, "topic_standing_unavailable");
  }
}
