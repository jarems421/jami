import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One of Jami's own places, as a door on the Tutor page.
 *
 * The page used to stack a card per feature -- the ask banner, the plan, the
 * revision shelf -- each drawn differently and each explaining itself, so it
 * read as a pile of unrelated panels. Every door now has the same shape: what
 * it is, one line on what it does for you, where you are with it, and the way
 * in. The whole card is the link, so the button is a label, not a second
 * target. A door that opens something on this page, rather than going
 * somewhere, takes `onOpen` instead of `href` and is the same card as a button.
 */
export default function TutorDoor({
  href,
  onOpen,
  icon,
  tone = "accent",
  title,
  description,
  status,
  action,
}: (
  | { href: string; onOpen?: never }
  | { href?: never; onOpen: () => void }
) & {
  icon: ReactNode;
  /**
   * Which of Jami's colours the door's mark is in, so the three tell apart. The
   * mark only: a wash of the colour across the card's corner read as a glow.
   */
  tone?: "accent" | "warm" | "success";
  title: string;
  description: string;
  /** Where the student is with it: "Next: Biology at 10:00". */
  status?: ReactNode;
  action: string;
}) {
  const mark =
    tone === "warm"
      ? "border-warm-border bg-warm-glow text-warm-accent"
      : tone === "success"
        ? "border-[var(--color-success)] bg-[var(--color-success-muted)] text-[var(--color-success)]"
        : "border-accent/40 bg-accent/15 text-[var(--color-accent)]";

  const className = `app-panel group flex h-full flex-col gap-3 rounded-3xl p-5 text-left transition duration-fast ease-spring hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 sm:p-6`;
  const body = (
    <>
      <span className={`grid h-11 w-11 place-items-center rounded-2xl border ${mark}`} aria-hidden="true">
        {icon}
      </span>
      <span className="text-lg font-bold tracking-tight text-text-primary">{title}</span>
      <span className="text-sm leading-6 text-text-secondary">{description}</span>
      {status ? <span className="mt-auto pt-1 text-xs leading-5 text-text-muted">{status}</span> : null}
      <span
        className={`inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-accent)] transition group-hover:text-[var(--color-accent-hover)] ${
          status ? "" : "mt-auto"
        }`}
      >
        {action}
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" aria-hidden="true">
          <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </>
  );
  return href !== undefined ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onOpen} className={className}>
      {body}
    </button>
  );
}
