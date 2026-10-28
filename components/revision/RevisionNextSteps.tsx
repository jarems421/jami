"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import InterventionDraftReview from "@/components/learning/InterventionDraftReview";
import MaterialReady from "@/components/today/MaterialReady";
import RevisionEmblem from "@/components/revision/RevisionEmblem";
import { useUser } from "@/components/providers/UserProvider";
import { useInterventionMaterial } from "@/hooks/useInterventionMaterial";
import { REVISION_SHELF_TITLE } from "@/lib/revision/shelf";
import type { RevisionNextStep, RevisionNextStepKind } from "@/lib/revision/types";
import type { Deck } from "@/lib/study/decks";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import { addToRevisionShelf, removeFromRevisionShelf } from "@/services/learning/revision-shelf";
import { getDecks } from "@/services/study/decks";
import { getActiveStudyFolders } from "@/services/study/folders";

/** What "Do it now" is called, by what it does. */
const NOW_LABEL: Record<RevisionNextStepKind, string> = {
  flashcards: "Make the cards",
  "review-cards": "Review them now",
  practice: "Write the questions",
  "exam-questions": "Start practicing",
  session: "Start the session",
};

const WRITES: ReadonlySet<RevisionNextStepKind> = new Set(["flashcards", "practice"]);

type ItemState = "idle" | "saving" | "saved" | "made" | "removed";

export type RevisionActionItem = {
  step: RevisionNextStep;
  /** Set when the item is already on the Tutor shelf, saved for later. */
  shelfId?: string;
};

/**
 * Things to do after a Revision Session, done now or kept for later.
 *
 * Two places show them. At the end of a session they are offers, each chosen
 * by rule from how it went (`lib/revision/next-steps.ts`) with "Do later" to
 * keep one. On the Tutor shelf they are the ones that were kept, with "Remove"
 * instead -- and each leaves the shelf once it is done.
 *
 * Cards and questions are written only when asked for, and nothing Jami writes
 * is kept until the student has read it and said yes: the same review every
 * other piece of Jami-written material goes through. What they keep is listed
 * on the shelf as made for them.
 */
export default function RevisionNextSteps({
  items,
  interventionId,
  heading = "What would help next",
  onShelfChange,
}: {
  items: readonly RevisionActionItem[];
  /** The recommendation or session any written material answers. */
  interventionId: string;
  heading?: string;
  /** Told when the shelf has changed, so a list reading it can refresh. */
  onShelfChange?: () => void;
}) {
  const { user } = useUser();
  const router = useRouter();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [folders, setFolders] = useState<StudyFolder[]>([]);
  const [states, setStates] = useState<Record<number, ItemState>>({});
  const [error, setError] = useState<string | null>(null);
  /** Which item the material being written belongs to. */
  const [writingIndex, setWritingIndex] = useState<number | null>(null);

  const needsMaterial = items.some((item) => WRITES.has(item.step.kind));
  useEffect(() => {
    if (!needsMaterial) return;
    let cancelled = false;
    // Cards go into one of the student's decks; a folder with none gets one
    // named after the folder. Both reads are shared and cached.
    void Promise.all([getDecks(user.uid), getActiveStudyFolders(user.uid)])
      .then(([loadedDecks, loadedFolders]) => {
        if (cancelled) return;
        setDecks(loadedDecks);
        setFolders(loadedFolders);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [needsMaterial, user.uid]);

  const folderName = useCallback(
    (folderId: string) => folders.find((folder) => folder.id === folderId)?.name ?? "Revision",
    [folders]
  );
  const material = useInterventionMaterial({ uid: user.uid, decks, folderName });

  const setState = (index: number, state: ItemState) =>
    setStates((current) => ({ ...current, [index]: state }));

  /** A kept item is done with once it has been done. */
  const clearFromShelf = async (item: RevisionActionItem) => {
    if (!item.shelfId) return;
    await removeFromRevisionShelf(user.uid, item.shelfId).catch(() => undefined);
  };

  /** Keeping what Jami wrote puts it on the shelf, as made for them. */
  const keepMaterial = async (draft: Parameters<typeof material.confirm>[0]) => {
    const index = writingIndex;
    const kept = await material.confirm(draft);
    if (!kept || index === null) return;
    const item = items[index];
    setWritingIndex(null);
    setState(index, "made");
    if (!item) return;
    await Promise.all([
      addToRevisionShelf(user.uid, { ...item.step, href: kept.href }, "made").catch(() => undefined),
      clearFromShelf(item),
    ]);
    onShelfChange?.();
  };

  const doNow = (item: RevisionActionItem, index: number) => {
    setError(null);
    const { step } = item;
    if (WRITES.has(step.kind) && step.conceptId) {
      setWritingIndex(index);
      void material.start({
        id: interventionId,
        scope: { folderId: step.folderId },
        generate: {
          kind: step.kind === "flashcards" ? "create_flashcards" : "create_practice",
          conceptId: step.conceptId,
        },
      });
      return;
    }
    if (!step.href) return;
    void clearFromShelf(item);
    router.push(step.href);
  };

  const doLater = async (item: RevisionActionItem, index: number) => {
    setError(null);
    setState(index, "saving");
    try {
      await addToRevisionShelf(user.uid, item.step, "later");
      setState(index, "saved");
      onShelfChange?.();
    } catch {
      setState(index, "idle");
      setError("That couldn't be saved just now.");
    }
  };

  const remove = async (item: RevisionActionItem, index: number) => {
    setError(null);
    setState(index, "saving");
    try {
      await clearFromShelf(item);
      setState(index, "removed");
      onShelfChange?.();
    } catch {
      setState(index, "idle");
      setError("That couldn't be removed just now.");
    }
  };

  const visible = items.filter((_item, index) => states[index] !== "removed");
  if (visible.length === 0) return null;

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-text-muted">{heading}</h2>

      <ul className="grid gap-3">
        {items.map((item, index) => {
          const state = states[index] ?? "idle";
          if (state === "removed") return null;
          const { step } = item;
          const writingThis =
            WRITES.has(step.kind) && writingIndex === index && material.generatingId !== null;
          return (
            <li
              key={item.shelfId ?? `${step.kind}:${step.topicKey}`}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 sm:p-5"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-warm-border bg-warm-glow text-warm-accent">
                  <RevisionEmblem className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium leading-6 text-text-primary">
                    {REVISION_SHELF_TITLE[step.kind](step.conceptLabel)}
                  </p>
                  {step.reason ? (
                    <p className="mt-1 text-sm leading-6 text-text-secondary">{step.reason}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {state === "made" ? (
                      <p className="text-sm font-medium text-[var(--color-success-mark)]">
                        Kept. It&apos;s in Jami under Made for you.
                      </p>
                    ) : state === "saved" ? (
                      <p className="text-sm font-medium text-text-secondary">
                        Saved for later. It&apos;s waiting in Jami.
                      </p>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={material.generatingId !== null || state === "saving"}
                          onClick={() => doNow(item, index)}
                        >
                          {writingThis ? "Writing…" : NOW_LABEL[step.kind]}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={state === "saving"}
                          onClick={() => void (item.shelfId ? remove(item, index) : doLater(item, index))}
                        >
                          {state === "saving" ? "…" : item.shelfId ? "Remove" : "Do later"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {error || material.error ? (
        <p role="alert" className="text-sm text-text-secondary">
          {error ?? material.error}
        </p>
      ) : null}

      {material.confirmed ? (
        <MaterialReady
          kind={material.confirmed.kind}
          created={material.confirmed.created}
          conceptLabel={material.confirmed.conceptLabel}
          href={material.confirmed.href}
          onDismiss={material.dismissConfirmation}
        />
      ) : null}

      <InterventionDraftReview
        draft={material.draft}
        saving={material.saving}
        onCancel={() => {
          setWritingIndex(null);
          material.cancel();
        }}
        onConfirm={(draft) => keepMaterial(draft)}
      />
    </section>
  );
}
