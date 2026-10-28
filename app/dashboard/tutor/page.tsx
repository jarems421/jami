"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppPage from "@/components/layout/AppPage";
import JamiAssistantDrawer from "@/components/ai/JamiAssistantDrawer";
import TutorAskPanel from "@/components/ai/TutorAskPanel";
import TutorDoor from "@/components/ai/TutorDoor";
import TutorSourcePicker from "@/components/ai/TutorSourcePicker";
import TutorPlanCard from "@/components/planning/TutorPlanCard";
import RevisionEmblem from "@/components/revision/RevisionEmblem";
import RevisionTutorShelf from "@/components/revision/RevisionTutorShelf";
import { featureFlags } from "@/lib/app/feature-flags";
import { useUser } from "@/components/providers/UserProvider";
import {
  Button,
  EmptyState,
  FeedbackBanner,
  JamiTutorIcon,
  Skeleton,
} from "@/components/ui";
import { useFeedback } from "@/hooks/useFeedback";
import {
  useDashboardData,
  type DashboardDataLoadOptions,
} from "@/hooks/useDashboardData";
import { getJamiAssistantContextKey } from "@/lib/ai/jami-assistant-history";
import { tutorSourceActions } from "@/lib/ai/tutor-source-actions";
import { getRevisionStartHref } from "@/lib/app/routes";
import {
  getSourcePanelHref,
  TUTOR_TITLE,
  TUTOR_VIEWS,
} from "@/lib/app/tutor-views";
import {
  describeDraftCounts,
  describeDraftGroupOrigin,
  draftGroupKey,
  groupTutorDrafts,
} from "@/lib/app/tutor-drafts";
import TutorDraftReviewDialog from "@/components/ai/TutorDraftReviewDialog";
import type { GeneratedContentDraft } from "@/lib/material/generated-content";
import type { Source } from "@/lib/material/sources";
import { getPendingGeneratedContentDrafts } from "@/services/study/generated-content";
import { getActiveSources } from "@/services/study/sources";
import type { RevisionPlan } from "@/lib/planning/types";
import { loadActiveRevisionPlan } from "@/services/planning/revision-plans";
import { prefersReducedMotion } from "@/lib/ui/reduced-motion";

/** Enough of the queue to act on without turning the page into a list. */
const MAX_PENDING_DRAFTS = 20;
const TUTOR_HREF = "/dashboard/tutor";

function MaterialIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M6 4h9l4 4v12H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M14.5 4v4.5H19M9 13h7M9 16.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Jami's front door.
 *
 * One question, three doors and one inbox. The question comes first because
 * asking is what most visits are for: type it, choose the material -- one
 * source or several -- and send, and the card it was typed into becomes the
 * conversation, with the answer on its way. Closing the chat brings the
 * question back. It used to open a full-screen chat on send, which felt like
 * being sent somewhere else mid-sentence. Under it, Jami's other places, all the same shape: the revision
 * plan, a revision session, and the material itself. Then what Jami has made
 * that is waiting for the student's OK.
 *
 * It used to be five unrelated cards -- an ask banner that sent you to the
 * Library, the plan, the revision shelf, recent material and a draft queue --
 * each drawn differently and each explaining itself. Jami reads what it is
 * handed, for that conversation only, and says so once, under the question.
 */
export default function TutorPage() {
  const { user } = useUser();
  const [sources, setSources] = useState<Source[]>([]);
  const [drafts, setDrafts] = useState<GeneratedContentDraft[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activePlan, setActivePlan] = useState<RevisionPlan | null>(null);
  const { feedback, showError, clear: clearFeedback } = useFeedback();
  /** The material the student chose; null until they choose, which means the most recent. */
  const [chosenSourceIds, setChosenSourceIds] = useState<string[] | null>(null);
  /**
   * The chat beside the page. `key` gives each question asked from here a
   * fresh conversation, and `message` is what that conversation opens by
   * sending.
   */
  const [chat, setChat] = useState<{ key: number; open: boolean; message?: string; history?: boolean }>({
    key: 0,
    open: false,
  });

  const loadTutorData = useCallback(
    async (reads: DashboardDataLoadOptions = {}) => {
      const [userSources, pendingDrafts, plan] = await Promise.all([
        getActiveSources(user.uid, reads),
        getPendingGeneratedContentDrafts(user.uid, MAX_PENDING_DRAFTS),
        // A plan that cannot be read is the same as not having one here, and a
        // page about asking Jami things should not fail over a timetable.
        featureFlags.enableRevisionPlans
          ? loadActiveRevisionPlan(user.uid).catch(() => null)
          : Promise.resolve(null),
      ]);
      return { sources: userSources, drafts: pendingDrafts, plan };
    },
    [user.uid],
  );

  const applyTutorData = useCallback(
    (data: Awaited<ReturnType<typeof loadTutorData>>) => {
      setSources(data.sources);
      setDrafts(data.drafts);
      setActivePlan(data.plan);
    },
    [],
  );

  const handleLoadError = useCallback(
    (error: unknown) => {
      console.error("Failed to load the Jami workspace.", error);
      setLoadFailed(true);
      showError("Jami could not load your drafts just now. Try again shortly.");
    },
    [showError],
  );

  const { loading, reload } = useDashboardData({
    requestKey: user.uid,
    load: loadTutorData,
    apply: applyTutorData,
    onError: handleLoadError,
    onLoadStart: () => {
      setLoadFailed(false);
      clearFeedback();
    },
  });

  const draftGroups = useMemo(
    () => groupTutorDrafts(drafts, sources),
    [drafts, sources],
  );
  const hasDrafts = draftGroups.length > 0;
  const [reviewingGroupKey, setReviewingGroupKey] = useState<string | null>(null);
  const reviewingGroup =
    draftGroups.find((group) => draftGroupKey(group) === reviewingGroupKey) ?? null;
  const draftTotal = draftGroups.reduce((sum, group) => sum + group.total, 0);

  /*
   * What the next question reads: the student's choice, or -- before they have
   * made one -- the material they touched last, which is nearly always the
   * one they came to ask about. A chosen source that has since been deleted
   * simply drops out.
   */
  const selectedSources = useMemo(() => {
    const byId = new Map(sources.map((source) => [source.id, source]));
    const chosen = (chosenSourceIds ?? []).flatMap((id) => {
      const source = byId.get(id);
      return source ? [source] : [];
    });
    if (chosen.length > 0) return chosen;
    const recent = [...sources].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return recent ? [recent] : [];
  }, [chosenSourceIds, sources]);
  const selectedIds = useMemo(() => selectedSources.map((source) => source.id), [selectedSources]);
  const several = selectedSources.length > 1;

  const ask = (message: string) =>
    setChat((current) => ({ key: current.key + 1, open: true, message }));
  const openChats = () => setChat((current) => ({ key: current.key + 1, open: true, history: true }));
  const chatOpen = chat.open && selectedIds.length > 0;

  // The chat takes the ask box's place. If that place has scrolled off the
  // top -- a quick action pressed lower down -- bring it back into view.
  const askAreaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const area = askAreaRef.current;
    if (!chatOpen || !area || area.getBoundingClientRect().top >= 0) return;
    area.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [chatOpen, chat.key]);

  return (
    <AppPage
      title={TUTOR_TITLE}
      views={TUTOR_VIEWS}
      viewsLabel="Jami views"
      backHref="/dashboard"
      backLabel="Today"
      width="xl"
      contentClassName="space-y-5"
    >
      {feedback ? (
        <FeedbackBanner
          type={feedback.type}
          message={feedback.message}
          onDismiss={clearFeedback}
        />
      ) : null}

      <div ref={askAreaRef} data-tutorial-target="tutor-material" className="scroll-mt-4">
        {chatOpen ? (
          <JamiAssistantDrawer
            key={chat.key}
            // The conversation carries on in the card the question was typed into.
            layout="inline"
            userId={user.uid}
            open={chatOpen}
            onOpenChange={(open) => setChat((current) => ({ ...current, open }))}
            resetKey="tutor-page"
            contextKey={getJamiAssistantContextKey({ surface: "sources", sourceIds: selectedIds })}
            contextLabel={several ? `${selectedSources.length} selected sources` : selectedSources[0]?.title ?? "Your material"}
            historyContextLabel={
              several
                ? `${selectedSources[0]?.title ?? "Sources"} and ${selectedSources.length - 1} more`
                : selectedSources[0]?.title ?? "Source"
            }
            getContext={() => ({ surface: "sources", sourceIds: selectedIds })}
            settingsFolderIds={Array.from(new Set(selectedSources.flatMap((source) => source.folderIds)))}
            quickActions={tutorSourceActions(selectedIds.length)}
            // Add or drop material without leaving the chat. Before the first
            // message that simply changes what the chat reads; after it, the
            // conversation was about the old material, so a new one starts.
            contextControls={({ conversationStarted }) => (
              <TutorSourcePicker
                sources={sources}
                selectedIds={selectedIds}
                onChange={(ids) => {
                  setChosenSourceIds(ids);
                  if (conversationStarted) {
                    setChat((current) => ({ key: current.key + 1, open: true }));
                  }
                }}
                {...(conversationStarted
                  ? { changeNote: "Changing the material starts a new chat." }
                  : {})}
              />
            )}
            {...(chat.message ? { initialMessage: chat.message } : {})}
            startInHistory={Boolean(chat.history)}
          />
        ) : (
          <TutorAskPanel
            sources={sources}
            selectedIds={selectedIds}
            onSelectedChange={setChosenSourceIds}
            onAsk={ask}
            onOpenChats={openChats}
            loading={loading}
          />
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/*
          Making study material, which used to be found only inside a source.
          It asks first -- flashcards or a practice set, which topic, what is
          hard -- in the chat card above, so nothing is made on a guess.
        */}
        {sources.length > 0 || loading ? (
          <TutorDoor
            onOpen={() => ask("Help me make flashcards or a practice set.")}
            icon={<JamiTutorIcon className="h-5 w-5" />}
            title="Make flashcards or questions"
            description="Pick a topic and say what you find hard. Jami makes flashcards, or a marked practice set, from your material."
            action="Start making"
          />
        ) : (
          <TutorDoor
            href="/dashboard/library"
            icon={<JamiTutorIcon className="h-5 w-5" />}
            title="Make flashcards or questions"
            description="Add some notes, a past paper or a link first, and Jami can make flashcards or a marked practice set from them."
            action="Add material"
          />
        )}
        {featureFlags.enableRevisionPlans ? (
          <TutorPlanCard plan={activePlan} loading={loading} />
        ) : null}
        {featureFlags.enableRevisionSessions ? (
          <TutorDoor
            href={getRevisionStartHref({ returnHref: TUTOR_HREF })}
            tone="warm"
            icon={<RevisionEmblem className="h-5 w-5" />}
            title="Get taught something"
            description="A short lesson on what your answers say needs work. You do the thinking, and every answer is checked."
            action="Start a session"
          />
        ) : null}
        <TutorDoor
          href="/dashboard/library"
          icon={<MaterialIcon />}
          title="Your material"
          description="The notes, past papers and links Jami reads from. Add more, or open any of them."
          {...(loading ? {} : { status: `${sources.length} saved` })}
          action="Open material"
        />
      </div>

      <section
        aria-labelledby="tutor-ok-title"
        className={`app-panel rounded-3xl p-5 sm:p-6 ${hasDrafts ? "border-warm-border" : ""}`}
      >
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-warm-border bg-warm-glow text-warm-accent"
          >
            <JamiTutorIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="tutor-ok-title" className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-text-primary">
              Waiting for your OK
              {hasDrafts ? (
                <span className="grid h-6 min-w-6 place-items-center rounded-full bg-warm-accent px-2 text-xs font-bold tabular-nums text-[var(--color-surface-base)]">
                  {draftTotal}
                </span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              Cards and questions Jami made from your material. Nothing joins your studying until you have read it and said yes.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {loading ? (
            <>
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </>
          ) : loadFailed ? (
            <div className="sm:col-span-2">
              <EmptyState
                variant="compact"
                align="left"
                emoji="Draft"
                title="Drafts are unavailable"
                description="We could not read your queue, so it has not been treated as empty."
                action={
                  <Button type="button" size="sm" onClick={() => void reload()}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : !hasDrafts ? (
            <p className="text-sm text-text-muted sm:col-span-2">
              Nothing waiting. When Jami makes cards or questions from your material, they wait here for you to check.
            </p>
          ) : (
            draftGroups.map((group) => {
              const counts = describeDraftCounts(group).join(" · ");
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text-primary">
                      {describeDraftGroupOrigin(group)}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-muted">
                      {counts || group.preview}
                    </span>
                  </span>
                  {group.sourceId ? (
                    <span className="shrink-0 text-sm font-semibold text-[var(--color-accent)]">Check them</span>
                  ) : null}
                </>
              );
              return group.sourceId ? (
                <Link
                  key={group.sourceId}
                  href={getSourcePanelHref(group.sourceId, "drafts")}
                  className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3.5 transition duration-fast hover:border-[var(--color-border-strong)] hover:bg-[var(--color-glass-medium)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  {body}
                </Link>
              ) : (
                /*
                 * Flashcards Tutor made from a conversation belong to no source,
                 * so there is no source page to review them on: they open here.
                 */
                <button
                  key="__unsourced__"
                  type="button"
                  onClick={() => setReviewingGroupKey(draftGroupKey(group))}
                  className="flex w-full items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3.5 text-left transition duration-fast hover:border-[var(--color-border-strong)]"
                >
                  {body}
                  <span className="shrink-0 text-sm font-semibold text-[var(--color-accent)]">Check them</span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {reviewingGroup ? (
        <TutorDraftReviewDialog
          key={draftGroupKey(reviewingGroup)}
          userId={user.uid}
          title={reviewingGroup.title}
          drafts={drafts.filter((draft) => reviewingGroup.draftIds.includes(draft.id))}
          onClose={() => {
            setReviewingGroupKey(null);
            // What was kept or discarded leaves the queue.
            void reload();
          }}
        />
      ) : null}

      {featureFlags.enableRevisionSessions ? <RevisionTutorShelf variant="shelf" /> : null}

    </AppPage>
  );
}
