"use client";

import Link from "next/link";
import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import PracticePaperAttemptBar from "@/components/practice/PracticePaperAttemptBar";
import NotebookSaveIndicator from "@/components/workspace/NotebookSaveIndicator";
import {
  NotebookSheetsButton,
  type NotebookSheetsBesideController,
} from "@/components/workspace/NotebookSheetsBeside";
import ToolbarIconButton, {
  NotebookIcon,
} from "@/components/workspace/NotebookToolbarIconButton";
import type { NotebookSaveStatus } from "@/lib/workspace/notebook-page-state";
import type { Notebook } from "@/lib/workspace/notebooks";

type AttemptBarProps = ComponentProps<typeof PracticePaperAttemptBar>;

type NotebookEditorHeaderProps = {
  notebook: Notebook;
  userId: string;
  saveStatus: NotebookSaveStatus;
  onRetrySave: () => void;
  /** The back link; prevents the navigation when the page could not be secured. */
  onExit: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  pagesDrawerOpen: boolean;
  onTogglePages: () => void;
  /** An exam in progress keeps the sheets and the Tutor out of reach. */
  tutorLocked: boolean;
  sheets: NotebookSheetsBesideController;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  /** Wiring for a practice paper's attempt bar; unused by other notebooks. */
  practicePaper: Omit<AttemptBarProps, "userId" | "notebookId">;
  /** The drawing toolbar, when it is docked in this bar. */
  tools: ReactNode;
  /** The bar itself, which a toolbar is carried into and out of when dragged. */
  barRef: RefObject<HTMLElement | null>;
};

/**
 * The notebook editor's top bar: back, title and save state, the drawing
 * tools when they are docked here, and the panels it opens.
 *
 * The tools sit in the middle of the bar, in the room a short title leaves,
 * so nothing covers the page. On a phone-sized screen, too narrow for all three
 * in a row, they take a row of their own under the title.
 */
export default function NotebookEditorHeader({
  notebook,
  userId,
  saveStatus,
  onRetrySave,
  onExit,
  pagesDrawerOpen,
  onTogglePages,
  tutorLocked,
  sheets,
  assistantOpen,
  onToggleAssistant,
  practicePaper,
  tools,
  barRef,
}: NotebookEditorHeaderProps) {
  return (
    <header
      ref={barRef}
      className="z-40 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-panel-strong)]/95 px-3 pb-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] shadow-e1"
    >
      <div
        className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 ${
          tools ? "md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : ""
        }`}
      >
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
          <Link
            href={`/dashboard/folders/${notebook.folderId}`}
            onClick={onExit}
            aria-label="Back to folder"
            title="Back to folder"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)]"
          >
            <NotebookIcon name="back" />
          </Link>
          <div data-tutorial-target="save-work" className="flex min-w-0 flex-1 items-center gap-2">
            <div className="truncate text-sm font-semibold text-text-primary">{notebook.title}</div>
            <NotebookSaveIndicator status={saveStatus} onRetry={onRetrySave} />
          </div>
        </div>
        {tools ? (
          <div className="col-span-2 row-start-2 flex min-w-0 justify-center md:col-span-1 md:col-start-2 md:row-start-1">
            {tools}
          </div>
        ) : null}
        <div
          className={`col-start-2 row-start-1 flex items-center gap-2 justify-self-end ${
            tools ? "md:col-start-3" : ""
          }`}
        >
          <ToolbarIconButton
            label="Pages"
            icon="pages"
            active={pagesDrawerOpen}
            onClick={onTogglePages}
          />
          {!tutorLocked ? <NotebookSheetsButton sheets={sheets} /> : null}
          {!tutorLocked ? (
            <ToolbarIconButton
              label="Ask Jami"
              icon="ai"
              tutorialTarget="ask-tutor"
              active={assistantOpen}
              onClick={onToggleAssistant}
            />
          ) : null}
        </div>
      </div>
      {notebook.type === "practice_paper" && userId ? (
        <PracticePaperAttemptBar userId={userId} notebookId={notebook.id} {...practicePaper} />
      ) : null}
    </header>
  );
}
