import type { NextRequest } from "next/server";
import { featureFlags } from "@/lib/app/feature-flags";
import { createLogger } from "@/lib/observability/logger";
import { enterAiSpendContext } from "@/lib/ai/spend-context";
import { apiFailure, authenticateRequest } from "@/services/auth/authenticate-request.server";
import { checkAiBudget, createAiBudgetLimitResponse, refundAiBudget } from "@/services/ai/budgets";
import { aiSpendContextFor } from "@/services/ai/spend.server";
import {
  buildPlanNotices,
  describeAssistantPlanDraft,
  type PlanSubjectOption,
} from "@/lib/ai/assistant-plan";
import {
  draftRevisionPlan,
  MAX_PLAN_MESSAGE_LENGTH,
  MAX_PLAN_TURNS,
  type PlanDraftTurn,
} from "@/services/ai/plan-draft.server";
import { loadStudyActions } from "@/services/learning/study-actions.server";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import { isPlanInterviewStep } from "@/lib/planning/plan-interview";
import { readPlanTimetableDays } from "@/lib/planning/plan-timetable-prompt";
import { planScopeKey, type RevisionPlanDraft } from "@/lib/planning/types";
import { describeUnmetAiProviderRequirements } from "@/lib/ai/provider-policy";
import { isAnyAiProviderConfigured } from "@/lib/ai/provider-router";
import { servableExamSetTexts } from "@/lib/practice/exam-set-texts";
import type { StudyFolder } from "@/lib/workspace/study-folders";

export const runtime = "nodejs";

/**
 * The platform's budget, which has to be at least the one below.
 *
 * Without this the function took the account default -- ten to fifteen seconds
 * -- while `draftRevisionPlan` alone allows the model twenty, so the platform
 * killed the request before the model could answer and every single message to
 * Jami came back as "couldn't answer just now". Every other AI route here
 * declares one; this was the only one that did not.
 */
export const maxDuration = 60;

const log = createLogger({ route: "ai.plan-draft" });

/** The most subjects offered to the model; more than this is not a revision plan. */
const MAX_SUBJECTS = 8;
/** Enough texts for the model to recognise one the student names, not the whole list. */
const MAX_SET_TEXTS_PER_SUBJECT = 8;

/**
 * What Jami already knows about a subject, from the student's own folder.
 *
 * This is the difference between planning inside Jami and planning on paper. A
 * student who says "I've got an English test on Tuesday" has already told Jami
 * everything it needs: their folder names the course, the course names the
 * specification, and the specification lists the texts. Asking them which board
 * they sit is asking them to repeat themselves.
 *
 * Only checked specification data is used -- `servableExamSetTexts` returns
 * nothing from a list a person has not verified -- so Jami never names a text
 * the student is not actually studying.
 */
function describeFolder(folder: StudyFolder) {
  const course = folder.examCourse;
  const setTexts = course
    ? servableExamSetTexts(course.specificationId)
        .slice(0, MAX_SET_TEXTS_PER_SUBJECT)
        .map((text) => (text.author ? `${text.label} (${text.author})` : text.label))
    : [];

  return {
    ...(course
      ? { course: [course.board, course.qualification, course.specificationTitle].filter(Boolean).join(" ") }
      : {}),
    ...(folder.studyLevel ? { level: String(folder.studyLevel) } : {}),
    ...(setTexts.length > 0 ? { setTexts } : {}),
  };
}

function readTurns(value: unknown): PlanDraftTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((raw) => {
      if (typeof raw !== "object" || raw === null) return [];
      const turn = raw as Record<string, unknown>;
      const text = typeof turn.text === "string" ? turn.text.trim() : "";
      if (!text) return [];
      return [
        {
          role: turn.role === "jami" ? ("jami" as const) : ("student" as const),
          text: text.slice(0, MAX_PLAN_MESSAGE_LENGTH),
        },
      ];
    })
    .slice(-MAX_PLAN_TURNS);
}

/**
 * Jami's side of a planning conversation.
 *
 * The subjects the model may choose between, and the notices it may reason
 * from, are both assembled here from the student's own recorded work -- never
 * taken from the request. A client that asked for a plan over somebody else's
 * folder, or supplied its own flattering list of "weaknesses", gets the
 * student's real ones regardless.
 */
export async function POST(request: NextRequest) {
  if (!featureFlags.enableRevisionPlans || !featureFlags.enableLearnerProfile) {
    return apiFailure("Not found", 404, "not_found");
  }
  const uid = await authenticateRequest(request);
  if (!uid) return apiFailure("Unauthorized", 401, "unauthorized");

  /*
   * Said before anything is attempted, and said by name.
   *
   * A half-configured environment -- a key present and a flag unset, say --
   * fails identically to a broken model call once the request is underway, and
   * this route used to report both as the same 503. Names only, never values,
   * and after the token check, so an unauthenticated caller learns nothing
   * about how this deployment is put together.
   */
  if (!isAnyAiProviderConfigured()) {
    log.error("provider.not_configured", {
      unmet: describeUnmetAiProviderRequirements(process.env),
    });
    return apiFailure(
      "Jami's planning help isn't switched on here. You can still build a plan yourself.",
      503,
      "ai_unconfigured"
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiFailure("That request could not be read.", 400, "bad_request");
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) return apiFailure("Say what you need and Jami will suggest a shape.", 400, "bad_request");

  /*
   * Counted like every other AI request. The daily and burst limits for
   * planning were set from the start and never asked, so a planner left open
   * could send as many messages as it liked; with the timetable now built in
   * conversation, that matters.
   */
  let budgetDecision;
  try {
    budgetDecision = await checkAiBudget({ uid, action: "planDraft" });
    enterAiSpendContext(aiSpendContextFor(uid, "planDraft"));
  } catch (error) {
    log.error("budget.check_failed", { error });
    return apiFailure("AI usage limits are temporarily unavailable. Try again shortly.", 503, "budget_unavailable");
  }
  if (!budgetDecision.allowed) return createAiBudgetLimitResponse("planDraft", budgetDecision);
  const budgetGrant = budgetDecision.grant;

  const startedAt = Date.now();
  try {
    /*
     * One read, answering both questions.
     *
     * The engine says what it has noticed and in which folders; the folder
     * documents say what each subject actually is -- the course, the level, the
     * set texts. This used to be two reads, and the second went through the
     * *browser* Firestore SDK, which on a server has no signed-in user: it
     * either waited out its own thirty-second timeout or was refused by the
     * rules, and either way it spent the whole request budget before the model
     * was ever called. `loadStudyActions` already reads these folders in full
     * through the admin SDK.
     */
    const { actions, folders: studyFolders } = await loadStudyActions({ uid });

    const subjectNames = new Map<string, string>();
    const detailById = new Map(studyFolders.map((folder) => [folder.id, describeFolder(folder)]));
    for (const folder of studyFolders) subjectNames.set(`folder:${folder.id}`, folder.name);
    const inScope = new Map<string, PlanSubjectOption>();
    for (const action of actions) {
      const scopeKey = planScopeKey(action.scope);
      if (inScope.has(scopeKey) || inScope.size >= MAX_SUBJECTS) continue;
      const label = subjectNames.get(scopeKey);
      if (!label) continue;
      inScope.set(scopeKey, {
        ref: `S${inScope.size + 1}`,
        label,
        ...(action.scope.folderId ? { folderId: action.scope.folderId } : {}),
        ...(action.scope.deckId ? { deckId: action.scope.deckId } : {}),
        ...(action.scope.folderId ? detailById.get(action.scope.folderId) ?? {} : {}),
      });
    }
    // A folder the engine had nothing to say about is still a subject somebody
    // may want to revise -- it is simply one Jami cannot comment on.
    for (const folder of studyFolders) {
      const scopeKey = `folder:${folder.id}`;
      if (inScope.has(scopeKey) || inScope.size >= MAX_SUBJECTS) continue;
      inScope.set(scopeKey, {
        ref: `S${inScope.size + 1}`,
        label: folder.name,
        folderId: folder.id,
        ...(detailById.get(folder.id) ?? {}),
      });
    }

    const subjects = [...inScope.values()];
    const notices = buildPlanNotices(actions, subjectNames);

    /*
     * The draft the student is looking at, normalised before it is described.
     *
     * It arrives from the client, so it is not trusted: it goes through the
     * same gate a saved plan does, and what reaches the prompt is a summary in
     * refs rather than anything the caller wrote. Nothing here is persisted --
     * it only tells Jami what is on the student's screen, so a small change
     * they ask for does not come back as an entirely new plan.
     */
    const draft =
      record.draft && typeof record.draft === "object"
        ? normalizeRevisionPlanDraft(record.draft as Partial<RevisionPlanDraft>).draft
        : null;
    const current = draft ? describeAssistantPlanDraft(draft, subjects) : null;

    const result = await draftRevisionPlan({
      message: message.slice(0, MAX_PLAN_MESSAGE_LENGTH),
      history: readTurns(record.history),
      subjects,
      notices,
      current,
      // The same gate as every other part of the request: bounded, cleaned, never trusted.
      timetable: readPlanTimetableDays(record.timetable),
      ...(draft ? { planEndDayKey: draft.endDayKey } : {}),
      // Only a step the interview has; anything else is an open conversation.
      ...(isPlanInterviewStep(record.step) ? { step: record.step } : {}),
    });

    log.info("plan_draft.answered", {
      latencyMs: Date.now() - startedAt,
      subjects: subjects.length,
      notices: notices.length,
      proposed: Boolean(result.plan),
      changes: result.changes.length,
    });

    return Response.json({
      reply: result.reply,
      plan: result.plan?.draft ?? null,
      changes: result.changes,
      notices,
      subjects: subjects.map((subject) => ({ ref: subject.ref, label: subject.label })),
    });
  } catch (error) {
    // Nothing the student can use came back, so it is not counted against them.
    try {
      await refundAiBudget(budgetGrant);
    } catch (refundError) {
      log.warn("budget.refund_failed", { error: refundError });
    }
    /*
     * Told apart, because the answers differ.
     *
     * A timeout is worth trying again; a provider that is not there is not, and
     * a student pressing send a third time on a request that cannot succeed is
     * the worst version of this. The client reads the code, so the message a
     * student sees follows the reason rather than being one line for all of it.
     */
    const timedOut =
      error instanceof Error && /timed out|timeout|abort/i.test(`${error.name} ${error.message}`);
    log.warn("plan_draft.failed", {
      latencyMs: Date.now() - startedAt,
      timedOut,
      error,
    });
    return timedOut
      ? apiFailure(
          "Jami took too long to answer. Try again, or build the plan yourself.",
          504,
          "plan_draft_timeout"
        )
      : apiFailure(
          "Jami could not suggest a plan just now. You can still build one yourself.",
          503,
          "plan_draft_unavailable"
        );
  }
}
