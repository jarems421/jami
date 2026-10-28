"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type ViewTabItem = {
  href: string;
  label: string;
  /** What this view is for, in the student's terms. */
  detail: string;
};

/**
 * Two or three views of one thing, switched between without leaving it.
 *
 * Built from links rather than buttons so every view has its own address: a
 * student can bookmark the one they use, the back button behaves, and another
 * page can send somebody straight to the right view.
 *
 * The point is that the views a student is *not* looking at stay visible. A
 * surface split across separate navigation entries hides half of itself from
 * anyone who has not found the other entry yet.
 *
 * Drawn as a row of underlined labels along the bottom of the page header,
 * rather than as a control of its own. It used to be a bordered pill shell on
 * the `--nav-shell-*` tokens, which put a third piece of chrome below the
 * sidebar and the top bar -- the same frame, the same two-line label-and-detail
 * items, three times over, before any of the student's own work appeared.
 *
 * Deliberately not on `.app-nav`: that class hides itself inside the notebook
 * editor, takes a constellation background override, and is forced to the page
 * shell radius. All three are right for a shell and wrong for a row nested in
 * one.
 */
export default function ViewTabs({
  items,
  label,
}: {
  items: ViewTabItem[];
  label: string;
}) {
  // Typed as a string, but null wherever there is no router above this -- a
  // test harness, or a tree rendered outside the app shell. Nothing is marked
  // current in that case, which is better than the control throwing.
  const pathname = usePathname() ?? "";

  const matches = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  /*
   * The most specific view wins. A view can live under another's address --
   * Progress's Practice view is /dashboard/progress/practice -- and matching by
   * prefix alone lit both tabs at once.
   */
  const activeHref = items
    .filter((item) => matches(item.href))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;
  const activeDetail = items.find((item) => isActive(item.href))?.detail;

  return (
    <nav
      aria-label={label}
      className="-mx-3 mt-3 flex items-stretch gap-1 overflow-x-auto border-t border-[var(--color-border)] px-3 scrollbar-hide sm:-mx-4 sm:px-4"
    >
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            // Lets a walkthrough point at one view, the way `data-agent-nav` names sidebar entries.
            data-view-tab={item.label}
            className={`relative flex min-h-11 shrink-0 items-center rounded-t-md px-3 text-sm font-semibold transition duration-fast ${
              active
                ? "text-text-primary"
                : "text-text-muted hover:bg-[var(--nav-hover-bg)] hover:text-text-primary"
            }`}
          >
            <span className="truncate">{item.label}</span>
            {/*
             * Always rendered, so the label never shifts as the underline
             * arrives -- only its colour changes.
             */}
            <span
              aria-hidden="true"
              className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full transition duration-fast ${
                active ? "bg-warm-accent" : "bg-transparent"
              }`}
            />
          </Link>
        );
      })}

      {/*
       * What the view you are on is for. "Decks" and "Sources" are the words
       * that needed explaining, and they still do -- but one quiet line earns
       * its place where a subtitle under every label did not.
       */}
      {activeDetail ? (
        <span className="ml-auto hidden shrink-0 items-center pl-4 text-2xs text-text-muted sm:flex">
          {activeDetail}
        </span>
      ) : null}
    </nav>
  );
}
