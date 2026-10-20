"use client";

import { useState, type FormEvent } from "react";
import { ButtonLink, JamiTutorIcon } from "@/components/ui";
import { SendIcon } from "@/components/ai/JamiAssistantIcons";
import TutorSourcePicker from "@/components/ai/TutorSourcePicker";
import { tutorSourceActions } from "@/lib/ai/tutor-source-actions";
import type { Source } from "@/lib/material/sources";

/**
 * Asking Jami, straight from the Tutor page.
 *
 * It used to say "Ask from your own material" and send the student to the
 * Library to find some first. Now the question and the material are chosen
 * together, here: type, pick one source or several, send -- and this card
 * becomes the conversation, in place, with the answer on its way. Closing it
 * brings this back. The three starting points are the same ones the chat
 * itself offers.
 */
export default function TutorAskPanel({
  sources,
  selectedIds,
  onSelectedChange,
  onAsk,
  onOpenChats,
  loading = false,
}: {
  sources: readonly Source[];
  selectedIds: readonly string[];
  onSelectedChange: (ids: string[]) => void;
  onAsk: (message: string) => void;
  /** Opens the chat on the student's saved chats, from any place, to carry one on. */
  onOpenChats?: () => void;
  loading?: boolean;
}) {
  const [message, setMessage] = useState("");
  const ready = selectedIds.length > 0;
  const actions = tutorSourceActions(selectedIds.length);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    if (!text || !ready) return;
    onAsk(text);
    setMessage("");
  };

  return (
    <section
      aria-labelledby="tutor-ask-title"
      className="app-panel relative overflow-hidden rounded-3xl px-5 py-8 sm:px-10 sm:py-10"
    >
      <div className="relative flex flex-col items-center gap-3 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-warm-border bg-warm-glow text-warm-accent">
          <JamiTutorIcon className="h-7 w-7" />
        </span>
        <h2 id="tutor-ask-title" className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          What do you want help with?
        </h2>
        <p className="text-sm text-text-secondary">Jami answers from your own notes, papers and links.</p>
      </div>

      {loading ? (
        <div className="relative mx-auto mt-6 h-32 max-w-3xl animate-pulse rounded-3xl bg-[var(--color-glass-subtle)]" />
      ) : sources.length === 0 ? (
        <div className="relative mx-auto mt-6 flex max-w-xl flex-col items-center gap-3 text-center">
          <p className="text-sm leading-6 text-text-secondary">
            Give Jami something to read first — notes, a past paper, a link.
          </p>
          <ButtonLink href="/dashboard/library">Add material</ButtonLink>
        </div>
      ) : (
        <>
          <form
            onSubmit={submit}
            className="app-field relative mx-auto mt-6 max-w-3xl rounded-3xl transition duration-normal"
          >
            <label htmlFor="tutor-ask-box" className="sr-only">
              Ask Jami
            </label>
            <textarea
              id="tutor-ask-box"
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="e.g. Why does temperature change how fast enzymes work?"
              className="min-h-[4.5rem] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-base leading-relaxed text-text-primary outline-none placeholder:text-text-muted focus-visible:outline-none focus-visible:shadow-none"
            />
            <div className="flex items-end gap-3 px-4 pb-3">
              <div className="min-w-0 flex-1">
                <TutorSourcePicker sources={sources} selectedIds={selectedIds} onChange={onSelectedChange} />
              </div>
              <button
                type="submit"
                aria-label="Send to Jami"
                disabled={!message.trim() || !ready}
                className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-accent-on shadow-accent transition duration-fast hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:bg-[var(--color-glass-medium)] disabled:text-text-muted disabled:shadow-none"
              >
                <SendIcon />
              </button>
            </div>
          </form>

          <div className="relative mt-4 flex flex-wrap justify-center gap-2">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={!ready}
                onClick={() => onAsk(action.prompt)}
                className="min-h-10 rounded-2xl border border-[var(--color-border-strong)] px-4 text-sm font-semibold text-text-secondary transition duration-fast hover:border-accent/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:opacity-50"
              >
                {action.label}
              </button>
            ))}
          </div>
          {onOpenChats ? (
            <div className="relative mt-3 flex justify-center">
              <button
                type="button"
                onClick={onOpenChats}
                className="rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--color-accent)] transition duration-fast hover:bg-[var(--color-glass-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              >
                Open a previous chat
              </button>
            </div>
          ) : null}
        </>
      )}

      {/*
        * The promises that matter, said once and quietly. Jami does remember
        * a few short notes between chats now, so this says that -- and where
        * the student can see and change them.
        */}
      <p className="relative mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-2xs leading-5 text-text-muted">
        <span>Reads only what you hand it</span>
        <span>
          Remembers a few notes about you —{" "}
          <a href="/dashboard/tutor/personalise" className="underline underline-offset-2 hover:text-text-secondary">
            see or change them
          </a>
        </span>
      </p>
    </section>
  );
}
