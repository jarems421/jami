"use client";

import type { ReactNode } from "react";
import type { NotebookToolbarDock } from "@/lib/workspace/notebook-toolbar";

type Notice = { key: string; role?: "status"; text: ReactNode };

/**
 * Short lines floating above the page, clear of the toolbar wherever it is
 * docked: how to write when a finger tried to, and that the page's drawing is
 * still on its way. Stacked, so two at once never sit on top of each other.
 */
export default function NotebookFloatingNotices({
  toolbarDock,
  touchInkHint,
  inkLoading,
}: {
  toolbarDock: NotebookToolbarDock;
  /** A finger touched the page while a writing tool was out. */
  touchInkHint: boolean;
  /** The page's drawing has not arrived yet, so writing waits for it. */
  inkLoading: boolean;
}) {
  const notices: Notice[] = [];
  if (touchInkHint) {
    notices.push({ key: "touch", text: "Use Apple Pencil or stylus to write. Fingers move the page." });
  }
  if (inkLoading) {
    notices.push({
      key: "loading",
      role: "status",
      text: <>Loading this page&rsquo;s drawing. Writing is paused until it arrives.</>,
    });
  }
  if (notices.length === 0) return null;

  return (
    <div
      className={`pointer-events-none absolute left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2 ${
        toolbarDock === "bottom"
          ? "bottom-[calc(var(--notebook-control-bottom-inset)+6.35rem)]"
          : "bottom-[var(--notebook-control-bottom-inset)]"
      }`}
    >
      {notices.map((notice) => (
        <div
          key={notice.key}
          role={notice.role}
          className="notebook-floating-control rounded-full border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-text-secondary"
        >
          {notice.text}
        </div>
      ))}
    </div>
  );
}
