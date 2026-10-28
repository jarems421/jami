import type { NextRequest } from "next/server";
import { describeEmailCodeWait, isPlausibleEmail, normaliseEmail } from "@/lib/auth/email-code";
import {
  buildPasswordResetEmail,
  buildPasswordResetUrl,
} from "@/lib/auth/password-reset-email";
import { createLogger } from "@/lib/observability/logger";
import { claimPasswordResetSend } from "@/services/auth/email-code.server";
import {
  authJson,
  crossOriginResponse,
  findAccountByEmail,
  getSenderKey,
  invalidRequestResponse,
  isSameOriginRequest,
  readJsonBody,
} from "@/services/auth/email-code-routes.server";
import {
  EmailUnavailableError,
  sendEmail,
} from "@/services/email/send-email.server";
import { getAdminAuth } from "@/services/firebase/admin";

export const runtime = "nodejs";

const log = createLogger({ route: "auth.password-reset" });

/**
 * Where the link in the email opens. In production that is Jami's configured
 * address and nothing the request says: the link carries a one-time code that
 * resets the account, so a forged Host header must not be able to point it at
 * another site. Off production -- a laptop, a preview -- the request's own
 * origin is what works.
 */
function getAppOrigin(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://jami.study";
  }
  return new URL(request.url).origin;
}

/** The same answer whether or not the address has an account. */
function sentResponse() {
  return authJson({ ok: true });
}

/**
 * Emails a link to choose a new password.
 *
 * Firebase makes the one-time code; Jami sends the mail, from jami.study
 * through the same relay as sign-up codes, so it arrives signed by Jami and
 * points at Jami's own reset page.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return crossOriginResponse();

  const body = await readJsonBody(request);
  if (!body || typeof body.email !== "string") return invalidRequestResponse();

  const email = normaliseEmail(body.email);
  if (!isPlausibleEmail(email)) {
    return authJson(
      { error: "That email address doesn't look right.", code: "auth/invalid-email" },
      400
    );
  }

  try {
    const claim = await claimPasswordResetSend({ email, senderKey: getSenderKey(request) });
    if (!claim.allowed) {
      return authJson(
        {
          error: describeEmailCodeWait(claim.retryAfterSeconds, "reset email"),
          code: "email-code/too-soon",
          retryAfterSeconds: claim.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(claim.retryAfterSeconds) }
      );
    }

    if (!(await findAccountByEmail(email))) return sentResponse();
  } catch (error) {
    log.error("prepare_failed", { error });
    return authJson(
      { error: "Password resets aren't available right now. Try again in a moment.", code: "auth/unavailable" },
      503
    );
  }

  let resetUrl: string;
  try {
    const firebaseLink = await getAdminAuth().generatePasswordResetLink(email);
    const oobCode = new URL(firebaseLink).searchParams.get("oobCode");
    if (!oobCode) throw new Error("Firebase's reset link carried no code.");
    resetUrl = buildPasswordResetUrl(getAppOrigin(request), oobCode);
  } catch (error) {
    log.error("link_failed", { error });
    return authJson(
      { error: "Password resets aren't available right now. Try again in a moment.", code: "auth/unavailable" },
      503
    );
  }

  try {
    const outcome = await sendEmail({ to: email, ...buildPasswordResetEmail({ resetUrl, email }) });
    // Only off production, where there is no mailbox: the link is the point.
    if (outcome === "logged") log.info("reset_link_logged", { resetUrl });
  } catch (error) {
    if (error instanceof EmailUnavailableError) {
      log.error("not_configured");
    } else {
      log.error("send_failed", { error });
    }
    return authJson(
      { error: "That email couldn't be sent. Check the address and try again.", code: "email/send-failed" },
      502
    );
  }

  return sentResponse();
}
