import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

/**
 * What typesetting a generated paper reads from disk. The body font, pdfkit's
 * metrics and MathJax's glyph ranges are all read by path at render time.
 * MathJax also reaches its default font through the `#default-font/*` import
 * alias in its package.json, which tracing does not follow: without the whole
 * SVG font the step function cannot load, and every workflow -- not only
 * papers -- sits queued (10 Oct 2026).
 */
const PAPER_TYPESETTING_FILES = [
  "./node_modules/pdfjs-dist/standard_fonts/LiberationSans-*.ttf",
  "./node_modules/pdfkit/js/data/**",
  "./node_modules/@mathjax/mathjax-newcm-font/package.json",
  "./node_modules/@mathjax/mathjax-newcm-font/mjs/package.json",
  "./node_modules/@mathjax/mathjax-newcm-font/mjs/{common,svg}.js",
  "./node_modules/@mathjax/mathjax-newcm-font/mjs/svg/**/*.js",
];

/**
 * Directives that cannot break resource loading, so they are safe to enforce
 * without first observing real traffic. They close clickjacking, base-tag
 * injection, plugin embedding and form hijacking.
 */
const ENFORCED_CSP = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * The restrictive policy, reported but not enforced.
 *
 * No external origin is hardcoded anywhere in the app -- the Firebase SDK
 * builds its endpoints at runtime from config -- so `connect-src` cannot be
 * verified by reading the source. Enforcing a guess would break Firestore,
 * Auth or Storage in production while every local gate stayed green.
 *
 * Report-Only surfaces violations in the browser console at no runtime cost
 * and with no risk to a working app. Promote to enforcement once a real
 * session reports clean.
 *
 * `script-src` keeps 'unsafe-inline' deliberately. The strong alternative is a
 * per-request nonce, which requires middleware and forces every page to render
 * dynamically -- this app prerenders most of its routes, so that trade costs
 * real serverless invocations to harden a surface that `trust: false` KaTeX and
 * the enforced directives above already cover.
 */
const REPORTED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com http://127.0.0.1:* ws://127.0.0.1:*",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  ENFORCED_CSP,
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: ENFORCED_CSP },
  { key: "Content-Security-Policy-Report-Only", value: REPORTED_CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  {
    // Vercel serves this over HTTPS. No `preload`, which is a one-way listing.
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

export const nextConfig: NextConfig = {
  // The floating "N" dev badge sits over the signed-out pages' bottom corner.
  // Compile and runtime errors still surface with it off.
  devIndicators: false,
  /*
   * Which build this is, stamped into the client and the server alike, so an
   * installed app can tell it is running an older one. The commit rather than
   * the deployment, so the version shown on the account page is the hash in
   * `git log`. Empty outside Vercel, which turns the check off. See
   * lib/app/app-build.ts.
   */
  env: {
    NEXT_PUBLIC_APP_BUILD:
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "",
  },
  // PDF evidence rendering uses a native Skia binary and must remain a
  // server runtime dependency rather than being parsed by webpack.
  // pdfkit reads its font metrics from disk, and MathJax imports glyph ranges
  // by computed path, so both stay unbundled for generated paper booklets.
  serverExternalPackages: [
    "@napi-rs/canvas",
    "mammoth",
    "officeparser",
    "pdfkit",
    "@mathjax/src",
    "@mathjax/mathjax-newcm-font",
  ],
  // pdf.js reads its image decoders from disk at render time, which tracing
  // cannot see from an import. Without them a deployed ingestion renders
  // Pearson's JBIG2 diagrams as blank space.
  outputFileTracingIncludes: {
    "/api/internal/exam-questions/ingest/**": ["./node_modules/pdfjs-dist/wasm/**"],
    "/.well-known/workflow/v1/step": PAPER_TYPESETTING_FILES,
    // These routes never typeset, but they import the paper workflow's
    // services, and MathJax fails at import, not at use: shipped without its
    // font, the job and paper routes answered every request with a 500 -- a
    // generated paper could be neither followed nor opened (19 Oct 2026).
    "/api/practice/paper-jobs/**": PAPER_TYPESETTING_FILES,
    "/api/practice/papers/**": PAPER_TYPESETTING_FILES,
    "/api/internal/paper-quality/**": PAPER_TYPESETTING_FILES,
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async redirects() {
    return [
      {
        source: "/dashboard/practise",
        destination: "/dashboard/practice",
        permanent: true,
      },
    ];
  },
};

export default withWorkflow(nextConfig);
