"use client";

import AppPage from "@/components/layout/AppPage";
import { Button, ButtonLink, EmptyState, Skeleton } from "@/components/ui";
import { InkStatsOverlay, useInkStatsEnabled } from "@/components/workspace/InkStatsOverlay";

/** What the notebook route shows when there is no notebook to edit yet, or at all. */
export default function NotebookEditorFallback({
  state,
  onRetry,
}: {
  /** Still loading, could not be read, or does not exist. */
  state: "loading" | "failed" | "missing";
  onRetry: () => void;
}) {
  const inkStats = useInkStatsEnabled();
  if (state === "loading") {
    return (
      <AppPage title="Notebook" backHref="/dashboard/folders" backLabel="Folders" width="3xl">
        <div className="space-y-5">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-[34rem] rounded-2xl" />
        </div>
        {inkStats ? <InkStatsOverlay opening /> : null}
      </AppPage>
    );
  }

  return (
    <AppPage title="Notebook" backHref="/dashboard/folders" backLabel="Folders" width="xl">
      {state === "failed" ? (
        <EmptyState
          emoji="Notebook"
          title="This notebook didn't open"
          description="Jami couldn't reach your notebook just now. Check your connection and try again."
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      ) : (
        <EmptyState
          emoji="Notebook"
          title="Notebook not found"
          description="This notebook may have been removed or belongs to another workspace."
          action={<ButtonLink href="/dashboard/folders">Back to folders</ButtonLink>}
        />
      )}
    </AppPage>
  );
}
