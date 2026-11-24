"use client";

import type { KeyboardEvent } from "react";
import TopicPicker from "@/components/topics/TopicPicker";
import { JamiTutorIcon, OptionSwitch } from "@/components/ui";
import type { DiagramEditorController } from "@/hooks/useDiagramEditor";
import type { Topic } from "@/lib/material/topics";
import { MAX_LABEL_ANSWER_LENGTH } from "@/lib/study/image-occlusion";

type DiagramLabelPanelProps = {
  editor: DiagramEditorController;
  userId: string;
  topics: Topic[];
  onTopicsChange: (topics: Topic[]) => void;
  /** Whether finding labels with Jami is offered here. */
  aiEnabled: boolean;
};

export function diagramLabelFieldId(labelId: string) {
  return `diagram-label-${labelId}`;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <rect x="2.5" y="3" width="7" height="4.5" rx="1" />
      <path d="M9.5 7.5 15 14" />
      <circle cx="15.5" cy="14.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

/**
 * The words side of the diagram editor, kept to what a student needs to be
 * done in a minute: how far along they are, the labels, and topics if they
 * want them.
 *
 * Naming is typed straight through: Enter in one name moves to the next part
 * still without one, and when every part is named it hands the picture back
 * for the next box. A named part can also have a line: its box goes beside the
 * picture, the way a textbook labels it, and the line points at the part.
 * Choosing a row selects its box on the picture, and
 * drawing a box puts its row here. On a phone this sits under the picture;
 * on a larger screen, beside it.
 */
export default function DiagramLabelPanel({ editor, userId, topics, onTopicsChange, aiEnabled }: DiagramLabelPanelProps) {
  const busy = editor.saving || editor.deleting;
  const naming = editor.labelMode === "name";
  const count = editor.labels.length;
  const unnamed = naming ? editor.labels.filter((label) => !label.answer.trim()).length : 0;
  const finding = editor.detecting && count === 0;

  const focusNextUnnamed = (fromIndex: number) => {
    const labels = editor.labels;
    for (let step = 1; step <= labels.length; step += 1) {
      const next = labels[(fromIndex + step) % labels.length];
      if (next && !next.answer.trim() && step < labels.length) {
        document.getElementById(diagramLabelFieldId(next.id))?.focus();
        return true;
      }
    }
    return false;
  };

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (naming && focusNextUnnamed(index)) return;
    // Nothing left to name: back to the picture for the next box.
    event.currentTarget.blur();
    editor.setSelection(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-text-primary">
            {finding
              ? "Finding the labels…"
              : count === 0
                ? naming
                  ? "Box the parts"
                  : "Cover the labels"
                : `${count} label${count === 1 ? "" : "s"}`}
          </p>
          <p className="text-xs text-text-muted" aria-live="polite">
            {finding
              ? "Jami is reading the picture. This takes a few seconds."
              : count === 0
                ? naming
                  ? "Box a part and type its name, or box a space beside it and draw a line to the part."
                  : "Tap a label to drop a box, or drag to size one."
                : unnamed > 0
                  ? `${unnamed} still need${unnamed === 1 ? "s" : ""} a name`
                  : "Ready to save as one card"}
          </p>
        </div>
        {count > 0 ? (
          <span
            aria-hidden="true"
            className={`grid h-9 min-w-9 shrink-0 place-items-center rounded-full px-2 text-sm font-bold ${
              unnamed > 0 ? "bg-[var(--color-glass-medium)] text-text-secondary" : "bg-accent text-accent-on"
            }`}
          >
            {unnamed > 0 ? count - unnamed : "✓"}
          </span>
        ) : null}
      </div>

      {aiEnabled && !naming && !finding ? (
        <button
          type="button"
          disabled={busy || editor.detecting}
          onClick={() => void editor.detectLabels()}
          className="flex w-full items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-3 py-2.5 text-left transition hover:bg-[var(--color-glass-medium)] disabled:opacity-60"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-glass-medium)] text-accent">
            <JamiTutorIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-text-primary">
              {editor.detecting ? "Finding the labels…" : count > 0 ? "Find any I missed" : "Find the labels for me"}
            </span>
            <span className="block text-xs text-text-muted">Jami boxes every printed label in one go</span>
          </span>
        </button>
      ) : null}

      {editor.notice ? (
        <p role="status" className="flex items-start justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-3 py-2.5 text-sm text-text-secondary">
          <span>{editor.notice}</span>
          <button
            type="button"
            onClick={editor.dismissNotice}
            className="rounded-full px-2 text-xs font-medium text-text-muted transition hover:text-text-primary"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </p>
      ) : null}

      <section aria-label="Labels">
        {finding ? (
          <ol aria-hidden="true" className="space-y-1.5">
            {[0, 1, 2, 3].map((row) => (
              <li key={row} className="flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-1.5">
                <span className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-[var(--color-glass-medium)]" />
                <span className="h-4 flex-1 animate-pulse rounded bg-[var(--color-glass-medium)]" style={{ maxWidth: `${70 - row * 12}%` }} />
              </li>
            ))}
          </ol>
        ) : count === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-sm leading-6 text-text-secondary">
            {naming
              ? "Each box you draw appears here, ready to name."
              : "Each box you draw appears here. The words under it are what you will recall."}
          </p>
        ) : (
          <ol className="space-y-1.5">
            {editor.labels.map((label, index) => {
              const selected = editor.selection?.labelId === label.id;
              const missingName = naming && !label.answer.trim();
              /*
               * A covered label only needs a name when it already has one --
               * found by Jami, or typed earlier -- so it can be corrected.
               * Otherwise the picture says it, and the row just says which box.
               */
              const showName = naming || Boolean(label.answer.trim());
              return (
                <li
                  key={label.id}
                  className={`flex items-center gap-1.5 rounded-xl border p-1.5 transition duration-fast ${
                    selected
                      ? "border-accent bg-[var(--color-glass-medium)]"
                      : "border-[var(--color-border)] bg-[var(--color-glass-subtle)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => editor.selectLabel(label.id)}
                    aria-label={`Select label ${index + 1} on the picture`}
                    aria-pressed={selected}
                    className="occlusion-edit-badge grid h-8 min-w-8 shrink-0 place-items-center rounded-lg px-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected-border)]"
                  >
                    {index + 1}
                  </button>
                  {showName ? (
                    <input
                      id={diagramLabelFieldId(label.id)}
                      value={label.answer}
                      maxLength={MAX_LABEL_ANSWER_LENGTH}
                      disabled={busy}
                      autoComplete="off"
                      enterKeyHint="next"
                      aria-label={`Label ${index + 1}`}
                      aria-invalid={missingName || undefined}
                      placeholder={naming ? "Name this part" : undefined}
                      onFocus={() => {
                        if (!selected) editor.selectLabel(label.id);
                      }}
                      onKeyDown={(event) => onNameKeyDown(event, index)}
                      onChange={(event) => editor.setAnswer(label.id, event.target.value)}
                      className="app-field app-field-text min-w-0 flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => editor.selectLabel(label.id)}
                      className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm text-text-secondary"
                    >
                      Covered label
                    </button>
                  )}
                  {naming ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        label.pointer ? editor.setPointer(label.id, null) : editor.startPointing(label.id)
                      }
                      aria-label={
                        label.pointer
                          ? `Remove the line from label ${index + 1}`
                          : `Draw a line from label ${index + 1} to its part`
                      }
                      title={label.pointer ? "Remove the line" : "Draw a line to the part"}
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg transition hover:bg-[var(--color-glass-medium)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected-border)] disabled:opacity-50 ${
                        label.pointer ? "text-accent" : "text-text-muted hover:text-text-primary"
                      }`}
                    >
                      <LineIcon />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => editor.removeLabel(label.id)}
                    aria-label={`Remove label ${index + 1}`}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-text-muted transition hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected-border)] disabled:opacity-50"
                  >
                    <TrashIcon />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {editor.cardStyleChanged && count >= 2 ? (
        <p className="text-xs leading-5 text-text-muted">
          This diagram was saved as a card per label. Saving makes it one card, so its review history starts again.
        </p>
      ) : null}

      {/* Topics belong to the whole diagram, the way they do to a flashcard, so they stay in view. */}
      <section aria-label="Diagram topics" className="space-y-1.5 border-t border-[var(--color-border)] pt-4">
        <TopicPicker
          userId={userId}
          topics={topics}
          selectedTopicIds={editor.topicIds}
          onChange={editor.setTopicIds}
          onTopicsChange={onTopicsChange}
          disabled={busy}
        />
        <p className="text-xs text-text-muted">For the whole diagram, not a single label.</p>
      </section>

      <details className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-text-secondary">
          More options
        </summary>
        <div className="mt-4 space-y-5">
          <OptionSwitch
            label="Are the labels on the picture?"
            value={editor.labelMode}
            disabled={busy}
            onChange={editor.setLabelMode}
            options={[
              { value: "cover", label: "Yes, cover them" },
              { value: "name", label: "No, name the parts" },
            ]}
          />
        </div>
      </details>
    </div>
  );
}
