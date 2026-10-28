"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { JamiTutorIcon } from "@/components/ui";
import { usePathname } from "next/navigation";
import { type TouchEvent, useEffect, useRef } from "react";
import { BrandMark, IconBubble } from "@/components/ui";
import { useFirstNight } from "@/components/onboarding/FirstNightProvider";
import { FirstNightNavStar } from "@/components/onboarding/FirstNightSky";
import { PLAN_HOME, PLANNER_PATH } from "@/lib/app/plan-views";

type TabGroup = "loop" | "support";

type Tab = {
  href: string;
  label: string;
  mobileLabel?: string;
  description: string;
  group: TabGroup;
  /**
   * SVG path data for the icon (24x24 viewBox).
   *
   * A list is drawn as separate shapes. One string is filled with the evenodd
   * rule, so overlapping parts of it cut holes -- right for a glyph with a
   * cut-out, wrong for a figure built from pieces that sit on top of each
   * other, where every overlap would punch through to the background.
   */
  icon: string | readonly string[];
  /**
   * Other routes this entry is the home of.
   *
   * One entry can cover a surface that spans several addresses -- Flashcards
   * is decks and every card, Folders is notebooks too -- and it has to stay
   * lit inside all of them, or a student navigates somewhere real and the
   * sidebar tells them they are nowhere.
   */
  owns?: string[];
  /**
   * A drawn mark, for an entry whose icon is a character rather than a glyph.
   * Takes precedence over `icon`, which stays required so every entry has a
   * shape even while one is being swapped.
   */
  iconComponent?: ComponentType<{ className?: string }>;
  iconMode?: "fill" | "stroke";
};

const tabs: Tab[] = [
  {
    href: "/dashboard",
    label: "Today",
    mobileLabel: "Today",
    description: "Start point",
    group: "loop",
    icon: "M11.47 3.841a.75.75 0 011.06 0l8.69 8.69a.75.75 0 01-.53 1.28h-1.44v7.44a.75.75 0 01-.75.75h-3a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-1.5a.75.75 0 00-.75.75v4.5a.75.75 0 01-.75.75h-3a.75.75 0 01-.75-.75v-7.44H5.31a.75.75 0 01-.53-1.28l8.69-8.69z",
  },
  {
    href: "/dashboard/study",
    label: "Learn",
    description: "Review flashcards",
    group: "loop",
    icon: "M11.4 2.55a1 1 0 011.2 0l8.1 6.075a1 1 0 010 1.6l-3.2 2.4v3.05a1 1 0 01-.42.815C15.63 17.51 13.92 18.05 12 18.05s-3.63-.54-5.08-1.565a1 1 0 01-.42-.815v-3.045l-2-1.5v4.425a1 1 0 11-2 0V9.625a1 1 0 01.4-.8l8.5-6.275zm-3.15 11.4v1.16c1.1.62 2.35.94 3.75.94s2.65-.32 3.75-.94v-1.16l-3.15 2.363a1 1 0 01-1.2 0L8.25 13.95z",
  },
  {
    href: "/dashboard/practice",
    owns: ["/dashboard/practise", "/dashboard/folders", "/dashboard/notebooks"],
    label: "Practice",
    description: "Notebooks and papers",
    group: "loop",
    icon: "M3 6.75A2.75 2.75 0 015.75 4h4.44c.73 0 1.43.29 1.945.805l1.06 1.06c.235.235.553.367.884.367h4.171A2.75 2.75 0 0121 8.982v8.268A2.75 2.75 0 0118.25 20h-12.5A2.75 2.75 0 013 17.25V6.75z",
  },
  {
    href: "/dashboard/tutor",
    owns: ["/dashboard/library"],
    iconComponent: JamiTutorIcon,
    label: "Jami",
    description: "Ask Jami, review drafts",
    group: "loop",
    icon: "M12 2.5l1.25 3.75 3.75 1.25-3.75 1.25-1.25 3.75-1.25-3.75-3.75-1.25 3.75-1.25z M17.8 12l.85 2.35 2.35.85-2.35.85-.85 2.35-.85-2.35-2.35-.85 2.35-.85z M6 14.4l.55 1.65 1.65.55-1.65.55-.55 1.65-.55-1.65-1.65-.55 1.65-.55z",
  },
  {
    href: "/dashboard/decks",
    owns: ["/dashboard/cards"],
    label: "Flashcards",
    mobileLabel: "Cards",
    description: "Decks and every card",
    group: "support",
    icon: "M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026-.383-1.178-1.47-2.026-2.75-2.026h-11A2.75 2.75 0 003.75 9.776zM2.25 12.75a2.75 2.75 0 012.75-2.75h14a2.75 2.75 0 012.75 2.75v6.5a2.75 2.75 0 01-2.75 2.75H5a2.75 2.75 0 01-2.75-2.75v-6.5zM6.5 7.25V5.5A2.75 2.75 0 019.25 2.75h5.5A2.75 2.75 0 0117.5 5.5v1.75",
  },
  {
    href: "/dashboard/topics",
    label: "Topics",
    description: "Connect study material",
    group: "support",
    icon: "M12 2.25c4.83 0 8.75 3.92 8.75 8.75S16.83 19.75 12 19.75c-.36 0-.72-.02-1.08-.07l-3.31 2.76a.75.75 0 01-1.23-.58v-3.1A8.72 8.72 0 013.25 11c0-4.83 3.92-8.75 8.75-8.75zm-3.5 6.1a.75.75 0 01.75-.75h5.5a.75.75 0 010 1.5h-5.5a.75.75 0 01-.75-.75zm0 4a.75.75 0 01.75-.75h4a.75.75 0 010 1.5h-4a.75.75 0 01-.75-.75z",
  },
  {
    // The revision plan and goals, one entry: it opens on the plan.
    href: PLAN_HOME,
    owns: [PLANNER_PATH, "/dashboard/goals"],
    label: "Plan",
    description: "Timetable and goals",
    group: "support",
    iconMode: "stroke",
    icon: "M7.5 3v3M16.5 3v3M3.75 9h16.5M5.25 5.25h13.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-12a1.5 1.5 0 011.5-1.5zM7.5 12.75h3M7.5 16.5h6",
  },
  {
    href: "/dashboard/constellation",
    label: "Stars",
    description: "Rewards",
    group: "support",
    /*
     * The northern star, scaled from its own 160 box into this 24 one.
     *
     * The entry that leads to the sky drew a five-point Heroicon, so the
     * feature was announced in the nav with a star nobody ever earns. The
     * reward overlay, the walkthrough trail, the landing page and now the sky
     * itself all draw NORTHERN_STAR_PATH; this is the same path at 24.
     */
    icon: "M12 0.15C12 11.76 12.19 12 21.3 12C12.19 12 12 12.24 12 23.85C12 12.24 11.81 12 2.7 12C11.81 12 12 11.76 12 0.15Z",
  },
  /*
   * Last but one, directly above Account.
   *
   * Progress is somewhere you go to look back rather than a place work gets
   * done, so it sat oddly at the head of the workspace group -- ahead of the
   * material it reports on. Sitting with Account puts the two things you visit
   * occasionally at the bottom together.
   */
  {
    href: "/dashboard/progress",
    label: "Progress",
    description: "See weak topics",
    group: "support",
    icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  },
  {
    href: "/dashboard/profile",
    label: "Account",
    description: "Settings",
    group: "support",
    icon: "M7.5 6.5C7.5 4.015 9.515 2 12 2s4.5 2.015 4.5 4.5S14.485 11 12 11 7.5 8.985 7.5 6.5zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z",
  },
];

const navGroups: { id: TabGroup; label: string; helper: string }[] = [
  {
    id: "loop",
    label: "Study",
    helper: "Today, review, practice and Jami",
  },
  {
    id: "support",
    label: "Workspace",
    helper: "Material, plan, rewards, progress",
  },
];

function isActive(pathname: string, tab: Tab) {
  // Home is the only exact match; everything else owns its subtree.
  if (tab.href === "/dashboard") return pathname === "/dashboard";
  return [tab.href, ...(tab.owns ?? [])].some((route) =>
    pathname.startsWith(route),
  );
}

function NavIcon({ tab, active }: { tab: Tab; active: boolean }) {
  const strokeIcon = tab.iconMode === "stroke";
  const sizing = `h-5 w-5 transition duration-fast ${active ? "opacity-100" : "opacity-75"}`;

  if (tab.iconComponent) {
    const Icon = tab.iconComponent;
    return <Icon className={sizing} />;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill={strokeIcon ? "none" : "currentColor"}
      stroke={strokeIcon ? "currentColor" : undefined}
      strokeWidth={strokeIcon ? 1.9 : undefined}
      strokeLinecap={strokeIcon ? "round" : undefined}
      strokeLinejoin={strokeIcon ? "round" : undefined}
      aria-hidden="true"
      className={sizing}
    >
      {(typeof tab.icon === "string" ? [tab.icon] : tab.icon).map((shape) => (
        <path key={shape} fillRule="evenodd" clipRule="evenodd" d={shape} />
      ))}
    </svg>
  );
}

function DesktopNavItem({ tab, active, pending = false }: { tab: Tab; active: boolean; pending?: boolean }) {
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      data-agent-nav={tab.label}
      data-agent-route={tab.href}
      className={`group relative flex min-h-[3.35rem] items-center justify-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition duration-fast ease-spring lg:justify-start lg:px-3.5 ${
        active
          ? "border border-[var(--nav-active-border)] bg-[var(--nav-active-bg)] text-[var(--nav-active-text)] shadow-nav-active"
          : "border border-transparent text-text-muted hover:border-[var(--color-border)] hover:bg-[var(--nav-hover-bg)] hover:text-text-primary"
      }`}
    >
      {active ? (
        <span className="absolute inset-y-2 left-0 hidden w-1 rounded-r-full bg-warm-accent lg:block" />
      ) : null}
      <span className="relative">
        <IconBubble
          size="sm"
          shape="rounded"
          className={`h-9 w-9 border transition duration-fast ${
            active
              ? "app-selected"
              : "app-chip text-text-muted group-hover:border-border-strong group-hover:text-text-primary"
          }`}
        >
          <NavIcon tab={tab} active={active} />
        </IconBubble>
        {pending ? <FirstNightNavStar /> : null}
      </span>
      <span className="hidden min-w-0 lg:block">
        <span className="block truncate text-sm font-semibold">
          {tab.label}
        </span>
        <span className="mt-0.5 block truncate text-xs text-text-muted">
          {tab.description}
        </span>
      </span>
    </Link>
  );
}

function MobileNavItem({ tab, active, pending = false }: { tab: Tab; active: boolean; pending?: boolean }) {
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      data-agent-nav={tab.label}
      data-agent-route={tab.href}
      className={`relative flex min-h-[3.25rem] w-[4.5rem] shrink-0 snap-start flex-col items-center justify-center gap-1 rounded-lg px-1 text-2xs leading-tight transition duration-fast ease-spring ${
        active
          ? "bg-[var(--nav-active-bg)] text-[var(--nav-active-text)] shadow-nav-active"
          : "text-text-muted active:text-text-primary"
      }`}
    >
      {active ? (
        <span className="absolute inset-x-5 top-1 h-0.5 rounded-full bg-warm-accent" />
      ) : null}
      <span className="relative">
        <NavIcon tab={tab} active={active} />
        {pending ? <FirstNightNavStar /> : null}
      </span>
      <span className={active ? "font-semibold" : "font-medium"}>
        {tab.mobileLabel ?? tab.label}
      </span>
    </Link>
  );
}

type TabBarProps = {
  desktopHidden?: boolean;
  onDesktopHiddenChange?: (hidden: boolean) => void;
};

export default function TabBar({
  desktopHidden = false,
  onDesktopHiddenChange,
}: TabBarProps) {
  const pathname = usePathname();
  const pendingNav = useFirstNight().pendingNavLabels;
  const mobileNavRef = useRef<HTMLElement>(null);
  const sidebarTouchStartXRef = useRef<number | null>(null);
  const sidebarTouchStartYRef = useRef<number | null>(null);
  const sidebarSwipeHandledRef = useRef(false);

  useEffect(() => {
    const nav = mobileNavRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>("[aria-current='page']");
    active?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: "smooth",
    });
  }, [pathname]);

  const handleSidebarTouchStart = (event: TouchEvent<HTMLElement>) => {
    sidebarTouchStartXRef.current = event.touches[0]?.clientX ?? null;
    sidebarTouchStartYRef.current = event.touches[0]?.clientY ?? null;
    sidebarSwipeHandledRef.current = false;
  };

  const handleSidebarTouchMove = (
    event: TouchEvent<HTMLElement>,
    action: "hide" | "show",
  ) => {
    if (sidebarSwipeHandledRef.current) {
      return;
    }

    const startX = sidebarTouchStartXRef.current;
    const startY = sidebarTouchStartYRef.current;
    const moveX = event.touches[0]?.clientX ?? null;
    const moveY = event.touches[0]?.clientY ?? null;

    if (
      startX === null ||
      startY === null ||
      moveX === null ||
      moveY === null
    ) {
      return;
    }

    const deltaX = moveX - startX;
    const deltaY = moveY - startY;
    const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) + 16;
    const passedThreshold = action === "hide" ? deltaX < -42 : deltaX > 42;

    if (mostlyHorizontal && passedThreshold) {
      sidebarSwipeHandledRef.current = true;
      onDesktopHiddenChange?.(action === "hide");
    }
  };

  const handleSidebarTouchEnd = (
    event: TouchEvent<HTMLElement>,
    action: "hide" | "show",
  ) => {
    const startX = sidebarTouchStartXRef.current;
    const startY = sidebarTouchStartYRef.current;
    sidebarTouchStartXRef.current = null;
    sidebarTouchStartYRef.current = null;

    if (sidebarSwipeHandledRef.current) {
      return;
    }

    const endX = event.changedTouches[0]?.clientX ?? null;
    const endY = event.changedTouches[0]?.clientY ?? null;

    if (startX === null || startY === null || endX === null || endY === null) {
      return;
    }

    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) + 16;
    const passedThreshold = action === "hide" ? deltaX < -56 : deltaX > 56;

    if (mostlyHorizontal && passedThreshold) {
      onDesktopHiddenChange?.(action === "hide");
    }
  };

  return (
    <>
      <nav
        ref={mobileNavRef}
        aria-label="Primary"
        data-nav="bar"
        className="app-nav fixed left-3 right-3 z-30 mx-auto flex max-w-[31rem] snap-x snap-mandatory gap-1 overflow-x-auto rounded-xl border-[1.5px] border-[var(--nav-shell-border)] bg-[var(--nav-shell-bg)] p-1.5 shadow-nav-shell backdrop-blur-xl scrollbar-hide md:hidden"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}
      >
        {tabs.map((tab) => {
          const active = isActive(pathname, tab);
          return <MobileNavItem key={tab.href} tab={tab} active={active} pending={pendingNav.includes(tab.label)} />;
        })}
      </nav>

      {desktopHidden ? (
        <div
          aria-hidden="true"
          onTouchStart={handleSidebarTouchStart}
          onTouchMove={(event) => handleSidebarTouchMove(event, "show")}
          onTouchEnd={(event) => handleSidebarTouchEnd(event, "show")}
          className="fixed inset-y-0 left-0 z-30 hidden w-8 touch-pan-y md:block"
        />
      ) : null}

      <nav
        aria-label="Primary"
        data-nav="sidebar"
        onTouchStart={handleSidebarTouchStart}
        onTouchMove={(event) => handleSidebarTouchMove(event, "hide")}
        onTouchEnd={(event) => handleSidebarTouchEnd(event, "hide")}
        className={`app-nav fixed inset-y-4 left-4 z-30 hidden w-[5rem] flex-col rounded-2xl border-[1.5px] border-[var(--nav-shell-border)] bg-[var(--nav-shell-bg)] p-2 shadow-nav-shell backdrop-blur-xl transition duration-300 md:flex lg:w-64 ${
          desktopHidden
            ? "pointer-events-none -translate-x-[calc(100%+1.5rem)] opacity-0"
            : "translate-x-0 opacity-100"
        }`}
      >
        <div className="flex justify-center border-b border-[var(--color-border)] px-1 pb-3 pt-2 lg:justify-start lg:px-2">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark size="md" />
            <div className="hidden min-w-0 lg:block">
              <div className="text-base font-semibold text-text-primary">
                Jami
              </div>
            </div>
          </div>
        </div>

        <div className="app-sidebar-scroll flex flex-1 flex-col gap-4 overflow-y-auto py-3 pl-0.5 pr-1.5">
          {navGroups.map((group) => (
            <section key={group.id} data-first-night-group={group.id} className="space-y-2">
              <div className="hidden px-3 lg:block">
                <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                  {group.label}
                </div>
                <div className="mt-1 text-xs leading-4 text-text-muted">
                  {group.helper}
                </div>
              </div>
              <div className="space-y-1">
                {tabs
                  .filter((tab) => tab.group === group.id)
                  .map((tab) => {
                    const active = isActive(pathname, tab);
                    return (
                      <DesktopNavItem
                        key={tab.href}
                        tab={tab}
                        active={active}
                        pending={pendingNav.includes(tab.label)}
                      />
                    );
                  })}
              </div>
            </section>
          ))}
        </div>
      </nav>
    </>
  );
}
