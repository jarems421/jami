"use client";

import { OptionMenu, type OptionMenuOption } from "@/components/ui";
import type { StudyMode, StudyModePolicy } from "@/lib/study/study-modes";

type ModeChoice = "smart" | StudyMode;

/**
 * Classic first because it is the default and the one a student arrives
 * already understanding. Smart Mix is the better way to study and says so, but
 * being recommended is not the same as being what happens to you.
 */
const CHOICES: readonly OptionMenuOption<ModeChoice>[] = [
  { value: "classic", label: "Classic", detail: "Read it, flip it, rate how it went." },
  {
    value: "smart",
    label: "Smart Mix",
    badge: "Recommended",
    detail: "Varies how each card is asked, so no session is one long typing test.",
  },
  {
    value: "type-answer",
    label: "Type Answer",
    detail: "Write the answer from memory before it is shown.",
  },
  {
    value: "gap-fill",
    label: "Gap Fill",
    detail: "The answer with its key word hidden.",
  },
  {
    value: "multiple-choice",
    label: "Multiple Choice",
    detail: "Pick the answer from four. Jami writes the three wrong ones.",
  },
];

/** Which session is being set up, for the one line that differs between them. */
export type StudyModeSurface = "daily" | "focused" | "simple";

const PREPARATION_NOTE =
  "Jami reads any new cards when you start, so the gaps land on the words that matter. Cards you have studied before are ready straight away.";

const SURFACE_NOTE: Record<StudyModeSurface, string | null> = {
  daily: null,
  // Focused Review has never moved a card's schedule, whichever way it asks.
  focused: "Focused Review practices without moving your review dates.",
  // Simple Study answers on two points, so a mode changes the question and
  // nothing else: there is no four-point rating for it to feed.
  simple: "Simple Study still answers Missed or Got it, so this changes the question, not your schedule.",
};

type StudyModePickerProps = {
  policy: StudyModePolicy;
  surface?: StudyModeSurface;
  /** For a surface that already asks the question in a heading of its own. */
  hideLabel?: boolean;
  onChange: (policy: StudyModePolicy) => void;
};

/**
 * How this session will ask its cards.
 *
 * One bubble and one line. This has been four designs now: five description
 * cards with a readiness count on each, which turned the calmest screen in the
 * app into a settings panel; a row of pills, which fixed the size and left five
 * unattached bubbles floating over the setup screen; the shared `OptionSwitch`,
 * which put them on the product's grid and still spent five tiles of a study
 * screen on a choice most students make once. It is a dropdown now: the current
 * mode is a pill, and the other four with their explanations are one click
 * behind it.
 *
 * It appears on all three ways to study rather than only on Daily Review, so
 * the choice is where the session starts. The mode is remembered per student,
 * so choosing here chooses everywhere -- what a surface changes is what a
 * rating then does, which is what `SURFACE_NOTE` says out loud.
 */
export default function StudyModePicker({
  policy,
  surface = "daily",
  hideLabel = false,
  onChange,
}: StudyModePickerProps) {
  const active: ModeChoice = policy.kind === "smart" ? "smart" : policy.mode;
  const surfaceNote = SURFACE_NOTE[surface];
  const note =
    active === "classic"
      ? surfaceNote
      : surfaceNote
        ? `${surfaceNote} ${PREPARATION_NOTE}`
        : PREPARATION_NOTE;

  return (
    <div
      data-study-mode-picker="true"
      data-study-mode-surface={surface}
      className="space-y-2"
    >
      <OptionMenu
        label="How to study"
        hideLabel={hideLabel}
        value={active}
        options={CHOICES}
        onChange={(value) =>
          onChange(
            value === "smart"
              ? { kind: "smart" }
              : { kind: "fixed", mode: value as StudyMode }
          )
        }
      />
      {note ? (
        <p className="max-w-md text-2xs leading-5 text-text-muted">{note}</p>
      ) : null}
    </div>
  );
}
