import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { beforeAll, afterAll, afterEach, describe, it } from "vitest";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const rules = readFileSync(path.join(rootDir, "firestore.rules"), "utf8");

const ALICE = "alice";
const BOB = "bob";
const ALICE_DECK_ID = "deck-alice";
const BOB_DECK_ID = "deck-bob";
const LEGACY_ALICE_DECK_ID = "deck-legacy-alice";

let testEnv: RulesTestEnvironment;

async function seedData() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const adminDb = context.firestore();

    await Promise.all([
      setDoc(doc(adminDb, "users", ALICE), { createdAt: 1 }),
      setDoc(doc(adminDb, "users", BOB), { createdAt: 1 }),
      setDoc(doc(adminDb, "decks", ALICE_DECK_ID), {
        name: "Alice deck",
        userId: ALICE,
        createdAt: 1,
      }),
      setDoc(doc(adminDb, "decks", BOB_DECK_ID), {
        name: "Bob deck",
        uid: BOB,
        createdAt: 1,
      }),
      setDoc(doc(adminDb, "decks", LEGACY_ALICE_DECK_ID), {
        name: "Legacy Alice deck",
        uid: ALICE,
        createdAt: 1,
      }),
      setDoc(doc(adminDb, "cards", "alice-card"), {
        deckId: ALICE_DECK_ID,
        userId: ALICE,
        front: "Question",
        back: "Answer",
        tags: ["biology"],
        createdAt: 1,
        dueDate: 100,
        stability: 2,
        difficulty: 5,
        fsrsState: 2,
        lapses: 1,
        reps: 2,
      }),
    ]);
  });
}

describe("Firestore security rules", () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "demo-jami",
      firestore: { rules },
    });
  });

  afterEach(async () => {
    await testEnv.clearFirestore();
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it("blocks unauthenticated reads to private data", async () => {
    await seedData();

    const guestDb = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(guestDb, "decks", ALICE_DECK_ID)));
    await assertFails(getDoc(doc(guestDb, "users", ALICE)));
  });

  it("lets a student read their Tutor settings but never write them directly", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const guestDb = testEnv.unauthenticatedContext().firestore();

    const settingsPath = ["users", ALICE, "tutorPersonalisation", "settings"] as const;

    // Seeded past the rules, which is the only way this document is ever
    // written: the settings route uses the Admin SDK so one normalisation and
    // one set of length limits apply to every write.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), ...settingsPath), {
        version: 1,
        helpApproach: "hints-first",
        updatedAt: 1,
      });
    });

    await assertSucceeds(getDoc(doc(aliceDb, ...settingsPath)));
    await assertFails(getDoc(doc(bobDb, ...settingsPath)));
    await assertFails(getDoc(doc(guestDb, ...settingsPath)));

    // A client that could write here could set guidance the server never
    // normalised, including a document past the length the prompt budgets for.
    await assertFails(
      setDoc(doc(aliceDb, ...settingsPath), { helpApproach: "explain-directly" })
    );
    await assertFails(
      updateDoc(doc(aliceDb, ...settingsPath), { customGuidance: "x" })
    );
    await assertFails(deleteDoc(doc(aliceDb, ...settingsPath)));
  });

  it("keeps onboarding progress private", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const guestDb = testEnv.unauthenticatedContext().firestore();

    const aliceProgress = doc(aliceDb, "users", ALICE, "onboarding", "release-1");

    await assertSucceeds(
      setDoc(aliceProgress, { status: "active", completedMissionIds: [] })
    );
    await assertSucceeds(getDoc(aliceProgress));
    await assertSucceeds(
      updateDoc(aliceProgress, { completedMissionIds: ["create-folder"] })
    );

    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "onboarding", "release-1"))
    );
    await assertFails(
      getDoc(doc(guestDb, "users", ALICE, "onboarding", "release-1"))
    );
    await assertSucceeds(deleteDoc(aliceProgress));
  });

  it("lets a student read their plan and allowance use but never write them", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users", ALICE, "billing", "plan"), { plan: "plus" });
      await setDoc(doc(db, "users", ALICE, "allowanceUsage", "2026-10-01"), { used: { papers: 2 } });
    });
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "billing", "plan")));
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "allowanceUsage", "2026-10-01")));
    // No client can give itself a plan or wipe what it has used.
    await assertFails(setDoc(doc(aliceDb, "users", ALICE, "billing", "plan"), { plan: "pro" }));
    await assertFails(
      updateDoc(doc(aliceDb, "users", ALICE, "allowanceUsage", "2026-10-01"), { used: {} })
    );
    await assertFails(deleteDoc(doc(aliceDb, "users", ALICE, "allowanceUsage", "2026-10-01")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "billing", "plan")));
  });

  it("keeps flashcard review history private, append-only and free of card text", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const event = (id: string) => doc(aliceDb, "users", ALICE, "flashcardReviewEvents", id);
    const valid = {
      schemaVersion: 1,
      cardId: "alice-card",
      deckId: ALICE_DECK_ID,
      reviewedAt: 1_789_000_000_000,
      studyDayKey: "2026-09-15",
      correct: true,
      rating: "good",
      createdAt: 1_789_000_000_001,
    };

    await assertSucceeds(setDoc(event("commit-1"), valid));
    await assertSucceeds(getDoc(event("commit-1")));
    // Simple study records a result without a rating.
    const withoutRating = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "rating")
    );
    await assertSucceeds(setDoc(event("commit-2"), { ...withoutRating, correct: false }));
    // A diagram mix-up rides along as a label id, and only on a wrong answer.
    await assertSucceeds(
      setDoc(event("commit-mixup"), { ...valid, correct: false, rating: "again", confusedWithLabelId: "label-7" })
    );
    await assertFails(setDoc(event("commit-mixup-right"), { ...valid, confusedWithLabelId: "label-7" }));
    await assertFails(
      setDoc(event("commit-mixup-long"), { ...valid, correct: false, rating: "again", confusedWithLabelId: "x".repeat(65) })
    );

    await assertFails(getDoc(doc(bobDb, "users", ALICE, "flashcardReviewEvents", "commit-1")));
    await assertFails(setDoc(doc(bobDb, "users", ALICE, "flashcardReviewEvents", "commit-3"), valid));
    // Written once, never edited.
    await assertFails(updateDoc(event("commit-1"), { correct: false }));
    // Nothing beyond the compact shape: no card or answer text rides along.
    // Which recommendation opened the session an answer was given in.
    await assertSucceeds(
      setDoc(event("commit-8"), {
        ...valid,
        interventionId: "folder:f1|low_mastery|topic:osmosis",
      })
    );
    await assertFails(setDoc(event("commit-9"), { ...valid, interventionId: "" }));
    await assertFails(setDoc(event("commit-4"), { ...valid, front: "Question" }));
    await assertFails(setDoc(event("commit-5"), { ...valid, rating: "perfect" }));
    await assertFails(setDoc(event("commit-6"), { ...valid, schemaVersion: 2 }));
    await assertFails(setDoc(event("commit-7"), { ...valid, studyDayKey: "yesterday" }));

    await assertSucceeds(deleteDoc(event("commit-1")));
  });

  it("keeps the record of what became of advice private, append-only and free of wording", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const event = (id: string) => doc(aliceDb, "users", ALICE, "studyActionEvents", id);
    const valid = {
      schemaVersion: 1,
      actionId: "folder:f1|low_mastery|topic:osmosis",
      reason: "low_mastery",
      targetKey: "topic:osmosis",
      folderId: "f1",
      outcome: "shown",
      at: 1_789_000_000_000,
      studyDayKey: "2026-09-21",
      createdAt: 1_789_000_000_001,
    };

    await assertSucceeds(setDoc(event("2026-09-21_shown_abc"), valid));
    await assertSucceeds(getDoc(event("2026-09-21_shown_abc")));
    await assertSucceeds(
      setDoc(event("2026-09-21_started_abc"), { ...valid, outcome: "started" })
    );
    // A deck-scoped action carries a deckId instead of a folderId.
    const deckScoped = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "folderId")
    );
    await assertSucceeds(
      setDoc(event("2026-09-21_dismissed_abc"), {
        ...deckScoped,
        deckId: "d1",
        outcome: "dismissed",
      })
    );

    await assertFails(getDoc(doc(bobDb, "users", ALICE, "studyActionEvents", "2026-09-21_shown_abc")));
    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "studyActionEvents", "other"), valid)
    );
    // Written once: what was suggested must not be rewritable after the fact.
    await assertFails(updateDoc(event("2026-09-21_shown_abc"), { outcome: "completed" }));
    // Nothing beyond the compact shape: no labels, no student wording.
    await assertFails(setDoc(event("bad-1"), { ...valid, label: "Revisit Osmosis" }));
    await assertSucceeds(
      setDoc(event("2026-09-21_abandoned_abc"), { ...valid, outcome: "abandoned" })
    );
    await assertFails(setDoc(event("bad-2"), { ...valid, outcome: "ignored" }));
    await assertFails(setDoc(event("bad-3"), { ...valid, reason: "because" }));
    await assertFails(setDoc(event("bad-4"), { ...valid, schemaVersion: 2 }));
    await assertFails(setDoc(event("bad-5"), { ...valid, studyDayKey: "today" }));
    await assertFails(setDoc(event("bad-6"), { ...valid, actionId: "" }));

    await assertSucceeds(deleteDoc(event("2026-09-21_shown_abc")));
  });

  it("keeps Tutor's marking of a page server-written and owner-readable", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const marking = doc(aliceDb, "users", ALICE, "notebookMarkings", "nb-1_page-3");
    const record = {
      schemaVersion: 1,
      notebookId: "nb-1",
      pageId: "page-3",
      topicIds: ["quadratics"],
      markedAt: 1_789_000_000_000,
      awardedMarks: 3,
      maxMarks: 5,
      criterionResults: [{ criterion: "States the gradient", awarded: true }],
      provenance: "tutor",
      markerVersion: "tutor-notebook-marking-v1-2026-09-21",
      createdAt: 1_789_000_000_001,
    };

    // A student who could write their own marks could write their own evidence.
    await assertFails(setDoc(marking, record));
    await assertFails(setDoc(doc(bobDb, "users", ALICE, "notebookMarkings", "x"), record));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "users", ALICE, "notebookMarkings", "nb-1_page-3"),
        record
      );
    });
    await assertSucceeds(getDoc(marking));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "notebookMarkings", "nb-1_page-3")));
    // Deletable with the page it describes.
    await assertSucceeds(deleteDoc(marking));
  });

  it("keeps a Revision Session, and the answers it holds, on the server", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const session = doc(aliceDb, "users", ALICE, "revisionSessions", "session-1");
    const record = {
      schemaVersion: 1,
      policy: "teach",
      status: "active",
      target: { topicKey: "topic:quadratics", source: "student-topic", conceptLabel: "Quadratics" },
      actionId: "folder:f1|low_mastery|topic:topic:quadratics",
      why: [],
      lesson: { guided: { answer: "(x + 4)^2 - 13" } },
      steps: [{ kind: "orient", attempts: 0, hintUsed: false, skipped: false, selfGraded: false }],
      position: 0,
      createdAt: 1_789_000_000_000,
      updatedAt: 1_789_000_000_000,
    };

    // Writable by nobody but the server: its outcomes are evidence.
    await assertFails(setDoc(session, record));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", ALICE, "revisionSessions", "session-1"), record);
    });
    // Not readable from a client either, even by its owner: it holds the
    // answers to the questions the student is about to be asked.
    await assertFails(getDoc(session));
    await assertFails(updateDoc(session, { position: 1 }));
    await assertSucceeds(deleteDoc(session));
  });

  it("lets a student keep a shelf of sessions to do later, and nothing more", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const item = (id: string) => doc(aliceDb, "users", ALICE, "revisionShelf", id);
    const valid = {
      schemaVersion: 1,
      kind: "practice",
      status: "made",
      topicKey: "spec:completing-the-square",
      conceptLabel: "Completing the square",
      folderId: "maths",
      conceptId: "completing-the-square",
      href: "/dashboard/practice/paper-1",
      createdAt: 1_789_000_000_000,
    };

    await assertSucceeds(setDoc(item("ok"), valid));
    await assertSucceeds(getDoc(item("ok")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "revisionShelf", "ok")));
    // A link out of the app, a kind nobody defined, or question text: refused.
    await assertFails(setDoc(item("bad-1"), { ...valid, href: "https://evil.example" }));
    await assertFails(setDoc(item("bad-2"), { ...valid, kind: "question-bank" }));
    await assertFails(setDoc(item("bad-3"), { ...valid, question: "Solve x^2 + 6x + 5 = 0" }));
    // Done items are removed, never edited.
    await assertFails(updateDoc(item("ok"), { status: "later" }));
    await assertSucceeds(deleteDoc(item("ok")));
  });

  it("keeps a Topic's specification relation inside the owner's own subtree", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const topic = doc(aliceDb, "users", ALICE, "topics", "quadratics");
    const relation = {
      name: "Quadratics",
      subject: "Maths",
      status: "active",
      specificationRelation: {
        type: "covers",
        conceptIds: ["completing-the-square", "factorisation"],
        confirmedByOwner: true,
      },
    };

    await assertSucceeds(setDoc(topic, relation));
    await assertSucceeds(getDoc(topic));
    // A relation decides how this student's evidence is attributed; nobody else may set it.
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "topics", "quadratics")));
    await assertFails(setDoc(doc(bobDb, "users", ALICE, "topics", "other"), relation));
    // Reversible: withdrawing the relation is an ordinary owner write.
    await assertSucceeds(updateDoc(topic, { specificationRelation: null }));
  });

  it("allows owners to read decks stored with either userId or legacy uid", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    await assertSucceeds(getDoc(doc(aliceDb, "decks", ALICE_DECK_ID)));
    await assertSucceeds(getDoc(doc(aliceDb, "decks", LEGACY_ALICE_DECK_ID)));
    await assertFails(getDoc(doc(bobDb, "decks", LEGACY_ALICE_DECK_ID)));
  });

  it("allows owner deck list queries by current userId and legacy uid", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();

    await assertSucceeds(
      getDocs(query(collection(aliceDb, "decks"), where("userId", "==", ALICE)))
    );
    await assertSucceeds(
      getDocs(query(collection(aliceDb, "decks"), where("uid", "==", ALICE)))
    );
  });

  it("allows creating only self-owned top-level decks", async () => {
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();

    await assertSucceeds(
      setDoc(doc(aliceDb, "decks", "deck-new"), {
        name: "New deck",
        userId: ALICE,
        createdAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, "decks", "deck-for-bob"), {
        name: "Wrong owner",
        userId: BOB,
        createdAt: 1,
      })
    );
  });

  it("requires card creation to reference an owned deck", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();

    await assertSucceeds(
      setDoc(doc(aliceDb, "cards", "card-1"), {
        deckId: ALICE_DECK_ID,
        userId: ALICE,
        front: "Question",
        back: "Answer",
        createdAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, "cards", "card-2"), {
        deckId: BOB_DECK_ID,
        userId: ALICE,
        front: "Wrong deck",
        back: "Answer",
        createdAt: 1,
      })
    );
  });

  it("restricts nested user deck metadata to the caller and matching owned deck", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "decks", ALICE_DECK_ID), {
        deckId: ALICE_DECK_ID,
        updatedAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "decks", ALICE_DECK_ID), {
        deckId: BOB_DECK_ID,
        updatedAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "decks", ALICE_DECK_ID), {
        deckId: ALICE_DECK_ID,
        updatedAt: 1,
      })
    );
  });

  it("restricts attempt writes to the caller and the matching owned deck", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "decks", ALICE_DECK_ID, "attempts", "attempt-1"), {
        deckId: ALICE_DECK_ID,
        startedAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "decks", ALICE_DECK_ID, "attempts", "attempt-2"), {
        deckId: BOB_DECK_ID,
        startedAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "decks", ALICE_DECK_ID, "attempts", "attempt-3"), {
        deckId: ALICE_DECK_ID,
        startedAt: 1,
      })
    );
  });

  it("restricts notification preference docs to the caller", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "notificationPreferences", "config"), {
        enabled: true,
        mode: "smart",
        updatedAt: 1,
      })
    );

    await assertSucceeds(
      getDoc(doc(aliceDb, "users", ALICE, "notificationPreferences", "config"))
    );

    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "notificationPreferences", "config"))
    );

    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "notificationPreferences", "config"), {
        enabled: true,
        mode: "smart",
        updatedAt: 1,
      })
    );
  });

  it("restricts push subscriptions to the caller", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "pushSubscriptions", "device-1"), {
        endpoint: "https://example.test/subscription",
        keys: {
          auth: "auth",
          p256dh: "p256dh",
        },
        updatedAt: 1,
      })
    );

    await assertSucceeds(
      getDoc(doc(aliceDb, "users", ALICE, "pushSubscriptions", "device-1"))
    );

    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "pushSubscriptions", "device-1"))
    );

    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "pushSubscriptions", "device-1"), {
        endpoint: "https://example.test/subscription",
        keys: {
          auth: "auth",
          p256dh: "p256dh",
        },
        updatedAt: 1,
      })
    );
  });

  it("restricts active study sessions to the caller", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const activeSessionData = {
      version: 1,
      userId: ALICE,
      studyDayKey: "2026-05-02",
      kind: "daily-required",
      status: "active",
      cardIds: ["alice-card"],
      index: 0,
      stats: {
        reviewedCards: 0,
        correctAnswers: 0,
        completedGoals: 0,
        starsEarned: 0,
        ratings: { again: 0, hard: 0, good: 0, easy: 0 },
      },
      selectedDeckIds: [],
      selectedTags: [],
      startedAt: 1,
      savedAt: 1,
    };

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "studyState", "activeSession"), activeSessionData)
    );

    await assertSucceeds(
      getDoc(doc(aliceDb, "users", ALICE, "studyState", "activeSession"))
    );

    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "studyState", "activeSession"))
    );

    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "studyState", "activeSession"), activeSessionData)
    );
  });

  it("restricts new learning-loop collections to the caller", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();

    const topicRef = doc(aliceDb, "users", ALICE, "topics", "topic-1");
    await assertSucceeds(
      setDoc(topicRef, {
        name: "Eigenvalues",
        slug: "eigenvalues",
        subject: "Linear Algebra",
        status: "active",
        createdBy: "user",
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(getDoc(topicRef));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "topics", "topic-1")));

    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "questions", "question-1"), {
        questionText: "Find the eigenvalues.",
        topicIds: ["topic-1"],
        sourceType: "manual",
        origin: "user-authored",
        contentStatus: "approved",
        createdAt: 1,
        updatedAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "attempts", "attempt-1"), {
        questionId: "question-1",
        userAnswer: "lambda = 2",
        isCorrect: true,
        confidence: 4,
        tutorUsed: false,
        mistakeLabels: [],
        createdAt: 1,
      })
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "masteryEvents", "event-1"), {
        topicId: "topic-1",
        sourceType: "manual",
        sourceId: "page-1",
        weight: "high",
        scoreDelta: 4,
        reason: "Notebook page reviewed",
        algorithmVersion: "mvp-test",
        createdAt: 1,
      })
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "generatedContentDrafts", "draft-1"), {
        kind: "flashcard",
        title: "Eigenvalue definition",
        front: "What is an eigenvalue?",
        back: "A scalar lambda where Av = lambda v.",
        topicIds: ["topic-1"],
        origin: "ai-assisted",
        contentStatus: "draft",
        createdAt: 1,
        updatedAt: 1,
      })
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "sources", "source-1"), {
        title: "Lecture 5 notes",
        type: "pasted_text",
        subject: "Linear Algebra",
        topicIds: ["topic-1"],
        contentText: "Eigenvalues are scalars where Av = lambda v.",
        status: "active",
        createdBy: ALICE,
        createdAt: 1,
        updatedAt: 1,
      })
    );

    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "sources", "source-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "sources", "source-1")));

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "studyFolders", "folder-linear-algebra"), {
        name: "Linear Algebra",
        description: "Decks, sources, and notebook work for eigenvalues.",
        subject: "Maths",
        topicIds: ["topic-1"],
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      })
    );

    await assertSucceeds(
      getDoc(doc(aliceDb, "users", ALICE, "studyFolders", "folder-linear-algebra"))
    );
    await assertSucceeds(getDocs(collection(aliceDb, "users", ALICE, "studyFolders")));
    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "studyFolders", "folder-linear-algebra"))
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "notebooks", "notebook-1"), {
        folderId: "folder-linear-algebra",
        title: "Eigenvalues practice",
        type: "practice",
        topicIds: ["topic-1"],
        sourceIds: ["source-1"],
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "notebookPages", "page-1"), {
        notebookId: "notebook-1",
        folderId: "folder-linear-algebra",
        pageNumber: 1,
        pageType: "question",
        typedContent: "I start by finding the characteristic polynomial.",
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "notebooks", "notebook-1")));
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "notebookPages", "page-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "notebooks", "notebook-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "notebookPages", "page-1")));
    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "notebookPageInk", "page-1"), {
        notebookId: "notebook-1",
        inkData: { version: 2, format: "js-draw-svg", svg: "<svg></svg>" },
        contentRevision: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, "users", ALICE, "notebookPageInk", "page-1"))
    );
    // Ink is a student's handwriting; it must be no more reachable than the
    // page it was split out of.
    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "notebookPageInk", "page-1"))
    );
    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "notebookPageInk", "page-1"), {
        notebookId: "notebook-1",
        contentRevision: 2,
        updatedAt: 2,
      })
    );
    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "notebookFiles", "file-1"), {
        notebookId: "notebook-1",
        folderId: "folder-linear-algebra",
        fileName: "biology-paper.pdf",
        fileType: "application/pdf",
        storagePath: "users/alice/notebookFiles/notebook-1/file-1-biology-paper.pdf",
        sizeBytes: 1024,
        uploadedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "notebookFiles", "file-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "notebookFiles", "file-1")));

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "practiceSets", "set-1"), {
        folderId: "folder-linear-algebra",
        title: "Eigenvalues drill",
        type: "manual",
        topicIds: ["topic-1"],
        questionIds: [],
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "pastPapers", "paper-1"), {
        folderId: "folder-linear-algebra",
        title: "2024 Linear Algebra paper",
        origin: "uploaded",
        status: "ready",
        questions: [],
        totalMarks: 0,
        markScheme: { kind: "missing", label: "No guide", notice: "", items: [] },
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "practiceSets", "set-1")));
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "pastPapers", "paper-1")));
    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "practicePaperAttempts", "attempt-1"), {
        paperId: "paper-1",
        status: "in_progress",
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", ALICE, "practicePaperAttempts", "attempt-1"), {
        paperId: "paper-1",
        status: "in_progress",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "practicePaperAttempts", "attempt-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "practicePaperAttempts", "attempt-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "practiceSets", "set-1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "pastPapers", "paper-1")));

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "tutorThreads", "thread-1"), {
        contextType: "notebook",
        contextId: "notebook-1",
        title: "Notebook support",
        createdAt: 1,
        updatedAt: 1,
      })
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, "users", ALICE, "tutorMessages", "message-1"), {
        threadId: "thread-1",
        role: "model",
        text: "Use this thread for source or future notebook Tutor context.",
        createdAt: 1,
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "assistantThreads", "assistant-thread-1"), {
        title: "Explain this page",
        surface: "notebook",
        contextKey: "notebook:notebook-1:page:page-1",
        contextLabel: "Eigenvalues practice · Page 1",
        context: {
          surface: "notebook",
          notebookId: "notebook-1",
          pageId: "page-1",
        },
        createdAt: 1,
        updatedAt: 1,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "assistantMessages", "assistant-message-1"), {
        threadId: "assistant-thread-1",
        role: "assistant",
        text: "Start with the characteristic polynomial.",
        createdAt: 1,
      })
    );
    // Seed server-owned history so the owner can still read it.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, "users", ALICE, "assistantThreads", "assistant-thread-1"), {
        title: "Explain this page",
        surface: "notebook",
        contextKey: "notebook:notebook-1:page:page-1",
        contextLabel: "Eigenvalues practice - Page 1",
        context: { surface: "notebook", notebookId: "notebook-1", pageId: "page-1" },
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await assertSucceeds(
      getDoc(
        doc(aliceDb, "users", ALICE, "assistantThreads", "assistant-thread-1")
      )
    );
    await assertFails(
      getDoc(doc(bobDb, "users", ALICE, "assistantThreads", "assistant-thread-1"))
    );
    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "assistantMessages", "assistant-message-2"), {
        threadId: "assistant-thread-1",
        role: "user",
        text: "Wrong user",
        createdAt: 2,
      })
    );

    await assertFails(
      setDoc(doc(bobDb, "users", ALICE, "attempts", "attempt-2"), {
        questionId: "question-1",
        userAnswer: "wrong user",
        isCorrect: false,
        confidence: 1,
        tutorUsed: false,
        mistakeLabels: [],
        createdAt: 1,
      })
    );
  });

  it("keeps deadline evidence immutable and source embeddings server-only", async () => {
    await seedData();

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    const deadlineRef = doc(
      aliceDb,
      "users",
      ALICE,
      "practicePaperDeadlineSnapshots",
      "attempt-1_page-1"
    );
    await assertFails(setDoc(deadlineRef, {
      attemptId: "attempt-1",
      paperId: "paper-1",
      notebookId: "notebook-1",
      pageId: "page-1",
      capturedAt: 10,
      page: { typedContent: "Forged answer" },
    }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(
        context.firestore(),
        "users",
        ALICE,
        "practicePaperDeadlineSnapshots",
        "attempt-1_page-1"
      ), {
        attemptId: "attempt-1",
        paperId: "paper-1",
        notebookId: "notebook-1",
        pageId: "page-1",
        capturedAt: 10,
        page: { typedContent: "Within-time answer" },
      });
    });
    await assertSucceeds(getDoc(deadlineRef));
    await assertFails(updateDoc(deadlineRef, { capturedAt: 11 }));
    await assertFails(deleteDoc(deadlineRef));
    await assertFails(getDoc(doc(
      bobDb,
      "users",
      ALICE,
      "practicePaperDeadlineSnapshots",
      "attempt-1_page-1"
    )));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", ALICE, "sourceChunks", "source-1-0000"), {
        sourceId: "source-1",
        text: "Private extracted source text",
        embedding: [0.1, 0.2],
      });
    });
    const chunkRef = doc(aliceDb, "users", ALICE, "sourceChunks", "source-1-0000");
    await assertFails(getDoc(chunkRef));
    await assertFails(setDoc(chunkRef, { sourceId: "source-1", text: "changed" }));
    await assertFails(getDocs(collection(aliceDb, "users", ALICE, "sourceChunks")));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", ALICE, "sourceOutlines", "source-1"), {
        sourceId: "source-1",
        sections: [{ kind: "lecture", number: 4, title: "Entropy", chunkStart: 9, chunkEnd: 12 }],
      });
    });
    const outlineRef = doc(aliceDb, "users", ALICE, "sourceOutlines", "source-1");
    await assertFails(getDoc(outlineRef));
    await assertFails(setDoc(outlineRef, { sourceId: "source-1", sections: [] }));

    const memoryRef = doc(aliceDb, "users", ALICE, "tutorMemory", "state");
    await assertFails(getDoc(memoryRef));
    await assertFails(setDoc(memoryRef, { enabled: true, items: [{ id: "m", kind: "goal", text: "planted" }] }));
  });

  it("keeps durable practice-paper job internals server-only", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(
          context.firestore(),
          "users",
          ALICE,
          "practicePaperJobs",
          "job-1"
        ),
        {
          paperId: "paper-1",
          status: "queued",
          request: { instructions: "private workflow input" },
        }
      );
    });

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const jobRef = doc(
      aliceDb,
      "users",
      ALICE,
      "practicePaperJobs",
      "job-1"
    );
    await assertFails(getDoc(jobRef));
    await assertFails(setDoc(jobRef, { status: "cancelled" }, { merge: true }));
    await assertFails(
      getDocs(collection(aliceDb, "users", ALICE, "practicePaperJobs"))
    );
  });

  it("keeps durable video-card jobs and evidence server-only", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", ALICE, "videoCardJobs", "job-1"), {
        status: "ready",
        evidence: [{ summary: "private extracted evidence" }],
      });
    });
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const jobRef = doc(aliceDb, "users", ALICE, "videoCardJobs", "job-1");
    await assertFails(getDoc(jobRef));
    await assertFails(setDoc(jobRef, { status: "approved" }, { merge: true }));
    await assertFails(getDocs(collection(aliceDb, "users", ALICE, "videoCardJobs")));
  });

  it("keeps marking jobs, evidence manifests, and workflow artifacts server-only", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await Promise.all([
        setDoc(doc(adminDb, "users", ALICE, "practicePaperMarkingJobs", "mark-job-1"), { status: "running" }),
        setDoc(doc(adminDb, "users", ALICE, "practicePaperMarkingJobArtifacts", "mark-job-1"), { providerOutput: "private" }),
        setDoc(doc(adminDb, "users", ALICE, "practicePaperEvidence", "attempt-1"), { manifest: { private: true } }),
      ]);
    });
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    for (const [collectionName, id] of [
      ["practicePaperMarkingJobs", "mark-job-1"],
      ["practicePaperMarkingJobArtifacts", "mark-job-1"],
      ["practicePaperEvidence", "attempt-1"],
    ]) {
      const reference = doc(aliceDb, "users", ALICE, collectionName, id);
      await assertFails(getDoc(reference));
      await assertFails(setDoc(reference, { status: "cancelled" }, { merge: true }));
    }
  });

  it("keeps exam-format and paper-quality namespaces server-only", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await Promise.all([
        setDoc(doc(adminDb, "examFormatProfiles", "aqa-gcse-maths"), { activeVersion: "v1" }),
        setDoc(doc(adminDb, "examFormatImports", "import-1"), { status: "processed" }),
        setDoc(doc(adminDb, "examFormatReferenceFingerprints", "aqa-gcse-maths"), { windowHashes: ["deadbeef"] }),
        setDoc(doc(adminDb, "paperGenerationBenchmarkRuns", "run-1"), { status: "running" }),
        setDoc(doc(adminDb, "paperGenerationBenchmarkBaselines", "baseline-1"), { schemaVersion: 2 }),
      ]);
    });
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    for (const [collectionName, id] of [
      ["examFormatProfiles", "aqa-gcse-maths"],
      ["examFormatImports", "import-1"],
      ["examFormatReferenceFingerprints", "aqa-gcse-maths"],
      ["paperGenerationBenchmarkRuns", "run-1"],
      ["paperGenerationBenchmarkBaselines", "baseline-1"],
    ]) {
      const reference = doc(aliceDb, collectionName, id);
      await assertFails(getDoc(reference));
      await assertFails(setDoc(reference, { exposed: true }, { merge: true }));
    }
  });

  it("keeps the shared exam bank private and exposes only owner session projections", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await Promise.all([
        setDoc(doc(adminDb, "examQuestions", "q1"), { prompt: "private bank question" }),
        setDoc(doc(adminDb, "examQuestionSecrets", "q1"), { answer: "private scheme" }),
        setDoc(doc(adminDb, "examPapers", "paper1"), { sourcePath: "private" }),
        setDoc(doc(adminDb, "examSourceDiscoveries", "aqa_8461"), { pairs: [] }),
        setDoc(doc(adminDb, "users", ALICE, "examGeneratedQuestions", "g1"), { prompt: "filler" }),
        setDoc(doc(adminDb, "users", ALICE, "examGeneratedSecrets", "g1"), { modelAnswer: "private" }),
        setDoc(doc(adminDb, "users", ALICE, "examSessions", "session1"), { userId: ALICE, status: "active" }),
        setDoc(doc(adminDb, "users", ALICE, "examAttempts", "attempt1"), { userId: ALICE, sessionId: "session1", status: "draft" }),
      ]);
    });
    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    const bobDb = testEnv.authenticatedContext(BOB).firestore();
    for (const [collectionName, id] of [["examQuestions", "q1"], ["examQuestionSecrets", "q1"], ["examPapers", "paper1"], ["examSourceDiscoveries", "aqa_8461"]]) {
      await assertFails(getDoc(doc(aliceDb, collectionName, id)));
      await assertFails(setDoc(doc(aliceDb, collectionName, id), { exposed: true }));
    }
    // Jami-created fillers live under the student but are still server-only:
    // their mark scheme sits beside them, so neither half is client-readable.
    for (const collectionName of ["examGeneratedQuestions", "examGeneratedSecrets"]) {
      await assertFails(getDoc(doc(aliceDb, "users", ALICE, collectionName, "g1")));
      await assertFails(setDoc(doc(aliceDb, "users", ALICE, collectionName, "g1"), { exposed: true }));
    }
    // The session carries only the candidate-visible half of each question, so
    // the owner reads it directly and the workspace renders without a round trip.
    await assertSucceeds(getDoc(doc(aliceDb, "users", ALICE, "examSessions", "session1")));
    await assertFails(getDoc(doc(bobDb, "users", ALICE, "examSessions", "session1")));
    // An attempt is the opposite: the stored document holds the marking audit,
    // the idempotency key and the official scheme, so even its owner reads it
    // through the API projection rather than from Firestore.
    await assertFails(getDoc(doc(aliceDb, "users", ALICE, "examAttempts", "attempt1")));
    await assertFails(updateDoc(doc(aliceDb, "users", ALICE, "examAttempts", "attempt1"), { status: "marked" }));
    const scratchpad = doc(aliceDb, "users", ALICE, "examScratchpads", "attempt1");
    await assertSucceeds(setDoc(scratchpad, { inkSvg: "<svg/>", updatedAt: 2 }));
    // Further pages of working ride along, up to sixteen pages in all.
    await assertSucceeds(setDoc(scratchpad, { inkSvg: "<svg/>", pages: Array(15).fill("<svg/>"), updatedAt: 2 }));
    await assertFails(setDoc(scratchpad, { inkSvg: "<svg/>", pages: Array(16).fill("<svg/>"), updatedAt: 2 }));
    await assertFails(setDoc(scratchpad, { inkSvg: "<svg/>", pages: "<svg/>", updatedAt: 2 }));
    await testEnv.withSecurityRulesDisabled(async (context) => updateDoc(doc(context.firestore(), "users", ALICE, "examAttempts", "attempt1"), { status: "marked" }));
    await assertFails(updateDoc(scratchpad, { inkSvg: "<svg>changed</svg>", updatedAt: 3 }));
  });

  it("keeps answer-bearing practice-paper rubrics inaccessible before submission", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await Promise.all([
        setDoc(doc(adminDb, "users", ALICE, "pastPapers", "safe-paper"), {
          status: "ready",
          markScheme: {
            kind: "generated",
            label: "Jami-generated marking guide",
            notice: "Hidden until marking",
            items: [],
          },
        }),
        setDoc(doc(adminDb, "users", ALICE, "pastPapers", "legacy-leak"), {
          status: "ready",
          markScheme: {
            kind: "generated",
            label: "Jami-generated marking guide",
            notice: "Hidden until marking",
            items: [{ questionId: "q1", answer: "secret answer" }],
          },
        }),
        setDoc(doc(adminDb, "users", ALICE, "practicePaperSecrets", "safe-paper"), {
          markScheme: {
            items: [{ questionId: "q1", answer: "secret answer" }],
          },
        }),
        setDoc(doc(adminDb, "users", ALICE, "practicePaperJobArtifacts", "job-1"), {
          generated: { markScheme: { items: [{ answer: "secret answer" }] } },
        }),
      ]);
    });

    const aliceDb = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(
      getDoc(doc(aliceDb, "users", ALICE, "pastPapers", "safe-paper"))
    );
    await assertFails(
      getDoc(doc(aliceDb, "users", ALICE, "pastPapers", "legacy-leak"))
    );
    await assertFails(
      getDoc(doc(aliceDb, "users", ALICE, "practicePaperSecrets", "safe-paper"))
    );
    await assertFails(
      getDoc(doc(aliceDb, "users", ALICE, "practicePaperJobArtifacts", "job-1"))
    );
    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "pastPapers", "attempted-leak"), {
        status: "ready",
        markScheme: {
          kind: "generated",
          label: "Guide",
          notice: "",
          items: [{ questionId: "q1", answer: "secret answer" }],
        },
      })
    );

    /*
     * A generated paper is the server's to write, not the browser's.
     *
     * Even with the mark scheme stripped to its public projection, a paper
     * carrying questions and marks is an assessment definition, and those do
     * not originate in a client. This is not hypothetical: the intervention
     * flow first wrote one straight from the browser, which would have been
     * refused for every student on four counts at once, and the mark scheme
     * would have been silently dropped even if it had not been.
     */
    await assertFails(
      setDoc(doc(aliceDb, "users", ALICE, "pastPapers", "attempted-generated"), {
        folderId: "folder-linear-algebra",
        title: "Completing the square",
        origin: "generated",
        status: "ready",
        questions: [{ id: "q1", label: "Question 1", prompt: "Solve", marks: 3, assets: [] }],
        totalMarks: 3,
        markScheme: { kind: "generated", label: "Guide", notice: "", items: [] },
        createdAt: 1,
        updatedAt: 1,
      })
    );
  });
});
