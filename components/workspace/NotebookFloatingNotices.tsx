"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { useNotebookPowerSavingNotice } from "@/hooks/useNotebookPowerSavingNotice";
import { isAppleMobileDevice } from "@/lib/app/notifications";
import { notebookPowerSavingMessage } from "@/lib/workspace/notebook-power-saving";
import type { NotebookToolbarDock } from "@/lib/workspace/notebook-toolbar";

type Notice = {
  key: string;
  role?: "status";
  text: ReactNode;
  action?: { label: string; onClick: () => void };
};

/**
 * Short lines floating above the page, clear of the toolbar wherever it is
 * docked: how to write when a finger tried to, that the page's drawing is
 * still on its way, and that the device is saving power at the ink's expense
 * (`useNotebookPowerSavingNotice`). Stacked, so two at once never sit on top
 * of each other.
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
  const powerSaving = useNotebookPowerSavingNotice();
  const notices: Notice[] = [];
  if (powerSaving.visible) {
    notices.push({
      key: "power",
      role: "status",
      text: notebookPowerSavingMessage(isAppleMobileDevice()),
      action: { label: "Got it", onClick: powerSaving.dismiss },
    });
  }
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
      className={`pointer-events-none absolute left-1/2 z-20 flex w-max max-w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 flex-col items-center gap-2 ${
        toolbarDock === "bottom"
          ? "bottom-[calc(var(--notebook-control-bottom-inset)+6.35rem)]"
          : "bottom-[var(--notebook-control-bottom-inset)]"
      }`}
    >
      {notices.map((notice) =>
        notice.action ? (
          <div
            key={notice.key}
            role={notice.role}
            className="notebook-floating-control pointer-events-auto flex items-center gap-3 rounded-2xl border border-[var(--color-border)] py-1.5 pl-4 pr-1.5 text-xs font-semibold text-text-secondary"
          >
            <span>{notice.text}</span>
            <Button size="sm" variant="secondary" onClick={notice.action.onClick}>
              {notice.action.label}
            </Button>
          </div>
        ) : (
          <div
            key={notice.key}
            role={notice.role}
            className="notebook-floating-control rounded-full border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-text-secondary"
          >
            {notice.text}
          </div>
        )
      )}
    </div>
  );
}
