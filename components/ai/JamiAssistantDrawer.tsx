"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import { featureFlags } from "@/lib/app/feature-flags";
import type { TutorAttachment } from "@/lib/ai/tutor-attachments";
import {
  describeThreadPlace,
  type JamiAssistantQuickAction,
} from "@/lib/ai/tutor-chat-messages";
import type { NotebookImageRef } from "@/lib/workspace/notebooks";
import type { NotebookGraphDraft } from "@/lib/workspace/notebook-graphs";
import { useAiPrivacyNotice } from "@/hooks/useAiPrivacyNotice";
import { useTutorAnswerMaterial } from "@/hooks/useTutorAnswerMaterial";
import { useTutorAnswerVisuals } from "@/hooks/useTutorAnswerVisuals";
import { useTutorAttachments } from "@/hooks/useTutorAttachments";
import { useTutorChatHistory } from "@/hooks/useTutorChatHistory";
import { useTutorChatSend } from "@/hooks/useTutorChatSend";
import { useTutorConversation } from "@/hooks/useTutorConversation";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import type { DialogPanel } from "@/components/ui";
import AssistantAnswerBody from "@/components/ai/AssistantAnswerBody";
import type { AssistantGraphActions } from "@/components/ai/AssistantGraphActions";
import { drawnFigureToPng } from "@/components/ai/drawn-figure-image";
import JamiAssistantHistory from "@/components/ai/JamiAssistantHistory";
import {
  FloatingTutorPill,
  FloatingTutorPinnedAnswer,
  FloatingTutorResizeFrame,
  floatingRectStyle,
  floatingTutorPanelClass,
  isCompactFloatingCard,
  MAX_PINNED_ANSWERS,
  onScreenFloatingRects,
  useFloatingTutorFrames,
} from "@/components/ai/JamiFloatingTutor";
import FloatingTutorHeader from "@/components/ai/JamiFloatingTutorHeader";
import type { TutorAnswerActionTools } from "@/components/ai/TutorAnswerActions";
import TutorAiPrivacyNotice from "@/components/ai/TutorAiPrivacyNotice";
import TutorChatEmptyState from "@/components/ai/TutorChatEmptyState";
import TutorChatHeader from "@/components/ai/TutorChatHeader";
import TutorChatMessageList from "@/components/ai/TutorChatMessageList";
import TutorChatShell from "@/components/ai/TutorChatShell";
import TutorComposer from "@/components/ai/TutorComposer";
import TutorSettingsPanel from "@/components/ai/TutorSettingsPanel";

export type { JamiAssistantQuickAction };

type JamiAssistantDrawerProps = {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resetKey: string;
  contextKey: string;
  contextLabel: string;
  historyContextLabel: string;
  getContext: () => JamiAssistantContext | Promise<JamiAssistantContext>;
  quickActions?: readonly JamiAssistantQuickAction[];
  /**
   * Short note shown above the starting points, for surfaces where Jami works
   * differently from what a student would assume. Only rendered before the
   * conversation begins.
   */
  emptyStateNote?: ReactNode;
  onIllustrationInserted?: (input: {
    imageRef: NotebookImageRef;
    contentRevision: number;
  }) => void;
  onBeforeIllustrationInsert?: () => boolean | Promise<boolean>;
  /**
   * Adds a graph from an answer to the open notebook page. Resolves true once
   * it is on the page; the notebook reports its own failures.
   */
  onGraphInsert?: (graph: NotebookGraphDraft) => Promise<boolean>;
  /**
   * Adds a drawn figure from an answer to the open notebook page, as an image.
   * Resolves true once it is on the page; the notebook reports its own failures.
   */
  onDrawingInsert?: (file: File) => Promise<boolean>;
  /**
   * Adds a whole answer to the open notebook page, shown there exactly as it
   * is here: tables, headings and typeset maths. True once it is on the page;
   * the notebook reports its own failures.
   */
  onAnswerInsert?: (text: string) => boolean;
  /** Keeps a PDF or picture sent in this chat open beside the notebook page. */
  onKeepAttachmentBeside?: (attachment: TutorAttachment) => void;
  /**
   * Adds blank pages to the end of the open notebook when Tutor is asked to,
   * and resolves to how many it added. Only a notebook supplies it, so only
   * there can Tutor add pages.
   */
  onAddNotebookPages?: (count: number) => Promise<number>;
  /**
   * The folders this conversation's material belongs to, when the surface
   * knows.
   *
   * Only used to tell the settings panel which folder's instructions are in
   * force. Left undefined by a surface that cannot say, and the panel then
   * explains the rule rather than asserting an answer it does not have.
   */
  settingsFolderIds?: readonly string[];
  /**
   * Controls for what this conversation reads, drawn under the header -- the
   * material picker, on surfaces that let a student choose several sources.
   * Told whether the conversation has begun, because changing the material
   * after that starts a new chat and the control should say so.
   */
  contextControls?: (state: { conversationStarted: boolean }) => ReactNode;
  /**
   * A message to send as soon as the drawer first opens: what the student
   * already typed somewhere else, such as the Tutor page's ask box. Sent once
   * per mount, so a surface that wants to send another remounts the drawer.
   */
  initialMessage?: string;
  /** Open on the list of saved chats, for a surface whose way in is "pick a chat". */
  startInHistory?: boolean;
  /**
   * How Jami sits over the work.
   *
   * `sidebar` is a full-height panel down the right. `floating` is a card the
   * student moves and resizes over a surface they are writing on, which can
   * also shrink to a pill or leave one answer pinned beside the page. Phones
   * get the full-screen sheet either way: there is no room to float.
   *
   * `page` is the whole screen at every size.
   *
   * `inline` is a card in the page itself, for a page whose point is the chat
   * -- the Tutor page. The question is typed into the page and the
   * conversation carries on in the same place, instead of the page handing
   * off to a panel or a full-screen chat the moment you send.
   */
  layout?: "sidebar" | "floating" | "page" | "inline";
};

/**
 * Jami's chat, wherever a surface offers it.
 *
 * This is the composition root: the conversation, sending, saved chats and the
 * work under each answer are hooks, and the header, messages and composer are
 * their own components. What stays here is how they fit together, and the
 * frame the chat sits in -- a dialog, a floating card with answers pinned
 * beside the page, or a card in the page.
 */
export default function JamiAssistantDrawer({
  userId,
  open,
  onOpenChange,
  resetKey,
  contextKey,
  contextLabel,
  historyContextLabel,
  getContext,
  quickActions = [],
  emptyStateNote,
  onIllustrationInserted,
  onBeforeIllustrationInsert,
  onGraphInsert,
  onDrawingInsert,
  onAnswerInsert,
  onKeepAttachmentBeside,
  onAddNotebookPages,
  settingsFolderIds,
  contextControls,
  initialMessage,
  startInHistory = false,
  layout = "sidebar",
}: JamiAssistantDrawerProps) {
  const conversation = useTutorConversation({ startInHistory });
  const {
    messages,
    loading,
    error,
    setError,
    historyNotice,
    setHistoryNotice,
    historyOpen,
    setHistoryOpen,
    threadLoading,
    activeThread,
    abandonActiveRequest,
    clearConversation,
  } = conversation;
  const [input, setInput] = useState("");
  const files = useTutorAttachments(userId);
  const clearFiles = files.clear;
  const [useRelatedSources, setUseRelatedSources] = useState(true);
  const visuals = useTutorAnswerVisuals({
    conversation,
    getContext,
    contextKey,
    onIllustrationInserted,
    onBeforeIllustrationInsert,
    onGraphInsert,
    onDrawingInsert,
    onAnswerInsert,
  });
  const { forgetInsertedVisuals, forgetVisualsInFlight } = visuals;
  const material = useTutorAnswerMaterial({ conversation, getContext, contextKey });
  const { forgetMaterial } = material;
  /*
   * Wide screens have room for the drawer to sit beside the work rather than
   * over it. Jami is meant to nudge you towards an answer you are looking at,
   * which does not work if opening it hides the card. Below this the page is
   * too narrow to show both, so it stays a modal sheet.
   *
   * A floating card is small enough to share a tablet in portrait too, so it
   * stops being modal from there; only a phone still gets the sheet.
  */
  const [sidePanel, setSidePanel] = useState(false);
  const floating = layout === "floating" && sidePanel;
  const fullPage = layout === "page";
  const inline = layout === "inline";
  // Shrunk to a pill rather than closed, so the pill stays to bring it back.
  const [minimised, setMinimised] = useState(false);
  /*
   * The answer pinned beside the page, if any.
   *
   * Its own thing, not a state of the card. Pinning used to put the card away
   * and leave only the answer, so asking the next question meant opening the
   * chat on top of the answer it was about. The pin now stays whether the card
   * is open, shrunk or closed, until it is unpinned.
   */
  // Up to three, oldest first; each sits in its own frame slot.
  const [pinnedAnswers, setPinnedAnswers] = useState<{ slot: number; text: string }[]>([]);
  const pinned = pinnedAnswers.length > 0;
  const occupiedSlots = Array.from({ length: MAX_PINNED_ANSWERS }, (_, slot) =>
    pinnedAnswers.some((answer) => answer.slot === slot)
  );
  const { card, pins } = useFloatingTutorFrames(floating, occupiedSlots);
  const compact = floating && isCompactFloatingCard(card.rect);
  const minimise = () => {
    setMinimised(true);
    onOpenChange(false);
  };
  const pinAnswer = (text: string) => {
    if (pinnedAnswers.some((answer) => answer.text === text)) return;
    // With every slot taken, the oldest pin makes way for the new one.
    const kept =
      pinnedAnswers.length >= MAX_PINNED_ANSWERS ? pinnedAnswers.slice(1) : pinnedAnswers;
    const slot = occupiedSlots.findIndex((taken) => !taken);
    const nextSlot = slot === -1 ? pinnedAnswers[0].slot : slot;
    setPinnedAnswers([...kept, { slot: nextSlot, text }]);
    // Placed clear of the card, of every pin still on screen and of any sheet beside the page, never over one.
    const obstacles = [
      ...(open && card.rect ? [card.rect] : []),
      ...kept.flatMap((answer) => {
        const rect = pins[answer.slot].rect;
        return rect ? [rect] : [];
      }),
      ...onScreenFloatingRects("sheet"),
    ];
    if (obstacles.length > 0) pins[nextSlot].moveClearOf(obstacles);
  };
  const unpinAnswer = (slot: number) => {
    const remaining = pinnedAnswers.filter((answer) => answer.slot !== slot);
    setPinnedAnswers(remaining);
    // With the card put away, unpinning the last pin leaves the pill to bring it back.
    if (!open && remaining.length === 0) setMinimised(true);
  };
  /**
   * Settings, shown over the conversation rather than beside it.
   *
   * The drawer is already the narrowest surface in the app, so a second column
   * is not available; and settings are read and changed deliberately, not
   * glanced at mid-question. It carries its own header with a way back, so the
   * conversation is one tap away and still there when you return.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * What the chat last rendered for, so state that follows a prop is adjusted
   * while rendering rather than an effect later. Opening the card, from
   * anywhere, replaces the pill it left behind; a new surface starts with an
   * empty box and nothing pinned.
   */
  const [renderedFor, setRenderedFor] = useState({ open, resetKey });
  if (renderedFor.open !== open || renderedFor.resetKey !== resetKey) {
    setRenderedFor({ open, resetKey });
    if (open && !renderedFor.open) setMinimised(false);
    if (resetKey !== renderedFor.resetKey) {
      setInput("");
      setMinimised(false);
      setPinnedAnswers([]);
    }
  }
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousResetKeyRef = useRef(resetKey);
  const { showAiNotice, dismissAiNotice } = useAiPrivacyNotice(open);

  /*
   * A new surface: stop the answer, forget the chat, and close. The box and
   * the pins were already cleared while rendering, above; the conversation is
   * cleared here, together with stopping its answer, so nothing still
   * streaming can land in the cleared chat.
   */
  useEffect(() => {
    if (previousResetKeyRef.current === resetKey) return;
    previousResetKeyRef.current = resetKey;
    clearConversation();
    forgetInsertedVisuals();
    forgetMaterial();
    forgetVisualsInFlight();
    clearFiles();
    onOpenChange(false);
  }, [
    clearConversation,
    clearFiles,
    forgetInsertedVisuals,
    forgetMaterial,
    forgetVisualsInFlight,
    onOpenChange,
    resetKey,
  ]);

  useEffect(() => {
    const query = window.matchMedia(
      layout === "floating" ? "(min-width: 640px)" : "(min-width: 1024px)"
    );
    const sync = () => setSidePanel(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [layout]);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [abandonActiveRequest, historyOpen, loading, messages, open, threadLoading]);

  const startNewChat = useCallback(() => {
    clearConversation();
    setInput("");
    forgetInsertedVisuals();
    forgetMaterial();
    clearFiles();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [clearConversation, clearFiles, forgetInsertedVisuals, forgetMaterial]);

  const history = useTutorChatHistory({
    conversation,
    open,
    contextKey,
    onActiveThreadRemoved: startNewChat,
  });
  const { viewingForeignThread, openThread } = history;

  const clearInput = useCallback(() => setInput(""), []);
  const { sendMessage, handleReasoningSaveStarted, answerHasStarted, waitingLabel, agentStepsDone } =
    useTutorChatSend({
      conversation,
      files,
      getContext,
      contextKey,
      historyContextLabel,
      useRelatedSources,
      clearInput,
      promoteThread: history.promoteThread,
      requestIllustration: visuals.requestIllustration,
    });

  // Graphs, figures, pictures and whole answers go only onto this notebook's page.
  const onThisNotebook = contextKey.startsWith("notebook:") && !viewingForeignThread;
  const graphActions: AssistantGraphActions = {
    canInsert: Boolean(onGraphInsert) && onThisNotebook,
    insertingKey: visuals.insertingGraphKey,
    isInserted: visuals.isGraphInserted,
    insert: visuals.insertGraph,
    canInsertDrawing: Boolean(onDrawingInsert) && onThisNotebook,
    insertDrawing: (key, svg) => visuals.insertDrawing(key, () => drawnFigureToPng(svg)),
  };

  const answerTools: TutorAnswerActionTools = {
    userId,
    activeThread,
    viewingForeignThread,
    floating,
    canInsertAnswer: Boolean(onAnswerInsert) && onThisNotebook,
    addedAnswerKey: visuals.addedAnswerKey,
    onAddAnswer: visuals.addAnswerToPage,
    onPin: pinAnswer,
    generatingIllustrationId: visuals.generatingIllustrationId,
    onRequestIllustration: (input) => void visuals.requestIllustration(input),
    material,
    onAddNotebookPages: contextKey.startsWith("notebook:") ? onAddNotebookPages : undefined,
    onFollowUp: (prompt) => void sendMessage(prompt),
  };

  /*
   * What the student already asked somewhere else, sent once the drawer is
   * open to hold the answer. After the render, not during it: sending starts
   * a request and sets state, which a render must not do.
   */
  const sentInitialRef = useRef(false);
  // Inline there is no dialog to move focus, so the reply box takes it when
  // the chat opens, ready for the next question, without scrolling the page.
  useEffect(() => {
    if (inline && open) inputRef.current?.focus({ preventScroll: true });
  }, [inline, open]);
  useEffect(() => {
    if (!open || !initialMessage || sentInitialRef.current) return;
    sentInitialRef.current = true;
    void Promise.resolve().then(() => sendMessage(initialMessage));
  }, [initialMessage, open, sendMessage]);

  const dictation = useVoiceDictation({ onText: setInput, onError: setError });

  /**
   * Sends what is in the box, whether it was typed or spoken.
   *
   * Dictation is stopped first and its own reading of the box is used, because
   * words the recogniser settles in the same tick as the send would otherwise
   * be lost: `input` is a render behind at that moment.
   */
  const submitComposer = useCallback(() => {
    const text = dictation.listening ? dictation.stop() : input;
    void sendMessage(text);
  }, [dictation, input, sendMessage]);

  const toggleDictation = useCallback(() => {
    if (dictation.listening) {
      dictation.stop();
      inputRef.current?.focus();
      return;
    }
    setError(null);
    dictation.start(input);
  }, [dictation, input, setError]);

  const subtitle = historyOpen
    ? "Chat history"
    : viewingForeignThread
      ? "Carrying on a saved chat"
      : contextLabel;
  const openSettings = featureFlags.enableTutorPersonalisation
    ? () => setSettingsOpen(true)
    : undefined;

  return (
    <>
    <TutorChatShell
      inline={inline}
      open={open && (!floating || card.rect !== null)}
      dialogProps={{
        modal: fullPage || !sidePanel,
        initialFocusRef: inputRef,
        className: `fixed inset-0 flex ${fullPage ? "justify-center" : "justify-end"} ${
          sidePanel && !fullPage ? "pointer-events-none" : ""
        }`,
        onDismiss: () => onOpenChange(false),
      }}
      backdropClassName={
        fullPage ? "absolute inset-0 bg-[var(--color-surface-base)]" : "absolute inset-0 bg-black/55 backdrop-blur-[1px]"
      }
      panelProps={{
        "data-notebook-text-editor": "true",
        ...(floating ? { "data-floating-panel": "tutor" } : {}),
        className: floating
          ? floatingTutorPanelClass(card)
          : fullPage
            ? "pointer-events-auto relative flex h-[100dvh] max-h-[100dvh] w-full max-w-4xl flex-col overflow-hidden bg-[var(--color-surface-panel-strong)] md:border-x md:border-[var(--color-border)]"
            : "pointer-events-auto relative flex h-[100dvh] max-h-[100dvh] w-full max-w-[32rem] flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] shadow-shell",
        /*
          The panel colour is a few percent translucent, which reads as depth
          over the scrim but lets the card show through once the scrim is gone.
          As a side panel it sits on an opaque base so the same colour stays,
          and the work behind it does not bleed into the conversation.
        */
        style:
          sidePanel || fullPage
            ? {
                ...(floating && card.rect ? floatingRectStyle(card.rect) : null),
                backgroundColor: "var(--color-surface-base)",
                backgroundImage:
                  "linear-gradient(var(--color-surface-panel-strong), var(--color-surface-panel-strong))",
              }
            : undefined,
        ...(floating ? card.bodyDragProps : {}),
      } as ComponentProps<typeof DialogPanel>}
      afterPanel={floating ? <FloatingTutorResizeFrame frame={card} /> : null}
    >
        {floating ? (
          <FloatingTutorHeader
            frame={card}
            subtitle={subtitle}
            compact={compact}
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((current) => !current)}
            onNewChat={startNewChat}
            onOpenSettings={openSettings}
            folderSources={{
              on: useRelatedSources,
              onToggle: () => setUseRelatedSources((current) => !current),
            }}
            onMinimise={minimise}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <TutorChatHeader
            inline={inline}
            subtitle={subtitle}
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((current) => !current)}
            onNewChat={startNewChat}
            onOpenSettings={openSettings}
            onClose={() => onOpenChange(false)}
          />
        )}

        {contextControls && !historyOpen && !viewingForeignThread ? (
          <div className={`border-b border-[var(--color-border)] ${compact ? "px-4 py-2.5" : "px-5 py-3 sm:px-7"}`}>
            {contextControls({ conversationStarted: messages.length > 0 })}
          </div>
        ) : null}

        <div
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-y-auto ${compact ? "px-4 py-4" : "px-5 py-5 sm:px-7 sm:py-6"}`}
        >
          {historyOpen ? (
            <JamiAssistantHistory
              threads={history.threads}
              loading={history.loading}
              error={history.error}
              onOpen={(thread) => void openThread(thread)}
              onNew={startNewChat}
              onRename={history.renameThread}
              onDelete={history.removeThread}
            />
          ) : threadLoading ? (
            <div className="flex min-h-full items-center justify-center gap-2 text-sm text-text-muted" role="status">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
              Opening chat
            </div>
          ) : messages.length === 0 ? (
            <TutorChatEmptyState
              note={emptyStateNote}
              latestThread={history.latestCurrentThread}
              quickActions={quickActions}
              disabled={loading}
              onContinue={(thread) => void openThread(thread)}
              onSend={(prompt) => void sendMessage(prompt)}
            />
          ) : (
            <TutorChatMessageList
              messages={messages}
              loading={loading}
              answerHasStarted={answerHasStarted}
              waitingLabel={waitingLabel}
              agentStepsDone={agentStepsDone}
              files={files}
              onKeepAttachmentBeside={onKeepAttachmentBeside}
              defaultFolderId={settingsFolderIds?.[0]}
              graphActions={graphActions}
              illustrations={{
                canInsert: Boolean(onIllustrationInserted) && onThisNotebook,
                isInserted: visuals.isIllustrationInserted,
                insertingId: visuals.insertingIllustrationId,
                onInsert: (message, illustration) =>
                  void visuals.addIllustrationToPage(message, illustration),
              }}
              tools={answerTools}
            />
          )}
        </div>

        {showAiNotice && !historyOpen ? (
          <TutorAiPrivacyNotice floating={floating} onDismiss={dismissAiNotice} />
        ) : null}

        <footer
          className={`shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] ${
            compact
              ? "px-3 pb-3 pt-3"
              : "px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-7 sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          }`}
        >
          {historyOpen ? (
            <div className="text-center text-2xs text-text-muted">
              Saved chats keep their messages and the files you attached, not notebook snapshots.
            </div>
          ) : (
            <TutorComposer
              userId={userId}
              compact={compact}
              loading={loading}
              foreignThreadPlace={
                viewingForeignThread
                  ? activeThread
                    ? describeThreadPlace(activeThread)
                    : "somewhere else"
                  : null
              }
              historyContextLabel={historyContextLabel}
              error={error}
              onDismissError={() => setError(null)}
              historyNotice={historyNotice}
              onDismissHistoryNotice={() => setHistoryNotice(null)}
              files={files}
              input={input}
              onInputChange={setInput}
              inputRef={inputRef}
              onSubmit={submitComposer}
              dictation={dictation}
              onToggleDictation={toggleDictation}
              onReasoningSaveStarted={handleReasoningSaveStarted}
              onError={setError}
              useRelatedSources={useRelatedSources}
              onToggleRelatedSources={() => setUseRelatedSources((current) => !current)}
            />
          )}
        </footer>

        {settingsOpen ? (
          <div className="absolute inset-0 z-10 flex flex-col bg-[var(--color-surface-panel-strong)]">
            <TutorSettingsPanel
              activeFolderIds={settingsFolderIds}
              onBack={() => setSettingsOpen(false)}
            />
          </div>
        ) : null}
    </TutorChatShell>
    {/* A pinned answer already says where Jami is, and opens it; the pill would repeat it. */}
    {floating && !open && minimised && !pinned ? (
      <FloatingTutorPill onOpen={() => onOpenChange(true)} />
    ) : null}
    {floating
      ? pinnedAnswers.map((answer, index) => (
          <FloatingTutorPinnedAnswer
            key={answer.slot}
            frame={pins[answer.slot]}
            // One way back to the chat is enough: only the newest pin carries it.
            onOpenChat={
              open || index !== pinnedAnswers.length - 1 ? undefined : () => onOpenChange(true)
            }
            onUnpin={() => unpinAnswer(answer.slot)}
          >
            <AssistantAnswerBody text={answer.text} illustrations={[]} renderIllustration={() => null} />
          </FloatingTutorPinnedAnswer>
        ))
      : null}
    </>
  );
}
