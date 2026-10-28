/**
 * The frame every email Jami sends sits in.
 *
 * Drawn after the first night a new student sees: the night sky, "✦ Jami" in
 * the corner, one gold star inside a faint orbit, Jami's sans heading with
 * its violet glow, an uppercase eyebrow, and lit lavender pills -- so the
 * mail reads as the app the student just left, not a generic notice.
 *
 * Mail clients are twenty years behind browsers, so this is tables and inline
 * styles -- no stylesheet, no web fonts, no SVG, nothing Gmail or Outlook
 * strips. Every colour is set as solid `bgcolor` as well as CSS (the app's
 * translucent colours are given here already mixed onto the sky), so a client
 * that drops one still has the other, and every star is an ordinary
 * character rather than an image, so they arrive even with images blocked.
 * Outlook for Windows draws no circles, so it gets the star without its orbit.
 *
 * No images, ever. Mail once loaded Jami's icon from the app's `*.vercel.app`
 * address, and that hosting domain is so often used for phishing that mail
 * filters (Microsoft's especially, which most university mail runs on) treat
 * a link to it as a sign of one: a code email pointing there was quarantined
 * before the student saw it. The only link any email may carry is to
 * jami.study itself, the domain it is sent from.
 */

export type JamiEmail = { subject: string; html: string; text: string };

export const EMAIL_SIGN_OFF = "The Jami team";
export const EMAIL_FOOTER = "Jami · Revision for GCSE, A-level and beyond";
export const EMAIL_SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The first night's palette, mixed onto the sky for clients without alpha. */
export const EMAIL_COLOURS = {
  sky: "#07041a",
  panel: "#130d2b",
  panelEdge: "#2b2448",
  title: "#f7f4ff",
  text: "#cdc6e8",
  muted: "#948cb6",
  faint: "#6f6893",
  eyebrow: "#a99fd2",
  lavender: "#c4b2ff",
  chosen: "#2a1f57",
  chosenEdge: "#8b78d6",
  gold: "#fff1b8",
  ink: "#160c33",
} as const;

const C = EMAIL_COLOURS;

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A row of quiet pills, like the subjects a student picks on the first night. */
export function renderEmailChips(labels: readonly string[]) {
  return labels
    .map(
      (label) =>
        `<span style="display:inline-block;margin:0 3px 8px;padding:6px 13px;border:1px solid #2f2852;border-radius:999px;background-color:#171032;font-family:${EMAIL_SANS};font-size:13px;line-height:18px;color:#ddd6f5;white-space:nowrap;"><span style="color:${C.lavender};">&#10022;</span>&nbsp;${escapeHtml(label)}</span>`
    )
    .join("\n");
}

/** The first night's star in its orbit; just the star where circles cannot be drawn. */
function renderHeroStar() {
  const star = `<span style="font-family:${EMAIL_SANS};font-size:40px;line-height:40px;color:${C.gold};text-shadow:0 0 18px rgba(255,223,115,0.75),0 0 46px rgba(255,214,120,0.45);">&#10022;</span>`;
  return `<tr><td align="center" style="padding:6px 0 26px;">
<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" height="96" style="height:96px;">${star}</td></tr></table><![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
<td width="128" height="128" align="center" valign="middle" style="width:128px;height:128px;border:1px solid #1d1740;border-radius:50%;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
<td width="86" height="86" align="center" valign="middle" style="width:86px;height:86px;border:1px solid #2e2660;border-radius:50%;background-image:radial-gradient(circle,rgba(255,231,160,0.18) 0%,rgba(142,112,255,0.10) 45%,transparent 72%);">${star}</td>
</tr></table>
</td></tr></table>
<!--<![endif]-->
</td></tr>`;
}

/**
 * Wraps one message in the frame. Every field but `centrepiece` is plain text
 * and escaped here; `centrepiece` is ready-made HTML (the code, the reset
 * button) from the email's own builder, and `chips` an optional row of pills.
 */
export function renderJamiEmail(input: {
  subject: string;
  /** The line a mail client shows beside the subject in the inbox list. */
  preheader: string;
  eyebrow: string;
  heading: string;
  body: string;
  centrepiece: string;
  note: string;
  chips?: { label: string; items: readonly string[] };
  ignore: string;
  /** Ready-made HTML under the card, such as a link spelled out in full. */
  afterCard?: string;
}) {
  const chips = input.chips
    ? `<p style="margin:28px 0 12px;font-family:${EMAIL_SANS};font-size:11px;line-height:16px;letter-spacing:3px;text-transform:uppercase;color:${C.eyebrow};">${escapeHtml(input.chips.label)}</p>
<div style="text-align:center;">${renderEmailChips(input.chips.items)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.sky};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.sky}" style="background-color:${C.sky};background-image:radial-gradient(ellipse 90% 60% at 50% 0%,#2a1b66 0%,#130b36 42%,${C.sky} 78%);">
<tr><td align="center" style="padding:24px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:500px;">
<tr><td style="padding:0 6px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" style="font-family:${EMAIL_SANS};font-size:16px;line-height:22px;font-weight:600;letter-spacing:0.3px;color:#f4f0ff;"><span style="color:#ffffff;text-shadow:0 0 8px rgba(190,170,255,0.9);">&#10022;</span>&nbsp;Jami</td>
<td align="right" style="font-family:${EMAIL_SANS};font-size:12px;line-height:22px;letter-spacing:6px;color:#4a4270;"><span style="color:#4a4270;">&middot;</span><span style="color:#8a7fc0;">&#10023;</span><span style="color:#4a4270;">&middot;</span></td>
</tr></table>
</td></tr>
${renderHeroStar()}
<tr><td bgcolor="${C.panel}" style="background-color:${C.panel};background-image:linear-gradient(180deg,#1b1240 0%,${C.panel} 50%,#0c0820 100%);border:1px solid ${C.panelEdge};border-radius:24px;padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;font-size:0;line-height:0;background-image:linear-gradient(90deg,transparent 12%,rgba(255,255,255,0.45) 50%,transparent 88%);">&nbsp;</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:34px 24px 30px;text-align:center;">
<p style="margin:0 0 14px;font-family:${EMAIL_SANS};font-size:11px;line-height:16px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:${C.eyebrow};">${escapeHtml(input.eyebrow)}</p>
<h1 style="margin:0 0 14px;font-family:${EMAIL_SANS};font-size:30px;line-height:36px;font-weight:600;letter-spacing:-0.6px;color:${C.title};text-shadow:0 0 40px rgba(160,130,255,0.45);">${escapeHtml(input.heading)}</h1>
<p style="margin:0 auto 28px;max-width:380px;font-family:${EMAIL_SANS};font-size:16px;line-height:26px;color:${C.text};">${escapeHtml(input.body)}</p>
${input.centrepiece}
<p style="margin:22px 0 0;font-family:${EMAIL_SANS};font-size:13px;line-height:20px;color:${C.muted};">${escapeHtml(input.note)}</p>
${chips}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;"><tr><td style="border-top:1px solid #241d42;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>
<p style="margin:18px auto 0;max-width:380px;font-family:${EMAIL_SANS};font-size:13px;line-height:20px;color:${C.muted};">${escapeHtml(input.ignore)}</p>
<p style="margin:16px 0 0;font-family:${EMAIL_SANS};font-size:14px;line-height:20px;font-weight:600;color:#e6e0fb;"><span style="color:${C.lavender};">&#10022;</span>&nbsp;${escapeHtml(EMAIL_SIGN_OFF)}</p>
</td></tr></table>
</td></tr>
${input.afterCard ? `<tr><td style="padding:22px 0 0;">${input.afterCard}</td></tr>` : ""}
<tr><td align="center" style="padding:26px 0 0;font-family:${EMAIL_SANS};font-size:12px;line-height:18px;letter-spacing:6px;color:#3d3563;">&middot; &#10023; &middot;</td></tr>
<tr><td align="center" style="padding:10px 0 0;font-family:${EMAIL_SANS};font-size:12px;line-height:18px;color:${C.faint};">${escapeHtml(EMAIL_FOOTER)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
