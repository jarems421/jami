import { readTopicStandings, type TopicStanding } from "@/lib/goals/topic-standing";
import { auth } from "@/services/firebase/client";

/**
 * Where each topic in a folder stands, for topic goals and for choosing one.
 *
 * Each answer is a profile built over the folder's evidence on the server, so
 * it is kept for a few minutes: opening the goal composer and the goals page
 * one after the other should not build the same profile twice.
 */

const TOPIC_STANDING_CACHE_MS = 5 * 60_000;

const cache = new Map<string, { storedAt: number; topics: TopicStanding[] }>();

export async function loadTopicStandings(
  folderId: string,
  options: { force?: boolean } = {}
): Promise<TopicStanding[]> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in again to see topic progress.");
  const key = `${user.uid}:${folderId}`;
  const cached = cache.get(key);
  if (!options.force && cached && Date.now() - cached.storedAt < TOPIC_STANDING_CACHE_MS) {
    return cached.topics;
  }
  const response = await fetch(`/api/learning/topic-standing?folderId=${encodeURIComponent(folderId)}`, {
    headers: { Authorization: `Bearer ${await user.getIdToken()}` },
  });
  if (!response.ok) throw new Error("Topic progress is unavailable right now.");
  const body = (await response.json()) as { topics?: unknown };
  const topics = readTopicStandings(body.topics);
  cache.set(key, { storedAt: Date.now(), topics });
  return topics;
}

/** Forgets every kept answer, so the next read asks again. */
export function clearTopicStandingCache() {
  cache.clear();
}
