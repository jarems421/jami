import "server-only";

import { tutorMemoryConcerns } from "@/lib/ai/tutor-memory";
import { loadTutorMemory } from "@/services/ai/tutor-memory.server";
import {
  FLASHCARD_REVIEW_EVENTS_COLLECTION,
  decodeFlashcardReviewEvent,
  type FlashcardReviewEvent,
} from "@/lib/learning/events/flashcard-review-event";
import {
  buildLearnerProfile,
  type LearnerEvidence,
  type LearnerSpecification,
} from "@/lib/learning/profile/build-learner-profile";
import type { LearnerExposureItem } from "@/lib/learning/profile/exposure";
import type { TopicRelationInput } from "@/lib/learning/concepts/topic-relations";
import type { FlashcardEvidenceCard } from "@/lib/learning/profile/flashcard-signals";
import type { StoredMarkedAnswer } from "@/lib/learning/profile/marked-answer";
import type { PastPaperEvidenceAttempt } from "@/lib/learning/profile/past-paper-signals";
import type { NotebookMarkedWorking } from "@/lib/learning/profile/notebook-signals";
import type { PracticePaperEvidenceAttempt } from "@/lib/learning/profile/practice-signals";
import type {
  LearnerEvidenceLimit,
  LearnerEvidenceSource,
  LearnerProfile,
  LearnerProfileScope,
  LearningConcept,
  LearningTopicLabel,
} from "@/lib/learning/types";
import { featureFlags } from "@/lib/app/feature-flags";
import { mapSourceData } from "@/lib/material/sources";
import { mapTopicData, type Topic } from "@/lib/material/topics";
import { servableExamSpecificationConcepts } from "@/lib/practice/exam-specification-concepts";
import { servableExamSpecificationTopics } from "@/lib/practice/exam-specification-topics";
import { mapPracticePaperData } from "@/lib/practice/practice-papers";
import { mapPracticePaperAttemptData } from "@/lib/practice/practice-paper-results";
import { mapCardData } from "@/lib/study/cards";
import { mapNotebookData } from "@/lib/workspace/notebooks";
import { mapStudyFolderData, type StudyFolder } from "@/lib/workspace/study-folders";
import { loadNotebookMarkings } from "@/services/learning/notebook-markings.server";
import { loadRevisionEvidence } from "@/services/learning/revision-sessions.server";
import { loadTutorChecks } from "@/services/learning/tutor-checks.server";
import { getAdminDb } from "@/services/firebase/admin";

type AdminDb = ReturnType<typeof getAdminDb>;

/**
 * How much of a student's history one profile reads.
 *
 * The profile is built per request, so every read is bounded: a folder's most
 * recent decks, a page of cards from each, the most recent review events,
 * practice sessions, papers, notebooks and sources. Recent work is what the
 * profile weights most anyway. When a cap is reached the profile says so in
 * its diagnostics rather than silently presenting part of the history as all
 * of it.
 */
export const LEARNER_PROFILE_LOAD_LIMITS = {
  decks: 8,
  cardsPerDeck: 250,
  /** Cards read directly because a recent review points at them and the deck's page missed them. */
  reviewedCards: 200,
  flashcardEvents: 600,
  examSessions: 40,
  examAttemptsPerQuery: 300,
  practicePapers: 20,
  practiceAttemptsPerQuery: 60,
  notebooks: 60,
  sources: 60,
  topicLabels: 60,
  /** Parent and merge-target Topics fetched beyond the ones evidence names. */
  topicLinks: 20,
} as const;

/** How many rounds of parent and merge links are followed; deeper student hierarchies are rare. */
const MAX_TOPIC_LINK_ROUNDS = 3;

const FIRESTORE_IN_LIMIT = 30;
const OWNER_FIELDS = ["userId", "uid"] as const;
/** Only what scoring reads, so a deck of long cards does not travel for nothing. */
const CARD_EVIDENCE_FIELDS = [
  "userId",
  "uid",
  "deckId",
  "topicIds",
  "reps",
  "lapses",
  "difficulty",
  "fsrsState",
  "lastReview",
  "dueDate",
  "createdAt",
] as const;

type DeckSummary = { id: string; name: string };

/** What went unseen while loading, reported with the profile. */
type LoadNotes = {
  limits: Set<LearnerEvidenceLimit>;
  unavailable: Set<LearnerEvidenceSource>;
};

function chunk<T>(values: readonly T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function readString(value: unknown, maxLength = 160) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ownerOf(data: Record<string, unknown>) {
  return readString(data.userId) || readString(data.uid);
}

function deckName(data: Record<string, unknown>) {
  return readString(data.name, 80) || "Untitled deck";
}

async function loadFolder(db: AdminDb, uid: string, folderId: string): Promise<StudyFolder | null> {
  const snapshot = await db
    .collection("users")
    .doc(uid)
    .collection("studyFolders")
    .doc(folderId)
    .get();
  if (!snapshot.exists) return null;
  return mapStudyFolderData(folderId, (snapshot.data() ?? {}) as Record<string, unknown>);
}

/** The folder's exam specification, when it has one with a servable topic catalogue. */
function folderSpecification(folder: StudyFolder): LearnerSpecification | undefined {
  const course = folder.examCourse;
  const catalogue = course ? servableExamSpecificationTopics(course.specificationId) : undefined;
  if (!course || !catalogue) return undefined;
  return {
    id: course.specificationId,
    title: course.specificationTitle,
    topics: catalogue.topics.map((topic) => ({ id: topic.id, label: topic.label })),
  };
}

async function loadFolderDecks(db: AdminDb, uid: string, folderId: string, notes: LoadNotes) {
  const snapshots = await Promise.all(
    OWNER_FIELDS.map((ownerField) =>
      db
        .collection("decks")
        .where(ownerField, "==", uid)
        .where("folderIds", "array-contains", folderId)
        .orderBy("createdAt", "desc")
        .limit(LEARNER_PROFILE_LOAD_LIMITS.decks)
        .get()
    )
  );
  const decks = new Map<string, DeckSummary & { createdAt: number }>();
  for (const snapshot of snapshots) {
    if (snapshot.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.decks) notes.limits.add("decks");
    for (const deckDoc of snapshot.docs) {
      const data = deckDoc.data() as Record<string, unknown>;
      if (ownerOf(data) !== uid) continue;
      const createdAt = typeof data.createdAt === "number" ? data.createdAt : 0;
      decks.set(deckDoc.id, { id: deckDoc.id, name: deckName(data), createdAt });
    }
  }
  if (decks.size > LEARNER_PROFILE_LOAD_LIMITS.decks) notes.limits.add("decks");
  // Each owner query is newest first; merged the same way, so the limit keeps the newest of both.
  return Array.from(decks.values())
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, LEARNER_PROFILE_LOAD_LIMITS.decks)
    .map(({ id, name }) => ({ id, name }));
}

async function loadOwnedDeck(db: AdminDb, uid: string, deckId: string) {
  const snapshot = await db.collection("decks").doc(deckId).get();
  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!snapshot.exists || ownerOf(data) !== uid) return [];
  return [{ id: deckId, name: deckName(data) }];
}

async function loadDeckCards(
  db: AdminDb,
  uid: string,
  deckId: string,
  notes: LoadNotes
): Promise<FlashcardEvidenceCard[]> {
  const snapshots = await Promise.all(
    OWNER_FIELDS.map((ownerField) =>
      db
        .collection("cards")
        .where(ownerField, "==", uid)
        .where("deckId", "==", deckId)
        .select(...CARD_EVIDENCE_FIELDS)
        .limit(LEARNER_PROFILE_LOAD_LIMITS.cardsPerDeck)
        .get()
    )
  );
  const cards = new Map<string, FlashcardEvidenceCard>();
  for (const snapshot of snapshots) {
    if (snapshot.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.cardsPerDeck) notes.limits.add("cards");
    for (const cardDoc of snapshot.docs) {
      const card = mapCardData(cardDoc.id, cardDoc.data() as Record<string, unknown>);
      // A card claiming another deck, or another owner, is not this deck's evidence.
      if (card.userId !== uid || card.deckId !== deckId) continue;
      cards.set(cardDoc.id, card);
    }
  }
  return Array.from(cards.values());
}

/**
 * Cards that recent review events point at, but the per-deck card page missed.
 *
 * A deck's cards are read a bounded page at a time, in no particular order,
 * so in a large deck the card a student reviewed this morning could fall
 * outside the page and its newest evidence be dropped. Those cards are read
 * directly, most recently reviewed first and within a cap, and still checked
 * against the owner and the decks in scope.
 */
async function loadReviewedCards(
  db: AdminDb,
  uid: string,
  deckIds: readonly string[],
  cards: readonly FlashcardEvidenceCard[],
  events: readonly FlashcardReviewEvent[],
  notes: LoadNotes
): Promise<FlashcardEvidenceCard[]> {
  const known = new Set(cards.map((card) => card.id));
  const missing = Array.from(new Set(events.map((event) => event.cardId))).filter(
    (cardId) => cardId && !known.has(cardId)
  );
  if (missing.length === 0) return [];
  if (missing.length > LEARNER_PROFILE_LOAD_LIMITS.reviewedCards) notes.limits.add("cards");
  const inScope = new Set(deckIds);
  try {
    const snapshots = (
      await Promise.all(
        chunk(missing.slice(0, LEARNER_PROFILE_LOAD_LIMITS.reviewedCards), 100).map((ids) =>
          db.getAll(...ids.map((cardId) => db.collection("cards").doc(cardId)))
        )
      )
    ).flat();
    return snapshots.flatMap((snapshot) => {
      if (!snapshot.exists) return [];
      const card = mapCardData(snapshot.id, (snapshot.data() ?? {}) as Record<string, unknown>);
      return card.userId === uid && inScope.has(card.deckId) ? [card] : [];
    });
  } catch {
    // The paged cards still stand; only the extra evidence is missing.
    return [];
  }
}

/**
 * The most recent recorded reviews for these decks.
 *
 * Read on its own terms: a missing index or any other failure here leaves the
 * profile on the cards' aggregate state, exactly as before events existed,
 * and is reported as an unavailable source rather than failing the profile.
 */
async function loadFlashcardReviewEvents(
  db: AdminDb,
  uid: string,
  deckIds: readonly string[],
  notes: LoadNotes
): Promise<FlashcardReviewEvent[]> {
  if (deckIds.length === 0) return [];
  try {
    const events = db.collection("users").doc(uid).collection(FLASHCARD_REVIEW_EVENTS_COLLECTION);
    const snapshots = await Promise.all(
      chunk(deckIds, FIRESTORE_IN_LIMIT).map((ids) =>
        events
          .where("deckId", "in", ids)
          .orderBy("reviewedAt", "desc")
          .limit(LEARNER_PROFILE_LOAD_LIMITS.flashcardEvents)
          .get()
      )
    );
    const decoded = new Map<string, FlashcardReviewEvent>();
    for (const snapshot of snapshots) {
      if (snapshot.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.flashcardEvents) {
        notes.limits.add("flashcard-events");
      }
      for (const eventDoc of snapshot.docs) {
        const event = decodeFlashcardReviewEvent(
          eventDoc.id,
          eventDoc.data() as Record<string, unknown>
        );
        if (event) decoded.set(event.id, event);
      }
    }
    return Array.from(decoded.values());
  } catch {
    notes.unavailable.add("flashcard-events");
    return [];
  }
}

/**
 * Topic-linked notebooks and sources in the folder: exposure, not evidence.
 *
 * Only the fields that say which topics the material is linked to are read --
 * never titles, page text or source content. Scoped to the folder by query,
 * then checked again on the document, so material from another folder cannot
 * leak in. Like review history, a failure here degrades the profile to "no
 * exposure known" rather than failing it.
 *
 * Also returns every notebook in the folder, Topics or not. Marked working is
 * placed by each marking's own concepts -- a page's linked question or its own
 * Topics -- so an untagged notebook still has evidence to give; only exposure
 * needs a notebook's Topics.
 */
async function loadFolderExposure(
  db: AdminDb,
  uid: string,
  folderId: string,
  notes: LoadNotes,
  /**
   * Specification ids that are not student Topics. Practice Jami wrote for a
   * specification concept once filed the concept's id among its notebook's
   * Topics, where it read as a Topic nobody had made; those are left out.
   */
  specificationIds: ReadonlySet<string>
): Promise<{ items: LearnerExposureItem[]; notebookIds: string[] }> {
  try {
    const userRef = db.collection("users").doc(uid);
    const [notebooks, sources] = await Promise.all([
      userRef
        .collection("notebooks")
        .where("folderId", "==", folderId)
        .where("archived", "==", false)
        .orderBy("updatedAt", "desc")
        .select("folderId", "archived", "topicIds", "updatedAt")
        .limit(LEARNER_PROFILE_LOAD_LIMITS.notebooks)
        .get(),
      userRef
        .collection("sources")
        .where("status", "==", "active")
        .where("folderIds", "array-contains", folderId)
        .orderBy("updatedAt", "desc")
        .select("status", "folderIds", "topicIds", "updatedAt")
        .limit(LEARNER_PROFILE_LOAD_LIMITS.sources)
        .get(),
    ]);
    if (notebooks.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.notebooks) notes.limits.add("notebooks");
    if (sources.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.sources) notes.limits.add("sources");

    const items: LearnerExposureItem[] = [];
    const notebookIds: string[] = [];
    for (const notebookDoc of notebooks.docs) {
      const notebook = mapNotebookData(notebookDoc.id, notebookDoc.data() as Record<string, unknown>);
      if (notebook.archived || notebook.folderId !== folderId) continue;
      notebookIds.push(notebook.id);
      const topicIds = notebook.topicIds.filter((topicId) => !specificationIds.has(topicId));
      if (topicIds.length === 0) continue;
      items.push({ kind: "notebook", id: notebook.id, topicIds, at: notebook.updatedAt });
    }
    for (const sourceDoc of sources.docs) {
      const source = mapSourceData(sourceDoc.id, sourceDoc.data() as Record<string, unknown>);
      if (source.status !== "active" || !source.folderIds.includes(folderId) || source.topicIds.length === 0) {
        continue;
      }
      items.push({ kind: "source", id: source.id, topicIds: source.topicIds, at: source.updatedAt });
    }
    return { items, notebookIds };
  } catch {
    notes.unavailable.add("exposure");
    return { items: [], notebookIds: [] };
  }
}

/**
 * The student Topics in scope, as concepts with their hierarchy.
 *
 * The folder's own topic list comes first, then the most-used Topics across its
 * cards and material. Parents and merge targets are then followed for a few
 * bounded rounds, so evidence on a sub-Topic rolls up and a merged Topic's
 * history counts towards the Topic it became. Only active Topics become
 * concepts; an archived one is left out, and a merged one becomes a redirect.
 */
async function loadStudentTopicConcepts(
  db: AdminDb,
  uid: string,
  input: {
    declaredTopicIds: readonly string[];
    cards: readonly FlashcardEvidenceCard[];
    exposureItems: readonly LearnerExposureItem[];
    /** Topics a marked notebook page was placed on, which may be the page's own. */
    notebookMarkings: readonly NotebookMarkedWorking[];
  },
  notes: LoadNotes
): Promise<{
  concepts: LearningConcept[];
  redirects: Record<string, string>;
  relations: TopicRelationInput[];
}> {
  const usage = new Map<string, number>();
  const use = (topicId: string) => {
    if (topicId) usage.set(topicId, (usage.get(topicId) ?? 0) + 1);
  };
  input.cards.forEach((card) => (card.topicIds ?? []).forEach(use));
  input.exposureItems.forEach((item) => item.topicIds.forEach(use));
  input.notebookMarkings.forEach((marking) =>
    marking.topicKeys.forEach((key) => {
      if (key.startsWith("topic:")) use(key.slice("topic:".length));
    })
  );
  input.declaredTopicIds.forEach(use);

  const declared = new Set(input.declaredTopicIds);
  if (usage.size > LEARNER_PROFILE_LOAD_LIMITS.topicLabels) notes.limits.add("topic-labels");
  const topicIds = Array.from(usage)
    .sort(
      (left, right) =>
        Number(declared.has(right[0])) - Number(declared.has(left[0])) ||
        right[1] - left[1] ||
        left[0].localeCompare(right[0])
    )
    .slice(0, LEARNER_PROFILE_LOAD_LIMITS.topicLabels)
    .map(([topicId]) => topicId);
  const topics = db.collection("users").doc(uid).collection("topics");
  const loaded = new Map<string, Topic>();
  let pending = topicIds;
  let linkBudget: number = LEARNER_PROFILE_LOAD_LIMITS.topicLinks;
  for (let round = 0; pending.length > 0; round += 1) {
    // One round trip per round, rather than one per Topic.
    const snapshots = await db.getAll(...pending.map((id) => topics.doc(id)));
    const links = new Set<string>();
    snapshots.forEach((snapshot, index) => {
      const topicId = pending[index];
      if (!topicId || !snapshot.exists) return;
      const topic = mapTopicData(topicId, (snapshot.data() ?? {}) as Record<string, unknown>);
      loaded.set(topicId, topic);
      const mergedInto = topic.status === "merged" ? topic.mergedIntoTopicId : undefined;
      for (const link of [topic.parentTopicId, mergedInto]) {
        if (link && link !== topicId) links.add(link);
      }
    });
    const unseen = Array.from(links).filter((id) => !loaded.has(id)).sort();
    if (round >= MAX_TOPIC_LINK_ROUNDS || linkBudget <= 0) {
      if (unseen.length > 0) notes.limits.add("topic-labels");
      break;
    }
    pending = unseen.slice(0, linkBudget);
    if (unseen.length > pending.length) notes.limits.add("topic-labels");
    linkBudget -= pending.length;
  }

  const concepts: LearningConcept[] = [];
  const redirects: Record<string, string> = {};
  const relations: TopicRelationInput[] = [];
  for (const [topicId, topic] of Array.from(loaded).sort(([left], [right]) => left.localeCompare(right))) {
    if (topic.status === "merged" && topic.mergedIntoTopicId) {
      redirects[`topic:${topicId}`] = `topic:${topic.mergedIntoTopicId}`;
      continue;
    }
    if (topic.status !== "active") continue;
    const parent = topic.parentTopicId ? loaded.get(topic.parentTopicId) : undefined;
    concepts.push({
      key: `topic:${topicId}`,
      label: topic.name,
      source: "student-topic",
      provenance: "student_defined",
      verified: true,
      ...(parent && parent.status === "active" ? { parentKey: `topic:${parent.id}` } : {}),
      ...(topic.aliases && topic.aliases.length > 0 ? { aliases: [...topic.aliases] } : {}),
    });
    /*
     * Collected whatever the flag says; the registry decides whether to use
     * them. Reading is free once the Topic is already loaded, and a loader
     * that quietly returned a different shape per flag would make the two
     * paths harder to compare than the feature is worth.
     */
    if (topic.specificationRelation) {
      relations.push({ topicId, relation: topic.specificationRelation });
    }
  }
  return { concepts, redirects, relations };
}

/** Verified finer concepts beneath the folder's specification topics, if its catalogue has any. */
function folderSpecificationConcepts(folder: StudyFolder): LearningConcept[] {
  const course = folder.examCourse;
  if (!course) return [];
  return servableExamSpecificationConcepts(course.specificationId).map((concept) => ({
    key: `spec:${concept.id}`,
    label: concept.label,
    source: "specification",
    provenance: "verified_specification",
    verified: true,
    parentKey: `spec:${concept.parentTopicId}`,
    ...(concept.aliases ? { aliases: [...concept.aliases] } : {}),
    ...(concept.reference ? { reference: concept.reference } : {}),
  }));
}

/**
 * Marked Past Paper Practice answers in the folder, with their topics.
 *
 * Topics come from the session's own snapshot of each question and are kept
 * only when a servable catalogue names them, so the profile never shows a topic
 * the specification does not. Only scores, specification headings and each
 * question's command word ("Explain", "Show that") leave here -- no other
 * question wording and no mark scheme -- so nothing licensed reaches the prompt
 * through the profile. Sessions or answers the student deleted are left out.
 */
async function loadPastPaperEvidence(db: AdminDb, uid: string, folderId: string, notes: LoadNotes) {
  const labels: Record<string, LearningTopicLabel> = {};
  if (!featureFlags.enablePastPaperPractice) return { attempts: [], labels };

  const userRef = db.collection("users").doc(uid);
  const sessions = await userRef
    .collection("examSessions")
    .where("folderId", "==", folderId)
    .orderBy("updatedAt", "desc")
    .limit(LEARNER_PROFILE_LOAD_LIMITS.examSessions)
    .get();
  if (sessions.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.examSessions) {
    notes.limits.add("exam-sessions");
  }

  const questionTopics = new Map<string, { topicIds: string[]; conceptIds: string[]; commandWord: string }>();
  const sessionIds: string[] = [];
  for (const sessionDoc of sessions.docs) {
    const data = sessionDoc.data() as Record<string, unknown>;
    if (readNumber(data.answersDeletedAt) || readString(data.folderId) !== folderId) continue;
    const specificationId = readString(readRecord(data.course)?.specificationId);
    const catalogue = specificationId
      ? servableExamSpecificationTopics(specificationId)
      : undefined;
    const labelById = new Map(catalogue?.topics.map((topic) => [topic.id, topic.label]) ?? []);
    const conceptLabelById = new Map(
      (specificationId ? servableExamSpecificationConcepts(specificationId) : []).map((concept) => [
        concept.id,
        concept.label,
      ])
    );
    const questions = Array.isArray(data.questions) ? data.questions : [];
    for (const item of questions) {
      const question = readRecord(item);
      const questionId = readString(question?.id);
      if (!question || !questionId) continue;
      const topicIds = (Array.isArray(question.topicIds) ? question.topicIds : []).filter(
        (topicId): topicId is string => typeof topicId === "string" && labelById.has(topicId)
      );
      const conceptIds = (Array.isArray(question.conceptIds) ? question.conceptIds : []).filter(
        (conceptId): conceptId is string => typeof conceptId === "string" && conceptLabelById.has(conceptId)
      );
      const commandWord = typeof question.commandWord === "string" ? question.commandWord.slice(0, 40) : "";
      questionTopics.set(`${sessionDoc.id}:${questionId}`, { topicIds, conceptIds, commandWord });
      for (const topicId of topicIds) {
        const label = labelById.get(topicId);
        if (label) labels[`spec:${topicId}`] = { label, source: "specification" };
      }
      // Labelled too, so a concept from an earlier course of the folder still reads as itself.
      for (const conceptId of conceptIds) {
        const label = conceptLabelById.get(conceptId);
        if (label) labels[`spec:${conceptId}`] = { label, source: "specification" };
      }
    }
    sessionIds.push(sessionDoc.id);
  }

  const attemptSnapshots = await Promise.all(
    chunk(sessionIds, FIRESTORE_IN_LIMIT).map((ids) =>
      userRef
        .collection("examAttempts")
        .where("sessionId", "in", ids)
        // Newest first, so a capped read loses the oldest answers, not a random slice.
        .orderBy("updatedAt", "desc")
        .limit(LEARNER_PROFILE_LOAD_LIMITS.examAttemptsPerQuery)
        .get()
    )
  );
  const known = new Set(sessionIds);
  const attempts = new Map<string, PastPaperEvidenceAttempt>();
  for (const snapshot of attemptSnapshots) {
    if (snapshot.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.examAttemptsPerQuery) {
      notes.limits.add("exam-attempts");
    }
    for (const attemptDoc of snapshot.docs) {
      const data = attemptDoc.data() as Record<string, unknown>;
      const sessionId = readString(data.sessionId);
      const questionId = readString(data.questionId);
      if (
        data.status !== "marked" ||
        readNumber(data.answerDeletedAt) ||
        !known.has(sessionId) ||
        !questionId
      ) {
        continue;
      }
      const result = readRecord(data.result) as StoredMarkedAnswer | undefined;
      const markedAt = readNumber(data.markedAt);
      const details = questionTopics.get(`${sessionId}:${questionId}`);
      attempts.set(attemptDoc.id, {
        id: attemptDoc.id,
        questionId,
        attemptNumber: readNumber(data.attemptNumber) ?? 1,
        ...(markedAt !== undefined ? { markedAt } : {}),
        updatedAt: readNumber(data.updatedAt) ?? 0,
        topicIds: details?.topicIds ?? [],
        ...(details?.conceptIds.length ? { conceptIds: details.conceptIds } : {}),
        ...(details?.commandWord ? { commandWord: details.commandWord } : {}),
        ...(result ? { result } : {}),
      });
    }
  }
  return { attempts: Array.from(attempts.values()), labels };
}

async function loadPracticePaperEvidence(
  db: AdminDb,
  uid: string,
  folderId: string,
  notes: LoadNotes,
  /** The folder's course, so a paper's stored concept ids can be checked. */
  specificationId?: string
) {
  const userRef = db.collection("users").doc(uid);
  const papers = await userRef
    .collection("pastPapers")
    .where("folderId", "==", folderId)
    .orderBy("updatedAt", "desc")
    .limit(LEARNER_PROFILE_LOAD_LIMITS.practicePapers)
    .get();
  if (papers.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.practicePapers) {
    notes.limits.add("practice-papers");
  }
  const paperIds = papers.docs.map((paperDoc) => paperDoc.id);
  const snapshots = await Promise.all(
    chunk(paperIds, FIRESTORE_IN_LIMIT).map((ids) =>
      userRef
        .collection("practicePaperAttempts")
        .where("paperId", "in", ids)
        .limit(LEARNER_PROFILE_LOAD_LIMITS.practiceAttemptsPerQuery)
        .get()
    )
  );
  const known = new Set(paperIds);
  /*
   * Each paper's own record of what its questions were written against, read
   * from the paper rather than the attempt, so a paper re-tagged later does
   * not leave past sittings disagreeing about the same question.
   */
  const conceptsByPaper = new Map<string, Record<string, readonly string[]>>();
  for (const paperDoc of papers.docs) {
    const paper = mapPracticePaperData(
      paperDoc.id,
      paperDoc.data() as Record<string, unknown>,
      specificationId
    );
    const byQuestion: Record<string, readonly string[]> = {};
    for (const question of paper.questions) {
      if (question.conceptIds?.length) byQuestion[question.id] = question.conceptIds;
    }
    if (Object.keys(byQuestion).length > 0) conceptsByPaper.set(paperDoc.id, byQuestion);
  }

  const attempts = new Map<string, PracticePaperEvidenceAttempt>();
  for (const snapshot of snapshots) {
    if (snapshot.docs.length >= LEARNER_PROFILE_LOAD_LIMITS.practiceAttemptsPerQuery) {
      notes.limits.add("practice-attempts");
    }
    for (const attemptDoc of snapshot.docs) {
      const attempt = mapPracticePaperAttemptData(
        attemptDoc.id,
        attemptDoc.data() as Record<string, unknown>
      );
      if (attempt.status !== "marked" || !attempt.result || !known.has(attempt.paperId)) {
        continue;
      }
      attempts.set(attempt.id, {
        id: attempt.id,
        paperId: attempt.paperId,
        assisted: attempt.assisted,
        ...(attempt.markedAt !== undefined ? { markedAt: attempt.markedAt } : {}),
        updatedAt: attempt.updatedAt,
        questionResults: attempt.result.questionResults,
        ...(conceptsByPaper.has(attempt.paperId)
          ? { conceptIdsByQuestion: conceptsByPaper.get(attempt.paperId) }
          : {}),
      });
    }
  }
  return Array.from(attempts.values());
}

export type LearnerEvidenceRequest = {
  uid: string;
  folderId?: string;
  deckId?: string;
  /** The folder document, when the caller already has it, so it is not read twice. */
  folder?: StudyFolder;
};

/**
 * The evidence for one folder or one deck, loaded and scoped.
 *
 * A folder is the unit that means one subject, so it is the scope whenever
 * there is one; a deck is the fallback for a card that sits in no single
 * folder. An account-wide profile is deliberately not offered -- it would set a
 * student's chemistry against their history essays.
 *
 * Returns null when there is no scope, or when the folder or deck no longer
 * exists for this student: deleted material produces nothing at all.
 */
export async function loadLearnerEvidence(
  input: LearnerEvidenceRequest
): Promise<{ scope: LearnerProfileScope; evidence: LearnerEvidence } | null> {
  const uid = input.uid.trim();
  const folderId = input.folderId?.trim();
  const deckId = input.deckId?.trim();
  if (!uid || (!folderId && !deckId)) return null;

  const db = getAdminDb();
  const notes: LoadNotes = { limits: new Set(), unavailable: new Set() };

  let decks: DeckSummary[];
  let folder: StudyFolder | null = null;
  if (folderId) {
    const [loadedFolder, folderDecks] = await Promise.all([
      input.folder && input.folder.id === folderId
        ? Promise.resolve(input.folder)
        : loadFolder(db, uid, folderId),
      loadFolderDecks(db, uid, folderId, notes),
    ]);
    if (!loadedFolder) return null;
    folder = loadedFolder;
    decks = folderDecks;
  } else {
    decks = await loadOwnedDeck(db, uid, deckId ?? "");
    if (decks.length === 0) return null;
  }
  const deckIds = decks.map((deck) => deck.id);
  const specification = folder ? folderSpecification(folder) : undefined;
  const specificationConcepts = folder ? folderSpecificationConcepts(folder) : [];
  const specificationIds = new Set([
    ...(specification?.topics ?? []).map((topic) => topic.id),
    ...specificationConcepts.map((concept) => concept.key.slice("spec:".length)),
  ]);

  const [cardLists, flashcardReviewEvents, pastPaper, practicePaperAttempts, folderMaterial] =
    await Promise.all([
      Promise.all(deckIds.map((id) => loadDeckCards(db, uid, id, notes))),
      loadFlashcardReviewEvents(db, uid, deckIds, notes),
      folderId
        ? loadPastPaperEvidence(db, uid, folderId, notes)
        : Promise.resolve({ attempts: [], labels: {} }),
      folderId
        ? loadPracticePaperEvidence(
            db,
            uid,
            folderId,
            notes,
            folder?.examCourse?.specificationId
          )
        : Promise.resolve([]),
      folderId
        ? loadFolderExposure(db, uid, folderId, notes, specificationIds)
        : Promise.resolve({ items: [], notebookIds: [] }),
    ]);
  const exposureItems = folderMaterial.items;
  const pagedCards = cardLists.flat();
  const declaredTopicIds = folder?.topicIds ?? [];
  /*
   * Two chains that share nothing, run side by side. The cards a student has
   * reviewed have to be read before their topics can be, but notebook marking
   * and revision sessions need only what is already loaded, and waiting for the
   * card chain added a round trip per folder to Today for no reason.
   */
  /*
   * Marked notebook working in every notebook the folder holds, whether or not
   * the notebook has Topics: each marking carries its own concepts, and one
   * that has none is dropped by the reader, not here. The Topics a page was
   * marked against are looked up with the rest, so a page Topic has its name.
   */
  const notebookMarkingsLoading = loadNotebookMarkings({ uid, notebookIds: folderMaterial.notebookIds });
  const [{ cards, studentTopics }, [notebookMarkings, revisionSessions, studentConcerns, tutorChecks]] = await Promise.all([
    (async () => {
      const [reviewedCards, notebookMarkings] = await Promise.all([
        loadReviewedCards(db, uid, deckIds, pagedCards, flashcardReviewEvents, notes),
        notebookMarkingsLoading,
      ]);
      const cards = [...pagedCards, ...reviewedCards];
      const studentTopics = await loadStudentTopicConcepts(
        db,
        uid,
        { declaredTopicIds, cards, exposureItems, notebookMarkings },
        notes
      );
      return { cards, studentTopics };
    })(),
    Promise.all([
      notebookMarkingsLoading,
      // Finished Revision Sessions opened from this scope's own recommendations.
      featureFlags.enableRevisionSessions
        ? loadRevisionEvidence({
            uid,
            ...(folderId ? { folderId } : deckId ? { deckId } : {}),
          })
        : Promise.resolve([]),
      loadStudentConcerns(uid),
      // Tutor's quick checks asked in this scope; see `tutor-check-signals.ts`.
      loadTutorChecks({ uid, ...(folderId ? { folderId } : deckId ? { deckId } : {}) }),
    ]),
  ]);

  const evidence: LearnerEvidence = {
    cards,
    flashcardReviewEvents,
    pastPaperAttempts: pastPaper.attempts,
    practicePaperAttempts,
    notebookMarkings,
    revisionSessions,
    ...(tutorChecks.length > 0 ? { tutorChecks } : {}),
    topicLabels: {
      ...Object.fromEntries(
        decks.map((deck) => [`deck:${deck.id}`, { label: deck.name, source: "deck" as const }])
      ),
      ...pastPaper.labels,
    },
    concepts: [...studentTopics.concepts, ...specificationConcepts],
    conceptRedirects: studentTopics.redirects,
    ...(featureFlags.enableConceptRelations
      ? { topicRelations: studentTopics.relations }
      : {}),
    exposureItems,
    ...(studentConcerns.length > 0 ? { studentConcerns } : {}),
    declaredTopicKeys: [
      ...declaredTopicIds.map((topicId) => `topic:${topicId}`),
      ...specificationConcepts.map((concept) => concept.key),
    ],
    ...(specification ? { specification } : {}),
    limitsReached: Array.from(notes.limits),
    unavailableSources: Array.from(notes.unavailable),
  };

  return {
    scope: folderId ? { folderId, deckIds } : { deckId },
    evidence,
  };
}

/**
 * The Topics the student has told Tutor they find hard, from Tutor's memory,
 * as keys and times only. Memory switched off, or unreadable, gives none: it
 * orders advice and nothing else, so its absence costs nothing but the order.
 */
async function loadStudentConcerns(uid: string) {
  if (!featureFlags.enableTutorMemory) return [];
  try {
    return tutorMemoryConcerns(await loadTutorMemory(uid), Date.now());
  } catch {
    return [];
  }
}

/** What Jami currently believes about a student, for one folder or one deck. */
export async function loadLearnerProfile(
  input: LearnerEvidenceRequest & { now?: number }
): Promise<LearnerProfile | null> {
  const loaded = await loadLearnerEvidence(input);
  if (!loaded) return null;
  return buildLearnerProfile({
    scope: loaded.scope,
    evidence: loaded.evidence,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
