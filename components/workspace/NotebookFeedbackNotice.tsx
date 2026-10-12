"use client";

import { FeedbackBanner } from "@/components/ui";

/** The editor's one message at a time, over the top of the page, or nothing. */
export default function NotebookFeedbackNotice({
  feedback,
  onDismiss,
}: {
  feedback: { type: "success" | "error"; message: string } | null;
  onDismiss: () => void;
}) {
  if (!feedback) return null;
  return (
    <div className="absolute left-3 right-3 top-3 z-50 mx-auto max-w-2xl">
      <FeedbackBanner type={feedback.type} message={feedback.message} onDismiss={onDismiss} />
    </div>
  );
}
