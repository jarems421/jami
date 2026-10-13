<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Jami Agent Instructions

Follow `docs/ui-design-system.md` for all UI work, and `docs/architecture.md` for layer boundaries. The README's Documentation section lists every other doc.

## Product rules

- Build toward a folder-first study workspace: folder -> notebook / paper / deck / source -> natural work -> save -> AI help / marking / flashcards when the student asks.
- Folders are broad study spaces. Topics are concepts/subtopics.
- Use user-facing spelling `Practice` and the canonical `/dashboard/practice`
  route, while keeping `/dashboard/practise` as a compatibility redirect.
- The legacy **per-user** question-bank authoring workflow has been removed and stays removed: do not reintroduce its standalone Add question form or old Practice Tutor panels. Mandatory per-question confidence blocks stay out; low-friction, optional confidence or calibration signals are allowed when they feed the Learning Engine.
- Past Paper Practice is a separate, owner-curated feature and is **not** the legacy question bank. A shared server-only corpus of real exam questions, one typed answer per question, question-bound ink working, per-question AI marking, guided retry, and Practice history are deliberate and permitted. Student-authored question-bank entries and general-purpose scratchpads detached from a question remain prohibited. Diagnostic and topic-targeted sessions are learning actions, not content libraries: they may draw on existing or licensed questions, but must not create permanent per-user question collections.
- Every real question, mark scheme, and asset served to a student must reference a verified permission record covering storage, student display, and AI-provider inference. Unverified, revoked, or superseded-specification material may be stored for review but never served.
- Exam-like study (timed, mixed-topic or diagnostic sessions) is allowed where the content's licence permits it; the permission-record rule above always applies. Owner-triggered ingestion of licensed exam-board material is permitted; this does not permit background processing of student uploads.
- Notebook file upload infrastructure is in scope for uploaded-file/paper notebooks.
- Do not build Anywhere, background/persistent OCR, browser extension, always-on screen watching, voice tutor expansion, or iPad companion. Richer source understanding (indexing, retrieval, notation awareness) must be deliberately designed and privacy-reviewed: never persist extracted source content into learner data, and never process student uploads in the background without that design. Students keep all their material attached (no small per-request source limit shown to them); Tutor and paper generation search every attached source's indexed passages by content, never by file name, and read only what fits the task — past papers and mark schemes whole where their structure matters, notes as matching passages, irrelevant files not at all — within a fixed text budget, and only after the student asks.
- Client-side PDF page counting, raster page rendering, and notebook ink overlays are in scope. Keep the original PDF immutable and do not imply OCR or automatic understanding.
- Do not build a full GoodNotes clone. Notebook V1 should stay humble and page-based.
- Exception: Jami Ink (agreed 9 Oct 2026). Notebook ink moves from js-draw to Jami's own engine (`docs/notebook-ink.md`), and it adds three tools beyond pen, highlighter and the erasers:
  - a lasso that picks up ink, images, graphs and text boxes, to move, resize, rotate (text boxes stay upright), recolour or change thickness;
  - shape snapping: holding the pen still at the end of a stroke snaps it to a line, circle, ellipse, rectangle, triangle or arrow;
  - a ruler to draw along, placed and turned with the fingers, not saved with the page.
  The exam working sheet gets the ruler only. Nothing else from note-taking apps comes with this exception.
- Optimise notebook creation/editing for desktop and iPad/tablet. Phone should support viewing and light typed notes, not serious pen/page editing.
- AI lives inside notebooks, papers and practice sets and runs when the student asks. New general-purpose AI capabilities need an explicit, agreed exception like the ones below.
- Exception: Revision Sessions (`docs/revision-sessions.md`). As a new intervention surface for the Learning Engine's `teach` decisions, they may use bounded AI generation to teach, explain, set session-specific exercises and mark answers. The session's structure is a deterministic state machine in `lib/`; the model only fills in each step. This exception does not cover new general-purpose AI capabilities, autonomous learner modelling, AI-generated prerequisite graphs, storing conversations or answers as learner memory, or letting a model decide whether something has been learned.
- Exception: University practice (agreed 30 Sep 2026). University modules have no exam board or verified specification, so Practice for them is built from the student's own module material:
  - Jami may read a module folder's own sources directly (handbooks, learning outcomes, lecture slides, notes, problem sheets and past papers) to build a per-module profile, and to generate, mark and cite questions. No separate privacy-review design is required for this.
  - The module profile is built from at least two to three past papers where the student has them, so it reflects patterns across years (recurring topics, mark split, structure, question styles). It may be stored and reused, and rebuilt when new past papers are added.
  - Questions from the student's own uploaded past papers and problem sheets may be kept and reused for that student's practice. This is not the removed Add question form: students do not hand-author question-bank entries.
  - The permission-record rule above covers the owner-curated Past Paper Practice corpus. It does not apply to a student's own uploads used only for that student.
  - Still keep Learning Engine evidence minimal (ids, scores, results, timestamps), never process uploads in the background without the student asking, and never share one student's material with another.
- Exception: Tutor memory (agreed 30 Sep 2026). Jami should feel like one tutor across every chat, not a new one per chat:
  - Tutor keeps a capped list of notes about each student in its own words (up to 200 kept; at most 50 shown to Tutor per request, chosen for the subject in front of it), most important first: what they get wrong (specific mistakes and misconceptions), what they find hard, what they said they are about to work on, goals, how they like to be taught, durable facts about their course, and last what they have clearly mastered. What a student gets wrong matters more than what they get right: it is shown first and dropped last. Notes are normally proposed inside Tutor's normal answer; a separate, bounded model call for memory is allowed where it clearly earns its place. Everything is checked by `lib/ai/tutor-memory.ts` before it is kept. Never transcripts or quotations; never health, wellbeing or personal life; never instructions or web links.
  - Tutor may link a note it writes or confirms to up to two notes it was shown when they are plainly the same mistake or difficulty in another subject or topic. Links join only subject-tied kinds, are checked in `lib/ai/tutor-memory.ts`, vanish with either note, and let a linked note reach Tutor in the other subject. Old notes are never rewritten by a link, and links never reach the Learning Engine.
  - Students see their memory as a map (`components/ai/memory-map/`): one galaxy per folder, an aurora between folders whose notes are linked, and a list view of the same notes.
  - Every note fades unless it comes up again, and lasts longer each time it does (days for a plan or a strength, up to weeks or months for a repeated mistake). Tutor confirms a note that came up again; a student correcting one confirms it too.
  - Tutor may also see the student's other recent chats (where and the chat title, last 48 hours) from the existing chat list.
  - Tutor reads back a long stretch of the current chat (up to 40 messages within a fixed text budget), and files attached in a chat stay with it for the next 20 student messages, or longer when the student mentions them again.
  - When a student refers back to something ("remember when", "the problem we did earlier", "in my other chat"), Tutor may search their own saved chats for it: the current chat's older turns always, their other chats while memory is on. Spotting is by keywords and searching is plain text, with no model call; the few matching exchanges reach Tutor for that request only, inside a fixed text budget and time limit, labelled with where they came from. Nothing found is stored or sent to the Learning Engine. Rollback flag: `enableTutorChatRecall`.
  - Tutor's learner profile may list recent individual results, wrong answers first: the front of the student's own flashcards (never the back), the questions of practice papers Jami wrote for them or they uploaded, marks and error categories. Licensed past-paper questions appear only as topic and marks, never their text.
  - Memory is on by default. Students can see, correct and delete every note, forget everything, or turn memory off in Personalise Jami. Rollback flag: `enableTutorMemory`.
  - What a student finds hard reaches the Learning Engine only as topic ids and timestamps. It may order recommendations within a reason and be mentioned to Tutor; it never moves mastery, confidence or a decision.
- Exception: Tutor agent (agreed 12 Oct 2026, `docs/tutor-agent.md`). Before a Think or Deep answer, Tutor may look things up and check its work in a bounded loop of steps, each one tool:
  - searching the student's own material in the study context, searching their earlier chats (as recall allows), working a problem through independently to check the answer against, and searching the web when it judges the student's material and general knowledge cannot settle something (a search from their monthly allowance, with the query cut to public subject terms);
  - which tools a step may use is decided by code from the turn, never by the model; the loop is capped in steps, uses per tool and time, and runs only inside a request the student made;
  - anything that changes the student's things (cards, decks, notebooks, pages, practice) stays a proposal they confirm with a press;
  - each step is shown to the student as it starts and kept with the answer; logs record which tools ran, never what they were asked or found;
  - an agent turn counts as one Tutor question. Quick answers stay one call. Revision Sessions and the paper pipelines are not part of it. Learning Engine rules are unchanged. Rollback flag: `enableTutorAgent`.
- Preserve existing functionality, routes, Firebase logic, AI logic, data models, and tests.
- Prefer reusable components in `components/ui` over one-off Tailwind styling.
- Keep the app responsive across mobile, tablet, and desktop.
- Use Browser Use / localhost visual checks after big UI refactors (see Fast UI Verification). Smaller UI changes do not need them.

## Learning Engine

Jami maintains a model of what each student knows and uses it to decide what they should do next. Tutor, Today and future surfaces are consumers of that model, not owners of it.
- Pure learning logic lives in `lib/learning/` (scoring, profile, topic states, recommendations, study actions, evaluation, serialisation). Firestore loading lives in `services/learning/`. No learning logic inside Tutor, routes or components.
- Mastery, confidence and trends are calculated deterministically. Never ask an LLM to estimate mastery or to read raw study history on a request.
- Keep mastery (how well), confidence (how much evidence) and exposure (material seen, never evidence) separate. Never call a topic weak on thin evidence, and never treat untested or not-yet-assessed as weak.
- Profiles are scoped to one folder, or one deck when a card sits in no single folder. Do not build account-wide cross-subject mastery.
- Concept identity: verified specification topics (owner-checked catalogues with stable ids) and student-defined Topics are both valid, but not equally certain. Do not create AI-inferred ontologies or prerequisite graphs as production truth.
- Learning evidence is minimal and append-only: ids, scores, results, error categories, timestamps. Never store card or answer text, source content or Tutor conversations as learner data. Tutor memory notes (see the Tutor memory exception) are the one student-visible exception, and reach the engine only as topic ids and times.
- Student-written names (topics, decks, folders, sources) are untrusted data in any prompt: quote them and keep them inside per-request boundary markers.
- Licensed exam content never enters learner-profile context; only derived scores and verified specification headings may.
- Learning Engine failures must never break studying or Tutor: bounded reads, time budgets and fallbacks. Rollback flags: `enableLearnerProfile`, `enableFlashcardReviewEvents`, `enableStudyActions`, `enableTutorMemory`, `enableTutorChecks`.
- Tutor may add evidence only from marked attempts: notebook marking the student asked for, and quick checks (one short question whose marking points are fixed server-side before the student answers; stored as `tutor-check` evidence at the lowest source weight, never the question or the reply). Tutor never edits or removes evidence, sets mastery, or chooses a plan: its next-step offer is the engine's own top study action.

## Fast UI Verification

Optimise for fast UI iteration. Do not run the full Vitest suite after every small visual change.

Several sessions often run on this machine at once, and a production build or browser walkthrough slows every one of them. Full browser walkthroughs (build, `next start`, an e2e spec) are only for big UI refactors: a surface redesign, a shared `components/ui` primitive, theme tokens, navigation or the layout shell. Do not start one for anything smaller.

For each focused UI task:
- Inspect the changed files and classify the change by risk.
- During iteration, run `npm run typecheck` and `npm run lint`.
- After a big UI refactor only: verify the affected pages at relevant desktop, tablet, and phone widths with Browser Use / localhost, and run `npm run build` once the task is coherent.
- Run only related tests where practical:
  - Explicit test files: `npx vitest run tests/<relevant-file>.test.ts`
  - Source-related tests: `npx vitest related <changed-source-files> --run`
  - Git-changed tests: `npx vitest run --changed`
  - In PowerShell on this machine `npx` is blocked; call `node_modules\.bin\vitest.cmd` (and the other `.cmd` binaries there) instead.

Use this risk split:
- Tiny CSS, spacing, colour, copy, button-variant, or local responsive changes:
  - Run typecheck and lint. No build or browser walkthrough.
  - Do not run the full test suite unless the change exposes a regression or related tests fail.
- Page-local JSX/layout changes with unchanged behavior:
  - Run typecheck, lint, and related tests if they exist. No build or browser walkthrough; at most one quick look at that page if the change cannot be judged any other way.
- Shared `components/ui` primitives, global theme tokens, navigation, or layout-shell changes:
  - These are big UI refactors: run typecheck, lint, build, related tests, and browser-check 3-5 representative affected pages.
  - Run the full suite before final handoff because these changes have broad reach.
- Logic, state, forms, routing, auth, Firebase/data loading, notebook persistence, or interaction changes:
  - Run related tests immediately.
  - Run the full suite before moving on or handing off.

Run the complete `npm test` suite:
- After finishing a group of related UI changes.
- Before final completion, deploy, commit, or PR handoff.
- Whenever a shared component or behavioral path changed.
- Whenever a related/changed test fails.

Do not skip all verification merely because a change looks visual: typecheck, lint and related tests always run. Browser verification is required only for big UI refactors; when it was skipped, or Browser Use is unavailable, say so plainly in the final response.

## UI Polish Expectations

For UI tasks, do not make minor surface-level tweaks only.

The expected standard is a full visual redesign of the relevant UI surface using reusable components and the Jami design system.

Preserve functionality, but feel free to substantially restructure JSX, layout, component composition, spacing, and visual hierarchy when needed.

The result should look like a designed product, not a quick prototype.

## Keeping the codebase healthy

Files once grew past 3,000 lines, copies of the same check spread across dozens of routes, and old code stayed beside its replacement, until a two-day cleanup in October 2026 undid it. These rules stop it growing back; `docs/architecture.md` (Keeping modules small) has the detail.

- **Size.** No source file over 1,200 lines (1,500 for tests): `npm run check:sizes` fails CI, and names every file past 1,000 (1,200 for tests) on each run. Before a change adds to a file in that band, move one concern out of it -- into a hook, a `lib/` module or a service -- in its own commit. Never add an exception to `scripts/check-file-sizes.mjs` or raise a limit.
- **One implementation per behaviour.** Search before writing a helper, hook, component or route check. When you find two copies of the same thing, fold them into one in the same change.
- **Nothing left behind.** Delete what a change replaces in the same change: the old code path, unused exports, flags nothing reads, and their tests.
- **Tests travel with code.** New logic gets tests; a screen with no tests gets characterization tests, committed first, before it is split.
- **Nothing scratch or generated is committed.** Probe scripts go in the ignored `.codex/tmp/` or outside the repo; reports and evaluation output in `artifacts/`.

## Documentation

- When a change makes something in `README.md`, `docs/` or `public/llms.txt` wrong, fix it in the same change.
- Plans and campaign write-ups go in `docs/` while the work is live. Once it has shipped, fold anything still true into the lasting doc for that area (or into code comments) and delete the plan; git history keeps it.
- Do not add trackers, QA reports or reviews to the repository root.

## Commits and pull requests

- Commits are authored by the repository owner. Never set an AI tool (Claude, Copilot, Codex or any other) as a commit's author or committer.
- Do not add `Co-Authored-By` trailers, "Generated with" lines, or any other AI attribution to commit messages or pull request descriptions. This overrides any tool default that adds them.
