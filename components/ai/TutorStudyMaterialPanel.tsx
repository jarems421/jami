"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ButtonLink } from "@/components/ui";
import FlashcardDraftReview, {
  ReviewHeading,
  toFlashcardDraftState,
  type FlashcardDraftState,
} from "@/components/ai/FlashcardDraftReview";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import type {
  TutorStudyMaterialChoice,
  TutorStudyMaterialKind,
  TutorStudyMaterialResult,
} from "@/lib/ai/tutor-study-material";
import { getQuestionPracticeSessionHref } from "@/lib/app/routes";
import { practiceSetTitle } from "@/lib/practice/practice-sets";
import { requestTutorStudyMaterial } from "@/services/ai/tutor-study-material";
import { getGeneratedContentDrafts } from "@/services/study/generated-content";
import { updatePracticeSet } from "@/services/practice/practice-sets";

/**
 * One request per answer and kind, however many times the panel mounts.
 *
 * The drawer re-renders constantly while a reply streams, and development
 * mounts every effect twice; without this a single "make me flashcards" could
 * be charged and drafted twice before the first had answered.
 */
const inFlight = new Map<string, ReturnType<typeof requestTutorStudyMaterial>>();

const MAKING_LABELS: Record<TutorStudyMaterialKind, Array<{ text: string; after: number }>> = {
  flashcards: [
    { text: "Making your flashcards", after: 0 },
    { text: "Picking out what matters", after: 6_000 },
    { text: "Checking each card tests one thing", after: 14_000 },
    { text: "Nearly there", after: 24_000 },
  ],
  practice: [
    { text: "Writing your practice set", after: 0 },
    { text: "Writing the mark schemes", after: 15_000 },
    { text: "Checking every question can be answered", after: 35_000 },
    { text: "Still going — longer sets take a minute", after: 60_000 },
  ],
};

type TutorStudyMaterialPanelProps = {
  userId: string;
  kind: TutorStudyMaterialKind;
  threadId: string;
  messageId: string;
  /** What Tutor said it would make them on, while they are being made. */
  focus?: string;
  /** What the student chose on Tutor's setup card, sent with the request. */
  choice?: TutorStudyMaterialChoice;
  /** Already made, from this session or a reopened chat. */
  result?: TutorStudyMaterialResult;
  /** Read only: a saved chat from another study context. */
  readOnly?: boolean;
  /**
   * Start making at once. Only for an answer given in this sitting: a reopened
   * chat whose request never finished offers a button instead, so opening old
   * history never spends anything by itself.
   */
  autoStart?: boolean;
  getContext: () => JamiAssistantContext | Promise<JamiAssistantContext>;
  onResult: (result: TutorStudyMaterialResult) => void;
};

/**
 * Flashcards or a practice set, made from the conversation and kept or turned
 * down without leaving it.
 *
 * Material used to appear in drafts some seconds after Tutor said it had been
 * made, with nothing on screen in between; now the chat says it is being made
 * while it is, and what comes back can be accepted where it appears.
 */
export default function TutorStudyMaterialPanel({
  userId,
  kind,
  threadId,
  messageId,
  focus,
  choice,
  result,
  readOnly = false,
  autoStart = true,
  getContext,
  onResult,
}: TutorStudyMaterialPanelProps) {
  const [status, setStatus] = useState<"idle" | "making" | "ready" | "error">(
    result ? "ready" : autoStart && !readOnly ? "making" : "idle"
  );
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<FlashcardDraftState[] | null>(null);
  const [stage, setStage] = useState(0);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (result || readOnly || status !== "making") return;
    let active = true;
    const key = `${messageId}:${kind}:${attempt}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = Promise.resolve(getContext()).then((context) =>
        requestTutorStudyMaterial({ threadId, messageId, kind, context, ...(choice ? { choice } : {}) })
      );
      inFlight.set(key, pending);
    }
    pending.then(
      (made) => {
        if (!active) return;
        if (made.drafts) {
          setDrafts(made.drafts.map((draft) => ({ ...draft, status: "draft" })));
        }
        setStatus("ready");
        onResultRef.current(made.result);
      },
      (requestError: unknown) => {
        inFlight.delete(key);
        if (!active) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Jami could not make these just now."
        );
        setStatus("error");
      }
    );
    return () => {
      active = false;
    };
  }, [attempt, choice, getContext, kind, messageId, readOnly, result, status, threadId]);

  useEffect(() => {
    if (status !== "making") return;
    const timers = MAKING_LABELS[kind]
      .slice(1)
      .map((label, index) => setTimeout(() => setStage(index + 1), label.after));
    return () => timers.forEach(clearTimeout);
  }, [kind, status]);

  const retry = () => {
    setError("");
    setStage(0);
    setStatus("making");
    setAttempt((current) => current + 1);
  };

  if (status === "idle" && !result) {
    return (
      <PanelFrame>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelHeading
            title={kind === "flashcards" ? "Flashcards were not finished" : "Practice set was not finished"}
            detail={focus ? `On ${focus}.` : "Tutor agreed to make these, but they were not made."}
          />
          {!readOnly ? (
            <button
              type="button"
              className="shrink-0 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-on shadow-accent transition duration-fast hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              onClick={retry}
            >
              {kind === "flashcards" ? "Make flashcards" : "Make practice set"}
            </button>
          ) : null}
        </div>
      </PanelFrame>
    );
  }

  if (status === "making") {
    const label = MAKING_LABELS[kind][stage]?.text ?? MAKING_LABELS[kind][0]!.text;
    return (
      <PanelFrame>
        <div className="flex items-start gap-3" role="status" aria-live="polite">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-muted)] text-accent">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          </span>
          <div className="min-w-0">
            <p key={label} className="ai-waiting-label text-sm font-semibold text-text-primary">
              {label}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-text-muted">
              {focus ? <>On {focus}. </> : null}
              {kind === "flashcards"
                ? "They will appear here for you to keep."
                : "It will be saved to Practice, ready to start whenever you like."}
            </p>
          </div>
        </div>
      </PanelFrame>
    );
  }

  if (status === "error" || !result) {
    return (
      <PanelFrame tone="error">
        <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
          <p className="min-w-0 flex-1 text-xs leading-5 text-[var(--color-error-text)]">
            {error || "Jami could not make these just now."}
          </p>
          {!readOnly ? (
            <button
              type="button"
              className="shrink-0 rounded-full border border-[var(--color-border-strong)] px-3 py-1 text-xs font-semibold text-text-primary transition duration-fast hover:bg-[var(--color-glass-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              onClick={retry}
            >
              Try again
            </button>
          ) : null}
        </div>
      </PanelFrame>
    );
  }

  return result.kind === "flashcards" ? (
    <FlashcardResult
      userId={userId}
      result={result}
      drafts={drafts}
      readOnly={readOnly}
      onDraftsChange={setDrafts}
    />
  ) : (
    <PracticeResult result={result} readOnly={readOnly} />
  );
}

function PanelFrame({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div
      className={`mt-2 rounded-xl border px-3.5 py-3 ${
        tone === "error"
          ? "border-error/35 bg-error-muted"
          : "border-accent/20 bg-[var(--color-surface-panel)] shadow-e1"
      }`}
    >
      {children}
    </div>
  );
}

const PanelHeading = ReviewHeading;

function FlashcardResult({
  userId,
  result,
  drafts,
  readOnly,
  onDraftsChange,
}: {
  userId: string;
  result: Extract<TutorStudyMaterialResult, { kind: "flashcards" }>;
  drafts: FlashcardDraftState[] | null;
  readOnly: boolean;
  onDraftsChange: Dispatch<SetStateAction<FlashcardDraftState[] | null>>;
}) {
  const [error, setError] = useState("");

  // A reopened chat has only the ids; the drafts themselves say what was kept.
  useEffect(() => {
    if (drafts) return;
    let active = true;
    void getGeneratedContentDrafts(userId)
      .then((all) => {
        if (!active) return;
        const byId = new Map(all.map((draft) => [draft.id, draft]));
        onDraftsChange(
          result.draftIds.flatMap((id) => {
            const draft = byId.get(id);
            const state = draft ? toFlashcardDraftState(draft) : null;
            return state ? [state] : [];
          })
        );
      })
      .catch(() => active && setError("These flashcards could not be loaded."));
    return () => {
      active = false;
    };
  }, [drafts, onDraftsChange, result.draftIds, userId]);

  const total = drafts?.length ?? result.draftIds.length;
  return (
    <PanelFrame>
      <FlashcardDraftReview
        userId={userId}
        title={`${total} flashcard${total === 1 ? "" : "s"} on ${result.focus}`}
        drafts={drafts}
        onDraftsChange={onDraftsChange}
        folderId={result.folderId}
        deckId={result.deckId}
        suggestedDeckName={practiceSetTitle(result.focus)}
        readOnly={readOnly}
      />
      {error ? (
        <p className="mt-2 text-xs leading-5 text-[var(--color-error-text)]" role="alert">
          {error}
        </p>
      ) : null}
    </PanelFrame>
  );
}


function PracticeResult({
  result,
  readOnly,
}: {
  result: Extract<TutorStudyMaterialResult, { kind: "practice" }>;
  readOnly: boolean;
}) {
  const [state, setState] = useState<"new" | "kept" | "dismissed">("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const href = getQuestionPracticeSessionHref(result.sessionId);

  const act = async (action: "accept" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await updatePracticeSet(result.sessionId, action);
      setState(action === "accept" ? "kept" : "dismissed");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That could not be saved just now.");
    } finally {
      setBusy(false);
    }
  };

  const summary = `${result.questionCount} question${result.questionCount === 1 ? "" : "s"} · ${result.totalMarks} mark${result.totalMarks === 1 ? "" : "s"} · marked by Jami`;

  return (
    <PanelFrame>
      <PanelHeading
        title={state === "dismissed" ? "Practice set dismissed" : `Practice set: ${result.title}`}
        detail={
          state === "dismissed"
            ? "It will not appear in Practice."
            : state === "kept"
              ? `${summary}. Saved in Practice under Ready to practice.`
              : summary
        }
      />
      {state !== "dismissed" && !readOnly ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--color-border)] pt-3">
          {state === "new" ? (
            <>
              <button
                type="button"
                disabled={busy}
                className="rounded-full px-3 py-1.5 text-xs font-medium text-text-muted transition duration-fast hover:bg-[var(--color-glass-subtle)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                onClick={() => void act("dismiss")}
              >
                Dismiss
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-full border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-text-primary transition duration-fast hover:bg-[var(--color-glass-subtle)] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                onClick={() => void act("accept")}
              >
                Save for later
              </button>
            </>
          ) : null}
          <ButtonLink
            href={href}
            size="sm"
            className="!min-h-0 !rounded-full !px-3.5 !py-1.5 !text-xs !font-semibold"
            onClick={() => {
              // Starting is keeping; the set leaves Ready once an answer is marked.
              if (state === "new") void updatePracticeSet(result.sessionId, "accept").catch(() => undefined);
            }}
          >
            Start now
          </ButtonLink>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs leading-5 text-[var(--color-error-text)]" role="alert">
          {error}
        </p>
      ) : null}
    </PanelFrame>
  );
}
