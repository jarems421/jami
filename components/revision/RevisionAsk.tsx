"use client";

import { useState, type FormEvent } from "react";
import { Button, StudyText, Textarea } from "@/components/ui";
import { askRevisionQuestion, RevisionSessionError } from "@/services/learning/revision-sessions";

/**
 * "Wait, why…?" -- a question about the step on screen, without leaving it.
 *
 * Quiet until asked for: one ghost button under the step. The answer sits in
 * the same panel a hint does, and goes when the step does; nothing is kept,
 * and the session carries on exactly where it was.
 */
export default function RevisionAsk({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const asked = question.trim();
    if (!asked || asking) return;
    setAsking(true);
    setError(null);
    try {
      setAnswer({ question: asked, text: await askRevisionQuestion(sessionId, asked) });
      setQuestion("");
    } catch (caught) {
      setError(caught instanceof RevisionSessionError ? caught.message : "Couldn't reach Jami. Try again.");
    } finally {
      setAsking(false);
    }
  };

  if (!open) {
    return (
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Ask Jami about this
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-5">
      {answer ? (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3">
          <p className="text-sm leading-6 text-text-muted">{answer.question}</p>
          <StudyText
            as="p"
            text={answer.text}
            className="mt-2 block whitespace-pre-line text-base leading-7 text-text-primary"
          />
        </div>
      ) : null}
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
        <Textarea
          label={answer ? "Ask something else" : "What would you like to ask?"}
          value={question}
          rows={2}
          maxLength={500}
          placeholder="Why did you divide by two?"
          disabled={asking}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={asking}
            onClick={() => {
              setOpen(false);
              setQuestion("");
              setError(null);
            }}
          >
            Close
          </Button>
          <Button type="submit" size="sm" className="ml-auto min-w-24" disabled={asking || !question.trim()}>
            {asking ? "Thinking…" : "Ask"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-text-secondary">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
