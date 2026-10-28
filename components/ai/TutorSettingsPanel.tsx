"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { TutorSaveIndicator } from "@/components/ai/TutorSaveIndicator";
import TutorFolderNotes from "@/components/ai/TutorFolderNotes";
import TutorMemoryPanel from "@/components/ai/TutorMemoryPanel";
import TutorNotesList from "@/components/ai/TutorNotesList";
import TutorSettingsTabs, {
  type TutorSettingsView,
} from "@/components/ai/TutorSettingsTabs";
import TutorStudyProfileForm from "@/components/ai/TutorStudyProfileForm";
import TutorStyleChoices from "@/components/ai/TutorStyleChoices";
import { Button, FeedbackBanner, Skeleton } from "@/components/ui";
import { useTutorMemory } from "@/hooks/useTutorMemory";
import { useTutorPersonalisation } from "@/hooks/useTutorPersonalisation";
import {
  GENERAL_NOTE_SUGGESTIONS,
  MAX_TUTOR_GENERAL_NOTES,
} from "@/lib/ai/tutor-personalisation";

type TutorSettingsPanelProps = {
  /**
   * The folders the current conversation's material belongs to.
   *
   * Exactly one means that folder's notes apply. More than one means none do,
   * because two documents cannot be merged and choosing between them would be a
   * guess. The Notes tab says which of those is true rather than leaving the
   * student to work it out from a silent Tutor.
   */
  activeFolderIds?: readonly string[];
  onBack?: () => void;
  /**
   * What leaving is called here. "Back to chat" when the settings covered a
   * conversation, "Done" when they arrived as a drawer over a page.
   */
  backLabel?: string;
};

/**
 * One part of a view: a heading, a line on what it is for, and its controls.
 *
 * The notes view holds two lists that differ only in reach, and a bare heading
 * over each left a student to work out from the placeholder which was which.
 */
function PanelSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-text-primary">
          {title}
        </h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * The same personalisation, beside a conversation.
 *
 * Views rather than the page's stacked cards, because the drawer is the
 * narrowest surface in the app and a student who opened it mid-question wants
 * one thing, not a screen to read. Anything that needs room -- writing a
 * subject document from scratch -- has a full page, and this links to it rather
 * than trying to be it.
 */
export default function TutorSettingsPanel({
  activeFolderIds,
  onBack,
  backLabel = "Back to chat",
}: TutorSettingsPanelProps) {
  const [view, setView] = useState<TutorSettingsView>("course");
  const {
    data,
    preferences,
    activeFolder,
    changedStyleCount,
    loading,
    loadFailed,
    loadingFolder,
    savingProfile,
    saveStatus,
    selectedFolderId,
    setSelectedFolderId,
    studyLevel,
    studySubjects,
    feedback,
    clearFeedback,
    reload,
    saveStyle,
    saveGeneralNotes,
    saveFolderNotes,
    saveStudyProfile,
  } = useTutorPersonalisation(activeFolderIds);
  const memory = useTutorMemory();

  return (
    <div
      className="flex h-full flex-col"
      /*
        Opaque, because it covers a conversation. The panel colour is a few
        percent translucent, which reads as depth over a page but let the chat
        underneath -- its composer, its suggestions -- show through every view.
      */
      style={{
        backgroundColor: "var(--color-surface-base)",
        backgroundImage:
          "linear-gradient(var(--color-surface-panel-strong), var(--color-surface-panel-strong))",
      }}
    >
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
        <h2 className="min-w-0 truncate text-base font-medium tracking-tight text-text-primary">
          Your Jami
        </h2>
        {onBack ? (
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            {backLabel}
          </Button>
        ) : null}
      </div>

      {/*
        What Jami is using sits in the tabs themselves rather than a strip
        above them: it is true of all three views, and the tabs are the one
        thing on the panel that is always in sight.
      */}
      <div className="border-b border-[var(--color-border)] px-4 pb-4">
        <TutorSettingsTabs
          view={view}
          onChange={setView}
          loading={loading || loadFailed}
          {...(activeFolderIds ? { activeFolderIds } : {})}
          activeFolder={activeFolder}
          accountStudyLevel={studyLevel}
          accountStudySubjects={studySubjects}
          changedStyleCount={changedStyleCount}
          memory={
            memory.view
              ? { enabled: memory.view.enabled, count: memory.view.items.length }
              : null
          }
        />
      </div>

      <div
        id="tutor-settings-panel"
        role="tabpanel"
        aria-labelledby={`tutor-settings-tab-${view}`}
        className="flex-1 overflow-y-auto px-5 pb-5 pt-5"
      >
        {feedback ? (
          <div className="mb-5">
            <FeedbackBanner
              type={feedback.type}
              message={feedback.message}
              onDismiss={clearFeedback}
            />
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        ) : loadFailed ? (
          <Button type="button" variant="secondary" onClick={reload}>
            Try again
          </Button>
        ) : view === "course" ? (
          <PanelSection
            title="What you're studying"
            description="Sets the vocabulary and assumed knowledge Jami starts from."
          >
            <TutorStudyProfileForm
              // Restarted from whatever a save or a reload produced, rather than
              // by an effect copying values back into fields.
              key={`${studyLevel ?? "none"}:${studySubjects.join("|")}`}
              studyLevel={studyLevel}
              studySubjects={studySubjects}
              folderLevel={activeFolder?.studyLevel ?? null}
              folderName={activeFolder?.name ?? null}
              saving={savingProfile}
              onSave={saveStudyProfile}
            />
          </PanelSection>
        ) : view === "memory" ? (
          <PanelSection
            title="What Jami remembers"
            description="Carried from one chat to the next. Tap a galaxy, then a note, to correct it."
          >
            <TutorMemoryPanel memory={memory} folders={data?.folders ?? []} density="compact" />
          </PanelSection>
        ) : view === "style" ? (
          <div className="flex flex-col gap-5">
            <TutorStyleChoices value={preferences} onChange={saveStyle} />
            <TutorSaveIndicator status={saveStatus} />
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            <PanelSection
              title="Every subject"
              description="Short lines, one habit each. Jami follows them everywhere."
            >
              <TutorNotesList
                label="Notes for every subject"
                notes={preferences.notes}
                max={MAX_TUTOR_GENERAL_NOTES}
                suggestions={GENERAL_NOTE_SUGGESTIONS}
                placeholder="Name the rule before you use it"
                emptyText="Nothing yet. Anything you add here applies everywhere."
                onChange={saveGeneralNotes}
              />
            </PanelSection>
            <div className="border-t border-[var(--color-border)] pt-6">
              <PanelSection
                title="One subject"
                description="Used only in that folder, and it wins over everything above."
              >
                <TutorFolderNotes
                  folders={data?.folders ?? []}
                  selectedFolderId={selectedFolderId}
                  folder={data?.folder ?? null}
                  loadingFolder={loadingFolder}
                  onSelectFolder={setSelectedFolderId}
                  onChange={saveFolderNotes}
                />
              </PanelSection>
            </div>
            <TutorSaveIndicator status={saveStatus} />
          </div>
        )}

        <p className="mt-6 border-t border-[var(--color-border)] pt-3 text-2xs text-text-muted">
          <Link
            href="/dashboard/tutor/personalise"
            className="font-semibold text-accent underline-offset-4 hover:underline"
          >
            Open the full page
          </Link>{" "}
          for more room.
        </p>
      </div>
    </div>
  );
}
