"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, ButtonLink, JamiTutorIcon } from "@/components/ui";
import { useStudyActions } from "@/hooks/useStudyActions";
import { featureFlags } from "@/lib/app/feature-flags";
import { getQuestionPracticeSessionHref } from "@/lib/app/routes";
import type { ExamSession } from "@/lib/practice/exam-questions";
import {
  selectPracticeRecommendations,
  type PracticeRecommendation,
} from "@/lib/practice/practice-recommendations";
import { describePracticeSetOrigin } from "@/lib/practice/practice-sets";
import {
  createRecommendedPracticeSet,
  listReadyPracticeSets,
  updatePracticeSet,
} from "@/services/practice/practice-sets";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Practice Jami has lined up: sets Tutor made in a chat, sets made from a
 * source, and what the Learning Engine thinks is worth practising next.
 *
 * Shown only when there is something in it, so the page stays as calm as it
 * was for a student who has never asked for a set.
 */
export default function ReadyToPractise({ userId }: { userId: string }) {
  const [sets, setSets] = useState<ExamSession[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [madeFrom, setMadeFrom] = useState<Set<string>>(() => new Set());
  const studyActions = useStudyActions(
    userId,
    featureFlags.enableLearnerProfile && featureFlags.enableStudyActions
  );

  useEffect(() => {
    let active = true;
    void listReadyPracticeSets()
      .then((loaded) => active && setSets(loaded))
      // Ready sets are an extra on this page; failing to read them hides the section.
      .catch(() => active && setSets([]));
    return () => {
      active = false;
    };
  }, [userId]);

  const recommendations = useMemo(
    () =>
      selectPracticeRecommendations(studyActions.actions).filter(
        (recommendation) => !madeFrom.has(recommendation.id)
      ),
    [madeFrom, studyActions.actions]
  );
  const folderNames = useMemo(
    () => new Map(studyActions.folders.map((folder) => [folder.id, folder.name])),
    [studyActions.folders]
  );

  const dismiss = async (session: ExamSession) => {
    if (busyId) return;
    setBusyId(session.id);
    setError("");
    try {
      await updatePracticeSet(session.id, "dismiss");
      setSets((current) => (current ?? []).filter((item) => item.id !== session.id));
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : "That set could not be dismissed.");
    } finally {
      setBusyId(null);
    }
  };

  const makeSet = async (recommendation: PracticeRecommendation) => {
    if (busyId) return;
    setBusyId(recommendation.id);
    setError("");
    try {
      const session = await createRecommendedPracticeSet({
        folderId: recommendation.folderId,
        focus: recommendation.label,
        ...(recommendation.topicIds ? { topicIds: recommendation.topicIds } : {}),
        ...(recommendation.conceptIds ? { conceptIds: recommendation.conceptIds } : {}),
      });
      setSets((current) => [session, ...(current ?? [])]);
      setMadeFrom((current) => new Set(current).add(recommendation.id));
    } catch (makeError) {
      setError(makeError instanceof Error ? makeError.message : "Jami could not write that set just now.");
    } finally {
      setBusyId(null);
    }
  };

  if (sets === null || (sets.length === 0 && recommendations.length === 0)) return null;

  return (
    <section className="space-y-3" aria-labelledby="ready-to-practise-heading">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 id="ready-to-practise-heading" className="text-base font-medium tracking-tight text-text-primary sm:text-lg">
            Ready to practice
          </h3>
          <p className="mt-1 text-sm leading-6 text-text-muted">
            Question sets Jami has written for you, marked when you answer.
          </p>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-error/35 bg-error-muted px-3.5 py-2.5 text-xs leading-5 text-[var(--color-error-text)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {sets.map((session) => {
          const practiceSet = session.practiceSet;
          const questionCount = session.questions.length;
          return (
            <article
              key={session.id}
              className="app-subtle-panel flex min-w-0 flex-col rounded-xl p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-text-muted">
                  <JamiTutorIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate">
                    {practiceSet ? describePracticeSetOrigin(practiceSet.origin) : "Practice set"}
                  </span>
                </span>
                {practiceSet && !practiceSet.acceptedAt ? (
                  <span className="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-2xs font-semibold text-accent">
                    New
                  </span>
                ) : null}
              </div>
              <h4 className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-text-primary">
                {practiceSet?.title ?? session.subject}
              </h4>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                {[
                  plural(questionCount, "question"),
                  plural(session.maxTotal, "mark"),
                  session.folderId ? session.folderName : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="mt-auto flex items-center justify-end gap-1.5 pt-3">
                <button
                  type="button"
                  disabled={busyId !== null}
                  className="rounded-full px-3 py-1.5 text-xs font-medium text-text-muted transition duration-fast hover:bg-[var(--color-glass-medium)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                  onClick={() => void dismiss(session)}
                >
                  {busyId === session.id ? "Dismissing…" : "Dismiss"}
                </button>
                <ButtonLink href={getQuestionPracticeSessionHref(session.id)} size="sm">
                  Start
                </ButtonLink>
              </div>
            </article>
          );
        })}

        {recommendations.map((recommendation) => {
          const folderName = folderNames.get(recommendation.folderId);
          const busy = busyId === recommendation.id;
          return (
            <article
              key={recommendation.id}
              className="flex min-w-0 flex-col rounded-xl border border-dashed border-[var(--color-border-strong)] p-4"
            >
              <span className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-text-muted">
                <JamiTutorIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
                Recommended by Jami
              </span>
              <h4 className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-text-primary">
                {recommendation.label}
              </h4>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                {[recommendation.why, folderName].filter(Boolean).join(" · ")}
              </p>
              <div className="mt-auto flex items-center justify-end gap-2 pt-3">
                {busy ? (
                  <span className="inline-flex items-center gap-2 text-xs text-text-muted" role="status">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
                    Writing your set
                  </span>
                ) : recommendation.setupHref ? (
                  <ButtonLink href={recommendation.setupHref} size="sm" variant="secondary">
                    Past paper questions
                  </ButtonLink>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busyId !== null}
                    onClick={() => void makeSet(recommendation)}
                  >
                    Make a set
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
