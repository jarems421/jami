import type {
  JamiAssistantRequest,
  JamiAssistantResponse,
  JamiAssistantSourceFailure,
} from "@/lib/ai/jami-assistant";
import {
  normalizeAssistantCitations,
  normalizeFollowUps,
  normalizeUsedContext,
} from "@/lib/ai/jami-assistant-normalize";
import { auth } from "@/services/firebase/client";
import { notifyAllowanceSpent } from "@/services/billing/plan-summary-store";
import { mapJamiAssistantThread } from "@/lib/ai/jami-assistant-history";
import {
  jamiDestinations,
  normalizeJamiAppScope,
  normalizeTutorAppActions,
} from "@/lib/ai/jami-app-guide";
import {
  normalizeTutorStudyMaterialOffers,
  normalizeTutorStudyMaterialRequest,
  normalizeTutorStudyMaterialSetup,
} from "@/lib/ai/tutor-study-material";
import { normalizeSuggestedCards } from "@/lib/ai/tutor-card-suggestions";
import { normalizeTutorPracticeOffer } from "@/lib/ai/tutor-practice-offer";
import { reportAllowanceRefusal } from "@/services/billing/allowance-events";
import {
  normalizeTutorAttachments,
  type TutorSourceSaveOffer,
} from "@/lib/ai/tutor-attachments";
import {
  normalizeTutorAgentLiveStep,
  normalizeTutorAgentSteps,
  type TutorAgentLiveStep,
  type TutorAgentStepView,
} from "@/lib/ai/tutor-agent";

function getFriendlyAssistantError(
  status: number,
  message?: string,
  code?: string
) {
  if (status === 401) return "Sign in again to ask Jami.";
  if (status === 404) return message || "Jami could not find the current study item.";
  if (status === 413) return message || "That context is too large for Jami to read at once.";
  if (status === 429) {
    // This month's plan allowance: the server's message says what ran out and
    // when it resets.
    if (code === "allowance_used" && message) return message;
    return code === "burst_limit"
      ? message || "Jami is receiving requests too quickly. Try again in a moment."
      : "Jami has reached today's AI limit. Try again tomorrow.";
  }
  if (status === 503) {
    if (code === "budget_unavailable") {
      return message || "AI usage limits are temporarily unavailable. Try again shortly.";
    }
    /*
     * Only `not_configured` means not configured.
     *
     * This read "anything that is not a budget problem", so every other 503 --
     * a provider outage, a workflow that would not start, a queue that was
     * full -- told the student the app was unfinished, and a genuinely
     * transient failure looked permanent enough to stop trying. The one case
     * that really is a deployment fault now says so on its own code, and
     * everything else says what it is: temporary.
     */
    if (code === "not_configured") {
      return "Jami's AI is not switched on for this app yet.";
    }
    return message || "Jami is unavailable for a moment. Try again shortly.";
  }
  if (status >= 500) return message || "Jami could not answer just now. Try again in a moment.";
  return message || "Jami could not answer that just now.";
}

function normalizeSourceFailures(value: unknown): JamiAssistantSourceFailure[] {
  if (!Array.isArray(value)) return [];
  const normalized: JamiAssistantSourceFailure[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim().slice(0, 160) : "";
    const title =
      typeof item.title === "string" ? item.title.trim().slice(0, 160) : "";
    const reason =
      typeof item.reason === "string" ? item.reason.trim().slice(0, 500) : "";
    if (id && title && reason) normalized.push({ id, title, reason });
  }
  return normalized;
}

/** Reads what is left of a stream whose answer has already been settled, and drops it. */
async function drainAssistantStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    // The answer is already shown; a stream that fails after it changes nothing.
  }
}

/**
 * Reads the newline-delimited stream the assistant route returns.
 *
 * Text events carry the answer as it is generated and are forwarded to
 * onChunk; the single terminal event carries the validated receipt, or an
 * error raised after the response had already started.
 */
async function readAssistantStream(
  response: Response,
  onChunk?: (textSoFar: string) => void,
  onStep?: (step: TutorAgentLiveStep) => void
): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let pending = "";
  let textSoFar = "";
  let result: Record<string, unknown> | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Ignore one malformed SSE event so later valid events can still finish
      // the streamed answer.
      return;
    }

    if (event.type === "text" && typeof event.value === "string") {
      textSoFar += event.value;
      onChunk?.(textSoFar);
      return;
    }
    if (event.type === "step") {
      const step = normalizeTutorAgentLiveStep(event);
      if (step) onStep?.(step);
      return;
    }
    if (event.type === "error") {
      throw new Error(
        typeof event.error === "string"
          ? event.error
          : "Jami could not finish that answer just now."
      );
    }
    if (event.type === "done") {
      result = event;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(handleLine);
    /*
     * The answer is settled once "done" arrives. The route keeps the stream
     * open after it only to finish its own bookkeeping -- updating the
     * student's Tutor memory -- and waiting for that kept the reply box locked
     * after the answer was already on screen. The rest is still read, so the
     * route is never cut off mid-write, but nobody waits for it.
     */
    if (result) {
      void drainAssistantStream(reader);
      return result;
    }
  }
  handleLine(pending);

  return result;
}

export async function sendJamiAssistantMessage(
  input: JamiAssistantRequest,
  onChunk?: (textSoFar: string) => void,
  /**
   * Abandons the answer. Dropping the request is what tells the route to stop
   * generating, so without one a closed drawer left the provider running to the
   * end and the student paying for an answer they would never see.
   */
  signal?: AbortSignal,
  /** What Jami looks up or works out before answering, as each step starts. */
  onStep?: (step: TutorAgentLiveStep) => void
): Promise<JamiAssistantResponse & { agentSteps?: TutorAgentStepView[] }> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();

  const response = await fetch("/api/ai/assistant", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });

  // Everything that can fail before generation starts still answers with JSON,
  // so a non-ok response is read the same way it always was.
  if (!response.ok) {
    const failure = (await response.json().catch(() => {
      // Infrastructure may replace the JSON API error body; status-based
      // fallback copy remains actionable without exposing that payload.
      return null;
    })) as Record<
      string,
      unknown
    > | null;
    reportAllowanceRefusal(failure);
    throw new Error(
      getFriendlyAssistantError(
        response.status,
        typeof failure?.error === "string" ? failure.error : undefined,
        typeof failure?.code === "string" ? failure.code : undefined
      )
    );
  }

  const data = await readAssistantStream(response, onChunk, onStep);
  // A question was spent; a "few left" line under the composer can catch up.
  notifyAllowanceSpent();

  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
  const used = normalizeUsedContext(data?.used);
  if (!reply || used.length === 0) {
    throw new Error("Jami returned an incomplete answer. Try again.");
  }

  const sourceFailures = normalizeSourceFailures(data?.sourceFailures);
  const followUps = normalizeFollowUps(data?.followUps);
  const citations = normalizeAssistantCitations(data?.citations);
  const suggestedCards = normalizeSuggestedCards(data?.suggestedCards);
  const practiceOffer = normalizeTutorPracticeOffer(data?.practiceOffer);
  const nextStepOffer = normalizeTutorPracticeOffer(data?.nextStepOffer);
  const savedThreadData =
    data?.savedThread &&
    typeof data.savedThread === "object" &&
    !Array.isArray(data.savedThread)
      ? (data.savedThread as Record<string, unknown>)
      : null;
  const savedThread = savedThreadData
    ? mapJamiAssistantThread(String(savedThreadData.id ?? ""), savedThreadData)
    : null;
  const studyMaterialRequest = normalizeTutorStudyMaterialRequest(data?.studyMaterialRequest);
  const studyMaterialOffers = normalizeTutorStudyMaterialOffers(data?.studyMaterialOffers);
  const studyMaterialSetup = normalizeTutorStudyMaterialSetup(data?.studyMaterialSetup);
  const sourceSaveOffer = normalizeTutorSourceSaveOffer(data?.sourceSaveOffer);
  const appScope = normalizeJamiAppScope(data?.appScope);
  const appActions = normalizeTutorAppActions(data?.appActions, jamiDestinations(appScope));
  const agentSteps = normalizeTutorAgentSteps(data?.agentSteps);
  return {
    reply,
    used,
    ...(followUps.length > 0 ? { followUps } : {}),
    ...(sourceFailures.length > 0 ? { sourceFailures } : {}),
    ...(citations.length > 0 ? { citations } : {}),
    ...(suggestedCards.length > 0 ? { suggestedCards } : {}),
    ...(practiceOffer ? { practiceOffer } : {}),
    ...(nextStepOffer ? { nextStepOffer } : {}),
    ...(data?.canIllustrate === true ? { canIllustrate: true } : {}),
    ...(studyMaterialRequest ? { studyMaterialRequest } : {}),
    ...(studyMaterialOffers.length > 0 ? { studyMaterialOffers } : {}),
    ...(studyMaterialSetup ? { studyMaterialSetup } : {}),
    ...(sourceSaveOffer ? { sourceSaveOffer } : {}),
    ...(appActions.length > 0 ? { appActions, appScope } : {}),
    ...(savedThread ? { savedThread } : {}),
    ...(agentSteps.length > 0 ? { agentSteps } : {}),
  };
}

function normalizeTutorSourceSaveOffer(value: unknown): TutorSourceSaveOffer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const offer = value as Record<string, unknown>;
  const [attachment] = normalizeTutorAttachments([offer.attachment]);
  const title = typeof offer.title === "string" ? offer.title.trim().slice(0, 120) : "";
  if (!attachment || !title) return null;
  const folderId = typeof offer.folderId === "string" ? offer.folderId.trim().slice(0, 160) : "";
  return { attachment, title, ...(folderId ? { folderId } : {}) };
}
