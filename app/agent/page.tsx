import Link from "next/link";
import AppPage from "@/components/layout/AppPage";
import { Card, PageHero, SectionHeader } from "@/components/ui";

const dashboardRoutes = [
  {
    href: "/dashboard",
    label: "Today",
    purpose: "Start with the daily command centre and recommended next action.",
  },
  {
    href: "/dashboard/study",
    label: "Learn",
    purpose: "Review flashcards and inspect the learning queue.",
  },
  {
    href: "/dashboard/practice",
    label: "Practice",
    purpose: "Continue working and open folder or notebook entry points.",
  },
  {
    href: "/dashboard/tutor",
    label: "Jami",
    purpose: "Ask the tutor about your sources, make a revision plan, and review drafts.",
  },
  {
    href: "/dashboard/folders",
    label: "Folders",
    purpose: "Inspect folder-based organisation for notebooks, decks, and sources.",
  },
  {
    href: "/dashboard/progress",
    label: "Progress",
    purpose: "Check learning activity, trends, and areas that need attention.",
  },
  {
    href: "/dashboard/library",
    label: "Sources",
    purpose: "Manage saved source material and deliberate source actions.",
  },
  {
    href: "/dashboard/cards",
    label: "Cards",
    purpose: "Browse and manage flashcards.",
  },
  {
    href: "/dashboard/decks",
    label: "Decks",
    purpose: "Understand deck/card-set organisation.",
  },
  {
    href: "/dashboard/planner",
    label: "Plan",
    purpose: "Build and keep a revision timetable; Goals is the second tab.",
  },
  {
    href: "/dashboard/goals",
    label: "Goals",
    purpose: "Manage study targets and deadlines (a tab of Plan).",
  },
  {
    href: "/dashboard/constellation",
    label: "Stars",
    purpose: "Inspect earned rewards and constellation progress.",
  },
  {
    href: "/dashboard/profile",
    label: "Account",
    purpose: "Review account, preferences, and data controls.",
  },
];

function AgentLink({
  href,
  label,
  purpose,
}: {
  href: string;
  label: string;
  purpose: string;
}) {
  return (
    <Link
      href={href}
      data-agent-route={href}
      className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 text-left transition duration-fast hover:-translate-y-0.5 hover:border-warm-border hover:bg-[var(--color-glass-strong,var(--color-glass-subtle))]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">{label}</div>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{purpose}</p>
        </div>
        <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-2.5 py-1 text-xs font-semibold text-text-muted group-hover:text-warm-accent">
          Open
        </span>
      </div>
    </Link>
  );
}

export default function AgentPage() {
  return (
    <AppPage
      title="Agent Walkthrough"
      width="3xl"
      contentClassName="space-y-5 sm:space-y-6"
    >
      <PageHero
        eyebrow="QA route index"
        title="Check Jami's authenticated product surfaces."
        description="Use this index after signing in to open the current Firebase-backed app routes directly. It does not bypass authentication or provide seeded demo data."
        action={
          <Link
            href="/dashboard"
            data-agent-start="dashboard"
            className="inline-flex min-h-[3.25rem] items-center justify-center rounded-2xl border border-white/24 bg-[linear-gradient(180deg,#fff8fd_0%,#ffe8f7_42%,#ffdff4_100%)] px-5 py-3 text-base font-medium text-[#10091d] shadow-warm transition duration-fast hover:-translate-y-[1px] hover:brightness-105"
          >
            Open dashboard
          </Link>
        }
        secondaryAction={
          <a
            href="/llms.txt"
            className="inline-flex min-h-[3.25rem] items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-5 py-3 text-base font-medium text-text-primary transition duration-fast hover:border-border-strong hover:bg-[var(--color-glass-strong,var(--color-glass-subtle))]"
          >
            Plain-text route map
          </a>
        }
      />

      <Card padding="lg">
        <SectionHeader
          title="Access rules"
          description="These routes use the same authentication and persistence paths as the product."
        />
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {[
            ["Sign-in required", "Dashboard routes redirect signed-out visitors to the authentication page."],
            ["Real user data", "Reads and writes use the signed-in account's Firebase data."],
            ["No demo bypass", "The route index does not enable test-only behavior or local seeded content."],
          ].map(([title, detail]) => (
            <div key={title} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4">
              <div className="text-sm font-semibold text-text-primary">{title}</div>
              <p className="mt-2 text-sm leading-6 text-text-secondary">{detail}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card padding="lg">
        <SectionHeader
          title="Direct route map"
          description="Open any stable top-level route directly after authentication."
        />
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {dashboardRoutes.map((route) => (
            <AgentLink key={route.href} {...route} />
          ))}
        </div>
      </Card>

    </AppPage>
  );
}
