import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  readPhotoRestoreSize,
  RESTORE_MAX_INPUT_BYTES,
} from "@/lib/app/photo-background-restore";
import { createLogger } from "@/lib/observability/logger";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import {
  checkAiBudget,
  createAiBudgetLimitResponse,
  refundAiBudget,
} from "@/services/ai/budgets";
import {
  isPhotoRestoreConfigured,
  restorePhotoBackground,
} from "@/services/profile/photo-restore.server";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Leaves the page time to hear back before the platform cuts the request off. */
const RESTORE_DEADLINE_MS = 75_000;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Restores a background photo that would otherwise be stretched to fill the
 * screen, and saves it in the student's background folder.
 *
 * The page asks only when it chose a photo that needs enlarging, and falls back
 * to enlarging it itself on any failure here -- so every refusal is a status
 * code, never something the student has to act on.
 */
export async function POST(request: NextRequest) {
  if (!isPhotoRestoreConfigured()) {
    return apiFailure("Photo sharpening is not available.", 503, "not_configured");
  }

  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  const size = readPhotoRestoreSize(Object.fromEntries(request.nextUrl.searchParams));
  if (!size) return apiFailure("That photo cannot be sharpened.", 400, "invalid_size");

  const contentType = request.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!ACCEPTED_TYPES.has(contentType)) {
    return apiFailure("Send a JPEG, PNG or WebP photo.", 415, "invalid_type");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESTORE_MAX_INPUT_BYTES) {
    return apiFailure("That photo is too large to sharpen.", 413, "too_large");
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return apiFailure("Invalid request body", 400, "invalid_body");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > RESTORE_MAX_INPUT_BYTES) {
    return apiFailure("That photo is too large to sharpen.", 413, "too_large");
  }

  const budget = await checkAiBudget({ uid, action: "photoBackgroundRestore" });
  if (!budget.allowed) return createAiBudgetLimitResponse("photoBackgroundRestore", budget);

  const log = createLogger({ route: "account.photo-background.restore", requestId: randomUUID(), uid });
  const startedAt = Date.now();
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(RESTORE_DEADLINE_MS)]);
  try {
    const storagePath = await restorePhotoBackground({ uid, bytes, contentType, size, signal: deadline });
    log.info("photo.restored", { ...size, durationMs: Date.now() - startedAt });
    return Response.json({ storagePath });
  } catch (error) {
    await refundAiBudget(budget.grant).catch(() => undefined);
    log.error("photo.restore_failed", { error, durationMs: Date.now() - startedAt });
    return apiFailure("Your photo could not be sharpened just now.", 502, "restore_failed");
  }
}
