import {
  EMAIL_COLOURS,
  EMAIL_FOOTER,
  EMAIL_SANS,
  EMAIL_SIGN_OFF,
  escapeHtml,
  renderJamiEmail,
  type JamiEmail,
} from "@/lib/auth/email-layout";

/**
 * The email with a link to choose a new password.
 *
 * Sent by Jami from jami.study rather than by Firebase. Firebase's own mail
 * came from a `firebaseapp.com` address, signed "Your project-1234 team", and
 * linked to that same hosting domain -- a sender, signature and link that
 * share nothing with Jami, which is what put it in junk folders.
 */

/** How long Firebase keeps a reset link usable. */
export const PASSWORD_RESET_LINK_TTL_HOURS = 1;

const COPY = {
  eyebrow: "A fresh start",
  heading: "Reset your password",
  body: "Someone asked to reset the password for your Jami account. Choose a new one and your sky is just as you left it.",
  button: "Choose a new password",
  ignore:
    "Didn't ask for this? You can ignore this email. Your password stays as it is.",
};

/**
 * The address the link opens: Jami's own reset page, carrying only Firebase's
 * one-time code. `appOrigin` must be Jami's configured address, never one
 * read from the request, so a forged Host header cannot send the code
 * somewhere else.
 */
export function buildPasswordResetUrl(appOrigin: string, oobCode: string) {
  const url = new URL("/auth/action", appOrigin);
  url.searchParams.set("mode", "resetPassword");
  url.searchParams.set("oobCode", oobCode);
  return url.toString();
}

export function buildPasswordResetEmail(input: {
  resetUrl: string;
  /** The account's address, shown so a student with two accounts knows which. */
  email: string;
}): JamiEmail {
  const expiry = `This link works for ${PASSWORD_RESET_LINK_TTL_HOURS} hour and only once.`;
  const subject = "Reset your Jami password";
  const href = escapeHtml(input.resetUrl);
  const C = EMAIL_COLOURS;

  const text = [
    COPY.heading,
    "",
    `For ${input.email}`,
    "",
    COPY.body,
    "",
    input.resetUrl,
    "",
    expiry,
    "",
    COPY.ignore,
    "",
    EMAIL_SIGN_OFF,
    EMAIL_FOOTER,
  ].join("\n");

  const html = renderJamiEmail({
    subject,
    preheader: `${COPY.body} ${expiry}`,
    eyebrow: COPY.eyebrow,
    heading: COPY.heading,
    body: COPY.body,
    centrepiece: `<p style="margin:-12px 0 26px;"><span style="display:inline-block;padding:7px 14px;border:1px solid #2f2852;border-radius:12px;background-color:#171032;font-family:${EMAIL_SANS};font-size:14px;line-height:20px;color:#ece7ff;">For <span style="font-weight:600;color:#ffffff;">${escapeHtml(input.email)}</span></span></p>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
<tr><td bgcolor="#e4dbff" style="background-color:#e4dbff;background-image:linear-gradient(135deg,#f8f5ff 0%,#c9baff 100%);border-radius:999px;box-shadow:0 10px 40px -10px rgba(160,130,255,0.85),inset 0 1px 0 rgba(255,255,255,0.85);">
<a href="${href}" style="display:inline-block;padding:15px 30px;font-family:${EMAIL_SANS};font-size:16px;line-height:20px;font-weight:600;color:${C.ink};text-decoration:none;border-radius:999px;">${escapeHtml(COPY.button)}&nbsp;&nbsp;&rarr;</a>
</td></tr>
</table>`,
    note: expiry,
    ignore: COPY.ignore,
    // The plain address, below the card, for a client whose button does not work.
    afterCard: `<p style="margin:0;padding:0 24px;font-family:${EMAIL_SANS};font-size:12px;line-height:18px;color:${C.faint};word-break:break-all;text-align:center;">Button not working? Paste this into your browser:<br><a href="${href}" style="color:${C.lavender};text-decoration:underline;">${href}</a></p>`,
  });

  return { subject, html, text };
}
