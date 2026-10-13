"use client";

import type { ComponentProps } from "react";
import JamiAssistantDrawer from "@/components/ai/JamiAssistantDrawer";
import type { useNotebookTutorBridge } from "@/hooks/useNotebookTutorBridge";
import type { Notebook } from "@/lib/workspace/notebooks";
import NotebookPageFocus from "./NotebookPageFocus";

type DrawerProps = ComponentProps<typeof JamiAssistantDrawer>;

/**
 * The floating Tutor over a notebook: one conversation across page turns, with
 * the page in front of the student resolved fresh for every message, and the
 * starting points the notebook's Tutor bridge chose for that page -- above
 * them, what marking the page counts towards.
 */
export default function NotebookTutorDrawer({
  userId,
  notebook,
  open,
  tutor,
  ...inserts
}: {
  userId: string;
  notebook: Notebook;
  open: boolean;
  tutor: ReturnType<typeof useNotebookTutorBridge>;
} & Pick<
  DrawerProps,
  | "getContext"
  | "onBeforeIllustrationInsert"
  | "onIllustrationInserted"
  | "onGraphInsert"
  | "onDrawingInsert"
  | "onKeepAttachmentBeside"
  | "onAddNotebookPages"
>) {
  return (
    <JamiAssistantDrawer
      userId={userId}
      open={open}
      onOpenChange={tutor.handleAssistantOpenChange}
      layout="floating"
      resetKey={`notebook:${notebook.id}`}
      contextKey={`notebook:${notebook.id}`}
      contextLabel="Current notebook page"
      historyContextLabel={notebook.title}
      quickActions={tutor.quickActions}
      emptyStateNote={
        tutor.pageFocus ? (
          <NotebookPageFocus userId={userId} notebookId={notebook.id} {...tutor.pageFocus} />
        ) : undefined
      }
      settingsFolderIds={notebook.folderId ? [notebook.folderId] : []}
      onAnswerInsert={tutor.handleTutorAnswerInsert}
      {...inserts}
    />
  );
}
