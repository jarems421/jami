"use client";

import { type ReactNode } from "react";
import AppPage from "@/components/layout/AppPage";
import { TutorSaveIndicator } from "@/components/ai/TutorSaveIndicator";
import TutorFolderNotes from "@/components/ai/TutorFolderNotes";
import TutorMemoryPanel from "@/components/ai/TutorMemoryPanel";
import TutorNotesList from "@/components/ai/TutorNotesList";
import TutorStudyProfileForm from "@/components/ai/TutorStudyProfileForm";
import TutorStyleChoices from "@/components/ai/TutorStyleChoices";
import {
  Button,
  Card,
  FeedbackBanner,
  PageHero,
  SectionHeader,
  Skeleton,
} from "@/components/ui";
import { useTutorMemory } from "@/hooks/useTutorMemory";
import { useTutorPersonalisation } from "@/hooks/useTutorPersonalisation";
import { featureFlags } from "@/lib/app/feature-flags";
import { TUTOR_TITLE, TUTOR_VIEWS } from "@/lib/app/tutor-views";
import {
  GENERAL_NOTE_SUGGESTIONS,
  MAX_TUTOR_GENERAL_NOTES,
} from "@/lib/ai/tutor-personalisation";

/**
 * One part of the page: a numbered step, its question, and its controls.
 *
 * The number sits in the heading rather than in a gutter of its own. The gutter
 * indented every control on the page by three rem, which the notes -- already
 * sharing their card with a folder list -- could not spare.
 */
function Step({
  number,
  eyebrow,
  title,
  description,
  children,
}: {
  number: number;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card padding="lg">
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-xs font-semibold text-accent"
        >
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <SectionHeader eyebrow={eyebrow} title={title} description={description} />
        </div>
      </div>
      <div className="mt-6 border-t border-[var(--color-border)] pt-6">
        {children}
      </div>
    </Card>
  );
}

/**
 * Your Jami: what Jami remembers about you, and how it teaches you.
 *
 * A view of the Jami page of its own, not a settings screen. The memory
 * galaxy comes first -- it is the student's, and the part worth coming back
 * to -- then four steps from the broadest to the most specific: who you are,
 * how Jami teaches, what it should always keep in mind, what one subject
 * needs. Everything but the
 * study level saves as it changes, so the page has no Save buttons to find and
 * nothing to lose by leaving.
 *
 * It used to be three stacked forms: a free-text "Anything else?" box bolted
 * under the style choices, and a Markdown document per folder behind a
 * one-time scripted chat. Both are now short lists of notes, which is easier to
 * write and is what the tutor is actually handed.
 */
export default function TutorPersonaliseWorkspace() {
  const {
    data,
    preferences,
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
  } = useTutorPersonalisation();
  const memory = useTutorMemory();

  return (
    <AppPage
      title={TUTOR_TITLE}
      views={TUTOR_VIEWS}
      viewsLabel="Jami views"
      backHref="/dashboard"
      backLabel="Today"
      width="2xl"
      contentClassName="space-y-4"
    >
      {feedback ? (
        <FeedbackBanner
          type={feedback.type}
          message={feedback.message}
          onDismiss={clearFeedback}
        />
      ) : null}

      <PageHero
        eyebrow="Your Jami"
        title={featureFlags.enableTutorMemory ? "What Jami knows about you" : "Jami, made for you"}
        description={
          featureFlags.enableTutorMemory
            ? "Jami remembers what you get wrong and what you're working on, and teaches the way you ask it to. All of it is yours to see and change."
            : "Tell Jami what you study, how you like to learn, and what each subject needs. All optional. Anything you leave, Jami decides for you."
        }
      />

      {loading ? (
        <div className="tutor-personalise">
          <div className="tutor-personalise-grid">
            <div className="space-y-4">
              <Skeleton className="h-48 w-full rounded-2xl" />
              <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
            <Skeleton className="h-72 w-full rounded-2xl" />
          </div>
        </div>
      ) : loadFailed ? (
        <Card padding="lg">
          <SectionHeader
            title="Jami could not load your preferences"
            description="Nothing has changed. Your existing settings are still in force."
          />
          <div className="mt-5">
            <Button type="button" variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* A summary of what was just filled in told the student nothing new; the save state is all it needs. */}
          {featureFlags.enableTutorMemory ? (
            <Card padding="lg">
              <SectionHeader
                eyebrow="Memory"
                title="What Jami remembers"
                description="Jami carries short notes from one chat to the next, so it knows what you get wrong and what you're working on. Each subject is a galaxy: tap one to fly in, and tap a note to correct or forget it."
              />
              <div className="mt-5">
                <TutorMemoryPanel memory={memory} folders={data?.folders ?? []} />
              </div>
            </Card>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-3 pt-4">
            <SectionHeader
              eyebrow="Teaching"
              title="How Jami teaches you"
              description="All optional. Anything you leave, Jami decides for you."
            />
            <TutorSaveIndicator status={saveStatus} />
          </div>
          <div>
            <div className="min-w-0 space-y-4">
              <Step
                number={1}
                eyebrow="You"
                title="What you're studying"
                description="Sets the vocabulary and assumed knowledge Jami starts from."
              >
                <div className="max-w-xl">
                  <TutorStudyProfileForm
                    // Remounted whenever a save produces a new level or list, so
                    // the fields restart from it without an effect copying values.
                    key={`${studyLevel ?? "none"}:${studySubjects.join("|")}`}
                    studyLevel={studyLevel}
                    studySubjects={studySubjects}
                    saving={savingProfile}
                    onSave={saveStudyProfile}
                  />
                </div>
              </Step>

              <Step
                number={2}
                eyebrow="Style"
                title="How Jami teaches"
                description="Each one starts on the recommended setting. Change only what you care about."
              >
                <TutorStyleChoices value={preferences} onChange={saveStyle} />
              </Step>

              <Step
                number={3}
                eyebrow="Every subject"
                title="Things Jami should always do"
                description="Short lines, one habit each. Jami follows them in every subject."
              >
                <TutorNotesList
                  label="Notes for every subject"
                  notes={preferences.notes}
                  max={MAX_TUTOR_GENERAL_NOTES}
                  suggestions={GENERAL_NOTE_SUGGESTIONS}
                  placeholder="Name the rule before you use it"
                  emptyText="Nothing yet. Add a habit you'd want from any tutor, or tap an idea below."
                  onChange={saveGeneralNotes}
                />
              </Step>

              <Step
                number={4}
                eyebrow="One subject"
                title="What each subject needs"
                description="Exam wording, notation, how you like your work checked. Used only when you're working in that folder, and it wins over everything above."
              >
                <TutorFolderNotes
                  folders={data?.folders ?? []}
                  selectedFolderId={selectedFolderId}
                  folder={data?.folder ?? null}
                  loadingFolder={loadingFolder}
                  onSelectFolder={setSelectedFolderId}
                  onChange={saveFolderNotes}
                />
              </Step>
            </div>

          </div>
        </div>
      )}
    </AppPage>
  );
}
