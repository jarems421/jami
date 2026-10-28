<p align="center">
  <img src="public/icons/icon-512.png" alt="Jami app icon" width="112" height="112" />
</p>

<h1 align="center">Jami</h1>

<p align="center">
  A study workspace for GCSE, A-level and university students: handwritten
  practice on real and generated exam papers, AI marking against the board's
  own rules, spaced-repetition flashcards, and a learning model that decides
  what to do next.
</p>

<p align="center">
  <a href="https://jami.study"><strong>Open Jami</strong></a>
  &middot;
  <a href="https://github.com/jarems421/jami"><strong>Source</strong></a>
</p>

<p align="center">
  <sub>Next.js &middot; TypeScript &middot; Firebase &middot; AI orchestration &middot; FSRS &middot; PWA</sub>
</p>

## About

I built Jami to go beyond flashcards: one place where a student keeps each
subject's notes, papers and cards together, practises on exam-style questions,
gets marked the way an examiner would, and is told what to do next based on
evidence rather than guesswork.

Students keep each subject in a folder with its notebooks, papers, flashcard decks
and sources. They practise on real past-paper questions or on papers Jami writes
in the board's format, write their answers by hand or type them, and have them
marked by two independent AI markers. What they get right and wrong feeds a
learning model that picks the next step: review cards, practise a topic, or sit a
Revision Session where Jami teaches the idea. Installed as a PWA, Jami caches the
app shell and queues reviews taken offline, replaying them when the connection
returns. It is live at [jami.study](https://jami.study).

### What I would point an employer to

- **A deterministic learning model.** Mastery, confidence and exposure are
  calculated by tested pure functions in `lib/learning/`. No model is asked to
  estimate them, and thin evidence never makes a topic "weak".
- **Marking I measured rather than assumed.** Dual-model blind marking with an
  adjudicator, benchmarked against real examiners' marks, with the results,
  small samples and failed experiments reported below.
- **AI with privacy enforced in code.** Zero-data-retention provider routing that
  fails closed, fenced untrusted content, per-user budgets in Firestore
  transactions, and deadlines on every request.
- **Durable, checkpointed jobs.** Paper generation and marking run as Vercel
  Workflow jobs, so a retry pays only for the stage that failed.
- **Engineering discipline.** Over 640 Vitest files, Firestore and Storage rules
  tests, a signed-in Playwright suite on the Firebase emulators, a CI pipeline,
  enforced file-size limits and written architecture rules.

<p align="center">
  <img src="docs/images/jami-hero.png" alt="A past-paper answer marked by Jami, showing the mark, the student's answer and the marking report" width="900" />
</p>

## Product areas

The sidebar has ten destinations in two groups.

**Study**

| Destination | Route | Purpose |
| --- | --- | --- |
| Today | `/dashboard` | With a revision plan: today's planned activities with the next one lit, the week and the exam countdown. Without one: one next step from the learning model |
| Learn | `/dashboard/study` | Scheduled and focused flashcard review |
| Practice | `/dashboard/practice` | Folders, notebooks, past-paper questions and generated papers |
| Jami | `/dashboard/tutor` | The tutor: ask about your sources, plan your revision timetable, review drafts |

**Workspace**

| Destination | Route | Purpose |
| --- | --- | --- |
| Flashcards | `/dashboard/decks` | Decks, with every card at `/dashboard/cards` |
| Topics | `/dashboard/topics` | Concepts and subtopics linking material across folders |
| Goals | `/dashboard/goals` | Flashcard, practice-question and topic targets, as totals or daily habits, paced to a date or a plan's exam; each finished goal earns a star |
| Stars | `/dashboard/constellation` | Earned constellation rewards |
| Progress | `/dashboard/progress` | Weak topics, recent activity and review history |
| Account | `/dashboard/profile` | Profile, authentication and account deletion |

Other surfaces sit under those entries rather than having their own:

| Surface | Route |
| --- | --- |
| Folder | `/dashboard/folders/[folderId]` |
| Notebook (generated papers open here too) | `/dashboard/notebooks/[notebookId]` |
| Sources (the library the tutor reads) | `/dashboard/library` |
| Past-paper question session | `/dashboard/practice/questions/new`, `/dashboard/practice/questions/[sessionId]` |
| Generate a paper, and its print view | `/dashboard/practice/new`, `/dashboard/practice/papers/[notebookId]/print` |
| Practice history | `/dashboard/practice/history` |
| Revision Session | `/dashboard/revision/start`, `/dashboard/revision/[sessionId]` |
| Revision plan and tutor personalisation (including memory) | `/dashboard/tutor/plan`, `/dashboard/tutor/personalise` |
| Appearance and AI usage | `/dashboard/profile/personalise`, `/dashboard/profile/usage` |
| Plans (behind `enableBilling`, off) | `/dashboard/plans` |
| Owner workspace: paper quality and exam corpus | `/dashboard/internal/paper-quality`, `/dashboard/internal/exam-corpus` |

These old routes redirect indefinitely, so existing links keep working:
`/dashboard/practise` → `/dashboard/practice`, `/dashboard/learn` →
`/dashboard/study`, `/dashboard/stats` → `/dashboard/progress`.

## How it works

### Notebooks and flashcards

Notebooks are fixed-page and humble by design: typed notes, pen and highlighter
ink tuned for Apple Pencil, PDF pages rendered client-side with ink overlays, and
the original file never modified. Ink runs on Jami's own engine (`lib/ink/`,
behind `enableJamiInk`), which I am migrating to from `js-draw`; switching the
flag off falls back to `js-draw`, and pages still save as SVG
([`docs/notebook-ink.md`](docs/notebook-ink.md)). Flashcards are scheduled with
FSRS (`ts-fsrs`) plus Jami's own prioritisation. Decks can be imported from Anki
packages, and drafted from notebooks, sources or a video. Nothing the AI drafts
joins a student's studying until they accept it.

### Past Paper Practice

Real exam questions from a shared corpus that I curate, drawn from AQA and
Pearson Edexcel GCSE papers. It is fail-closed: a question,
its mark scheme and its figures are served only while a versioned permission
record covers storage, display to students and AI inference
([`docs/past-paper-practice-rights.md`](docs/past-paper-practice-rights.md)).
Unverified, revoked or superseded-specification material may be stored for review
but is never shown. A student answers one question at a time, writing on the
question's printed pages or typing. They then get a mark, per-criterion feedback,
a next step and, once earned, the official scheme.

### Generated papers

Jami writes full practice papers in a board's own format. The exam-format
library ([`docs/exam-format-library.md`](docs/exam-format-library.md)) records each
component's duration, marks, sections, tariffs and command words from official
documents. Papers are typeset in the board's house style, and graphs are stated
as data and drawn by code rather than by the model. Generation and marking run
as durable Vercel Workflow jobs.

### Marking

Every answer is marked twice, blind: by a primary marker and a cheaper verifier,
in parallel. If they disagree, an adjudicator settles it. Point-marked disputes
go to the stronger model, and levels-marked disputes go to the worker, which was
measured as less harsh on essays. Essay disputes within one mark take the
worker's report without adjudication. Levels-marked questions carry the boards'
levels-of-response guidance. Every stage is checkpointed, so a retry pays only
for the stage that failed. A student can ask for an independent second look at
any marked answer.

The marker is also told how the board's examiners treat each kind of question.
These rules are read from the boards' own mark schemes and examiner reports:
112 subjects and 917 kinds of question across AQA, OCR and Pearson Edexcel GCSE
and AQA A-level. They are paraphrased, never copied, and every rule names its
sources.

### The Learning Engine and Revision Sessions

Jami keeps a model of what each student knows, one profile per folder (or per
deck, for cards that sit in no single folder). Mastery,
confidence and exposure are calculated deterministically in `lib/learning/`, and
no model is ever asked to estimate them. Weak areas need enough evidence before
Jami calls them weak, and untested is never treated as weak. Today, the tutor and
recommendations read that model; they do not own it. Learning evidence is
minimal and append-only: ids, scores and timestamps, never answer text.

Notebook pages feed it when a student asks Tutor to mark their work. Each page
is placed by one resolver (`lib/learning/notebook-page-context.ts`): a page made
for a question counts towards that question's specification concepts and shares
its item, a page with its own Topics counts towards those, and any other page
towards its notebook's Topics. Students can give a page its own Topics from
Tutor, which also says what marking the page will count towards. Checking working
never creates evidence; marking the corrected page does. Tutor's third starting
point on a page is the engine's own decision for its concepts (a quick check,
an exam question, recall from memory), and its profile leads with that page's
concepts. The engine can send a student back to their own page on a concept,
and a marking done there is recorded as the advice being carried out.

When the model decides a student needs teaching, a Revision Session teaches it:
a short explanation with a worked example, a guided question with one retry, then
questions on their own ([`docs/revision-sessions.md`](docs/revision-sessions.md)).
The session's order is a deterministic state machine; the model only writes the
lesson and marks answers.

### AI

Students never choose models. A server-side router resolves logical roles to
approved models:

| Role | Used for | Default |
| --- | --- | --- |
| Worker | Routine tutoring, the verifier marker, levels adjudication | GLM 5.3 Flash |
| Supervisor | Paper generation, the primary marker, point adjudication | Qwen3.6 35B A3B, with Kimi K3 as standby |
| Juror | An independent third view | Kimi K2.6 |
| Gemini | Grounded research, document vision, images, embeddings | Gemini Flash family |

Worker, supervisor and juror run through OpenRouter. The defaults are in
[`lib/ai/provider-policy.ts`](lib/ai/provider-policy.ts), and a deployment can
override them.

These constraints are enforced in code:

- **Provider privacy fails closed.** Every OpenRouter call requires zero data
  retention, denies data collection and uses explicit model and provider
  allowlists. A missing approved endpoint is an error, not permission to fall
  back ([`docs/ai-provider-release-gates.md`](docs/ai-provider-release-gates.md)).
- **Untrusted content is fenced.** Source text and student-written names sit
  inside per-request random boundary markers, so they cannot be read as
  instructions.
- **Context is relevant and bounded.** With source context on, the assistant
  searches the indexed passages of every source attached to the current folder
  by content and reads only what fits a fixed text budget. The current page
  remains authoritative, and sources are read only when the student asks.
- **Per-user budgets.** Request limits are counted in Firestore transactions, and
  refunded when a request fails before producing anything.
- **Deadlines everywhere.** Requests carry deadlines and are cancelled when the
  client disconnects. High-stakes stages retry durably without silently
  downgrading quality.

## Benchmarks

The measured numbers so far. None of them is a release approval: samples are
small, most cover one subject, and each links to the document with its method
and caveats.

### Marking accuracy on real exam scripts

Qualifications Scotland Higher Mathematics 2023, 67 real scripts, marked through
the student path against the examiner's mark-by-mark commentary (22 September
2026, [details](docs/past-paper-marking-release.md)):

| | August | September |
| --- | --- | --- |
| Individual marks agreeing with the examiner | 79.7% | 82.5% |
| Total mark exactly right | 47.5% | 64.2% |
| Total mark within one | 88.5% | 92.5% |
| Bias per answer | +0.51 | +0.09 |
| Marks the examiner withheld that Jami awarded | 50% | 27% |

A larger supervisor (Kimi K2.6) changed one mark of 57 and made it worse, at
three to four times the cost. The model's size is not what limits this.

### Essay marking against two examiners

GCSE English Language reading answers (8 to 20 marks), each marked by two
examiners who differ from each other by 1.31 marks on average. The same 36
answers are marked each time (23 September 2026):

| | Before | Levels guidance | + worker adjudicates | + examiner practice |
| --- | --- | --- | --- | --- |
| Distance from the examiners' mean | 2.26 | 1.88 | 1.15 | 1.10 |
| Within one mark of an examiner | 53% | 67% | 83% | — |
| Between the two examiners' marks | 28% | 31% | 53% | 61% |
| Bias per answer | −2.13 | −1.68 | −0.93 | — |

On 36 fresh answers no change was tuned on, the shipped marker sat 1.11 marks
from the examiners' mean, closer than the examiners were to each other (1.61).
Settling close essay disputes without adjudication cut adjudications from 30 to
18, with no measurable accuracy cost.

### Handwritten extended answers

Thirteen handwritten, examiner-marked Qualifications Scotland scripts. In Higher
Chemistry open questions (11 answers), the bias was +0.45 and 7 answers got
exactly the examiner's mark. In Higher History essays (2 answers), the bias was
+2.0. On real examiners' marks Jami leans slightly generous. One pattern persists:
answers an examiner calls "limited" are marked "reasonable".

### Feedback quality with researched question-type rules

Six AQA GCSE English Language answers were each marked twice, with the researched
rules and with the older hand-written guidance. A model from a different family
compared the two sets of feedback without knowing which was which (24 September
2026, `scripts/eval/feedback-comparison.ts`):

| | With researched rules | Hand-written guidance |
| --- | --- | --- |
| Preferred by the judge | 5 of 6 | 1 of 6 |
| Specific (1–5) | 4.33 | 3.83 |
| Actionable (1–5) | 4.33 | 3.33 |
| Accurate (1–5) | 4.50 | 3.17 |

With the rules, the mark was closer to the examiners' on 3 answers and the same
on 3. This is a small sample in the subject where the old guidance was already
strongest.

### Question-type coverage

Rules for 112 subjects: AQA GCSE (28 of 28), OCR GCSE (31 of 31), AQA A-level
(31 of 31) and Pearson Edexcel GCSE (22 of 25; its 2024 language specifications
have no public mark schemes yet). Across the corpus, between 76% (AQA Biology)
and 100% of questions per subject find a rule. Where a rule is found, it agrees
with the official scheme on whether the question is marked by levels or by points
for all but 16 of about 2,400 questions. Most questions without a rule are 1-mark
science items that fit several 1-mark kinds, and those are marked from their own
scheme.

### Paper generation

The owner benchmark freezes twelve components and generates 108 cases, each
reviewed against hard blockers: unanswerable questions, wrong schemes, invalid
totals, answer leakage and broken visuals. It has not passed yet. The first pilot
produced 0 of 12 usable papers, almost all harness and parser strictness. After
those fixes, a rerun of the six affected cases produced 3. See
[`docs/exam-format-library.md`](docs/exam-format-library.md).

### Tests

About 640 Vitest files (over 6,500 test cases), plus Firestore and Storage rules
tests and a signed-in Playwright suite against the Firebase emulators.

## Technology

| Area | Technology |
| --- | --- |
| Web application | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS, with reusable primitives in `components/ui` |
| Authentication and data | Firebase Auth, Firestore, Cloud Storage |
| Durable jobs | Vercel Workflow (generation, marking, reviews, imports) |
| Review scheduling | `ts-fsrs`, with Jami's own prioritisation on top |
| Notebook ink | Jami Ink (`lib/ink/`), with `js-draw` as a fallback, and `perfect-freehand`, rendered to canvas |
| Documents | `pdfjs-dist` to read, `pdfkit` and `svg-to-pdfkit` to write paper PDFs, `mammoth`, `officeparser` and `cheerio` for imports, `sql.js` for Anki packages |
| Images | `sharp`, `@napi-rs/canvas` |
| Rich text and maths | `react-markdown`, `remark-math`, `rehype-katex`, KaTeX, MathJax |
| Notifications | Web Push (`web-push`), sent hourly by Vercel Cron in each student's time zone |
| Email | `nodemailer`, for sign-in codes |
| Payments | Stripe Checkout, webhook and Portal, behind `enableBilling` (off) |
| AI | OpenRouter role routing, Google GenAI specialists |
| Monitoring | Sentry |
| Testing | Vitest, Playwright, Firebase Rules Unit Testing |

## Repository layout

```text
app/                  Pages, layouts and server Route Handlers
components/           Feature UI, application layout and shared UI primitives
hooks/                Stateful React hooks, including the notebook controllers
lib/                  Pure domain logic: learning, practice, marking, ink, validation
services/             Firebase persistence, AI calls and other I/O
workflows/            Durable jobs: paper generation and marking, question marking and review, imports
tests/                Unit, service and Route Handler tests (Vitest)
e2e/                  Signed-in browser tests against the Firebase emulators
scripts/              Tooling; scripts/eval/ holds the benchmarks and research runs
benchmarks/           Approved marking and paper-generation baselines
artifacts/            Evaluation corpora and reports, created locally by eval scripts (not committed)
docs/                 Design guidance, release gates and measured reports
public/               PWA manifest, service worker, icons and static assets
```

Routes stay thin. Firebase and HTTP access belongs in `services`, pure domain
logic in `lib`, and reusable visual primitives in `components/ui`. See
[`docs/architecture.md`](docs/architecture.md) for dependency and compatibility
boundaries, and [`docs/ui-design-system.md`](docs/ui-design-system.md), which all
UI work must follow.

## Documentation

Contributor and agent rules are in [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` imports
it). Everything else is in `docs/`:

| Document | Covers |
| --- | --- |
| [`architecture.md`](docs/architecture.md) | Layer boundaries and what the tooling enforces |
| [`data-access-audit.md`](docs/data-access-audit.md) | Reads that load a whole collection, why, and how heavy accounts stay fast |
| [`ui-design-system.md`](docs/ui-design-system.md) | The design rules every UI change follows |
| [`manual-qa.md`](docs/manual-qa.md) | The release checklist for what automated tests cannot judge |
| [`learning-engine-verification.md`](docs/learning-engine-verification.md) | Production checks for the Learning Engine, and specification catalogue sign-off |
| [`revision-sessions.md`](docs/revision-sessions.md) | How Revision Sessions teach, and what they record |
| [`tutor-agent.md`](docs/tutor-agent.md) | How Tutor looks things up and checks its work before a Think or Deep answer |
| [`revision-planner.md`](docs/revision-planner.md) | The revision planner: the student's timetable, what fills it, and Jami beside it |
| [`ai-operations.md`](docs/ai-operations.md) | Runbook: release sequence, kill switches, telemetry, job recovery, spend |
| [`ai-provider-release-gates.md`](docs/ai-provider-release-gates.md) | Privacy, quality and operational gates before AI traffic is enabled |
| [`ai-quality-benchmark.md`](docs/ai-quality-benchmark.md) | The offline AI benchmark and its report format |
| [`past-paper-practice-rights.md`](docs/past-paper-practice-rights.md) | Permission records and correctness gates for real exam questions |
| [`past-paper-marking-release.md`](docs/past-paper-marking-release.md) | Marking release checks and measured accuracy |
| [`exam-format-library.md`](docs/exam-format-library.md) | Board exam formats, generated papers and the paper benchmark |
| [`image-occlusion.md`](docs/image-occlusion.md) | Diagram cards |
| [`notebook-ink.md`](docs/notebook-ink.md) | Jami Ink, the notebook ink engine replacing js-draw: plan, format, migration and performance gates |
| [`notifications.md`](docs/notifications.md) | Push nudges by each student's own clock |
| [`plans-and-stardust.md`](docs/plans-and-stardust.md) | Plans, allowances, payments and stardust |

## Local development

### Requirements

- Node.js 22.13 or newer, and npm
- A Firebase project with Authentication, Firestore and Storage
- Java 21, to run the Firebase emulators for rules and browser tests
- OpenRouter and paid-tier Gemini API keys, only to exercise AI features

### Setup

```bash
git clone https://github.com/jarems421/jami.git
cd jami
npm ci
cp .env.example .env.local   # then fill in your own values
npm run dev
```

Open `http://localhost:3000`. The dashboard requires a signed-in Firebase user.

[`.env.example`](.env.example) lists every variable with safe placeholders:
- the Firebase client config and Admin credentials;
- Web Push keys and the cron secret;
- the AI provider keys with their privacy, quality and kill-switch gates, and the
  role models and provider allowlists;
- Practice switches: the exam-format library, per-board question switches, and
  paper and marking job limits;
- Sentry.

AI traffic stays off until its gates are set. Never commit `.env.local` or
production secrets.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run typecheck` | Strict TypeScript checks, including unused code |
| `npm run lint` | Lint the repository |
| `npm test` | Run the Vitest suite once |
| `npm run test:rules` | Firestore and Storage rules tests, in emulators |
| `npm run test:e2e` | Signed-in Playwright suite, in emulators |
| `npm run build` | Production build (runs the marking benchmark check first) |
| `npm run check` | Typecheck, lint, size limits, benchmark checks and Vitest |
| `npm run verify:all` | `check`, plus build, rules tests and browser tests |
| `npm run check:ai-release` | Live check that every approved AI endpoint is up and compliant |
| `npm run check:marking-release` | Strict marking release gate |
| `npm run check:marking-live` | How often markers disagreed on real students' attempts |
| `npm run report:ai-spend` | AI spend by user and action |
| `npm run firebase:rules:deploy` | Deploy Firestore rules, indexes and Storage rules |

Evaluation and research scripts run with
`node --env-file-if-exists=.env.local scripts/run-ts.mjs <script>`:

| Script | Purpose |
| --- | --- |
| `scripts/eval/criterion-run.ts` | Mark a corpus through the student path and compare with examiners; `--variant` switches individual marker changes off |
| `scripts/eval/feedback-comparison.ts` | Blind comparison of feedback with and without researched rules |
| `scripts/eval/research-question-types.ts` | Research a board's question types; `--documents`, `--report` and `--matching` are free |
| `scripts/eval/paper-auto-review.ts` | AI review of a paper-benchmark run |

## Verification

Run focused tests while iterating, and the full gate before a release:

```bash
npm run verify:all
```

Pushes to `main` and pull requests run three parallel jobs in GitHub Actions
([`.github/workflows/quality.yml`](.github/workflows/quality.yml)):
- typecheck, lint, size limits, Vitest and a production build;
- Firestore and Storage rules tests;
- signed-in browser smoke tests on Chromium.

Green unit tests are not enough for UI work. Notebook and responsive changes
also need manual desktop, iPad and phone checks; see
[`docs/manual-qa.md`](docs/manual-qa.md). Pen feel can only be judged with a real
stylus. Before any marking evaluation or release, run `npm run check:ai-release`,
because approved AI endpoints drift within hours. Also make sure a deployment's
model variables match its provider lists
([`docs/past-paper-marking-release.md`](docs/past-paper-marking-release.md)).

## Security and data changes

My rule for this codebase: do not delete legacy Firestore structures, rules, indexes, compatibility fields,
or externally callable API routes on the strength of static import analysis alone.
Inventory production data and traffic first, then use an explicit migration or a
deprecation window. Licensed exam content never enters learner data, and learner
data never stores answer text, source content or tutor conversations.

## License

MIT. See [LICENSE](LICENSE).
