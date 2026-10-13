"use client";

import type { ReactNode } from "react";
import type { JamiAssistantThread } from "@/lib/ai/jami-assistant-history";
import {
  normalizeTutorQuickActions,
  type JamiAssistantQuickAction,
} from "@/lib/ai/tutor-chat-messages";
import { HistoryIcon } from "@/components/ai/JamiAssistantIcons";

/**
 * Before the conversation starts: what Jami can do here, the last chat from
 * this place to carry on, and the surface's starting points.
 */
export default function TutorChatEmptyState({
  note,
  latestThread,
  quickActions,
  disabled,
  onContinue,
  onSend,
}: {
  /** Where Jami works differently from what a student would assume. */
  note?: ReactNode;
  latestThread?: JamiAssistantThread;
  quickActions: readonly JamiAssistantQuickAction[];
  disabled: boolean;
  onContinue: (thread: JamiAssistantThread) => void;
  onSend: (prompt: string) => void;
}) {
  const actions = normalizeTutorQuickActions(quickActions);
  return (
    <div className="flex min-h-full flex-col justify-center py-5">
      <div className="mx-auto max-w-sm text-center">
        <h3 className="text-lg font-semibold text-text-primary">
          How can I help?
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          Ask about what you are studying, or choose a useful starting point.
        </p>
        {note ? (
          <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-3 py-2 text-xs leading-5 text-text-muted">
            {note}
          </div>
        ) : null}
      </div>
      {latestThread ? (
        <button
          type="button"
          className="mx-auto mt-5 flex max-w-full items-center gap-2 rounded-full border border-accent/25 bg-accent/8 px-3.5 py-2 text-xs font-medium text-accent transition duration-fast hover:border-accent/40 hover:bg-accent/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          onClick={() => onContinue(latestThread)}
        >
          <HistoryIcon />
          <span className="truncate">Continue {latestThread.title}</span>
        </button>
      ) : null}
      {actions.length > 0 ? (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {actions.map((action) => (
            <button
              key={"prompt" in action ? `${action.label}:${action.prompt}` : action.label}
              type="button"
              disabled={disabled}
              className="app-chip rounded-full px-3.5 py-2 text-xs font-medium text-text-secondary transition duration-fast hover:border-border-strong hover:bg-[var(--color-glass-medium)] hover:text-text-primary disabled:cursor-not-allowed disabled:saturate-[0.82]"
              onClick={() => ("prompt" in action ? onSend(action.prompt) : void action.run())}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
