"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button, Input } from "@/components/ui";

export type FocusedFilterKind = "decks" | "topics";

/** Decks and Topics are both just a named thing that can be picked. */
export type FocusedReviewOption = { id: string; name: string };

export type FocusedReviewColumn = {
  search: string;
  onSearchChange: (value: string) => void;
  /** Empty while the search box is, rather than showing everything. */
  searchResults: FocusedReviewOption[];
  recents: FocusedReviewOption[];
  selectedIds: string[];
  namesById: Record<string, string>;
  cardCounts: Map<string, number>;
  onToggle: (id: string) => void;
};

const COPY: Record<
  FocusedFilterKind,
  {
    tab: string;
    searchLabel: string;
    searchPlaceholder: string;
    noMatches: string;
    recentsHeading: string;
    recentsEmpty: string;
    removePrefix: string;
    fallbackName: string;
  }
> = {
  decks: {
    tab: "Decks",
    searchLabel: "Search decks",
    searchPlaceholder: "Type a deck name",
    noMatches: "No decks match that search.",
    recentsHeading: "Recent decks",
    recentsEmpty: "Search for a deck to build your first focused session.",
    removePrefix: "Remove deck",
    fallbackName: "Deck",
  },
  topics: {
    tab: "Topics",
    searchLabel: "Search Topics",
    searchPlaceholder: "Type a Topic name",
    noMatches: "No Topics match that search.",
    recentsHeading: "Recent Topics",
    recentsEmpty: "Search for a Topic to narrow this session.",
    removePrefix: "Remove Topic",
    fallbackName: "Topic",
  },
};

/** The numbered steps down the panel, so the order is readable at a glance. */
function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] text-2xs font-semibold tabular-nums text-text-secondary"
        >
          {number}
        </span>
        <h4 className="text-sm font-semibold tracking-[0.01em] text-text-primary">
          {title}
        </h4>
      </div>
      {children}
    </section>
  );
}

function SelectedChips({
  ids,
  column,
  kind,
}: {
  ids: string[];
  column: FocusedReviewColumn;
  kind: FocusedFilterKind;
}) {
  return (
    <>
      {ids.map((id) => {
        const name = column.namesById[id] ?? COPY[kind].fallbackName;
        return (
          <button
            key={id}
            type="button"
            aria-label={`${COPY[kind].removePrefix} ${name}`}
            onClick={() => column.onToggle(id)}
            className="app-selected inline-flex min-h-10 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition duration-fast hover:border-border-strong"
          >
            <span>{name}</span>
            <span aria-hidden="true">×</span>
          </button>
        );
      })}
    </>
  );
}

/** Search results and recents look different, so they render separately. */
function ColumnOptions({
  column,
  kind,
}: {
  column: FocusedReviewColumn;
  kind: FocusedFilterKind;
}) {
  const copy = COPY[kind];

  if (column.search.trim()) {
    if (column.searchResults.length === 0) {
      return <p className="text-sm text-text-muted">{copy.noMatches}</p>;
    }
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {column.searchResults.map((option) => {
          const selected = column.selectedIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => column.onToggle(option.id)}
              className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition duration-fast ${selected ? "app-selected" : "app-chip hover:border-border-strong"}`}
            >
              <span className="min-w-0">
                <span className="block truncate">{option.name}</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {column.cardCounts.get(option.id) ?? 0} cards
                </span>
              </span>
              <span className="shrink-0 text-xs text-text-muted">
                {selected ? "Selected" : "Add"}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
        {copy.recentsHeading}
      </div>
      {column.recents.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {column.recents.map((option) => {
            const selected = column.selectedIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => column.onToggle(option.id)}
                className={`min-h-10 rounded-full px-3.5 py-2 text-sm font-medium transition duration-fast ${selected ? "app-selected" : "app-chip hover:border-border-strong"}`}
              >
                {option.name} · {column.cardCounts.get(option.id) ?? 0}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-sm leading-6 text-text-muted">
          {copy.recentsEmpty}
        </p>
      )}
    </div>
  );
}

type FocusedReviewBuilderProps = {
  filterKind: FocusedFilterKind;
  onFilterKindChange: (kind: FocusedFilterKind) => void;
  decks: FocusedReviewColumn;
  topics: FocusedReviewColumn;
  /** How many cards the current selection would study. */
  previewCount: number;
  /** True when the student has filters on but nothing matches them. */
  selectionEmpty: boolean;
  /** The "How to study" control, when study modes are switched on. */
  modePicker?: ReactNode;
  onClearFilters: () => void;
  onStart: () => void;
};

/**
 * Builds a Focused Review session from decks and Topics.
 *
 * It opens inside the Focused Review card rather than as a panel of its own.
 * It used to render after the whole "Other ways to study" grid, which put the
 * setup for one card underneath a different one -- press "Choose decks or
 * Topics" and the thing that appeared was below Simple Study, attached to
 * nothing. So there is no card, no heading and no close button here now: the
 * card supplies all three, and this is the contents of the disclosure it owns.
 *
 * Two steps, numbered, in the order the decision is actually made: what to
 * study, then how to study it. The two filter kinds are a tab pair rather than
 * two panels, because a student picks from one list at a time but the selection
 * spans both.
 */
export default function FocusedReviewBuilder({
  filterKind,
  onFilterKindChange,
  decks,
  topics,
  previewCount,
  selectionEmpty,
  modePicker,
  onClearFilters,
  onStart,
}: FocusedReviewBuilderProps) {
  const activeColumn = filterKind === "decks" ? decks : topics;
  const hasFilters =
    decks.selectedIds.length > 0 || topics.selectedIds.length > 0;

  return (
    <div
      id="focused-review-builder"
      className="mt-5 space-y-6 border-t border-[var(--color-border)] pt-5"
    >
      <Step number={1} title="What to study">
        <div className="space-y-3">
          <div
            role="group"
            aria-label="Focused Review filter type"
            className="app-subtle-panel inline-flex w-full rounded-full p-1 sm:w-auto"
          >
            {(["decks", "topics"] as FocusedFilterKind[]).map((kind) => {
              const selected = filterKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onFilterKindChange(kind)}
                  className={`min-h-10 flex-1 rounded-full px-5 text-sm font-semibold transition sm:flex-none ${
                    selected
                      ? "bg-[var(--color-selected-bg)] text-[var(--color-selected-text)] shadow-sm"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {COPY[kind].tab}
                </button>
              );
            })}
          </div>

          <div id="focused-review-options" className="space-y-3">
            <Input
              label={COPY[filterKind].searchLabel}
              placeholder={COPY[filterKind].searchPlaceholder}
              value={activeColumn.search}
              onChange={(event) =>
                activeColumn.onSearchChange(event.target.value)
              }
            />
            <ColumnOptions column={activeColumn} kind={filterKind} />
          </div>

          {hasFilters ? (
            <div className="flex flex-wrap items-center gap-2">
              <SelectedChips
                ids={decks.selectedIds}
                column={decks}
                kind="decks"
              />
              <SelectedChips
                ids={topics.selectedIds}
                column={topics}
                kind="topics"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClearFilters}
              >
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-sm leading-6 text-text-muted">
              Nothing selected, so this session will use every card.
            </p>
          )}
        </div>
      </Step>

      {modePicker ? (
        <Step number={2} title="How to study">
          {modePicker}
        </Step>
      ) : null}

      <div className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div aria-live="polite" className="min-w-0">
          <div className="text-base font-semibold text-text-primary">
            {selectionEmpty
              ? "No cards match this selection"
              : `${previewCount} ${previewCount === 1 ? "card" : "cards"} ready`}
          </div>
          <p className="mt-1 text-sm leading-6 text-text-muted">
            {selectionEmpty
              ? "Clear a filter or choose something different."
              : "Focused Review practices without changing your review dates."}
          </p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
          {selectionEmpty ? (
            <Link
              href="/dashboard/cards"
              className="inline-flex min-h-[2.75rem] items-center justify-center rounded-2xl border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-secondary-text)] shadow-button-secondary transition duration-fast hover:border-[var(--button-secondary-border-hover)] hover:bg-[var(--button-secondary-bg-hover)]"
            >
              Edit cards
            </Link>
          ) : (
            <Button
              type="button"
              onClick={onStart}
              size="lg"
              className="w-full sm:w-auto"
            >
              Start Focused Review
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
