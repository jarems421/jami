"use client";

import FormDisclosure from "@/components/ui/FormDisclosure";
import NotebookPenSettingSlider from "@/components/workspace/NotebookPenSettingSlider";
import {
  getNotebookCornerSharpnessLabel,
  getNotebookPressureLabel,
  getNotebookStraightenLabel,
  getNotebookTrackingLabel,
  hasNotebookPenAdvancedChanges,
  NOTEBOOK_STRAIGHTEN_MODES,
  resetNotebookPenAdvancedSettings,
  type NotebookPenSettings,
} from "@/lib/workspace/notebook-pen-feel";

/**
 * The pen settings behind Smoothing.
 *
 * Smoothing on the front of the panel is how much wobble is taken out of the
 * line. Everything else about how the pen shapes a stroke is here, folded away
 * until it is wanted -- corners first, because it is the one most reached for.
 *
 * Corner sharpness used to follow Smoothing until it was unlinked, and read as
 * a greyed-out slider that did nothing beside a Smoothing slider that was
 * really moving the corners. It is its own setting now, always live.
 *
 * Every control here reproduces the previous behaviour at its default, so
 * opening this section and closing it again cannot change how the pen writes.
 */
export default function NotebookPenAdvancedSettings({
  settings,
  onChange,
}: {
  settings: NotebookPenSettings;
  onChange: (next: NotebookPenSettings) => void;
}) {
  const cornerSharpness = settings.cornerSharpnessPercent;
  const changed = hasNotebookPenAdvancedChanges(settings);
  const set = (patch: Partial<NotebookPenSettings>) =>
    onChange({ ...settings, ...patch });

  return (
    <FormDisclosure
      title="Advanced"
      summary={changed ? "Customised" : "Default"}
      className="mt-1"
    >
      <div className="space-y-3.5">
        <NotebookPenSettingSlider
          label="Corner sharpness"
          name={getNotebookCornerSharpnessLabel(cornerSharpness).name}
          description={
            getNotebookCornerSharpnessLabel(cornerSharpness).description
          }
          percent={cornerSharpness}
          onChange={(value) => set({ cornerSharpnessPercent: value })}
        />

        <NotebookPenSettingSlider
          label="Nib tracking"
          name={getNotebookTrackingLabel(settings.trackingPercent).name}
          description={
            getNotebookTrackingLabel(settings.trackingPercent).description
          }
          percent={settings.trackingPercent}
          onChange={(value) => set({ trackingPercent: value })}
        />

        <NotebookPenSettingSlider
          label="Pressure"
          name={getNotebookPressureLabel(settings.pressurePercent).name}
          description={
            getNotebookPressureLabel(settings.pressurePercent).description
          }
          percent={settings.pressurePercent}
          onChange={(value) => set({ pressurePercent: value })}
        />

        <div>
          <div className="px-0.5 text-xs font-semibold text-text-secondary">
            Hold still at the end of a stroke
          </div>
          <div
            role="radiogroup"
            aria-label="Hold still at the end of a stroke"
            className="mt-1.5 grid grid-cols-3 gap-1.5"
          >
            {NOTEBOOK_STRAIGHTEN_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={settings.straightenOnHold === mode}
                aria-label={getNotebookStraightenLabel(mode).name}
                onClick={() => set({ straightenOnHold: mode })}
                className={`min-h-11 rounded-full border px-2 text-2xs font-semibold leading-tight transition ${
                  settings.straightenOnHold === mode
                    ? "app-selected"
                    : "app-chip"
                }`}
              >
                {getNotebookStraightenLabel(mode).name}
              </button>
            ))}
          </div>
          <p className="mt-1 px-0.5 text-2xs leading-4 text-text-secondary">
            {getNotebookStraightenLabel(settings.straightenOnHold).description}
          </p>
        </div>

        <div className="border-t border-[var(--color-border)] pt-2.5">
          <button
            type="button"
            disabled={!changed}
            onClick={() => onChange(resetNotebookPenAdvancedSettings(settings))}
            className="inline-flex min-h-[2.25rem] w-full items-center justify-center rounded-full px-3 text-xs font-semibold text-text-secondary transition hover:bg-[var(--color-glass-medium)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset advanced settings
          </button>
        </div>
      </div>
    </FormDisclosure>
  );
}
