# Learning Engine: production verification

What has to be checked outside the unit tests before the Learning Engine is
trusted in production, in the order it has to happen. Everything here is a
check by the owner against real infrastructure; nothing in the test suite can
stand in for it.

## 1. Deploy, in this order

1. `firestore.indexes.json` — adds `flashcardReviewEvents (deckId ASC, reviewedAt DESC)`.
   Wait until the index shows **Enabled** in the Firebase console.
2. `firestore.rules` — adds the create-only `flashcardReviewEvents` rule.
3. The application.

Out of order fails safe: without the rule, event writes are refused and the
review still saves; without the index, the profile reports review history as
unavailable and falls back to card totals.

## 2. Confirm CI ran what this machine could not

On the push or pull request carrying this work, in `.github/workflows/quality.yml`:

- [ ] **rules** job passed. It runs `tests/firestore.rules.test.ts` on Java 21,
      including "keeps flashcard review history private, append-only and free of card text".
- [ ] **browser-smoke** job passed, including:
  - [ ] `e2e/learning-engine.smoke.spec.ts` — a graded card leaves exactly one
        compact event under the real rules; Today recommends testing the seeded
        Topic and the link opens a study session for it.
  - [ ] `e2e/offline-replay.smoke.spec.ts` — a review graded offline and synced
        later still leaves exactly one event.

## 3. Real project checks

Use your own account, or a test account in the production project.

### Review history is recorded once, and owned

- [ ] Review two cards in a deck. Then run:

      node --env-file-if-exists=.env.local scripts/run-ts.mjs scripts/eval/learner-profile-check.ts --uid <uid>

  Expect `reviewHistory.sampled >= 2`, `malformed: 0` and
  `deckReviewedAtIndex: "ok"`. Anything else under `deckReviewedAtIndex` is the
  index error, including the console link to create it.
- [ ] Review a card with the network off, reconnect, and run the script again.
      The sampled count rises by exactly one.
- [ ] In the Firebase console, open one `users/<uid>/flashcardReviewEvents`
      document. It holds only `schemaVersion`, `cardId`, `deckId`, `reviewedAt`,
      `studyDayKey`, `correct`, `createdAt` and, outside simple study, `rating`.

### Deleted content stops counting

- [ ] Delete a deck you have reviewed. Run the script: `eventsForMissingOrForeignDecks`
      is `0` (deck deletion removes its history). If it is not, deletion hit an
      error — the profile still ignores those events, because their cards are gone.

### The profile builds, within budget

- [ ] Run the script with `--folder <folderId>` for a folder with real work in it.
      Expect `profile.latencyMs` comfortably under 2500 (Tutor's budget) and
      `limitsReached` / `unavailableSources` to be empty or explained.

### Tutor uses the profile, and survives without it

- [ ] Ask Tutor something from a notebook in that folder. In the server logs,
      `learner_profile.completed` appears with `consumer: "tutor"` and an outcome
      of `included` or `insufficient_evidence`.
- [ ] Temporarily revoke the index, or point a test deployment at a project without
      it: Tutor still answers, and the logs show the profile with
      `unavailableSources: ["flashcard-events"]` rather than `learner_profile.failed`.

### Today sends the student somewhere real

- [ ] The script's `studyActions.actions[].href` values each open the right page:
      a study session, Past Paper Practice narrowed to a topic, a folder's practice
      papers, a Topic or deck page, or the student's own notebook page on it.
- [ ] Open Tutor in a notebook. `notebook_view.completed` is logged once for the
      notebook, not once per page turned, with `outcome: "included"` and a
      `latencyMs` well under its 3000 ms budget.
- [ ] Open a notebook link from Today and ask Tutor to mark the page. The logs show
      `marking.accepted` with its `attribution`, and the study action reads as
      completed on Today afterwards.
- [ ] On Today, the next step and the suggestions under it show the same actions, and each
      link opens its page at desktop, tablet and phone widths.

## 4. Specification catalogues

Topic-narrowed practice needs a checked topic list; concept-narrowed practice,
concept tagging and concept evidence need a checked concept list beneath it.
Nothing unchecked is served to students, offered to extraction or tagging, or
reasoned over by the Learning Engine.

All files are in `lib/practice/`. Outlines are registered in
`exam-specification-outlines.ts` and written under `specifications/`.

| Course | Topic list | Concept list | Where |
| --- | --- | --- | --- |
| AQA GCSE Mathematics (8300) | checked | checked by the owner, 2026-09-15 | `exam-specification-topics.ts`, `exam-specification-concepts.ts` |
| Pearson Edexcel GCSE Mathematics (1MA1) | checked by the owner, 2026-09-16 | checked by the owner, 2026-09-16 | the `1MA1` entries in the same two files |
| AQA GCSE Biology (8461) | checked by the owner, 2026-09-16 | checked by the owner, 2026-09-16 | `AQA_GCSE_BIOLOGY` in `specifications/aqa-gcse-science.ts` |
| AQA GCSE Chemistry (8462) | checked by the owner, 2026-09-16 | checked by the owner, 2026-09-16 | `AQA_GCSE_CHEMISTRY`, same file |
| AQA GCSE Physics (8463) | checked by the owner, 2026-09-16 | checked by the owner, 2026-09-16 | `AQA_GCSE_PHYSICS`, same file |
| AQA GCSE Combined Science: Trilogy (8464) | checked by the owner, 2026-09-16 | checked by the owner, 2026-09-16 | `AQA_GCSE_COMBINED_SCIENCE_TRILOGY`, same file |
| AQA GCSE Geography (8035) | **draft, not yet checked** | **draft, not yet checked** | `AQA_GCSE_GEOGRAPHY` in `specifications/gcse-humanities-and-languages.ts` |
| Pearson Edexcel GCSE Business (1BS0) | **draft, not yet checked** | **draft, not yet checked** | `PEARSON_EDEXCEL_GCSE_BUSINESS`, same file |
| Pearson Edexcel GCSE French (1FR0) | **draft, not yet checked** | **draft, not yet checked** | `PEARSON_EDEXCEL_GCSE_FRENCH`, same file |

How the drafts were made, so you know what you are checking:

- **1MA1** is the checked 8300 list under Pearson ids. The Pearson specification
  prints the same national subject content under the same codes (N1–S6) and the
  same ten subheadings, read from the published PDF.
- **The sciences** are AQA's own numbered headings: a topic is a section (4.1),
  a concept is the finest heading beneath each subsection (4.1.3.2). They were
  read from aqa.org.uk and cross-checked mechanically against the published
  specification PDFs; every reference matched. Two titles differ between the
  live site and the 2016 PDF and the site's wording was kept: 8461 4.5.3.7
  "Feedback systems" (PDF: "Negative feedback"), and 8462 4.3.4, which only the
  site marks higher tier.
- **Geography, Business and French** were read on 2026-09-16: Geography from
  the subject content pages on aqa.org.uk, Business and French from the
  published Pearson PDFs. These specifications publish shallower structures than
  the sciences (named units rather than numbered headings), so their outlines
  are shorter. AQA Geography 3.2.1 and 3.2.2 publish key ideas rather than
  numbered headings and carry no concepts. Pearson numbers neither French themes
  nor topics, so no references are recorded.

To sign one off:

- [ ] Compare its topics and concepts with the published specification.
- [ ] For a science outline, set `checked: { topics: true, concepts: true }` on it.
      For 1MA1, set `verified: true` on its topic entry and `verified: true` with
      `provenance: "verified_specification"` on its concept entry. Say who checked
      it and when in `source`.
- [ ] Never change an id once questions may carry it. Change the label; for an
      outline heading that is retitled, pin its old slug in `slugOverrides`.

## 5. Tag the stored questions

New ingestion asks for concepts and command words. Questions ingested earlier
carry neither until they are tagged.

- [ ] See where each course stands:

      node --env-file-if-exists=.env.local scripts/run-ts.mjs scripts/eval/corpus-readiness.ts

  "Tagging by course" lists every ingested course, the state of its lists, and
  how many questions have topics / concepts / a command word read. An ingested
  course with no list at all (an A level, say) needs one drafted first.
- [ ] Tag a course with checked lists, a batch at a time. Each question is one
      provider call:

      node --env-file-if-exists=.env.local scripts/run-ts.mjs scripts/eval/tag-question-details.ts --spec=8300 --batch=10 --batches=5

  Continue with the printed `--cursor` until it reports reaching the end. Read
  the "invented ids dropped" lines: a list that keeps provoking them needs a look.
- [ ] If Firestore asks for an index for the tagging query, create it from the link
      in the error.
- [ ] Spot-check a few tagged questions in the console: the concepts fit, and the
      command word appears in the printed question.
- [ ] Past Paper Practice for a folder on that course shows subtopics under each
      topic, and a session narrowed to one draws only questions tagged with it.
