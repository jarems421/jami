"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Card, IconBubble } from "@/components/ui";
import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/Dialog";
import NightSkyBackdrop from "@/components/constellation/NightSkyBackdrop";
import CelestialBody from "@/components/billing/CelestialBody";
import PlanWelcome from "@/components/billing/PlanWelcome";
import { CHECKOUT_WAIVER_TEXT, type CheckoutKind } from "@/lib/billing/checkout";
import {
  ALLOWANCE_KEYS,
  ALLOWANCE_LABELS,
  PLAN_ALLOWANCES,
  PLAN_LABELS,
  PLAN_PRICES_PENCE,
  PLAN_SPACE_LIMITS,
  getExamPassExpiry,
  getExamPassMonths,
  getExamPassPricePence,
  type AllowanceKey,
  type PaidPlanId,
  type PlanId,
} from "@/lib/billing/plans";
import type { PlanSummary } from "@/lib/billing/summary";
import {
  TUTOR_HOUR_PENCE,
  describeAllowancePace,
  describePassAllowance,
  describePlanAllowance,
  describeUpgradeFor,
  getExamPassQuote,
  getPlanComparisonRows,
  perDayPence,
} from "@/lib/billing/upsell";
import { CheckoutError, openBillingPortal, startCheckout } from "@/services/billing/checkout";
import { loadPlanSummary } from "@/services/billing/plan-summary-store";

/**
 * Choosing a plan.
 *
 * Reached only on purpose: from "See plans" after running out of something,
 * from the plan row on Account, or from Usage. Most buyers are under 18
 * (docs/plans-and-stardust.md §1), so this page persuades only with what is
 * true and checkable, and never with pressure:
 *
 * - The recommended plan is raised in the middle (the centre-stage effect).
 *   It is a recommendation, never a popularity claim we cannot back.
 * - Each card shows only what people buy a plan for: papers, Tutor, marking
 *   and room. The rest is one tap away in "Everything else".
 * - Numbers are made concrete: allowances as the pace they would be used at
 *   ("nearly 2 a week"), prices as a daily figure beside the real one, and the
 *   month set against one hour of private tutoring.
 * - Risk is taken away before it is asked about: cancel any time, your work
 *   stays on Free, a parent can pay, and a short list of honest answers.
 * - Nothing counts down, nothing is "limited time", and Free is a real plan.
 *
 * The Exam Pass is the cheaper way to pay, so it leads with what it works out
 * at each month and shows each allowance across the whole pass.
 */

type ShownPlan = Exclude<PlanId, "lifetime">;

const OUTCOMES: Record<ShownPlan, string> = {
  free: "See what Jami can do",
  plus: "Revise every subject, every week",
  pro: "Everything, for exam season",
};

const TAGLINES: Record<ShownPlan, string> = {
  free: "A taste of everything, free for good.",
  plus: "Papers, marking and Tutor for steady revision, with room for all your subjects.",
  pro: `Nearly twice ${PLAN_LABELS.plus}, for heavy papers and lots of marking.`,
};

/** What a plan is bought for, shown on every card. */
const MAIN_ROWS: AllowanceKey[] = ["tutor", "answers", "paperMarkings"];
/** Paced, because they are used often enough for "about 17 a day" to mean something. */
const PACED_ROWS: AllowanceKey[] = ["tutor", "answers"];
/** One tap away: real, but nobody chooses a plan for them. */
const EXTRA_ROWS: AllowanceKey[] = ["revisionSessions", "videos", "searches", "photos", "diagramLabels", "pages"];

const ROW_WORDS: Partial<Record<AllowanceKey, string>> = {
  tutor: "Tutor messages",
  answers: "marked answers",
  paperMarkings: "of your own past papers marked",
  revisionSessions: "Revision Sessions",
  videos: "video imports",
  searches: "web searches",
  photos: "Tutor photos",
  diagramLabels: "label finds on diagram cards",
  pages: "pages Tutor can search",
};

function rowWords(key: AllowanceKey) {
  return ROW_WORDS[key] ?? ALLOWANCE_LABELS[key];
}

function pounds(pence: number) {
  return `£${(pence / 100).toFixed(2)}`;
}

function poundsShort(pence: number) {
  return pence % 100 === 0 ? `£${pence / 100}` : pounds(pence);
}

export default function PlansView({
  highlight,
  checkoutSucceeded,
  welcomePlan,
}: {
  highlight: AllowanceKey | null;
  /** Back from Stripe after paying: the webhook may take a moment to grant the plan. */
  checkoutSucceeded: boolean;
  /** The plan just bought, for the welcome. */
  welcomePlan?: PaidPlanId | null;
}) {
  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [kind, setKind] = useState<CheckoutKind>("subscription");
  const [buying, setBuying] = useState<{ plan: PaidPlanId; forParent: boolean } | null>(null);
  const [welcome, setWelcome] = useState<PaidPlanId | null>(checkoutSucceeded ? (welcomePlan ?? null) : null);
  // One "now" for the whole visit, so prices cannot shift between render and checkout.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    loadPlanSummary(true)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const current: PlanId | null = summary?.enabled ? summary.plan : null;
  const lifetime = current === "lifetime";
  // In UTC: the pass ends at the last moment of 31 July UTC, which is already
  // 1 August in British Summer Time.
  const passUntil = new Date(getExamPassExpiry(now)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const passMonths = getExamPassMonths(now);
  const highlightKey =
    highlight && (ALLOWANCE_KEYS as readonly string[]).includes(highlight) ? highlight : null;
  const reason = highlightKey && current ? describeUpgradeFor(current, highlightKey) : null;
  const bestSaving = Math.max(
    getExamPassQuote("plus", now).discountPercent,
    getExamPassQuote("pro", now).discountPercent
  );
  // Recommend the step up from where the student is; Nova for everyone else.
  const recommended: PaidPlanId = current === "plus" ? "pro" : "plus";
  const monthSoFar = summary?.enabled && summary.plan !== "lifetime" ? usageSoFar(summary) : [];

  return (
    <div className="space-y-10 sm:space-y-14">
      {checkoutSucceeded && !welcome ? (
        <div role="status" className="app-subtle-panel rounded-xl px-4 py-3 text-sm text-text-primary">
          Thank you. Your plan is being set up and will show here in a moment.
        </div>
      ) : null}

      {lifetime ? (
        <Card tone="warm" padding="lg">
          <h2 className="text-lg font-medium text-text-primary">You have Lifetime access</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
            You joined Jami before plans existed, so it stays free for you, for good, with nothing
            counted month to month. The plans below are what new students choose from.
          </p>
        </Card>
      ) : null}

      {/* The night Jami opens on, so choosing a plan feels like Jami rather than a checkout. */}
      <section className="relative overflow-hidden rounded-2xl bg-[#07051c] px-5 pb-10 pt-12 text-center text-white shadow-bubble sm:px-10 sm:pb-14 sm:pt-16">
        <NightSkyBackdrop />
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 hidden opacity-80 md:block">
          <CelestialBody plan="pro" size={340} animated />
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-10 -left-10 hidden opacity-60 md:block">
          <CelestialBody plan="plus" size={190} animated />
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(70%_100%_at_50%_100%,rgba(255,170,226,.16)_0%,transparent_70%)]"
        />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center">
          {reason && highlightKey ? (
            <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold text-[#ffd6f6] backdrop-blur-md">
              You&apos;ve used this month&apos;s {ALLOWANCE_LABELS[highlightKey]}
            </span>
          ) : (
            <span className="text-xs font-semibold uppercase tracking-[0.28em] text-[#cfc6ff]">Jami plans</span>
          )}
          <h2 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight [text-wrap:balance] sm:text-6xl">
            {reason && highlightKey ? (
              <>
                Keep going with <NightGradient>more {ALLOWANCE_LABELS[highlightKey]}</NightGradient>
              </>
            ) : (
              <>
                Go further <NightGradient>with Jami</NightGradient>
              </>
            )}
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-[#d9d3f7] [text-wrap:pretty] sm:text-base sm:leading-7">
            {reason
              ? `${reason} Free keeps working, and your allowances come back every month.`
              : "More papers written for your course, more marking, more Tutor, and room for every subject."}
          </p>
          {monthSoFar.length > 0 ? (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {monthSoFar.map((item) => (
                <span key={item} className="rounded-full border border-white/10 bg-white/[0.07] px-3 py-1 text-xs text-[#e6e1ff] backdrop-blur-md">
                  {item}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-8">
            <BillingToggle value={kind} onChange={setKind} saving={bestSaving} />
          </div>
          <p className="mt-3 min-h-5 text-xs text-[#b8b0e6]">
            {kind === "pass"
              ? `Pay once and it lasts until ${passUntil}. It never renews.`
              : "Pay monthly, cancel any time."}
          </p>
        </div>
      </section>

      <div className="grid items-stretch gap-6 lg:grid-cols-3 lg:gap-4">
        {(["free", "plus", "pro"] as const).map((plan) => (
          <PlanCard
            key={plan}
            plan={plan}
            kind={kind}
            now={now}
            passUntil={passUntil}
            passMonths={passMonths}
            current={current === plan}
            recommended={plan === recommended}
            disabled={lifetime}
            highlight={highlightKey}
            onChoose={(paid) => setBuying({ plan: paid, forParent: false })}
          />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ValueTile title="Less than one hour of tutoring" icon={<path d="M4 19V9l8-5 8 5v10M9 19v-6h6v6" />}>
          A GCSE tutor costs about {poundsShort(TUTOR_HOUR_PENCE)} an hour. {PLAN_LABELS.plus} is{" "}
          {pounds(PLAN_PRICES_PENCE.plus)} for the whole month.
        </ValueTile>
        <ValueTile title="Cancel any time" icon={<path d="M5 12.5l4.5 4.5L19 7.5" />}>
          No contract. Cancel in Account and keep your plan to the end of the month you paid for.
        </ValueTile>
        <ValueTile title="Your work stays yours" icon={<path d="M6 4h9l3 3v13H6zM9 12h6M9 16h6" />}>
          Go back to Free whenever you like. Every card, notebook and folder you made stays.
        </ValueTile>
      </div>

      <Card padding="lg">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 max-w-xl gap-4">
            <IconBubble size="lg" shape="circle" className="border border-warm-border bg-warm-glow text-warm-accent" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
                <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
              </svg>
            </IconBubble>
            <div className="min-w-0">
              <h2 className="text-base font-medium text-text-primary">Ask a parent to pay</h2>
              <p className="mt-1.5 text-sm leading-6 text-text-muted">
                Make a payment link and send it. They pay on their own phone or computer, and the
                plan lands on your account. They only see the plan and the price.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" disabled={lifetime} onClick={() => setBuying({ plan: "plus", forParent: true })}>
              Link for {PLAN_LABELS.plus}
            </Button>
            <Button variant="secondary" disabled={lifetime} onClick={() => setBuying({ plan: "pro", forParent: true })}>
              Link for {PLAN_LABELS.pro}
            </Button>
          </div>
        </div>
      </Card>

      <section aria-labelledby="plans-questions" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <h2 id="plans-questions" className="text-xl font-medium tracking-tight text-text-primary">
            Questions
          </h2>
          <p className="mt-2 text-sm leading-6 text-text-muted">The things students and parents ask before choosing.</p>
        </div>
        <div className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)]">
          <Question title="What does Free include?">
            Small monthly amounts of papers, marking and Tutor, unlimited flashcards, and{" "}
            {PLAN_SPACE_LIMITS.free.folders} folders with up to {PLAN_SPACE_LIMITS.free.notebooksPerFolder}{" "}
            notebooks of your own in each. {PLAN_LABELS.plus} and {PLAN_LABELS.pro} have no limit on folders or
            notebooks.
          </Question>
          <Question title="What happens when I run out?">
            That one thing pauses until your allowance comes back next month. Everything else keeps
            working, and you can still study, write notes and review cards.
          </Question>
          <Question title="How do I cancel?">
            In Account, any time. There is no fee, and you keep your plan until the end of the month
            you paid for. Then you are on Free, and nothing you made is deleted.
          </Question>
          <Question title="What is the Exam Pass?">
            One payment that covers you until {passUntil}, cheaper each month than paying monthly.
            You get the same allowances every month, and it never renews, so there is nothing to
            cancel.
          </Question>
          <Question title="Can a parent pay?">
            Yes. Make a link above and send it. They pay on their own device and only see the plan
            and the price.
          </Question>
          <Question title="Is paying safe?">
            Payments go through Stripe, a payments company used by businesses worldwide. Jami never
            sees or stores your card. UK cards only.
          </Question>
        </div>
      </section>

      <details className="app-subtle-panel group rounded-xl">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold text-text-primary">
          Compare everything
          <Chevron />
        </summary>
        <div className="overflow-x-auto px-5 pb-5">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead>
              <tr className="text-2xs uppercase tracking-[0.14em] text-text-secondary">
                <th className="py-2 pr-4 font-semibold">Each month</th>
                <th className="py-2 pr-4 font-semibold">{PLAN_LABELS.free}</th>
                <th className="py-2 pr-4 font-semibold">{PLAN_LABELS.plus}</th>
                <th className="py-2 font-semibold">{PLAN_LABELS.pro}</th>
              </tr>
            </thead>
            <tbody>
              {getPlanComparisonRows().map((row) => (
                <tr key={row.key} className="border-t border-[var(--color-border)]">
                  <td className="py-2.5 pr-4 text-text-primary">{row.label}</td>
                  <td className="py-2.5 pr-4 text-text-muted">{row.free}</td>
                  <td className="py-2.5 pr-4 text-text-muted">{row.plus}</td>
                  <td className="py-2.5 text-text-muted">{row.pro}</td>
                </tr>
              ))}
              <tr className="border-t border-[var(--color-border)]">
                <td className="py-2.5 pr-4 text-text-primary">Folders</td>
                <td className="py-2.5 pr-4 text-text-muted">{PLAN_SPACE_LIMITS.free.folders}</td>
                <td className="py-2.5 pr-4 text-text-muted">Unlimited</td>
                <td className="py-2.5 text-text-muted">Unlimited</td>
              </tr>
              <tr className="border-t border-[var(--color-border)]">
                <td className="py-2.5 pr-4 text-text-primary">Your own notebooks in each folder</td>
                <td className="py-2.5 pr-4 text-text-muted">{PLAN_SPACE_LIMITS.free.notebooksPerFolder}</td>
                <td className="py-2.5 pr-4 text-text-muted">Unlimited</td>
                <td className="py-2.5 text-text-muted">Unlimited</td>
              </tr>
              <tr className="border-t border-[var(--color-border)]">
                <td className="py-2.5 pr-4 text-text-primary">Flashcards, decks and the planner</td>
                <td className="py-2.5 pr-4 text-text-muted">Unlimited</td>
                <td className="py-2.5 pr-4 text-text-muted">Unlimited</td>
                <td className="py-2.5 text-text-muted">Unlimited</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-xs text-text-muted">An Exam Pass gives the same each month, until {passUntil}.</p>
        </div>
      </details>

      <p className="text-xs leading-5 text-text-muted">
        UK cards only. Prices are the whole price. Plans renew monthly until you cancel, and
        cancelling keeps your plan until the end of the month you paid for. Exam Passes last until{" "}
        {passUntil} and never renew. Everyone who joined before plans has Lifetime access and never pays.
      </p>

      {buying ? (
        // Keyed so each purchase opens with the waiver unticked and no old link.
        <CheckoutDialog
          key={`${buying.plan}:${buying.forParent}:${kind}`}
          buying={buying}
          kind={kind}
          now={now}
          passUntil={passUntil}
          onClose={() => setBuying(null)}
        />
      ) : null}

      {welcome ? <PlanWelcome plan={welcome} onClose={() => setWelcome(null)} /> : null}
    </div>
  );
}

/** "Jami papers 1 of 1 used": the month so far, so the choice is about this student. */
function usageSoFar(summary: Extract<PlanSummary, { enabled: true }>) {
  const items = summary.groups.flatMap((group) => group.items);
  return (["papers", "tutor", "answers"] as const)
    .map((key) => items.find((item) => item.key === key))
    .filter((item): item is NonNullable<typeof item> => Boolean(item && item.shown === "count" && item.used > 0))
    .map((item) => `${ALLOWANCE_LABELS[item.key][0].toUpperCase()}${ALLOWANCE_LABELS[item.key].slice(1)}: ${item.used.toLocaleString("en-GB")} of ${item.limit.toLocaleString("en-GB")} used`);
}

function NightGradient({ children }: { children: ReactNode }) {
  return (
    <span className="bg-[linear-gradient(100deg,#c9bcff_10%,#ffd6f6_60%,#ffe9c7)] bg-clip-text text-transparent">
      {children}
    </span>
  );
}

function GradientText({ children, warm }: { children: ReactNode; warm: boolean }) {
  return (
    <span
      className={`bg-clip-text text-transparent ${
        warm
          ? "bg-[linear-gradient(100deg,var(--color-warm-accent),var(--color-accent-hover))]"
          : "bg-[linear-gradient(100deg,var(--color-accent-hover),var(--color-warm-accent))]"
      }`}
    >
      {children}
    </span>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted transition group-open:rotate-180" fill="currentColor">
      <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" />
    </svg>
  );
}

/** Monthly or Exam Pass, as one pill on the night sky: how to pay, not which plan. */
function BillingToggle({
  value,
  onChange,
  saving,
}: {
  value: CheckoutKind;
  onChange: (next: CheckoutKind) => void;
  saving: number;
}) {
  const options: { value: CheckoutKind; label: string }[] = [
    { value: "subscription", label: "Monthly" },
    { value: "pass", label: "Exam Pass" },
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = value === "subscription" ? "pass" : "subscription";
    onChange(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="How to pay"
      className="inline-flex rounded-full border border-white/15 bg-white/[0.07] p-1 backdrop-blur-md"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-value={option.value}
            onKeyDown={onKeyDown}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9bcff] sm:px-5 ${
              selected
                ? "bg-white text-[#1b1240] shadow-accent"
                : "text-[#e6e1ff] hover:text-white"
            }`}
          >
            {option.label}
            {option.value === "pass" ? (
              <span
                className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${
                  selected ? "bg-[#ece6ff] text-[#3b2a8f]" : "bg-[#ffd6f6]/20 text-[#ffd6f6]"
                }`}
              >
                Up to {saving}% off
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Each plan's mark: Jami's star, then two galaxies, straight on the card. */
function PlanGlyph({ plan }: { plan: ShownPlan }) {
  return <CelestialBody plan={plan} size={64} className="-my-3 -ml-2" />;
}

/** "£7.99" set like a price tag: the pounds large, the pence and £ smaller. */
function Price({ pence }: { pence: number }) {
  const whole = Math.floor(pence / 100);
  const part = String(pence % 100).padStart(2, "0");
  return (
    <span className="inline-flex items-start font-semibold tracking-tight text-text-primary tabular-nums" aria-label={pounds(pence)}>
      <span aria-hidden="true" className="mt-1.5 text-2xl">£</span>
      <span aria-hidden="true" className="text-6xl leading-none">{whole}</span>
      {pence === 0 ? null : (
        <span aria-hidden="true" className="mt-1.5 text-2xl">.{part}</span>
      )}
    </span>
  );
}

/** Jami papers as paper, one mark for each a month. */
function PaperRow({ count, tone }: { count: number; tone: string }) {
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-1">
      {Array.from({ length: count }, (_, index) => (
        <svg key={index} viewBox="0 0 14 18" className={`h-[18px] w-[14px] ${tone}`} fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M1.5 1.5h7l4 4v11h-11z" fill="currentColor" fillOpacity="0.16" />
          <path d="M4 8.5h6M4 11h6M4 13.5h4" strokeLinecap="round" />
        </svg>
      ))}
    </div>
  );
}

function PlanCard({
  plan,
  kind,
  now,
  passUntil,
  passMonths,
  current,
  recommended,
  disabled,
  highlight,
  onChoose,
}: {
  plan: ShownPlan;
  kind: CheckoutKind;
  now: number;
  passUntil: string;
  passMonths: number;
  current: boolean;
  recommended: boolean;
  disabled: boolean;
  highlight: AllowanceKey | null;
  onChoose: (plan: PaidPlanId) => void;
}) {
  const paid = plan === "free" ? null : plan;
  const warm = plan === "pro";
  const pass = kind === "pass" && Boolean(paid);
  const quote = paid ? getExamPassQuote(paid, now) : null;
  const monthlyPence = !paid ? 0 : pass && quote ? quote.perMonthPence : PLAN_PRICES_PENCE[paid];
  const papers = PLAN_ALLOWANCES[plan].papers.limit;
  const space = PLAN_SPACE_LIMITS[plan];
  const extras = highlight && EXTRA_ROWS.includes(highlight);
  const accentTone = !paid ? "text-text-secondary" : warm ? "text-warm-accent" : "text-accent";

  // Free has no pass, so it keeps its monthly numbers either way.
  const amount = (key: AllowanceKey) => {
    if (!pass) {
      const value = describePlanAllowance(plan, key);
      return {
        main: value.replace(" a month", ""),
        aside: PACED_ROWS.includes(key) ? describeAllowancePace(plan, key) : null,
      };
    }
    const value = describePassAllowance(plan, key, passMonths);
    return { main: value.total, aside: value.perMonth };
  };

  const row = (key: AllowanceKey, quiet: boolean) => {
    const { main, aside } = amount(key);
    const missing = main === "Not included";
    const emphasised = key === highlight;
    return (
      <li
        key={key}
        className={`flex min-w-0 items-start gap-2.5 ${emphasised ? "-mx-2 rounded-lg bg-accent-muted px-2 py-1" : ""}`}
      >
        <Tick missing={missing} strong={recommended && !quiet} warm={warm} />
        <span className={`min-w-0 ${missing ? "text-text-muted" : quiet ? "text-text-muted" : "text-text-secondary"}`}>
          {missing ? (
            <>No {rowWords(key)}</>
          ) : (
            <>
              <span className="font-semibold text-text-primary tabular-nums">{main}</span> {rowWords(key)}
              {aside ? <span className="text-text-muted"> · {aside}</span> : null}
            </>
          )}
        </span>
      </li>
    );
  };

  const card = (
    <section
      aria-label={`${PLAN_LABELS[plan]} plan`}
      className={`relative flex h-full min-w-0 flex-col overflow-hidden rounded-2xl p-6 sm:p-7 ${
        recommended
          ? "bg-[var(--color-surface-raised)] lg:py-9"
          : `border-[1.5px] bg-[var(--color-surface-panel)] shadow-bubble backdrop-blur-md ${
              warm ? "border-warm-border" : "border-[var(--color-border-strong)]"
            }`
      }`}
    >
      <div className="relative flex flex-1 flex-col">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <PlanGlyph plan={plan} />
            <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
              {paid ? <GradientText warm={warm}>{PLAN_LABELS[plan]}</GradientText> : PLAN_LABELS[plan]}
            </h2>
          </div>
          {current ? (
            <span className="app-chip rounded-full px-2.5 py-0.5 text-2xs font-semibold">Your plan</span>
          ) : null}
        </div>
        <h3 className="mt-5 text-lg font-semibold leading-snug text-text-primary [text-wrap:balance]">{OUTCOMES[plan]}</h3>
        <p className="mt-1 text-sm leading-6 text-text-muted">{TAGLINES[plan]}</p>

        <div className="mt-6 flex items-end gap-2">
          <Price pence={monthlyPence} />
          <span className="mb-1 text-sm text-text-muted">{paid ? "a month" : "for good"}</span>
        </div>
        <div className="mt-2 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          {paid && pass && quote ? (
            <>
              <span>
                {pounds(quote.pricePence)} once · {quote.months} {quote.months === 1 ? "month" : "months"}
              </span>
              <span className="rounded-full bg-success-muted px-2 py-0.5 font-semibold text-text-primary">
                Save {pounds(quote.savingPence)}
              </span>
            </>
          ) : paid ? (
            <span>
              That&apos;s about <span className="font-semibold text-text-secondary">{perDayPence(monthlyPence)}p a day</span>
            </span>
          ) : (
            <span>No card needed</span>
          )}
        </div>

        <div className="mt-6">
          {!paid ? (
            <Button variant="ghost" disabled className="w-full justify-center">
              {current ? "Your plan" : "Free forever"}
            </Button>
          ) : (
            <Button
              variant={recommended ? "primary" : "secondary"}
              size={recommended ? "lg" : "md"}
              disabled={disabled || (current && !pass)}
              className="w-full justify-center"
              onClick={() => onChoose(paid)}
            >
              {current && !pass ? "Your plan" : pass ? `Get ${PLAN_LABELS[paid]} to July` : `Get ${PLAN_LABELS[paid]}`}
            </Button>
          )}
          <p className="mt-2 text-center text-2xs text-text-muted">
            {!paid ? "Always free." : pass ? `Lasts until ${passUntil}.` : "Cancel any time."}
          </p>
        </div>

        <div className="my-6 h-px bg-[var(--color-border)]" />

        <div
          className={`rounded-2xl border px-3.5 py-3 ${
            highlight === "papers" ? "border-accent bg-accent-muted" : "border-[var(--color-border)] bg-[var(--color-glass-subtle)]"
          }`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-text-primary">
              {pass ? describePassAllowance(plan, "papers", passMonths).total : papers}{" "}
              {papers === 1 && !pass ? "Jami paper" : "Jami papers"}
            </span>
            <span className="text-2xs text-text-muted">
              {pass ? `${papers} a month` : describeAllowancePace(plan, "papers") ?? "a month"}
            </span>
          </div>
          <div className="mt-2">
            <PaperRow count={papers} tone={accentTone} />
          </div>
          <div className="mt-1.5 text-2xs text-text-muted">Exam-style papers written for your course, marked by Jami.</div>
        </div>

        <ul className="mt-4 space-y-2.5 text-sm">
          {MAIN_ROWS.map((key) => row(key, false))}
          <li className="flex min-w-0 items-start gap-2.5">
            <Tick missing={false} strong={recommended} warm={warm} />
            <span className="min-w-0 text-text-secondary">
              {space.folders === null ? (
                <>
                  <span className="font-semibold text-text-primary">Unlimited</span> folders and notebooks
                </>
              ) : (
                <>
                  <span className="font-semibold text-text-primary">{space.folders}</span> folders,{" "}
                  {space.notebooksPerFolder} notebooks in each
                </>
              )}
            </span>
          </li>
        </ul>

        <details className="group mt-5 border-t border-[var(--color-border)] pt-1" open={Boolean(extras) || undefined}>
          <summary className="flex cursor-pointer list-none items-center justify-between py-3 text-xs font-semibold text-text-secondary hover:text-text-primary">
            Everything else
            <Chevron />
          </summary>
          <ul className="space-y-2 pb-1 text-xs">
            {EXTRA_ROWS.map((key) => row(key, true))}
            <li className="flex min-w-0 items-start gap-2.5">
              <Tick missing={false} strong={false} warm={warm} />
              <span className="min-w-0 text-text-muted">
                <span className="font-semibold text-text-primary">Unlimited</span> flashcards, decks and the planner
              </span>
            </li>
            <li className="flex min-w-0 items-start gap-2.5">
              <Tick missing={false} strong={false} warm={warm} />
              <span className="min-w-0 text-text-muted">
                {paid ? (
                  <>
                    <span className="font-semibold text-text-primary">Unlimited</span> card drafts and cards from files
                  </>
                ) : (
                  <>Card drafts and cards from files, a few each month</>
                )}
              </span>
            </li>
          </ul>
        </details>
      </div>
    </section>
  );

  if (!recommended) {
    return <div className="transition duration-normal hover:-translate-y-1 motion-reduce:transform-none">{card}</div>;
  }
  const edge = warm
    ? "bg-[linear-gradient(160deg,var(--color-warm-accent),var(--color-accent)_55%,var(--color-warm-border))]"
    : "bg-[linear-gradient(160deg,var(--color-accent),var(--color-warm-accent)_55%,var(--color-accent-muted))]";
  return (
    <div className={`relative rounded-2xl p-[2px] shadow-accent transition duration-normal hover:-translate-y-1 motion-reduce:transform-none lg:-my-4 ${edge}`}>
      <span className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-[linear-gradient(100deg,var(--color-accent),var(--color-accent-hover))] px-3.5 py-1 text-2xs font-semibold uppercase tracking-[0.14em] text-accent-on shadow-accent">
        {current ? "Your plan" : "Recommended"}
      </span>
      {card}
    </div>
  );
}

function Tick({ missing, strong, warm }: { missing: boolean; strong: boolean; warm: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full ${
        missing
          ? "bg-[var(--color-glass-subtle)] text-text-muted"
          : strong
            ? "bg-accent text-accent-on"
            : warm
              ? "bg-warm-glow text-warm-accent"
              : "bg-accent-muted text-accent"
      }`}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {missing ? <path d="M4.5 8h7" /> : <path d="M4 8.5l2.5 2.5L12 5.5" />}
      </svg>
    </span>
  );
}

function ValueTile({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="app-subtle-panel flex gap-3.5 rounded-2xl p-5">
      <IconBubble size="md" shape="circle" className="bg-accent-muted text-accent" aria-hidden>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </IconBubble>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-text-muted">{children}</p>
      </div>
    </div>
  );
}

function Question({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group px-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-semibold text-text-primary">
        {title}
        <Chevron />
      </summary>
      <p className="-mt-1 pb-4 text-sm leading-6 text-text-muted">{children}</p>
    </details>
  );
}

function CheckoutDialog({
  buying,
  kind,
  now,
  passUntil,
  onClose,
}: {
  buying: { plan: PaidPlanId; forParent: boolean };
  kind: CheckoutKind;
  now: number;
  passUntil: string;
  onClose: () => void;
}) {
  const [waiver, setWaiver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parentLink, setParentLink] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const label = PLAN_LABELS[buying.plan];
  const price =
    kind === "subscription"
      ? `${pounds(PLAN_PRICES_PENCE[buying.plan])} a month, renewing monthly until cancelled`
      : `${pounds(getExamPassPricePence(buying.plan, now))} once, lasting until ${passUntil}`;

  const proceed = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await startCheckout({
        plan: buying.plan,
        kind,
        waiverAccepted: waiver,
        forParent: buying.forParent,
      });
      if (buying.forParent) {
        setParentLink(url);
      } else {
        window.location.assign(url);
      }
    } catch (reason) {
      // Already paying monthly: switching happens in Stripe's portal, not a second checkout.
      if (reason instanceof CheckoutError && reason.code === "use_portal") {
        try {
          window.location.assign(await openBillingPortal());
          return;
        } catch {
          // Fall through to the message.
        }
      }
      setError(
        reason instanceof CheckoutError ? reason.message : "Payments are unavailable right now. Try again shortly."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      dismissible={!busy}
      initialFocusRef={cancelRef}
      className="fixed inset-0 z-[90] flex items-end justify-center p-4 sm:items-center"
      onDismiss={onClose}
    >
      <DialogBackdrop className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <DialogPanel className="app-panel relative w-full max-w-md rounded-2xl p-5 shadow-e3 sm:p-6">
        <DialogTitle className="text-lg font-semibold text-text-primary">
          {buying.forParent ? `A payment link for ${label}` : `Jami ${label}${kind === "pass" ? " Exam Pass" : ""}`}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm leading-6 text-text-secondary">{price}.</DialogDescription>

        {parentLink ? (
          <div className="mt-5 space-y-3">
            <p className="text-sm text-text-muted">Send this to whoever is paying. It works for 24 hours.</p>
            <input
              readOnly
              value={parentLink}
              className="app-subtle-panel w-full rounded-lg px-3 py-2 text-xs text-text-primary"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              className="w-full justify-center"
              onClick={() => void navigator.clipboard?.writeText(parentLink)}
            >
              Copy link
            </Button>
          </div>
        ) : (
          <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm leading-6 text-text-primary">
            <input
              type="checkbox"
              checked={waiver}
              onChange={(event) => setWaiver(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span>{CHECKOUT_WAIVER_TEXT}</span>
          </label>
        )}

        {error ? (
          <p role="alert" className="mt-3 text-sm text-warm-accent">
            {error}
          </p>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-2">
          <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onClose}>
            {parentLink ? "Done" : "Cancel"}
          </Button>
          {parentLink ? null : (
            <Button disabled={!waiver || busy} onClick={() => void proceed()}>
              {busy ? "Opening…" : buying.forParent ? "Make link" : "Continue to payment"}
            </Button>
          )}
        </div>
      </DialogPanel>
    </Dialog>
  );
}
