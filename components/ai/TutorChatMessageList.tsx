"use client";

import type { AssistantIllustration } from "@/lib/ai/jami-assistant";
import type { TutorAgentStepView } from "@/lib/ai/tutor-agent";
import type { TutorAttachment } from "@/lib/ai/tutor-attachments";
import type { TutorChatMessage } from "@/lib/ai/tutor-chat-messages";
import { StudyText } from "@/components/ui";
import { AddToPageIcon } from "@/components/ai/AddAnswerToPageButton";
import AssistantAnswerBody from "@/components/ai/AssistantAnswerBody";
import AssistantAnswerHold, {
  type AssistantAnswerHoldAction,
} from "@/components/ai/AssistantAnswerHold";
import {
  AssistantGraphActionsContext,
  type AssistantGraphActions,
} from "@/components/ai/AssistantGraphActions";
import AssistantIllustrationCard from "@/components/ai/AssistantIllustrationCard";
import { PinIcon } from "@/components/ai/JamiFloatingTutor";
import { TutorMessageAttachments, TutorSourceSaveCard } from "@/components/ai/TutorAttachments";
import TutorAnswerActions, { type TutorAnswerActionTools } from "@/components/ai/TutorAnswerActions";
import { TutorAgentStepsDone, TutorAgentStepsSummary } from "@/components/ai/TutorAgentSteps";

/** Pictures Tutor made for an answer, and adding one to the open page. */
type TutorIllustrationTools = {
  canInsert: boolean;
  isInserted: (id: string) => boolean;
  insertingId: string | null;
  onInsert: (message: TutorChatMessage, illustration: AssistantIllustration) => void;
};

type TutorChatMessageListProps = {
  messages: readonly TutorChatMessage[];
  loading: boolean;
  /** The answer's first words are on screen, so the waiting line goes. */
  answerHasStarted: boolean;
  waitingLabel: string;
  /** What Jami has looked up for the question so far, shown above the waiting line. */
  agentStepsDone?: readonly TutorAgentStepView[];
  files: {
    sentPreviewUrl: (storagePath: string) => string | undefined;
    sentFile: (storagePath: string) => File | undefined;
  };
  onKeepAttachmentBeside?: (attachment: TutorAttachment) => void;
  /** Where a file Tutor suggests keeping as a source is saved unless the student picks another. */
  defaultFolderId?: string;
  graphActions: AssistantGraphActions;
  illustrations: TutorIllustrationTools;
  tools: TutorAnswerActionTools;
};

/** The conversation: each question, each answer with what it offers, and the wait for the next. */
export default function TutorChatMessageList({
  messages,
  loading,
  answerHasStarted,
  waitingLabel,
  agentStepsDone = [],
  ...itemProps
}: TutorChatMessageListProps) {
  return (
    // Selectable even over a notebook, which otherwise cancels native
    // selection, so an answer can be copied into a text box on the page.
    <div className="space-y-4" aria-live="polite" data-notebook-selectable-text="true">
      {messages.map((message, index) => {
        const last = index === messages.length - 1;
        return (
          <TutorChatMessageItem
            key={`${message.role}-${index}`}
            message={message}
            answerKey={message.id ?? `index-${index}`}
            writing={loading && last}
            last={last && !loading}
            showPracticeOffer={
              Boolean(message.practiceOffer) &&
              messages.findIndex(
                (candidate) => candidate.practiceOffer?.actionId === message.practiceOffer?.actionId
              ) === index
            }
            {...itemProps}
          />
        );
      })}
      {/*
        Only shown until the first words arrive. These models think
        before they write, so there is a silent gap that streaming
        cannot fill, and once text is streaming the dots would be
        competing with it.
      */}
      {loading && !answerHasStarted ? <TutorWaitingLine label={waitingLabel} done={agentStepsDone} /> : null}
    </div>
  );
}

function TutorChatMessageItem({
  message,
  answerKey,
  writing,
  last,
  showPracticeOffer,
  files,
  onKeepAttachmentBeside,
  defaultFolderId,
  graphActions,
  illustrations,
  tools,
}: Omit<TutorChatMessageListProps, "messages" | "loading" | "answerHasStarted" | "waitingLabel" | "agentStepsDone"> & {
  message: TutorChatMessage;
  answerKey: string;
  writing: boolean;
  last: boolean;
  showPracticeOffer: boolean;
}) {
  return (
    <div className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[90%]">
        {message.role === "user" && message.attachments?.length ? (
          <TutorMessageAttachments
            attachments={message.attachments}
            previewUrlFor={files.sentPreviewUrl}
            onKeepBeside={onKeepAttachmentBeside}
          />
        ) : null}
        {message.role === "assistant" && message.agentSteps?.length ? (
          <TutorAgentStepsSummary steps={message.agentSteps} />
        ) : null}
        {message.role === "assistant" ? (
          <AssistantAnswerHold
            enabled={!writing}
            actions={answerHoldActions(message, answerKey, tools)}
            className="rounded-xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3 text-sm leading-relaxed text-text-primary"
          >
            <AssistantGraphActionsContext.Provider value={graphActions}>
              <AssistantAnswerBody
                text={message.text}
                illustrations={message.illustrations ?? []}
                renderIllustration={(illustration) => (
                  <AssistantIllustrationCard
                    key={illustration.id}
                    illustration={illustration}
                    canInsert={illustrations.canInsert}
                    inserted={illustrations.isInserted(illustration.id)}
                    inserting={illustrations.insertingId === illustration.id}
                    onInsert={() => illustrations.onInsert(message, illustration)}
                  />
                )}
              />
            </AssistantGraphActionsContext.Provider>
          </AssistantAnswerHold>
        ) : (
          <div className="rounded-xl rounded-br-md bg-accent px-4 py-3 text-sm leading-relaxed text-accent-on">
            <StudyText text={message.text} className="select-text whitespace-pre-wrap" />
          </div>
        )}
        {message.role === "assistant" && message.sourceSaveOffer && !tools.viewingForeignThread ? (
          <TutorSourceSaveCard
            userId={tools.userId}
            offer={message.sourceSaveOffer}
            fileFor={files.sentFile}
            defaultFolderId={defaultFolderId}
          />
        ) : null}
        {message.role === "assistant" ? (
          <TutorAnswerActions
            message={message}
            answerKey={answerKey}
            writing={writing}
            last={last}
            showPracticeOffer={showPracticeOffer}
            tools={tools}
          />
        ) : null}
      </div>
    </div>
  );
}

/** What pressing and holding an answer offers: the buttons under it, larger. */
function answerHoldActions(message: TutorChatMessage, key: string, tools: TutorAnswerActionTools) {
  const actions: AssistantAnswerHoldAction[] = [];
  if (tools.canInsertAnswer) {
    actions.push({
      id: "add-to-page",
      label: "Add to page",
      icon: <AddToPageIcon />,
      onSelect: () => tools.onAddAnswer(message, key),
    });
  }
  if (tools.floating) {
    actions.push({
      id: "pin",
      label: "Keep beside page",
      icon: <PinIcon className="h-4 w-4" />,
      onSelect: () => tools.onPin(message.text),
    });
  }
  return actions;
}

function TutorWaitingLine({ label, done }: { label: string; done: readonly TutorAgentStepView[] }) {
  return (
    <div className="flex justify-start">
      <div className="app-chip rounded-xl rounded-bl-md px-4 py-3 text-sm text-text-muted" role="status">
        <TutorAgentStepsDone steps={done} />
        <span className="inline-flex items-center gap-2">
          <span key={label} className="ai-waiting-label inline-block">
            {label}
          </span>
          <span className="ai-thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </span>
      </div>
    </div>
  );
}
