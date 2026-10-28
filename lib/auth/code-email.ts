import { EMAIL_CODE_TTL_MS } from "@/lib/auth/email-code";
import {
  EMAIL_COLOURS,
  EMAIL_FOOTER,
  EMAIL_SIGN_OFF,
  escapeHtml,
  renderJamiEmail,
  type JamiEmail,
} from "@/lib/auth/email-layout";

/**
 * The email that carries a sign-up code: the code lit like a subject chosen
 * on the first night, and no link at all -- the student types the code into
 * the tab they already have open. It is one run of text, not a box per digit,
 * so it can be copied whole.
 */

const COPY = {
  eyebrow: "Your first night",
  heading: "Welcome to Jami",
  body: "Your study sky is ready. Enter this code in Jami to finish creating your account.",
  waiting: "Waiting for you",
  ignore:
    "Didn't ask for this? You can ignore this email. No account is created without the code.",
};

const WAITING = ["Flashcards", "Notebooks", "Past papers", "Tutor"];

const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

export function buildCodeEmail(input: { code: string }): JamiEmail {
  const minutes = Math.round(EMAIL_CODE_TTL_MS / 60_000);
  const expiry = `This code expires in ${minutes} minutes.`;
  const subject = `${input.code} is your Jami code`;

  const text = [
    COPY.heading,
    "",
    COPY.body,
    "",
    `    ${input.code}`,
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
    preheader: `${input.code} is your code. ${expiry}`,
    eyebrow: COPY.eyebrow,
    heading: COPY.heading,
    body: COPY.body,
    centrepiece: `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
<tr><td bgcolor="${EMAIL_COLOURS.chosen}" style="background-color:${EMAIL_COLOURS.chosen};border:1px solid ${EMAIL_COLOURS.chosenEdge};border-radius:20px;padding:16px 12px 16px 24px;font-family:${MONO};font-size:34px;line-height:42px;font-weight:700;letter-spacing:12px;color:#ffffff;text-shadow:0 0 18px rgba(196,178,255,0.65);box-shadow:0 0 0 1px rgba(196,178,255,0.22),0 0 40px rgba(142,112,255,0.45);">${escapeHtml(input.code)}</td></tr>
</table>`,
    note: expiry,
    chips: { label: COPY.waiting, items: WAITING },
    ignore: COPY.ignore,
  });

  return { subject, html, text };
}
