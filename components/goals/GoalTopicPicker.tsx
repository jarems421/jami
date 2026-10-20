"use client";

import { useId, useState } from "react";
import { Button, Select, Skeleton } from "@/components/ui";
import { useTopicStandings } from "@/hooks/useTopicStandings";
import type { GoalScope, GoalTopic } from "@/lib/goals/model";
import { GOAL_TOPIC_LADDER } from "@/lib/goals/standing";
import type { LearningDemonstration } from "@/lib/learning/types";

const STATE_CLASS: Record<LearningDemonstration, string> = {
  weak: "app-warning",
  developing: "bg-accent-muted text-accent",
  insufficient: "app-chip",
  none: "app-chip",
  strong: "app-success",
};

/** Past this many topics a search box earns its place. */
const SEARCH_FROM = 8;

function stateLabel(demonstration: LearningDemonstration) {
  return GOAL_TOPIC_LADDER.find((step) => step.demonstration === demonstration)?.label ?? "";
}

/**
 * Choosing a topic to get to strong.
 *
 * Each topic shows where Jami's results put it now, so the choice is made with
 * the same information the goal will be judged by. A topic already strong is
 * shown but cannot be picked: there would be nothing left to reach.
 */
export default function GoalTopicPicker({
  folders,
  scope,
  topic,
  onChange,
}: {
  folders: readonly { id: string; label: string }[];
  scope: GoalScope;
  topic?: GoalTopic;
  onChange: (next: { scope: GoalScope; topic?: GoalTopic }) => void;
}) {
  const folderId = scope.type === "folder" ? scope.id : undefined;
  const standings = useTopicStandings(folderId);
  const [search, setSearch] = useState("");
  const listId = useId();
  const searchId = useId();

  const query = search.trim().toLowerCase();
  const shown = query
    ? standings.topics.filter((candidate) => candidate.label.toLowerCase().includes(query))
    : standings.topics;

  if (folders.length === 0) {
    return (
      <p className="app-subtle-panel rounded-xl px-4 py-3 text-sm leading-6">
        Topic goals live in a folder. Make a folder for a subject first, and its topics will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Select
        label="Which folder?"
        value={folderId ?? ""}
        onChange={(event) => {
          const chosen = folders.find((folder) => folder.id === event.target.value);
          setSearch("");
          onChange({ scope: chosen ? { type: "folder", id: chosen.id, label: chosen.label } : { type: "all" } });
        }}
        className="!py-2.5 text-sm"
      >
        <option value="">Choose a folder</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.label}
          </option>
        ))}
      </Select>

      {folderId ? (
        <div className="space-y-2">
          <p id={listId} className="text-sm font-semibold text-text-primary">
            Which topic?
          </p>
          {standings.status === "loading" ? (
            <div className="space-y-2" aria-label="Loading topics">
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-11 rounded-xl" />
            </div>
          ) : standings.status === "error" ? (
            <div className="app-subtle-panel flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm">
              <span>Jami could not read this folder&apos;s topics just now.</span>
              <Button type="button" size="sm" variant="secondary" onClick={standings.retry}>
                Try again
              </Button>
            </div>
          ) : standings.topics.length === 0 ? (
            <p className="app-subtle-panel rounded-xl px-4 py-3 text-sm leading-6">
              No topics here yet. Add topics to this folder, or study it a little, and they will appear.
            </p>
          ) : (
            <>
              {standings.topics.length > SEARCH_FROM ? (
                <div>
                  <label htmlFor={searchId} className="sr-only">
                    Search topics
                  </label>
                  <input
                    id={searchId}
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search topics"
                    className="app-field min-h-10 w-full rounded-xl px-3.5 text-sm"
                  />
                </div>
              ) : null}
              <div
                role="radiogroup"
                aria-labelledby={listId}
                className="max-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-1"
              >
                {shown.map((candidate) => {
                  const selected = topic?.key === candidate.key;
                  const strong = candidate.demonstration === "strong";
                  return (
                    <button
                      key={candidate.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={strong}
                      onClick={() =>
                        onChange({ scope, topic: { key: candidate.key, label: candidate.label } })
                      }
                      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-60 ${
                        selected
                          ? "border-accent/55 bg-accent/10 shadow-e1"
                          : "border-[var(--color-border)] bg-[var(--color-surface-panel)] hover:border-[var(--color-border-strong)]"
                      }`}
                    >
                      <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{candidate.label}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${STATE_CLASS[candidate.demonstration]}`}
                      >
                        {strong ? "Already strong" : stateLabel(candidate.demonstration)}
                      </span>
                    </button>
                  );
                })}
                {shown.length === 0 ? (
                  <p className="px-1 py-2 text-sm text-text-muted">No topic matches that.</p>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
