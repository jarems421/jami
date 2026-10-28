import { PLANNER_PATH } from "@/lib/app/plan-views";

export function getDeckHref(deckId: string) {
  return `/dashboard/decks/${encodeURIComponent(deckId)}`;
}

export function getDeckStudyRouteHref(deckId: string) {
  return `${getDeckHref(deckId)}/study`;
}

export type RouteSearchParams = Record<
  string,
  string | string[] | undefined
>;

export function buildDeckStudyRedirectHref(
  deckId: string,
  searchParams: RouteSearchParams = {},
) {
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      value.forEach((item) => nextSearchParams.append(key, item));
    } else if (typeof value === "string") {
      nextSearchParams.set(key, value);
    }
  }

  nextSearchParams.set("mode", "custom");
  nextSearchParams.set("decks", deckId);
  return `/dashboard/study?${nextSearchParams.toString()}`;
}

export function getCustomStudyHref(options?: {
  mode?: "daily" | "custom";
  deckIds?: string[];
  topicIds?: string[];
  /**
   * What the Learning Engine wants this session to do, when it opened the link.
   *
   * Carried in the URL rather than held in memory because the student may
   * arrive by any route -- a new tab, a bookmark, a reload mid-session -- and
   * a recommendation that silently became an ordinary session on reload would
   * be worse than one that never claimed to be anything else.
   */
  focus?: { emphasis: string; targetItems: number };
  /** The recommendation that opened this session, so finishing it can be recorded. */
  fromActionId?: string;
}) {
  const searchParams = new URLSearchParams();
  const mode = options?.mode ?? "custom";
  searchParams.set("mode", mode);

  const deckIds = (options?.deckIds ?? []).filter(Boolean);
  if (deckIds.length > 0) {
    searchParams.set("decks", deckIds.join(","));
  }

  const topicIds = (options?.topicIds ?? []).filter(Boolean);
  if (topicIds.length > 0) {
    searchParams.set("topics", topicIds.join(","));
  }

  const focus = options?.focus;
  if (focus && focus.emphasis && focus.targetItems > 0) {
    searchParams.set("focus", focus.emphasis);
    searchParams.set("focusCount", String(Math.round(focus.targetItems)));
  }

  const fromActionId = options?.fromActionId?.trim();
  if (fromActionId) searchParams.set("from", fromActionId);

  return `/dashboard/study?${searchParams.toString()}`;
}

export function getFolderHref(folderId: string, tab?: "practice" | "decks" | "sources") {
  const base = `/dashboard/folders/${encodeURIComponent(folderId)}`;
  return tab ? `${base}?tab=${tab}` : base;
}

export function getTopicHref(topicId: string) {
  return `/dashboard/topics/${encodeURIComponent(topicId)}`;
}

/**
 * A notebook, opened at a page when one is named.
 *
 * `from` carries the recommendation that sent the student here, as a study
 * session's link does, so a marking of the work they do can say it answered
 * that advice.
 */
export function getNotebookHref(
  notebookId: string,
  options?: { pageId?: string; fromActionId?: string }
) {
  const base = `/dashboard/notebooks/${encodeURIComponent(notebookId)}`;
  const searchParams = new URLSearchParams();
  if (options?.pageId) searchParams.set("page", options.pageId);
  if (options?.fromActionId) searchParams.set("from", options.fromActionId);
  const query = searchParams.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Where a Revision Session sends the student when it is over: back to the page
 * they started it from, when that is one of this app's own pages other than a
 * session, and to Today otherwise. Anything else in a link is ignored rather
 * than followed.
 */
export function readRevisionReturnHref(value: unknown) {
  return typeof value === "string" &&
    value.startsWith("/dashboard") &&
    !value.startsWith("//") &&
    !value.startsWith("/dashboard/revision")
    ? value
    : undefined;
}

/** A Revision Session that exists. */
export function getRevisionSessionHref(sessionId: string, returnHref?: string) {
  const base = `/dashboard/revision/${encodeURIComponent(sessionId)}`;
  const back = readRevisionReturnHref(returnHref);
  return back ? `${base}?return=${encodeURIComponent(back)}` : base;
}

/**
 * Where a teach recommendation opens. The session itself is made there, on the
 * server, from the recommendation's id -- never from anything else in the link.
 */
export function getRevisionSessionStartHref(actionId?: string) {
  return actionId
    ? `/dashboard/revision/new?action=${encodeURIComponent(actionId)}`
    : "/dashboard/revision/new";
}

/**
 * Choosing what to revise: a folder's concepts, or -- with a concept -- straight
 * into a session on it. Every entry point outside Today lands here.
 */
export function getRevisionStartHref(
  input: { folderId?: string; topicKey?: string; returnHref?: string } = {}
) {
  const searchParams = new URLSearchParams();
  if (input.folderId) searchParams.set("folder", input.folderId);
  if (input.folderId && input.topicKey) searchParams.set("topic", input.topicKey);
  const back = readRevisionReturnHref(input.returnHref);
  if (back) searchParams.set("return", back);
  const query = searchParams.toString();
  return query ? `/dashboard/revision/start?${query}` : "/dashboard/revision/start";
}

/** Past Paper Practice setup for a folder, optionally narrowed to specification topics. */
export function getQuestionPracticeSetupHref(input: {
  folderId: string;
  topicIds?: string[];
  /** Specification concepts, one grain finer than topics. */
  conceptIds?: string[];
}) {
  const searchParams = new URLSearchParams({ folderId: input.folderId });
  const topicIds = (input.topicIds ?? []).filter(Boolean);
  if (topicIds.length > 0) searchParams.set("topics", topicIds.join(","));
  const conceptIds = (input.conceptIds ?? []).filter(Boolean);
  if (conceptIds.length > 0) searchParams.set("concepts", conceptIds.join(","));
  return `/dashboard/practice/questions/new?${searchParams.toString()}`;
}

/** One Past Paper Practice session, a practice set included. */
export function getQuestionPracticeSessionHref(sessionId: string) {
  return `/dashboard/practice/questions/${encodeURIComponent(sessionId)}`;
}

export function getDeckStudyHref(deckId: string, topicId?: string) {
  return getCustomStudyHref({
    mode: "custom",
    deckIds: [deckId],
    topicIds: topicId ? [topicId] : [],
  });
}

/** The student's revision plan: their own timetable, filled by the engine. */
export function getRevisionPlanHref() {
  return PLANNER_PATH;
}
