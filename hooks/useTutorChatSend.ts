"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isExplicitTutorIllustrationRequest,
  type JamiAssistantContext,
} from "@/lib/ai/jami-assistant";
import {
  getJamiAssistantContextKey,
  getJamiAssistantSavedContext,
  type JamiAssistantThread,
} from "@/lib/ai/jami-assistant-history";
import type { TutorAgentLiveStep } from "@/lib/ai/tutor-agent";
import { selectTutorRequestAttachments } from "@/lib/ai/tutor-attachments";
import {
  TUTOR_WAITING_LABELS,
  tutorAnswerFromResponse,
  tutorRequestHistory,
} from "@/lib/ai/tutor-chat-messages";
import { reportTutorialAction } from "@/lib/onboarding/tutorial";
import type { useTutorAttachments } from "@/hooks/useTutorAttachments";
import type { TutorConversation } from "@/hooks/useTutorConversation";
import { sendJamiAssistantMessage } from "@/services/ai/jami-assistant";

type TutorChatSendInput = {
  conversation: TutorConversation;
  files: Pick<ReturnType<typeof useTutorAttachments>, "ready" | "uploading" | "take">;
  getContext: () => JamiAssistantContext | Promise<JamiAssistantContext>;
  contextKey: string;
  historyContextLabel: string;
  useRelatedSources: boolean;
  /** Empties the reply box once a question is on its way. */
  clearInput: () => void;
  /** Moves a chat just saved to the top of the saved list. */
  promoteThread: (thread: JamiAssistantThread) => void;
  requestIllustration: (input: {
    threadId: string;
    messageId: string;
    context?: JamiAssistantContext;
  }) => Promise<void>;
};

/**
 * Asking Tutor: the question goes on screen at once, the answer streams in
 * under it, and the checked reply replaces what streamed.
 *
 * One answer at a time. Leaving the chat stops the one in flight (see
 * `useTutorConversation`), and an answer that lands after that is dropped
 * rather than shown in a chat it no longer belongs to.
 */
export function useTutorChatSend({
  conversation,
  files,
  getContext,
  contextKey,
  historyContextLabel,
  useRelatedSources,
  clearInput,
  promoteThread,
  requestIllustration,
}: TutorChatSendInput) {
  const {
    messages,
    setMessages,
    loading,
    setLoading,
    setError,
    setHistoryNotice,
    activeThread,
    setActiveThread,
    beginRequest,
    isCurrentRequest,
    endRequest,
  } = conversation;

  /*
   * How far through the waiting lines the current wait is. Every wait starts
   * with a question being sent, so that is where it goes back to the first;
   * the line is only shown while waiting, so it is never seen stale.
   */
  const [waitingStage, setWaitingStage] = useState(0);
  /** What Jami is looking up or working out for the current question, as each step starts. */
  const [agentSteps, setAgentSteps] = useState<TutorAgentLiveStep[]>([]);
  const reasoningSaveRef = useRef<Promise<void>>(Promise.resolve());
  const handleReasoningSaveStarted = useCallback((save: Promise<void>) => {
    reasoningSaveRef.current = save;
  }, []);

  const sendMessage = useCallback(
    async (rawMessage: string) => {
      const typed = rawMessage.trim();
      if ((!typed && !files.ready) || files.uploading) return;
      const request = beginRequest();
      if (!request) return;

      const sentFiles = files.take();
      const message = typed || "Take a look at what I've attached.";
      const { files: requestFiles, newCount: newAttachmentCount } = selectTutorRequestAttachments({
        messages,
        sentFiles,
        message,
      });
      setMessages((current) => [
        ...current,
        {
          role: "user",
          text: message,
          ...(sentFiles.length > 0 ? { attachments: sentFiles, attachmentsUnsaved: true } : {}),
        },
      ]);
      clearInput();
      setLoading(true);
      setWaitingStage(0);
      setAgentSteps([]);
      setError(null);
      setHistoryNotice(null);

      // Tracks whether a streamed placeholder message is on screen, so it can
      // be settled on success or cleared if generation fails part-way through.
      let streaming = false;

      try {
        // A student can change this immediately before sending. Wait for that
        // small preference write so this message uses the level shown in the
        // composer rather than the previous one from their account.
        await reasoningSaveRef.current;
        const context = await getContext();
        const savedContext = getJamiAssistantSavedContext(context);
        const resolvedContextKey = getJamiAssistantContextKey(savedContext);
        if (resolvedContextKey !== contextKey) {
          throw new Error("The study context changed. Open Jami again and retry.");
        }
        // The answer streams in, so a placeholder is appended on the first
        // chunk and then updated in place. The receipt and follow-ups only
        // arrive once the whole response has been validated.
        const response = await sendJamiAssistantMessage(
          {
            message,
            history: tutorRequestHistory(messages),
            context,
            useRelatedSources,
            threadId: activeThread?.id,
            contextLabel: historyContextLabel,
            ...(requestFiles.length > 0
              ? {
                  attachments: requestFiles,
                  newAttachmentCount,
                }
              : {}),
          },
          (textSoFar) => {
            if (!isCurrentRequest(request)) return;
            setMessages((current) => {
              if (!streaming) {
                streaming = true;
                return [...current, { role: "assistant", text: textSoFar }];
              }
              const next = [...current];
              next[next.length - 1] = { ...next[next.length - 1], text: textSoFar };
              return next;
            });
          },
          request.controller.signal,
          (step) => {
            if (isCurrentRequest(request)) setAgentSteps((current) => [...current, step]);
          }
        );

        if (!isCurrentRequest(request)) return;
        const assistantMessage = tutorAnswerFromResponse(response);
        // Settle on the validated reply, replacing the streamed placeholder
        // rather than trusting the deltas that produced it. Every file sent so
        // far is now on a saved message.
        setMessages((current) =>
          (streaming ? [...current.slice(0, -1), assistantMessage] : [...current, assistantMessage]).map(
            (entry) => (entry.attachmentsUnsaved ? { ...entry, attachmentsUnsaved: false } : entry)
          )
        );
        if (context.surface === "notebook") {
          reportTutorialAction("ask-tutor", {
            notebookId: context.notebookId,
          });
        }

        const savedThread = response.savedThread;
        if (savedThread) {
          try {
            if (!isCurrentRequest(request)) return;
            const savedMessageId = savedThread.lastAssistantMessageId;
            setActiveThread(savedThread);
            promoteThread(savedThread);
            if (savedMessageId) {
              setMessages((current) => {
                const next = [...current];
                const finalIndex = next.length - 1;
                if (next[finalIndex]?.role === "assistant") {
                  next[finalIndex] = { ...next[finalIndex], id: savedMessageId };
                }
                return next;
              });
              if (response.canIllustrate && isExplicitTutorIllustrationRequest(message)) {
                void requestIllustration({
                  threadId: savedThread.id,
                  messageId: savedMessageId,
                  context,
                });
              }
            }
          } catch {
            // The answer already reached the student; only persisting it to
            // history failed. That is reported in the drawer rather than
            // thrown, so a history outage cannot discard a good reply.
            if (isCurrentRequest(request)) {
              setHistoryNotice("Jami answered, but this turn could not be added to chat history.");
            }
          }
        }
      } catch (requestError) {
        if (!isCurrentRequest(request)) return;
        // Abandoning the answer is something the student did; it is not a
        // failure to report back to them.
        if (request.controller.signal.aborted) return;
        // Drop any partially streamed answer so an incomplete reply is not
        // left sitting above the error.
        if (streaming) setMessages((current) => current.slice(0, -1));
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Jami could not answer that just now. Please try again."
        );
      } finally {
        endRequest(request);
      }
    },
    [
      activeThread,
      beginRequest,
      clearInput,
      contextKey,
      endRequest,
      files,
      getContext,
      historyContextLabel,
      isCurrentRequest,
      messages,
      promoteThread,
      requestIllustration,
      setActiveThread,
      setError,
      setHistoryNotice,
      setLoading,
      setMessages,
      useRelatedSources,
    ]
  );

  /*
   * What the chat says while the student waits for the first words. Once they
   * arrive there is a streamed assistant message on the end of the list, so
   * the waiting state has served its purpose.
   */
  const answerHasStarted = loading && messages[messages.length - 1]?.role === "assistant";
  const waiting = loading && !answerHasStarted;

  useEffect(() => {
    if (!waiting) return;
    // Escalates rather than cycling, so the wait reads as progress. Nothing
    // here claims to be nearly finished before it plausibly is.
    const timers = TUTOR_WAITING_LABELS.slice(1).map((_, index) =>
      setTimeout(() => setWaitingStage(index + 1), TUTOR_WAITING_LABELS[index + 1].after)
    );
    return () => timers.forEach(clearTimeout);
  }, [waiting]);

  return {
    sendMessage,
    handleReasoningSaveStarted,
    answerHasStarted,
    // A real step says what is happening; until there is one, the waiting lines do.
    waitingLabel: agentSteps.at(-1)?.doing ?? TUTOR_WAITING_LABELS[waitingStage].text,
    /** The steps finished so far, while the student waits; the one under way is the waiting line. */
    agentStepsDone: waiting ? agentSteps.slice(0, -1).map((step) => ({ tool: step.tool, label: step.done })) : [],
  };
}
