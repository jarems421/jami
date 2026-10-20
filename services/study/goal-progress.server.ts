import "server-only";

import { goalProgressFields, normalizeGoal } from "@/lib/goals/model";
import { applyGoalEvent } from "@/lib/goals/progress";
import { createLogger } from "@/lib/observability/logger";
import { getAdminDb } from "@/services/firebase/admin";

const log = createLogger({ route: "goals.marked-answers" });

/**
 * Marked answers, counted towards practice-question goals where the mark is
 * written.
 *
 * Only the server knows an answer was marked -- the marks themselves are
 * server-only -- so this is the one place those goals can be counted honestly.
 * The rule is the same `applyGoalEvent` the device runs for flashcards.
 *
 * Each marking counts once: a receipt keyed by what was marked commits with
 * the goal writes, so a retried step or a resubmitted mark adds nothing. A goal
 * this finishes is left `rewardPending`, and the next screen the student opens
 * lights its star, since only a screen can show one being earned.
 *
 * Never throws. Losing a count is a small thing; failing a marking because a
 * goal could not be written would be a large one.
 */
export async function countMarkedAnswersTowardGoals(input: {
  uid: string;
  /** What was marked, unique per marking: `exam:<attemptId>`, `paper:<attemptId>`. */
  receiptId: string;
  folderId?: string;
  /** One share of the marks per answered question, 0 to 1. Blank answers are left out. */
  scores: readonly number[];
  at: number;
}): Promise<{ counted: number; completed: number }> {
  const none = { counted: 0, completed: 0 };
  const uid = input.uid.trim();
  if (!uid || input.scores.length === 0) return none;
  try {
    const db = getAdminDb();
    const userRef = db.collection("users").doc(uid);
    // Most students have no question goal at all; they pay one small read and no transaction.
    const active = await userRef.collection("goals").where("status", "==", "active").get();
    const candidates = active.docs.filter(
      (document) => normalizeGoal(document.id, document.data() as Record<string, unknown>).measure === "questions"
    );
    if (candidates.length === 0) return none;

    const receiptRef = userRef.collection("studyState").doc(`goal-${encodeURIComponent(input.receiptId)}`);
    return await db.runTransaction(async (transaction) => {
      const receipt = await transaction.get(receiptRef);
      if (receipt.exists) return none;
      const snapshots = await Promise.all(candidates.map((candidate) => transaction.get(candidate.ref)));
      let counted = 0;
      let completed = 0;
      for (const snapshot of snapshots) {
        if (!snapshot.exists) continue;
        const goal = normalizeGoal(snapshot.id, snapshot.data() as Record<string, unknown>);
        let next = goal;
        for (const score of input.scores) {
          next = applyGoalEvent(next, { kind: "question", score, at: input.at, folderId: input.folderId });
        }
        if (next === goal) continue;
        const finished = goal.status === "active" && next.status === "completed";
        transaction.update(snapshot.ref, { ...goalProgressFields(next), ...(finished ? { rewardPending: true } : {}) });
        if (next.progress.count > goal.progress.count) counted += 1;
        if (finished) completed += 1;
      }
      transaction.set(receiptRef, { kind: "goal-receipt", createdAt: Date.now() });
      return { counted, completed };
    });
  } catch (error) {
    log.warn("goals.marked_answers_failed", { uid, error });
    return none;
  }
}
