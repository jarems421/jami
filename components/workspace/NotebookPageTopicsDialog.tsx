"use client";

import { useState } from "react";
import TopicPicker from "@/components/topics/TopicPicker";
import { Button, FeedbackBanner } from "@/components/ui";
import type { Topic } from "@/lib/material/topics";
import { MAX_NOTEBOOK_PAGE_TOPIC_IDS } from "@/lib/workspace/notebooks";
import { updateNotebookPageTopics } from "@/services/study/notebooks";
import WorkspaceActionDialog from "./WorkspaceActionDialog";

/**
 * What one page is about, in the student's own Topics.
 *
 * A notebook often holds a whole subject; a page usually holds one idea. When
 * Jami marks the page, its marks count towards these Topics rather than being
 * shared out across every Topic the notebook has. Only the student sets them.
 */
export default function NotebookPageTopicsDialog({
  open,
  userId,
  notebookId,
  pageId,
  initialTopicIds,
  topics,
  onTopicsChange,
  onClose,
  onSaved,
}: {
  open: boolean;
  userId: string;
  notebookId: string;
  pageId: string;
  initialTopicIds: readonly string[];
  topics: Topic[];
  onTopicsChange: (topics: Topic[]) => void;
  onClose: () => void;
  onSaved: (topicIds: string[]) => void;
}) {
  const [topicIds, setTopicIds] = useState<string[]>([...initialTopicIds]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await updateNotebookPageTopics(userId, { notebookId, pageId, topicIds: next }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this page's topics.");
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
      {initialTopicIds.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => void save([])}
          className="self-start"
        >
          Use the notebook&apos;s topics
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={saving || topicIds.length === 0} onClick={() => void save(topicIds)}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );

  return (
    <WorkspaceActionDialog
      open={open}
      title="What is this page about?"
      description={`Choose up to ${MAX_NOTEBOOK_PAGE_TOPIC_IDS} of your topics. When Jami marks this page, the marks count towards these rather than every topic in the notebook.`}
      busy={saving}
      footer={footer}
      onClose={onClose}
    >
      <div className="space-y-3">
        {error ? <FeedbackBanner type="error" message={error} onDismiss={() => setError(null)} /> : null}
        <TopicPicker
          userId={userId}
          topics={topics}
          selectedTopicIds={topicIds}
          onChange={setTopicIds}
          onTopicsChange={onTopicsChange}
          disabled={saving}
          label="This page's topics"
          maxSelections={MAX_NOTEBOOK_PAGE_TOPIC_IDS}
        />
      </div>
    </WorkspaceActionDialog>
  );
}
