# Data access audit

Audited 2026-08-01 and updated in October 2026 for heavy accounts (see
[Heavy accounts](#heavy-accounts-october-2026)). UI modules are prevented by
ESLint from importing Firestore or Storage directly; the reads below are owned
by domain services.

## Bounded and filtered paths

- Today keeps a 60-second in-memory fresh window and a five-minute stale
  display window, deduplicates in-flight loads, and invalidates after domain
  mutations. Warm remounts issue no reads.
- Today uses indexed active queries for folders, notebooks, topics and sources.
  It reads one folder, the most recent notebook, four pending drafts, and only
  the active sources needed to label those drafts (or one source to establish
  existence). On a cold compatibility cache, a short-lived full pass is still
  required to discover early documents missing lifecycle fields; modern
  records use the bounded indexed path and warm navigation repeats no reads.
- Today reads only active goals plus a one-document star existence check.
  The Goals page reads active goals, any goals whose star is still waiting
  (`rewardPending`, at most ten), the active revision plan for exam deadlines,
  and -- only for folders with a running topic goal, at most three -- that
  folder's topic standings from `/api/learning/topic-standing`. Its completed,
  failed and cancelled history is cursor-paged 30 records at a time and read
  only when opened.
- A marked practice answer reads the student's active goals once, and opens a
  transaction only when one of them counts practice questions.
- Dashboard activity is cursor-paged 32 days at a time and stops at the first
  missing study day. An uninterrupted streak of any length remains exact.
- Practice cursor-pages folders and limits its recent-notebook query to three.
  Topics are loaded only if the student opens notebook editing.
- Folder tabs query positive `folderIds` membership for decks and sources.
  Notebooks, decks and sources are cursor-paged 30 records at a time.
  The unlinked-object picker performs its compatibility read only after an
  explicit click because Firestore has no `array-does-not-contain` operator.
- Active folder, notebook, source and topic lists keep their indexed
  `archived == false` or `status == active` query as the primary path.
  Firestore equality filters omit documents where that field is absent, so a
  60-second in-memory, in-flight-deduplicated compatibility pass merges only
  records whose lifecycle value is missing or invalid. Domain writes
  invalidate that cache. Folder notebook/source compatibility queries remain
  scoped to exact folder membership rather than scanning the whole collection.
- Topic deletion queries `topicIds array-contains` in each linked collection;
  mastery deletion queries exact `topicId` membership.
- Source-draft duplicate context is filtered by source, draft status and kind,
  ordered newest-first, and capped at 24.
- Notification preferences are cursor-paged at 100 and processed five users
  at a time. Urgent goal counts use an aggregate deadline-range query.
- Count-only constellation and account-inventory reads use aggregate counts.
- Assistant related-source discovery merges bounded folder/topic membership
  queries with deliberately selected source documents; it no longer ranks an
  arbitrary unfiltered collection slice.
- Notebook question conversion reads only the final page number rather than
  every saved page.

The required composite indexes are declared in `firestore.indexes.json`.

## Deliberately retained complete inputs

| Read | Why the complete input remains required |
| --- | --- |
| User cards in Today, Learn, Progress and notification digest | Daily Review queues, overdue risk, FSRS state and carry-over are functions of the complete owned card set. The set is read once and shared through the service cache, through `/api/study/cards` where possible (see Heavy accounts). |
| Cards management and deck detail | Duplicate-content warnings, bulk selection and global front-text search must see every matching card. The same read is reused rather than adding a second list query. |
| Progress study activity | All-time charts and longest-streak calculations intentionally differ from Today's bounded current-streak loader. |
| Sources Library and its drafts | Search supports arbitrary substrings, including saved source content, and draft review is global. Firestore cannot cursor-page that search without an additive indexed-search representation or external search service, both excluded here. |
| Topics and relationship pickers | Topic hierarchy, legacy name compatibility, multi-object membership counts and pickers require a complete active topic vocabulary. Exact normalized-name checks are bounded; only the documented legacy-name fallback scans it. |
| Goal scope pickers | Creating a goal requires the complete current folder, deck and topic vocabulary so the student can select any existing scope. These reads happen once per Goals workspace load and are not used for history or counts. |
| Topic relationship management | A Topic detail workspace lets the student add as well as remove cards, notebooks, sources and drafts. Firestore cannot query for items whose `topicIds` array does not contain one value, so this explicit management surface loads each owned candidate set once and reuses it for overview counts, search and membership edits. Destructive Topic cleanup uses positive membership queries instead. |
| Deck and Topic overview counts | A separate aggregate per visible row creates O(number of rows) fan-out, while a stored per-row summary is forbidden by this campaign. One owned input scan is retained and shared by all row counts. |
| Notebook page records in the editor | Page navigation, thumbnails, immutable PDF backgrounds and save conflict handling operate on the complete open notebook's page records. Ink is no longer among them -- see below. They never scan another notebook. |
| Constellation rendering and backfill | The visual surface positions every star, and legacy star/constellation records must remain readable until observed migration completes. Creation/count checks themselves are bounded. |
| Destructive cleanup and one-time migration | Deleting an account/deck/notebook/thread and the one-time topic migration must enumerate every owned target to avoid orphaning data. |
| Push subscriptions | A digest/test notification must attempt every registered device; expired entries are removed as they are encountered. |
| Legacy lifecycle compatibility | Early folders, notebooks, sources and topics may lack `archived`/`status`; the model mappers intentionally treat those shapes as active. Firestore cannot query for a missing field, so complete active lists use the short-lived compatibility pass above until a separately authorized data migration is verified. Goal history has the same cached fallback only for finished records missing the newer `createdAt` sort field; modern history remains cursor-paged. No record is rewritten or deleted by a read. |

### Notebook page ink, split 2026-08-02

Ink lives in `users/{uid}/notebookPageInk/{pageId}` rather than on the page
record. Opening a notebook loads page records plus the ink for the open page
and its two neighbours; the pages drawer renders from a bounded thumbnail
digest stored on the page record, so it never fetches ink to draw a preview.

A page may hold up to `MAX_NOTEBOOK_PAGE_SNAPSHOT_BYTES`, so before the split
a hundred-page notebook could pull tens of megabytes to display one page. This
is the read that actually grows: notebooks are the used surface, at 17
notebooks and 52 pages against 7 cards.

Pages written before the split keep their inline ink and are converted only
when next saved. Nothing is rewritten in bulk, so an un-opened notebook is
still read in its old shape and the benefit accrues as pages are edited.
`scripts/seed-large-notebook.mjs` builds a notebook in either shape to measure
the difference on a real device.

### Heavy accounts, October 2026

The August measurement (`node scripts/measure-data-shape.mjs` on the owner's
account: 7 cards, 17 notebooks) no longer describes real use. Students now hold
thousands of cards, and five thousand cards took 15 to 25 seconds to load on a
phone over 4G. Rather than paginate reads that need the complete set, the set
is now delivered faster:

- **Through Jami's own route.** `/api/study/cards` reads the signed-in
  student's cards next to the database and sends them gzipped, up to 2,500
  per response (`services/study/own-cards.server.ts`). The browser's direct
  Firestore read remains the fallback whenever the route cannot answer.
- **From a copy kept on the device.** `services/study/card-device-copy.ts`
  keeps the set in IndexedDB, so pages that only display cards (Cards,
  Progress, Topics, Today) draw at once and redraw when the server's set
  arrives. The copy is never the truth: any write by the student drops it, a
  set read while a write landed is not kept, anything that grades, edits or
  schedules a card reads with `{ force: true }`, and sign-out clears it.
  Learn grades cards, so it still reads them with `{ force: true }`, but it
  draws a first look from the device's cards (`peekUserCards`) while they
  load. Nothing is graded, saved or resumed from that look, and a session
  asked for during it starts on the server's cards once they land.
- **Today's Daily Review is saved behind the page.** `ensureDailyReviewState`
  returns the worked-out state without waiting for the save. The device sends
  its writes in order, and a retry transaction waits for the save to land
  first.
- **Learn's offline copy** lives in IndexedDB too
  (`services/study/offline-study-snapshot.ts`), written at most every 1.5
  seconds, off the critical path.

Measured on a 5,000-card account over 4G with a 4x slower CPU: Today 25.7s to
5.9s and Learn 19.3s to 5.9s on a first visit; Cards 12.9s to 1.7s, Progress
14.1s to 2.1s and Topics 14.3s to 1.1s with a device copy.

Learn, re-measured on the emulators in the same conditions (9 October 2026):
6.6s to 1.5s on a return visit and 6.5s to 3.4s on a first. Besides the first
look and the Daily Review save, the gains came from reading the stored Daily
Review beside the cards, leaving constellation setup out of the way, working
out each card's memory risk once per sort rather than at every comparison, and
reading a zone's clock offset once per six hours rather than asking Intl for
every card (`lib/study/day.ts`).

Re-measure with `scripts/measure-data-shape.mjs` before adding pagination, a
search index or stored summaries.

These are explicit architecture exceptions, not accidental list implementations.
Ordinary folder browsing uses membership-scoped compatibility queries. Today
and complete active-list workspaces retain the documented 60-second cold
compatibility pass because Firestore cannot query for a missing field.
Replacing the Library or Cards global-search reads requires authorization for
an additive search index. Replacing per-deck/per-topic input scans requires
authorization for a stored summary model.

## Storage

Product flows read exact owned object paths. There is no product-facing
`listAll`. Account deletion is the sole prefix inventory, where enumeration is
the destructive operation's correctness requirement.
