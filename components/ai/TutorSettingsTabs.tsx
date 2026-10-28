import { useId } from "react";
import { featureFlags } from "@/lib/app/feature-flags";
import type { TutorFolderSummary } from "@/services/ai/tutor-personalisation";
import {
  getStudyLevelShortLabel,
  type StudyLevel,
} from "@/lib/profile/study-level";

export type TutorSettingsView = "course" | "style" | "notes" | "memory";

/**
 * Whether folder notes apply here, said as one sentence for assistive tech.
 *
 * A surface that does not know which folders its material is in is not the
 * same as one that knows the answer is none, and saying "none apply" when the
 * truth is "not established here" is a small lie the rest of the screen pays
 * for.
 */
export function describeFolderScope(input: {
  activeFolderIds?: readonly string[];
  activeFolderName?: string;
  noteCount: number;
}) {
  if (!input.activeFolderIds) return "Set per folder";
  if (input.activeFolderIds.length > 1) return "Several folders — off";
  if (input.activeFolderIds.length === 0) return "No folder — off";
  const name = input.activeFolderName ?? "this folder";
  return input.noteCount > 0
    ? `${name} — ${input.noteCount} note${input.noteCount === 1 ? "" : "s"}`
    : `${name} — none yet`;
}

type Summary = {
  /** The answer, short enough for a third of a 20rem card. */
  value: string;
  /** Where it came from, or what it covers, on a second line. */
  detail: string | null;
  /** Both, as one sentence, for anyone not reading the tile. */
  spoken: string;
  active: boolean;
};

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarise({
  activeFolderIds,
  activeFolder,
  accountStudyLevel,
  accountStudySubjects,
  changedStyleCount,
  memory,
}: TutorSettingsTabsProps): Record<TutorSettingsView, Summary> {
  const level = activeFolder?.studyLevel ?? accountStudyLevel;
  const levelLabel = level ? getStudyLevelShortLabel(level) : null;
  const fromFolder = Boolean(activeFolder?.studyLevel);
  const subjects = accountStudySubjects.length;
  const levelDetail = !levelLabel
    ? "Jami guesses"
    : fromFolder
      ? `From ${activeFolder?.name ?? "folder"}`
      : subjects > 0
        ? plural(subjects, "subject")
        : null;

  const noteCount = activeFolder?.noteCount ?? 0;
  const scope = describeFolderScope({
    ...(activeFolderIds ? { activeFolderIds } : {}),
    ...(activeFolder?.name ? { activeFolderName: activeFolder.name } : {}),
    noteCount,
  });
  const notes: Summary = !activeFolderIds
    ? { value: "Per folder", detail: null, spoken: scope, active: false }
    : activeFolderIds.length !== 1
      ? {
          value: "Off here",
          detail: activeFolderIds.length > 1 ? "Several folders" : "No folder",
          spoken: scope,
          active: false,
        }
      : {
          value: noteCount > 0 ? plural(noteCount, "note") : "None yet",
          detail: activeFolder?.name ?? "This folder",
          spoken: scope,
          active: noteCount > 0,
        };

  return {
    course: {
      value: levelLabel ?? "Not set",
      detail: levelDetail,
      spoken: levelLabel
        ? `${levelLabel}${
            fromFolder
              ? " (folder)"
              : subjects > 0
                ? ` · ${plural(subjects, "subject")}`
                : ""
          }`
        : "Not set",
      active: Boolean(levelLabel),
    },
    style: {
      value: changedStyleCount === 0 ? "Default" : `${changedStyleCount} changed`,
      detail: changedStyleCount === 0 ? "Recommended" : "Your picks",
      spoken: changedStyleCount === 0 ? "Default" : `${changedStyleCount} changed`,
      active: changedStyleCount > 0,
    },
    notes,
    memory: !memory
      ? { value: "Across chats", detail: null, spoken: "Across chats", active: false }
      : !memory.enabled
        ? { value: "Off", detail: "Each chat fresh", spoken: "Memory off", active: false }
        : {
            value:
              memory.count > 0
                ? `${memory.count} ${memory.count === 1 ? "memory" : "memories"}`
                : "None yet",
            detail: "Across chats",
            spoken:
              memory.count > 0
                ? `${memory.count} ${memory.count === 1 ? "memory" : "memories"} across chats`
                : "Memory on, nothing yet",
            active: memory.count > 0,
          },
  };
}

const ALL_VIEWS: { id: TutorSettingsView; label: string }[] = [
  { id: "course", label: "Course" },
  { id: "style", label: "Style" },
  { id: "notes", label: "Notes" },
  { id: "memory", label: "Memory" },
];

const VIEWS = ALL_VIEWS.filter(
  (entry) => entry.id !== "memory" || featureFlags.enableTutorMemory
);

type TutorSettingsTabsProps = {
  activeFolderIds?: readonly string[];
  activeFolder: TutorFolderSummary | null;
  accountStudyLevel: StudyLevel | null;
  accountStudySubjects: readonly string[];
  changedStyleCount: number;
  /** What Jami remembers, once loaded: whether memory is on and how much there is. */
  memory?: { enabled: boolean; count: number } | null;
};

/**
 * The drawer's views, each showing what it is currently set to.
 *
 * This used to be two rows: a strip of three chips saying what Jami was using,
 * then a row of three tabs for changing it. They named the same three things,
 * and in a 20rem card the chips wrapped and truncated into a heap. One tile per
 * view says both -- where to go, and what you will find there -- and gives each
 * a third of the width instead of whatever a chip could fit.
 */
export default function TutorSettingsTabs({
  view,
  onChange,
  loading,
  ...summaryInput
}: TutorSettingsTabsProps & {
  view: TutorSettingsView;
  onChange: (view: TutorSettingsView) => void;
  /** Tiles without values until the settings have loaded, rather than guesses. */
  loading: boolean;
}) {
  const id = useId();
  const summaries = summarise(summaryInput);

  return (
    <div
      role="tablist"
      aria-label="Your Jami"
      // Two by two for four: four tiles in a row left each too narrow to say anything.
      className={`grid ${VIEWS.length === 4 ? "grid-cols-2" : "grid-cols-3"} gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-1`}
    >
      {VIEWS.map((entry) => {
        const selected = entry.id === view;
        const summary = summaries[entry.id];
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tutor-settings-tab-${entry.id}`}
            aria-selected={selected}
            aria-controls="tutor-settings-panel"
            aria-labelledby={`${id}-${entry.id}-label`}
            aria-describedby={loading ? undefined : `${id}-${entry.id}-spoken`}
            onClick={() => onChange(entry.id)}
            className={`flex min-w-0 flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
              selected
                ? "border-accent/45 bg-[var(--color-surface-panel-strong)] shadow-e1"
                : "border-transparent hover:bg-[var(--color-glass-subtle)]"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span
                id={`${id}-${entry.id}-label`}
                className={`text-xs font-semibold tracking-tight ${
                  selected ? "text-text-primary" : "text-text-secondary"
                }`}
              >
                {entry.label}
              </span>
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  !loading && summary.active
                    ? "bg-accent"
                    : "bg-[var(--color-border-strong)]"
                }`}
              />
            </span>
            {loading ? (
              <span aria-hidden="true" className="h-8" />
            ) : (
              <>
                <span aria-hidden="true" className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {summary.value}
                  </span>
                  <span className="block truncate text-2xs text-text-muted">
                    {summary.detail ?? " "}
                  </span>
                </span>
                <span id={`${id}-${entry.id}-spoken`} className="sr-only">
                  {summary.spoken}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
