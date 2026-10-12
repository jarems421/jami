"use client";

import Link from "next/link";
import { useState } from "react";
import { Card } from "@/components/ui";
import PracticePaperAssets from "@/components/practice/PracticePaperAssets";
import type { NotebookPage } from "@/lib/workspace/notebooks";

/**
 * The question a page was written against, floated above the sheet.
 *
 * A page saved out of Past Paper Practice records the session it came from and
 * used to offer no way back to it, so the loop the feature is built around --
 * notebook to practice to notebook -- ended in a dead end on the last step.
 */
export default function NotebookQuestionOverlay({
  page,
}: {
  page: NotebookPage;
}) {
  /*
   * A practice question's answer, folded away until asked for. Revealing it is
   * the student's call -- after an attempt, or when they are stuck -- and never
   * something they meet before writing a line.
   */
  const [answerShownFor, setAnswerShownFor] = useState<string | null>(null);
  if (!page.questionPrompt) return null;
  const answerShown = answerShownFor === page.id;
  return (
    <div className="absolute left-1/2 top-3 z-20 w-[min(92vw,36rem)] -translate-x-1/2">
      <Card tone="warm" padding="sm">
        <p className="whitespace-pre-wrap text-sm leading-6 text-text-primary">
          {page.questionPrompt}
        </p>
        <PracticePaperAssets assets={page.questionAssets ?? []} />
        {page.questionAnswer ? (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={answerShown}
              onClick={() => setAnswerShownFor(answerShown ? null : page.id)}
              className="text-xs font-medium text-accent underline-offset-2 hover:underline"
            >
              {answerShown ? "Hide answer" : "Show answer"}
            </button>
            {answerShown ? (
              <p className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-[var(--color-border)] pt-1.5 text-xs leading-5 text-text-secondary">
                {page.questionAnswer}
              </p>
            ) : null}
          </div>
        ) : null}
        {page.linkedExamSessionId ? (
          <Link
            href={`/dashboard/practice/questions/${encodeURIComponent(page.linkedExamSessionId)}`}
            className="mt-2 inline-block text-xs font-medium text-accent underline-offset-2 hover:underline"
          >
            Open original practice
          </Link>
        ) : null}
      </Card>
    </div>
  );
}
