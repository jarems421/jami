import type { NextRequest } from "next/server";
import { authenticateRequest } from "@/services/auth/authenticate-request.server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { mapVideoCardJobData } from "@/lib/ai/video-card-jobs";
import { mapCardData } from "@/lib/study/cards";
import { getAdminDb, getAdminStorageBucket } from "@/services/firebase/admin";

export const runtime = "nodejs";

function failure(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const uid = await authenticateRequest(request);
  if (!uid) return failure("Unauthorized", 401);
  const { jobId } = await params;
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(jobId)) return failure("Job not found", 404);

  const db = getAdminDb();
  const jobRef = db.collection("users").doc(uid).collection("videoCardJobs").doc(jobId);
  const result = await db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef);
    if (!jobSnapshot.exists) return { kind: "missing" as const };
    const raw = jobSnapshot.data() ?? {};
    const job = mapVideoCardJobData(jobId, raw);
    if (job.status === "approved") {
      return { kind: "existing" as const, ids: Array.isArray(raw.approvedCardIds) ? raw.approvedCardIds.filter((id): id is string => typeof id === "string") : [] };
    }
    const storagePath = typeof raw.storagePath === "string" ? raw.storagePath : "";
    if (job.status !== "ready" || job.followUp?.status === "running") return { kind: "not_ready" as const };
    const selected = job.drafts.filter((draft) => draft.selected);
    if (!selected.length) return { kind: "empty" as const };

    const deck = await transaction.get(db.collection("decks").doc(job.deckId));
    if (!deck.exists || ![deck.data()?.userId, deck.data()?.uid].includes(uid)) return { kind: "deck_missing" as const };

    const now = Date.now();
    const cards = selected.map((draft, index) => {
      const cardRef = db.collection("cards").doc();
      const data = { deckId: job.deckId, userId: uid, front: draft.front, back: draft.back, tags: [], topicIds: job.topicIds, createdAt: now - index };
      transaction.create(cardRef, data);
      return mapCardData(cardRef.id, data);
    });
    // The cards carry no timestamps and no evidence, and the video the
    // timestamps referred to is deleted right after this commits. Once an
    // import is approved there is nothing left to look back at.
    transaction.update(jobRef, { status: "approved", drafts: [], evidence: [], storagePath: FieldValue.delete(), contentText: FieldValue.delete(), followUp: FieldValue.delete(), approvedCardIds: cards.map((card) => card.id), completedAt: now, expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000), updatedAt: now });
    return { kind: "created" as const, cards, storagePath };
  });

  if (result.kind === "missing") return failure("Job not found", 404);
  if (result.kind === "not_ready") return failure("This import is not ready.", 409);
  if (result.kind === "empty") return failure("Select at least one card.", 400);
  if (result.kind === "deck_missing") return failure("Deck not found", 404);
  if (result.kind === "created") {
    if (result.storagePath) {
      await getAdminStorageBucket().file(result.storagePath).delete({ ignoreNotFound: true }).catch(() => undefined);
    }
    return Response.json({ cards: result.cards });
  }

  const snapshots = await Promise.all(result.ids.map((id) => db.collection("cards").doc(id).get()));
  return Response.json({ cards: snapshots.flatMap((snapshot) => snapshot.exists && snapshot.data()?.userId === uid ? [mapCardData(snapshot.id, snapshot.data() ?? {})] : []) });
}
