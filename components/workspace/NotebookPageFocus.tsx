"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { NotebookPageLearningView } from "@/lib/learning/notebook-page-context";
import type { Topic } from "@/lib/material/topics";
import { describeNotebookPageFocus } from "@/lib/workspace/notebook-page-focus";
import { getActiveTopics } from "@/services/study/topics";
import NotebookPageTopicsDialog from "./NotebookPageTopicsDialog";

/**
 * One line above Tutor's starting points: what marking this page counts
 * towards, by name, and a way to say what the page is actually about.
 *
 * Shown only once the engine's view of the page has arrived, so it never
 * names Topics the page has just been moved off.
 */
export default function NotebookPageFocus({
  userId,
  notebookId,
  pageId,
  pageTopicIds,
  view,
  onTopicsSaved,
}: {
  userId: string;
  notebookId: string;
  pageId: string;
  pageTopicIds: readonly string[];
  view: NotebookPageLearningView;
  onTopicsSaved: (topicIds: string[]) => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [choosing, setChoosing] = useState(false);
  const needsNames = view.concepts.some((concept) => !concept.label && concept.key.startsWith("topic:"));

  // The student's own list names their Topics; cached, so turning pages does not read it again.
  useEffect(() => {
    if (!userId || (!needsNames && !choosing)) return;
    let cancelled = false;
    void getActiveTopics(userId)
      .then((loaded) => {
        if (!cancelled) setTopics(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [choosing, needsNames, userId]);

  const copy = useMemo(() => {
    const names = new Map(topics.map((topic) => [topic.id, topic.name]));
    return describeNotebookPageFocus(view, (topicId) => names.get(topicId));
  }, [topics, view]);

  return (
    <span className="block text-left">
      {copy.lead}
      {copy.names.length > 0 ? (
        <>
          {view.attribution === "notebook-topics" ? ": " : " "}
          {copy.names.map((name, index) => (
            <Fragment key={`${name}:${index}`}>
              {index > 0 ? (index === copy.names.length - 1 ? " and " : ", ") : null}
              <span className="font-medium text-text-secondary">{name}</span>
            </Fragment>
          ))}
        </>
      ) : null}
      {copy.tail ?? (copy.names.length > 0 ? "." : "")}
      {copy.changeLabel ? (
        <>
          {" "}
          <button
            type="button"
            className="rounded font-medium text-accent underline-offset-2 transition duration-fast hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            onClick={() => setChoosing(true)}
          >
            {copy.changeLabel}
          </button>
        </>
      ) : null}
      {choosing ? (
        <NotebookPageTopicsDialog
          open
          userId={userId}
          notebookId={notebookId}
          pageId={pageId}
          initialTopicIds={pageTopicIds}
          topics={topics}
          onTopicsChange={setTopics}
          onClose={() => setChoosing(false)}
          onSaved={(topicIds) => {
            setChoosing(false);
            onTopicsSaved(topicIds);
          }}
        />
      ) : null}
    </span>
  );
}
