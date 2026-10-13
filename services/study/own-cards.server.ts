import "server-only";

import { FieldPath } from "firebase-admin/firestore";
import { mapCardData, type Card } from "@/lib/study/cards";
import { getAdminDb } from "@/services/firebase/admin";

/**
 * Cards per response: about a megabyte and a half of JSON before compression,
 * well inside a function's response limit however long the student's cards are.
 */
export const OWN_CARDS_PAGE_SIZE = 2_500;

export type OwnCardsPage = {
  cards: Card[];
  /** The id to read on from, or null when this page was the last. */
  nextCursor: string | null;
};

/**
 * One page of the signed-in student's own cards, in document id order.
 *
 * Read here rather than in the browser because the browser's Firestore
 * connection makes a large read slow: every card arrives in a verbose wire
 * format over long-polling and is decoded on the student's device. Five
 * thousand cards took fifteen to thirty seconds on a phone over 4G. Read beside
 * the database and sent as one compressed response, the same cards arrive in a
 * small fraction of that.
 *
 * Only ever the caller's cards: the query is bound to their uid, and a cursor
 * only moves within it.
 */
export async function readOwnCardsPage(
  uid: string,
  options: { after?: string | null; limit?: number } = {}
): Promise<OwnCardsPage> {
  const limit = Math.max(1, Math.min(OWN_CARDS_PAGE_SIZE, options.limit ?? OWN_CARDS_PAGE_SIZE));
  let query = getAdminDb()
    .collection("cards")
    .where("userId", "==", uid)
    .orderBy(FieldPath.documentId())
    .limit(limit + 1);
  if (options.after) query = query.startAfter(options.after);

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  return {
    cards: docs.map((doc) => mapCardData(doc.id, doc.data() as Record<string, unknown>)),
    nextCursor: snapshot.docs.length > limit ? (docs.at(-1)?.id ?? null) : null,
  };
}

/** Fronts a draft is compared with: enough to catch repeats, bounded for a request. */
export const OWN_CARD_FRONTS_LIMIT = 200;

/**
 * Fronts of the student's own cards in some decks, or on one concept, so new
 * drafts can be checked against what they already have.
 *
 * One reader for every way Jami writes cards. A failed read costs the check,
 * never the cards: callers treat it as "nothing to compare with", and the
 * student still reviews every draft before it is kept.
 */
export async function readOwnCardFronts(
  uid: string,
  scope: { deckIds: readonly string[] } | { topicId: string },
  limit = OWN_CARD_FRONTS_LIMIT
): Promise<string[]> {
  const cards = getAdminDb().collection("cards").where("userId", "==", uid);
  let query;
  if ("topicId" in scope) {
    query = cards.where("topicIds", "array-contains", scope.topicId);
  } else {
    // Firestore's `in` takes thirty values.
    const deckIds = Array.from(new Set(scope.deckIds.filter(Boolean))).slice(0, 30);
    if (deckIds.length === 0) return [];
    query = cards.where("deckId", "in", deckIds);
  }
  const snapshot = await query.limit(Math.max(1, limit)).get();
  return snapshot.docs
    .map((document) => (document.data() as { front?: unknown }).front)
    .filter((front): front is string => typeof front === "string" && front.trim().length > 0);
}

/** The student's decks in one folder, newest first. */
export async function readOwnFolderDeckIds(uid: string, folderId: string, limit = 30): Promise<string[]> {
  const snapshot = await getAdminDb()
    .collection("decks")
    .where("userId", "==", uid)
    .where("folderIds", "array-contains", folderId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map((document) => document.id);
}
