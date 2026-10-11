import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { start } from "workflow/api";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  CARD_SOURCE_MAX_BYTES,
  CARD_SOURCE_TEXT_MAX_LENGTH,
  parseVideoCardLimit,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_SECONDS,
  mapVideoCardJobData,
  parseVideoCoverage,
} from "@/lib/ai/video-card-jobs";
import { isSourceFileMimeType } from "@/lib/material/source-files";
import { checkAiBudget, createAiBudgetLimitResponse, refundAiBudget } from "@/services/ai/budgets";
import { getAdminDb, getAdminStorageBucket } from "@/services/firebase/admin";
import { failVideoCardJobIfStalled } from "@/services/ai/video-card-job-stall.server";
import { generateVideoCardWorkflow } from "@/workflows/video-card-generation";

export const runtime = "nodejs";

function jobId(value: string | null) { const safe = value?.trim() ?? ""; return /^[A-Za-z0-9_-]{16,120}$/.test(safe) ? safe : randomUUID(); }
function youtubeId(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "youtu.be") return /^[A-Za-z0-9_-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
    if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) return null;
    const candidate = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/)?.[1];
    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
  } catch { return null; }
}
function parseIsoDuration(value: string) {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0;
}
async function inspectYouTube(url: string) {
  const id = youtubeId(url);
  const key = process.env.YOUTUBE_DATA_API_KEY?.trim();
  if (!id || !key) throw new Error(!key ? "youtube_not_configured" : "invalid_youtube_url");
  const query = new URLSearchParams({ part: "contentDetails,status,snippet", id, key });
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error("youtube_unavailable");
  const body = await response.json() as { items?: Array<{ contentDetails?: { duration?: string }; status?: { privacyStatus?: string }; snippet?: { title?: string } }> };
  const item = body.items?.[0];
  if (!item || item.status?.privacyStatus !== "public") throw new Error("youtube_not_public");
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}`, durationSeconds: parseIsoDuration(item.contentDetails?.duration || ""), title: item.snippet?.title?.slice(0, 160) || "YouTube video" };
}

/**
 * Frees the videos behind this student's own expired imports.
 *
 * Storage is released when an import fails, is discarded, or is approved. A
 * student who reads their cards and closes the tab does none of those, and now
 * that the upload is kept for review it would otherwise sit in the bucket for
 * good. Starting another import is the natural moment to clear the last one,
 * and it needs no scheduler to be reliable. Bounded per request, and never a
 * reason for the new import to fail.
 */
async function sweepExpiredImports(db: ReturnType<typeof getAdminDb>, uid: string) {
  const snapshot = await db
    .collection("users").doc(uid).collection("videoCardJobs")
    .where("expiresAt", "<=", Timestamp.now())
    .limit(5)
    .get();

  await Promise.all(snapshot.docs.map(async (doc) => {
    const storagePath = doc.data().storagePath;
    if (typeof storagePath !== "string" || !storagePath) return;
    await getAdminStorageBucket().file(storagePath).delete({ ignoreNotFound: true });
    await doc.ref.update({ storagePath: FieldValue.delete() });
  }));
}

export async function GET(request: NextRequest) {
  const uid = await authenticateRequest(request); if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");
  const snapshot = await getAdminDb().collection("users").doc(uid).collection("videoCardJobs").orderBy("updatedAt", "desc").limit(10).get();
  const jobs = await Promise.all(snapshot.docs.map(async (doc) =>
    mapVideoCardJobData(doc.id, await failVideoCardJobIfStalled(doc.ref, doc.data()))
  ));
  return Response.json({ jobs });
}

export async function POST(request: NextRequest) {
  const uid = await authenticateRequest(request); if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");
  let body: Record<string, unknown>; try { body = await request.json(); } catch { return apiFailure("Invalid request", 400, "invalid_request"); }
  const coverage = parseVideoCoverage(body.coverage); const maxCards = parseVideoCardLimit(body.maxCards); const deckId = typeof body.deckId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(body.deckId) ? body.deckId : "";
  const topics = Array.isArray(body.topicIds) ? body.topicIds.filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v)).slice(0, 20) : [];
  const focus = typeof body.focus === "string" ? body.focus.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (!coverage || !deckId) return apiFailure("Choose a deck and coverage.", 400, "invalid_request");
  const db = getAdminDb();
  await sweepExpiredImports(db, uid).catch(() => undefined);
  const deck = await db.collection("decks").doc(deckId).get();
  if (!deck.exists || ![deck.data()?.userId, deck.data()?.uid].includes(uid)) return apiFailure("Deck not found", 404, "deck_not_found");
  const id = jobId(request.headers.get("x-idempotency-key"));
  const ref = db.collection("users").doc(uid).collection("videoCardJobs").doc(id);
  const existing = await ref.get(); if (existing.exists) return Response.json(mapVideoCardJobData(id, existing.data() ?? {}));
  let source: Record<string, unknown>;
  try {
    if (body.sourceKind === "youtube" && typeof body.youtubeUrl === "string") {
      const video = await inspectYouTube(body.youtubeUrl);
      source = { sourceKind: "youtube", youtubeUrl: video.url, youtubeId: video.videoId, youtubePublic: true, durationSeconds: video.durationSeconds, title: video.title };
    } else if (body.sourceKind === "upload") {
      const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
      const expectedPrefix = `users/${uid}/videoCardImports/${id}/`;
      if (!storagePath.startsWith(expectedPrefix)) throw new Error("invalid_upload");
      const [metadata] = await getAdminStorageBucket().file(storagePath).getMetadata();
      const durationSeconds = Number(body.durationSeconds);
      const allowed = ["video/mp4", "video/mpeg", "video/quicktime", "video/webm"];
      if (!allowed.includes(metadata.contentType || "") || Number(metadata.size) > VIDEO_MAX_BYTES || durationSeconds <= 0 || durationSeconds > VIDEO_MAX_SECONDS) throw new Error("invalid_upload");
      source = { sourceKind: "upload", storagePath, fileName: typeof body.fileName === "string" ? body.fileName.slice(0, 160) : "Uploaded video", mimeType: metadata.contentType, sizeBytes: Number(metadata.size), durationSeconds, title: typeof body.fileName === "string" ? body.fileName.slice(0, 160) : "Uploaded video" };
    } else if (body.sourceKind === "file") {
      const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
      const expectedPrefix = `users/${uid}/cardSourceImports/${id}/`;
      if (!storagePath.startsWith(expectedPrefix)) throw new Error("invalid_upload");
      const [metadata] = await getAdminStorageBucket().file(storagePath).getMetadata();
      const mimeType = metadata.contentType || "";
      const sizeBytes = Number(metadata.size);
      if (!isSourceFileMimeType(mimeType) || sizeBytes <= 0 || sizeBytes >= CARD_SOURCE_MAX_BYTES) {
        throw new Error("invalid_upload");
      }
      const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 160) : "Uploaded source";
      source = { sourceKind: "file", storagePath, fileName, mimeType, sizeBytes, durationSeconds: 0, title: fileName };
    } else if (body.sourceKind === "text") {
      const contentText = typeof body.contentText === "string" ? body.contentText.trim() : "";
      if (!contentText || contentText.length > CARD_SOURCE_TEXT_MAX_LENGTH) throw new Error("invalid_text");
      source = { sourceKind: "text", contentText, durationSeconds: 0, title: "Pasted notes" };
    } else throw new Error("invalid_source");
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_source";
    return apiFailure(
      code === "youtube_not_public"
        ? "That YouTube video is not public."
        : code === "youtube_not_configured"
          ? "YouTube imports are not configured yet."
          : code === "invalid_text"
            ? `Paste between 1 and ${CARD_SOURCE_TEXT_MAX_LENGTH.toLocaleString()} characters.`
            : "That source could not be verified.",
      code === "youtube_not_configured" ? 503 : 400,
      code
    );
  }
  if (Number(source.durationSeconds) > VIDEO_MAX_SECONDS) return apiFailure("Videos must be 90 minutes or shorter.", 413, "video_too_long");
  let budget; try { budget = await checkAiBudget({ uid, action: "videoCardImport", skipBurstLimit: true }); } catch { return apiFailure("AI usage limits are temporarily unavailable.", 503, "budget_unavailable"); }
  if (!budget.allowed) return createAiBudgetLimitResponse("videoCardImport", budget);
  const now = Date.now();
  await ref.create({ ...source, deckId, topicIds: topics, coverage, ...(maxCards !== null ? { maxCards } : {}), focus, status: "queued", stage: "preparing", progress: 5, drafts: [], warnings: [], budgetGrant: budget.grant, cancellationRequested: false, createdAt: now, updatedAt: now });
  try {
    const run = await start(generateVideoCardWorkflow, [uid, id]);
    await ref.update({ workflowRunId: run.runId, updatedAt: Date.now() });
    return Response.json(mapVideoCardJobData(id, { ...source, deckId, topicIds: topics, coverage, ...(maxCards !== null ? { maxCards } : {}), focus, status: "queued", stage: "preparing", progress: 5, createdAt: now, updatedAt: now }), { status: 202 });
  } catch {
    await refundAiBudget(budget.grant);
    if (typeof source.storagePath === "string") {
      await getAdminStorageBucket().file(source.storagePath).delete({ ignoreNotFound: true }).catch(() => undefined);
    }
    const failedAt = Date.now();
    await ref.update({ status: "failed", failureMessage: "Jami could not start that import.", budgetRefunded: true, completedAt: failedAt, expiresAt: Timestamp.fromMillis(failedAt + 24 * 60 * 60_000), updatedAt: failedAt });
    return apiFailure("Jami could not start that import.", 503, "workflow_start_failed");
  }
}
