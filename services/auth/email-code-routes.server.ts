import "server-only";

import type { NextRequest } from "next/server";
import type { UserRecord } from "firebase-admin/auth";
import { buildCodeEmail } from "@/lib/auth/code-email";
import {
  describeEmailCodeFailure,
  describeEmailCodeWait,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
} from "@/lib/auth/email-code";
import { createLogger } from "@/lib/observability/logger";
import {
  issueEmailCode,
  withdrawEmailCode,
  type EmailCodeRedemption,
} from "@/services/auth/email-code.server";
import {
  EmailUnavailableError,
  sendEmail,
} from "@/services/email/send-email.server";
import { getAdminAuth } from "@/services/firebase/admin";

/**
 * What the auth routes that send mail -- sign-up codes, password resets --
 * have in common.
 */

const log = createLogger({ area: "auth.email-code" });

export function authJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/**
 * These routes send mail and create accounts, so a page on another site must
 * not be able to drive them from a visitor's browser.
 */
export function isSameOriginRequest(request: NextRequest) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function crossOriginResponse() {
  return authJson({ error: "Forbidden", code: "auth/origin-mismatch" }, 403);
}

export async function readJsonBody(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function invalidRequestResponse() {
  return authJson({ error: "Invalid request body", code: "auth/invalid-request" }, 400);
}

/** The first address in the proxy chain: the visitor, on Vercel. */
export function getSenderKey(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || null;
}

/** The account using an address, or null when there is none. */
export async function findAccountByEmail(email: string): Promise<UserRecord | null> {
  try {
    return await getAdminAuth().getUserByEmail(email);
  } catch (error) {
    if ((error as { code?: string })?.code === "auth/user-not-found") return null;
    throw error;
  }
}

export function accountExistsResponse() {
  return authJson(
    {
      error: "An account already uses that email. Try signing in instead.",
      code: "auth/email-already-in-use",
    },
    409
  );
}

/** The response for a code that was not accepted. */
export function codeRefusedResponse(
  redemption: Extract<EmailCodeRedemption, { redeemed: false }>
) {
  return authJson(
    {
      error: describeEmailCodeFailure(redemption.failure, redemption.attemptsLeft),
      code: `email-code/${redemption.failure}`,
      attemptsLeft: redemption.attemptsLeft,
    },
    400
  );
}

/**
 * Makes a code, emails it, and says how that went.
 */
export async function deliverEmailCode(
  request: NextRequest,
  email: string
): Promise<Response> {
  let issue;
  try {
    issue = await issueEmailCode({ email, senderKey: getSenderKey(request) });
  } catch (error) {
    log.error("issue_failed", { error });
    return authJson(
      { error: "Codes can't be sent right now. Try again in a moment.", code: "email-code/unavailable" },
      503
    );
  }

  if (!issue.issued) {
    return authJson(
      {
        error: describeEmailCodeWait(issue.retryAfterSeconds),
        code: "email-code/too-soon",
        retryAfterSeconds: issue.retryAfterSeconds,
      },
      429,
      { "Retry-After": String(issue.retryAfterSeconds) }
    );
  }

  const message = buildCodeEmail({ code: issue.code });

  try {
    await sendEmail({ to: email, ...message });
  } catch (error) {
    await withdrawEmailCode(email).catch(() => undefined);
    if (error instanceof EmailUnavailableError) {
      log.error("not_configured");
      return authJson(
        {
          error: "Email codes aren't available right now. Continue with Google instead, or try again later.",
          code: "email/unavailable",
        },
        503
      );
    }
    log.error("send_failed", { error });
    return authJson(
      {
        error: "That email couldn't be sent. Check the address and try again.",
        code: "email/send-failed",
      },
      502
    );
  }

  return authJson({
    ok: true,
    resendAfterSeconds: Math.round(EMAIL_CODE_RESEND_COOLDOWN_MS / 1000),
  });
}
