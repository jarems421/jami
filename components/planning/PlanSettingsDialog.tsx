"use client";

import { Dialog, DialogBackdrop, DialogDescription, DialogPanel, DialogTitle } from "@/components/ui";
import RevisionPlanBuilder, { type PlanScopeOption } from "@/components/planning/RevisionPlanBuilder";
import type { RevisionPlanDraft } from "@/lib/planning/types";

/**
 * The plan itself -- name, subjects, usual week, dates, exams, and whether
 * Jami fills free sessions -- behind one button, so the timetable keeps the
 * page. Nothing already on the timetable changes when these do.
 */
export default function PlanSettingsDialog({
  options,
  plan,
  activityCount,
  saving,
  onSave,
  onClose,
}: {
  options: readonly PlanScopeOption[];
  plan: RevisionPlanDraft;
  activityCount: number;
  saving: boolean;
  onSave: (draft: RevisionPlanDraft) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open className="fixed inset-0 flex items-end justify-center p-0 sm:items-center sm:p-4" onDismiss={onClose}>
      <DialogBackdrop className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
      <DialogPanel className="app-panel relative max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-b-none px-5 py-6 shadow-e3 sm:rounded-2xl sm:px-7">
        <DialogTitle className="text-xl font-semibold text-text-primary">Plan settings</DialogTitle>
        <DialogDescription className="mt-1.5 text-sm leading-6 text-text-secondary">
          The shape of your plan. Changing your usual week changes the free sessions in weeks you haven&rsquo;t
          planned; anything already on your timetable stays as it is.
        </DialogDescription>
        <div className="mt-6">
          <RevisionPlanBuilder
            options={options}
            initial={plan}
            activityCount={activityCount}
            saving={saving}
            submitLabel="Save settings"
            onSave={onSave}
            onCancel={onClose}
          />
        </div>
      </DialogPanel>
    </Dialog>
  );
}
