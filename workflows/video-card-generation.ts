import { sleep } from "workflow";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { VideoCardRead, VideoCardSourceVideo } from "@/services/ai/video-card-generation.server";

/**
 * How often, and for how long, an upload is checked while Gemini processes it.
 * A long lecture can take minutes; the wait is a durable sleep, so it costs no
 * function time.
 */
const PROCESSING_POLL = "10s";
const PROCESSING_MAX_POLLS = 60;

/**
 * One import, in steps that each fit inside a function's time limit: the
 * upload, the wait for Gemini, the read, and the second look and tidy
 * (`services/ai/video-card-generation.server.ts`).
 */
export async function generateVideoCardWorkflow(uid: string, jobId: string) {
  "use workflow";
  let video: VideoCardSourceVideo | null = null;
  try {
    const start = await startImport(uid, jobId);
    if (start.kind === "stopped" || start.kind === "done") return { status: "ready" as const };
    video = start.kind === "youtube" ? start.video : await uploadVideo(uid, jobId);
    for (let polls = 0; video.state && video.state !== "ACTIVE"; polls += 1) {
      if (video.state === "FAILED") throw new Error("gemini_file_processing_failed");
      if (polls >= PROCESSING_MAX_POLLS) throw new Error("gemini_file_processing_timeout");
      await sleep(PROCESSING_POLL);
      video = await checkVideo(video);
    }
    const read = await readVideo(uid, jobId, video);
    if (read) await finishImport(uid, jobId, video, read);
    return { status: "ready" as const };
  } catch {
    await failVideoGeneration(uid, jobId);
    return { status: "failed" as const };
  } finally {
    if (video?.name) await removeVideoCopy(video);
  }
}

async function startImport(uid: string, jobId: string) {
  "use step";
  const { startVideoCardJob } = await import("@/services/ai/video-card-generation.server");
  return startVideoCardJob(uid, jobId);
}

async function uploadVideo(uid: string, jobId: string) {
  "use step";
  const { uploadVideoCardSource } = await import("@/services/ai/video-card-generation.server");
  return uploadVideoCardSource(uid, jobId);
}

async function checkVideo(video: VideoCardSourceVideo) {
  "use step";
  const { checkVideoCardSource } = await import("@/services/ai/video-card-generation.server");
  return checkVideoCardSource(video);
}

async function readVideo(uid: string, jobId: string, video: VideoCardSourceVideo) {
  "use step";
  const { readVideoCardSource } = await import("@/services/ai/video-card-generation.server");
  return readVideoCardSource(uid, jobId, video);
}

async function finishImport(uid: string, jobId: string, video: VideoCardSourceVideo, read: VideoCardRead) {
  "use step";
  const { finishVideoCardJob } = await import("@/services/ai/video-card-generation.server");
  await finishVideoCardJob(uid, jobId, video, read);
}

async function removeVideoCopy(video: VideoCardSourceVideo) {
  "use step";
  const { removeVideoCardSourceCopy } = await import("@/services/ai/video-card-generation.server");
  await removeVideoCardSourceCopy(video);
}

async function failVideoGeneration(uid: string, jobId: string) {
  "use step";
  const [{ getAdminDb, getAdminStorageBucket }] = await Promise.all([import("@/services/firebase/admin")]);
  const ref = getAdminDb().collection("users").doc(uid).collection("videoCardJobs").doc(jobId);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data || data.status === "cancelled") return;
  if (typeof data.storagePath === "string") await getAdminStorageBucket().file(data.storagePath).delete({ ignoreNotFound: true }).catch(() => undefined);
  const now = Date.now();
  const sourceName = data.sourceKind === "file" || data.sourceKind === "text" ? "source" : "video";
  await ref.update({ status: "failed", failureMessage: `Jami could not read that ${sourceName}. Check it and try again.`, contentText: FieldValue.delete(), completedAt: now, expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000), updatedAt: now });
}
