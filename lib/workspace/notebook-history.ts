import type { NotebookGraphBlock } from "@/lib/workspace/notebook-graphs";
import type { NotebookImageRef, NotebookTextBlock } from "@/lib/workspace/notebooks";

/**
 * An edit to a page's images or graphs, as the ones it touched were before it
 * (`previous`) and after it (`next`): one it added is only in `next`, one it
 * removed only in `previous`. See {@link stepPlacedHistory}.
 */
export type NotebookPlacedEdit =
  | { kind: "images"; previous: NotebookImageRef[]; next: NotebookImageRef[] }
  | { kind: "graphs"; previous: NotebookGraphBlock[]; next: NotebookGraphBlock[] };

/** A placed edit that undo or redo hands back for the page to apply. */
export type NotebookPlacedStep = { edit: NotebookPlacedEdit; direction: "undo" | "redo" };

/**
 * An edit the page can reverse itself: its text boxes as they were and
 * became, or its images or graphs.
 *
 * Ink history is owned by the ink editor and is not represented here; the two
 * are reconciled by timestamp in {@link chooseNotebookHistorySource}.
 */
export type NotebookPageHistoryEntry = (
  | { kind: "texts"; previous: NotebookTextBlock[]; next: NotebookTextBlock[] }
  | NotebookPlacedEdit
) & {
  /** When the edit happened, used to order it against ink commands. */
  at: number;
  /** One gesture's edits (a lasso drag) share a group, and undo and redo together, ink included. */
  group: number | null;
};

/** When an ink command landed, and the gesture it was part of. */
export type NotebookInkHistoryStamp = { at: number; group: number | null };

export type NotebookHistorySource = "ink" | "page";

export const MAX_NOTEBOOK_HISTORY_ENTRIES = 40;

/**
 * Mirrors the ink editor's undo depth as a stack of stamps.
 *
 * The editor reports only how deep its history is, never when each command
 * landed, so the notebook keeps a parallel stack: a deeper history means a new
 * command just landed, a shallower one means commands were undone or dropped.
 */
export function syncInkHistoryTimestamps<T>(timestamps: T[], depth: number, now: T): T[] {
  if (depth < 0) return [];
  if (depth === timestamps.length) return timestamps;
  if (depth < timestamps.length) return timestamps.slice(0, depth);
  const next = timestamps.slice();
  while (next.length < depth) next.push(now);
  return next;
}

/**
 * Picks which history to step through next.
 *
 * Whichever action happened most recently wins, so undo walks back through the
 * page in the order the student actually worked. Ties go to ink, because a
 * stroke and the text edit that triggered it share a timestamp only when the
 * stroke came last.
 */
export function chooseNotebookHistorySource(input: {
  inkTimestamp: number | null;
  pageTimestamp: number | null;
}): NotebookHistorySource | null {
  const { inkTimestamp, pageTimestamp } = input;
  if (inkTimestamp === null && pageTimestamp === null) return null;
  if (pageTimestamp === null) return "ink";
  if (inkTimestamp === null) return "page";
  return inkTimestamp >= pageTimestamp ? "ink" : "page";
}

/** Appends an entry, discarding the oldest once the cap is reached. */
export function pushNotebookHistoryEntry<T>(stack: T[], entry: T): T[] {
  return [...stack.slice(-(MAX_NOTEBOOK_HISTORY_ENTRIES - 1)), entry];
}

/**
 * What an edit changed among a page's images or graphs, as the two sides of a
 * history entry, or null for nothing. They are never changed in place, so a
 * changed one is a new object. Without `addsAndRemovals` only what changed in
 * place counts, which is how images are kept: deleting one deletes its file,
 * so undo could not bring it back, and undoing one added would leave its
 * file behind.
 */
export function placedHistoryChange<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  options: { addsAndRemovals: boolean }
): { previous: T[]; next: T[] } | null {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const counts = (other: Map<string, T>, item: T) => options.addsAndRemovals || other.has(item.id);
  const previous = before.filter((item) => afterById.get(item.id) !== item && counts(afterById, item));
  const next = after.filter((item) => beforeById.get(item.id) !== item && counts(beforeById, item));
  return previous.length > 0 || next.length > 0 ? { previous, next } : null;
}

/**
 * Steps a page's images or graphs across one edit, from one side of it to the
 * other (undo: `next` to `previous`; redo: the other way). What the edit
 * changed is changed back, what it added goes, and what it removed comes back
 * on top. Anything gone since stays gone, and the rest is left as it is.
 */
export function stepPlacedHistory<T extends { id: string }>(
  current: readonly T[],
  from: readonly T[],
  to: readonly T[]
): T[] {
  const target = new Map(to.map((item) => [item.id, item]));
  const fromIds = new Set(from.map((item) => item.id));
  const present = new Set(current.map((item) => item.id));
  const stepped = current.flatMap((item) => {
    const wanted = target.get(item.id);
    if (wanted) return [wanted];
    return fromIds.has(item.id) ? [] : [item];
  });
  for (const item of to) {
    if (!present.has(item.id) && !fromIds.has(item.id)) stepped.push(item);
  }
  return stepped;
}
