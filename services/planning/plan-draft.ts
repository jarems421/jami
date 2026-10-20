import { auth } from "@/services/firebase/client";
import type { PlanNotice } from "@/lib/ai/assistant-plan";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import type { PlanInterviewStep } from "@/lib/planning/plan-interview";
import { readPlanProposalChanges, type PlanProposalChange } from "@/lib/planning/plan-proposal";
import type { PlanTimetableDay } from "@/lib/planning/plan-timetable-prompt";
import type { RevisionPlanDraft } from "@/lib/planning/types";

/** One side of the planning conversation, as the panel holds it. */
export type PlanDraftTurn = { role: "student" | "jami"; text: string };

/**
 * Why a planning message failed, in the words the student should read.
 *
 * The route has always distinguished its failures and the client has always
 * thrown the distinction away, so "Jami couldn't answer just now" was the reply
 * to a missing sign-in, an unconfigured provider, a timeout and a genuine
 * outage alike -- and a student pressing send again on a provider that is not
 * there was the commonest version of that. The code comes from the server; the
 * sentence is chosen here, next to the panel that shows it, except for a limit,
 * whose words the server already wrote for the limit that was reached.
 */
export type PlanDraftErrorCode =
  | "signed_out"
  | "ai_unconfigured"
  | "plan_draft_timeout"
  | "plan_draft_unavailable"
  | "limit_reached";

const PLAN_DRAFT_MESSAGES: Record<PlanDraftErrorCode, string> = {
  signed_out: "Sign in again to plan with Jami.",
  ai_unconfigured:
    "Jami's planning help isn't switched on here. You can still build a plan yourself.",
  plan_draft_timeout: "Jami took too long to answer. Try again, or build the plan yourself.",
  plan_draft_unavailable:
    "Jami couldn't answer just now. You can still build a plan yourself.",
  limit_reached: "Jami has helped plan as much as it can for now. You can still change the timetable yourself.",
};

export class PlanDraftError extends Error {
  readonly code: PlanDraftErrorCode;
  /** Whether pressing send again could plausibly work. */
  readonly retryable: boolean;

  constructor(code: PlanDraftErrorCode, message?: string) {
    super(message || PLAN_DRAFT_MESSAGES[code]);
    this.name = "PlanDraftError";
    this.code = code;
    this.retryable = code === "plan_draft_timeout" || code === "plan_draft_unavailable";
  }
}

function readError(status: number, body: unknown): PlanDraftError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = record.code;
  if (code === "ai_unconfigured" || code === "plan_draft_timeout") return new PlanDraftError(code);
  if (status === 401) return new PlanDraftError("signed_out");
  if (status === 429 || status === 403) {
    return new PlanDraftError("limit_reached", typeof record.error === "string" ? record.error : undefined);
  }
  if (status === 504) return new PlanDraftError("plan_draft_timeout");
  return new PlanDraftError("plan_draft_unavailable");
}

export type PlanDraftAnswer = {
  reply: string;
  /**
   * The plan as Jami left it, or null while Jami is still asking.
   *
   * Part of a plan counts: the first question fills in exams before there is
   * any subject or day, and the interview keeps only the part it asked about.
   */
  plan: RevisionPlanDraft | null;
  /** Changes to particular days, checked on the server, for the student to apply or not. */
  changes: PlanProposalChange[];
  notices: PlanNotice[];
};

/**
 * Ask Jami to help with the timetable.
 *
 * What comes back is normalised again on arrival. It was checked on the server
 * too, and doing it twice is deliberate: this is the value that gets put
 * straight into the planner's state, so it has to be a plan, and changes the
 * timetable can apply, by the time it is a React prop.
 */
export async function draftPlanWithJami(input: {
  message: string;
  history: readonly PlanDraftTurn[];
  /** The draft on screen, so Jami adjusts it rather than starting again. */
  draft?: RevisionPlanDraft | null;
  /** The days of the timetable on screen, so Jami can change particular ones. */
  timetable?: readonly PlanTimetableDay[];
  /** Which question this message answers. */
  step?: PlanInterviewStep;
}): Promise<PlanDraftAnswer> {
  const user = auth.currentUser;
  if (!user) throw new PlanDraftError("signed_out");

  const response = await fetch("/api/ai/plan-draft", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await user.getIdToken()}`,
    },
    body: JSON.stringify({
      message: input.message,
      history: input.history,
      ...(input.draft ? { draft: input.draft } : {}),
      ...(input.timetable && input.timetable.length > 0 ? { timetable: input.timetable } : {}),
      ...(input.step ? { step: input.step } : {}),
    }),
  });
  if (!response.ok) {
    // Read rather than discarded: the route says which failure this was, and
    // the panel can only tell the student if the reason survives the fetch.
    const failure: unknown = await response.json().catch(() => null);
    throw readError(response.status, failure);
  }

  const body: unknown = await response.json();
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawPlan = record.plan;
  const normalized =
    rawPlan && typeof rawPlan === "object"
      ? normalizeRevisionPlanDraft(rawPlan as Partial<RevisionPlanDraft>)
      : null;

  return {
    reply: typeof record.reply === "string" ? record.reply : "",
    plan: normalized ? normalized.draft : null,
    changes: readPlanProposalChanges(record.changes),
    notices: Array.isArray(record.notices) ? (record.notices as PlanNotice[]) : [],
  };
}

/** What Jami has noticed, for the panel to show before anyone has typed. */
export async function loadPlanNotices(): Promise<PlanNotice[]> {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const response = await fetch("/api/learning/study-actions", {
      headers: { Authorization: `Bearer ${await user.getIdToken()}` },
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const { buildPlanNotices } = await import("@/lib/ai/assistant-plan");
    const folders = Array.isArray(record.folders)
      ? (record.folders as { id: string; name: string }[])
      : [];
    return buildPlanNotices(
      Array.isArray(record.actions) ? (record.actions as never[]) : [],
      new Map(folders.map((folder) => [`folder:${folder.id}`, folder.name]))
    );
  } catch {
    // The panel works without them; it just cannot open with what it noticed.
    return [];
  }
}
