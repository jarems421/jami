import { isValidEvidenceTime } from "@/lib/learning/evidence-time";
import type {
  NotebookPageAttribution,
  NotebookPageLearningContext,
} from "@/lib/learning/notebook-page-context";
import type { NotebookMarkedWorking } from "@/lib/learning/profile/notebook-signals";

/**
 * A verdict Tutor reached on a page of a student's own working.
 *
 * Tutor has always been able to mark notebook working; it answered in prose
 * and nothing was kept, so the most considered work a student does produced no
 * evidence at all. This is the record that changes that -- and it is the one
 * piece of learner evidence not marked against a published scheme, so it is
 * held to a stricter standard on the way in rather than a looser one.
 *
 * **Fail closed.** A verdict that is not a complete, internally coherent,
 * machine-readable marking is discarded. "Looks mostly right, probably 4 out
 * of 5" is a helpful thing to say to a student and is not evidence. There is
 * no partial credit for a partial record: notebook evidence already carries a
 * low source weight, and compensating for weak structure by accepting vague
 * output would be the exact wrong direction -- it would let the least reliable
 * source be the most permissive one.
 *
 * **What is deliberately not stored.** Criterion wording is kept, because it
 * is the marker's own language and the error-category rules read it. The
 * student's own answer text is not, anywhere: past-paper markings carry a
 * `candidateValue` per criterion and this does not, because that field is the
 * student's writing and a notebook page is where a student writes most freely.
 * Nothing here holds what they wrote -- only whether each point was earned.
 */

/**
 * Version 2 places a marking on the page's own concepts and piece of work
 * (`lib/learning/notebook-page-context.ts`) rather than on the notebook's
 * Topics. Version 1 records are still read, as what they were: the notebook's
 * Topics, and the page as its own item.
 */
export const NOTEBOOK_MARKING_SCHEMA_VERSION = 2;
const LEGACY_NOTEBOOK_MARKING_SCHEMA_VERSION = 1;
export const NOTEBOOK_MARKINGS_COLLECTION = "notebookMarkings";

/** More than any single page of working is credibly marked against. */
export const MAX_NOTEBOOK_CRITERIA = 30;
/** A page marked out of more than this is a whole paper, not a page. */
export const MAX_NOTEBOOK_MARKS = 60;
const MAX_CRITERION_LENGTH = 300;
const MAX_ID_LENGTH = 160;
/** A concept key or item id carries a namespace and an id or two. */
const MAX_KEY_LENGTH = 400;
const CONCEPT_KEY_PATTERN = /^(topic|spec):[^/\s]+$/;
const ITEM_ID_PATTERN = /^(notebook|paper|exam):[^\s]+$/;
const ATTRIBUTIONS: readonly NotebookMarkingAttribution[] = [
  "linked-question",
  "page-topics",
  "notebook-topics",
];

/**
 * Which marker produced a verdict.
 *
 * Stored so a change in how Tutor marks can be told apart later, and so a
 * verdict from a marker that turned out to be wrong can be found and removed
 * rather than hunted for by date.
 */
export const NOTEBOOK_MARKER_VERSION = "tutor-notebook-marking-v1-2026-09-21";

export type NotebookMarkingCriterion = {
  criterion: string;
  awarded: boolean;
  awardedMarks?: number;
};

/** How a marking was placed on its concepts; a marking that could not be placed is not kept. */
export type NotebookMarkingAttribution = Exclude<NotebookPageAttribution, "none">;

export type NotebookMarking = {
  id: string;
  notebookId: string;
  pageId: string;
  /** Namespaced concept keys, `topic:<id>` or `spec:<id>`; evidence with none is not kept. */
  topicKeys: string[];
  attribution: NotebookMarkingAttribution;
  /** The piece of work marked, shared with that question's other evidence. */
  itemId: string;
  /** The study action the student was following when they asked, if any. */
  interventionId?: string;
  markedAt: number;
  criterionResults: NotebookMarkingCriterion[];
  awardedMarks: number;
  maxMarks: number;
  /** Always `tutor` today; present so a marking can never be mistaken for a scheme's. */
  provenance: "tutor";
  markerVersion: string;
};

export type NotebookMarkingWrite = Omit<NotebookMarking, "id"> & {
  schemaVersion: typeof NOTEBOOK_MARKING_SCHEMA_VERSION;
  createdAt: number;
};

function readId(value: unknown, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return id.length > 0 && id.length <= maxLength && !id.includes("/") ? id : "";
}

function readKey(value: unknown, pattern: RegExp) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  return key.length <= MAX_KEY_LENGTH && pattern.test(key) ? key : "";
}

function readMarks(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function readCriteria(value: unknown): NotebookMarkingCriterion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const criteria: NotebookMarkingCriterion[] = [];
  for (const candidate of value.slice(0, MAX_NOTEBOOK_CRITERIA)) {
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as Record<string, unknown>;
    const criterion =
      typeof record.criterion === "string" ? record.criterion.trim().slice(0, MAX_CRITERION_LENGTH) : "";
    if (!criterion || typeof record.awarded !== "boolean") return null;
    const awardedMarks = record.awardedMarks === undefined ? undefined : readMarks(record.awardedMarks);
    if (awardedMarks === null) return null;
    criteria.push({
      criterion,
      awarded: record.awarded,
      ...(awardedMarks !== undefined ? { awardedMarks } : {}),
    });
  }
  return criteria.length > 0 ? criteria : null;
}

export type NotebookMarkingRejection =
  | "declined"
  | "malformed"
  | "no_topics"
  | "marks_out_of_range"
  | "criteria_disagree_with_total";

export type NotebookMarkingResult =
  | { ok: true; marking: Omit<NotebookMarking, "id"> }
  | { ok: false; reason: NotebookMarkingRejection };

/**
 * A verdict, or the reason it is not one.
 *
 * The reason is returned rather than swallowed so the route can log which way
 * the model failed: a marker that is quietly rejected on every page looks
 * exactly like a marker nobody uses, and those need telling apart.
 */
export function readNotebookMarking(input: {
  verdict: unknown;
  notebookId: string;
  pageId: string;
  /** Where the page sits, from `resolveNotebookPageLearningContext`. */
  learning: NotebookPageLearningContext;
  markedAt: number;
}): NotebookMarkingResult {
  const notebookId = readId(input.notebookId);
  const pageId = readId(input.pageId);
  const itemId = readKey(input.learning.workItemId, ITEM_ID_PATTERN);
  if (!notebookId || !pageId || !itemId || !isValidEvidenceTime(input.markedAt)) {
    return { ok: false, reason: "malformed" };
  }

  const topicKeys = Array.from(
    new Set(input.learning.conceptKeys.map((key) => readKey(key, CONCEPT_KEY_PATTERN)).filter(Boolean))
  );
  const attribution = ATTRIBUTIONS.find((value) => value === input.learning.attribution);
  // Evidence that cannot be placed on a concept is not evidence the engine can use.
  if (topicKeys.length === 0 || !attribution) return { ok: false, reason: "no_topics" };
  const interventionId = readKey(input.learning.interventionId, /^.+$/);

  if (!input.verdict || typeof input.verdict !== "object" || Array.isArray(input.verdict)) {
    return { ok: false, reason: "malformed" };
  }
  const record = input.verdict as Record<string, unknown>;

  /*
   * The model saying it cannot mark this page.
   *
   * Checked first, and it exists because omitting an optional field turns out
   * not to be reachable: asked to mark a page with nothing markable on it, the
   * model writes "I can't mark this" in its answer and then emits a
   * structurally perfect nought out of six underneath. That is valid by every
   * other rule here, and it would record a student scoring zero on work that
   * was never assessed -- the one failure the whole fail-closed design was
   * meant to prevent, arriving in the one shape it could not see.
   *
   * So abstention is given somewhere to go. A marking that declines is not a
   * malformed marking and must not be counted as one: the model did exactly
   * the right thing, and the telemetry needs to say so.
   */
  if (record.canMark === false) return { ok: false, reason: "declined" };

  const awardedMarks = readMarks(record.awardedMarks);
  const maxMarks = readMarks(record.maxMarks);
  const criterionResults = readCriteria(record.criterionResults);
  if (awardedMarks === null || maxMarks === null || !criterionResults) {
    return { ok: false, reason: "malformed" };
  }
  if (maxMarks < 1 || maxMarks > MAX_NOTEBOOK_MARKS || awardedMarks > maxMarks) {
    return { ok: false, reason: "marks_out_of_range" };
  }

  /*
   * The coherence check, and the reason this is worth doing at all.
   *
   * A marker that awards four marks and then lists criteria adding to two has
   * not marked the work: it has written a number and then written a list. Only
   * checked when every criterion carries its own marks, because a marker may
   * legitimately give a tick-list without per-point tariffs.
   */
  const tariffed = criterionResults.filter((entry) => entry.awardedMarks !== undefined);
  if (tariffed.length === criterionResults.length) {
    const summed = criterionResults.reduce(
      (total, entry) => total + (entry.awarded ? (entry.awardedMarks ?? 0) : 0),
      0
    );
    if (summed !== awardedMarks) return { ok: false, reason: "criteria_disagree_with_total" };
  }

  return {
    ok: true,
    marking: {
      notebookId,
      pageId,
      topicKeys,
      attribution,
      itemId,
      ...(interventionId ? { interventionId } : {}),
      markedAt: input.markedAt,
      criterionResults,
      awardedMarks,
      maxMarks,
      provenance: "tutor",
      markerVersion: NOTEBOOK_MARKER_VERSION,
    },
  };
}

/**
 * One record per page per marker version.
 *
 * Re-marking a page replaces its verdict rather than adding another, which is
 * what the reader already assumes: asking Tutor to look again is one piece of
 * evidence looked at twice, not two pieces.
 */
export function notebookMarkingId(input: { notebookId: string; pageId: string }) {
  const notebookId = readId(input.notebookId);
  const pageId = readId(input.pageId);
  return notebookId && pageId ? `${notebookId}_${pageId}` : null;
}

export function buildNotebookMarkingWrite(
  marking: Omit<NotebookMarking, "id">,
  createdAt: number
): NotebookMarkingWrite {
  return { ...marking, schemaVersion: NOTEBOOK_MARKING_SCHEMA_VERSION, createdAt };
}

function readStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Where a stored record sits.
 *
 * A version-1 record was placed on its notebook's Topics and counted as its
 * own page, and is read as exactly that: re-attributing old evidence to a page
 * Topic set later would change what a past marking said.
 */
function storedLearning(data: Record<string, unknown>): NotebookPageLearningContext | null {
  const notebookId = typeof data.notebookId === "string" ? data.notebookId : "";
  const pageId = typeof data.pageId === "string" ? data.pageId : "";
  if (data.schemaVersion === LEGACY_NOTEBOOK_MARKING_SCHEMA_VERSION) {
    return {
      conceptKeys: readStringList(data.topicIds).map((topicId) => `topic:${topicId.trim()}`),
      attribution: "notebook-topics",
      workItemId: `notebook:${notebookId}:${pageId}`,
    };
  }
  if (data.schemaVersion !== NOTEBOOK_MARKING_SCHEMA_VERSION) return null;
  const attribution = ATTRIBUTIONS.find((value) => value === data.attribution);
  if (!attribution) return null;
  return {
    conceptKeys: readStringList(data.topicKeys),
    attribution,
    workItemId: typeof data.itemId === "string" ? data.itemId : "",
    ...(typeof data.interventionId === "string" ? { interventionId: data.interventionId } : {}),
  };
}

/** A stored record, or null for anything not a well-formed marking of a known version. */
export function decodeNotebookMarking(
  id: string,
  data: Record<string, unknown>
): NotebookMarking | null {
  if (!readId(id, 400) || data.provenance !== "tutor") return null;
  const learning = storedLearning(data);
  if (!learning) return null;
  const result = readNotebookMarking({
    verdict: data,
    notebookId: typeof data.notebookId === "string" ? data.notebookId : "",
    pageId: typeof data.pageId === "string" ? data.pageId : "",
    learning,
    markedAt: typeof data.markedAt === "number" ? data.markedAt : 0,
  });
  if (!result.ok) return null;
  return {
    id,
    ...result.marking,
    markerVersion:
      typeof data.markerVersion === "string" && data.markerVersion
        ? data.markerVersion
        : result.marking.markerVersion,
  };
}

/**
 * The shape the learner profile already reads.
 *
 * A deliberate translation rather than a shared type: the stored record is
 * about the marking, and `NotebookMarkedWorking` is about the evidence. Mixing
 * them would mean a change to how Tutor marks could reach the scorer without
 * anyone noticing it had.
 */
export function toNotebookMarkedWorking(marking: NotebookMarking): NotebookMarkedWorking {
  return {
    id: marking.id,
    notebookId: marking.notebookId,
    pageId: marking.pageId,
    topicKeys: marking.topicKeys,
    itemId: marking.itemId,
    ...(marking.interventionId ? { interventionId: marking.interventionId } : {}),
    markedAt: marking.markedAt,
    result: {
      attempted: true,
      counted: true,
      awardedMarks: marking.awardedMarks,
      maxMarks: marking.maxMarks,
      criterionResults: marking.criterionResults,
    },
  };
}
