# AI operations runbook

Jami exposes capabilities, not provider or model controls. Browser payloads,
Firestore student documents, analytics, and student-facing errors must never
contain provider names, model IDs, route decisions, prompts, responses, source
text, student work, image bytes, or cost metadata.

## Release sequence

1. Deploy Firestore indexes/rules and Storage rules before enabling any new AI
   surface.
2. Configure the server-only variables in `.env.example` for Preview. Keep
   every API key and Firebase Admin credential sensitive.
3. Complete the privacy and quality gates in
   `docs/ai-provider-release-gates.md`.
4. Run `npm run check:ai-release` inside the Preview deployment environment.
   This live check must pass for every OpenRouter role.
5. Exercise all kill switches using synthetic content, then restore only the
   capabilities approved for release.
6. Run the offline quality benchmark, automated verification, browser checks,
   and a paper-workflow restart/cancellation drill.
7. Cut over production atomically. Do not shadow or replay real student
   content.

## Kill switches

| Incident scope | Immediate action |
|---|---|
| All OpenRouter text inference | Set `OPENROUTER_KILL_SWITCH=true` |
| Independent juror only | Set `OPENROUTER_JUROR_KILL_SWITCH=true` |
| All Gemini specialist inference | Set `GEMINI_KILL_SWITCH=true` |
| Grounded web/URL research (the Tutor agent's searches too) | Set `AI_WEB_RESEARCH_ENABLED=false` |
| Tutor agent's look-ups before Think and Deep answers | Set `NEXT_PUBLIC_ENABLE_TUTOR_AGENT=false` |
| Tutor illustrations | Set `AI_TUTOR_IMAGES_ENABLED=false` |
| Paper raster illustrations | Set `AI_PAPER_IMAGES_ENABLED=false` |
| Second-model check of drawn paper figures | Set `PRACTICE_PAPER_FIGURE_REVIEW_ENABLED=false` |
| Exam-format library | Set `EXAM_FORMAT_LIBRARY_ENABLED=false` |
| Low-confidence format confirmation | Set `PAPER_FORMAT_CONFIRMATION_ENABLED=false` |
| Owner paper-generation benchmark | Set `PAPER_GENERATION_BENCHMARK_ENABLED=false` |
| Full-paper marking | Set `PRACTICE_PAPER_MARKING_WORKFLOW_ENABLED=false` |
| One exam board's questions | Set its `EXAM_QUESTION_<BOARD>_ENABLED=false` |
| One specification's questions | Add it to `EXAM_QUESTION_DISABLED_SPECIFICATIONS` |

After changing a kill switch, redeploy or refresh the runtime environment,
verify that the affected endpoint fails safely, and record the incident. A
disabled specialist must not silently fall back to a general text model.

Before turning full-paper marking on for a new environment, have Preview
complete a synthetic submitted paper, overtime dual scoring, cancellation,
retry, question recheck, and deletion. The service-wide marking lease defaults
to four jobs (`PRACTICE_PAPER_MARKING_JOB_CONCURRENCY=4`) and the automatic
provider ceiling defaults to `$0.50`
(`PRACTICE_PAPER_MARKING_MAX_COST_USD=0.50`). A job that reaches the ceiling
pauses with its evidence and completed provider checkpoints intact; raising the
ceiling or retrying after an operational review does not consume another daily
allowance.

## Tutor thinking levels

Every Tutor question is answered in one of three tiers
(`lib/ai/tutor-thinking.ts`), because effort alone does not separate the
models. Measured in October 2026: the worker (GLM 5.3 Flash) gave its first
words in one to five seconds at any effort and was right on nine in ten hard
competition problems at low and high effort alike; the supervisor's Qwen took
fifteen to a hundred seconds, and three runs in ten broke before finishing.

- **quick**: the worker at low effort. Recall, definitions, hints, chat.
- **think**: the worker at high effort. Calculations, "solve / show that /
  prove / why", questions in parts, a picture of a question, marking.
- **deep**: the supervisor role with its standby, Kimi K3, tried first (correct
  with its working shown, first words in about a second), then Qwen. A student
  challenging an answer, a concept that keeps coming back, a request of 1,200+
  characters or 8+ sources. About ten times the cost of the worker per answer.

The student's setting picks the tier. **Auto**, the default, reads each
question: the rules settle the clear cases, and only an open one gets the
one-line preflight on the worker, which can move it to deep, or to quick when it
is sure. **Low**, **Medium** and **High** are quick, think and deep for
everything. A challenged answer is deep at every level. A repeated challenge gets
the juror (Kimi K2.6), and the answer that reconciles its review stays on Qwen,
so the juror never checks its own family. No attempt is sent less effort than its
role needs, and a model that thinks gets 4,000 tokens of headroom over the
answer's cap, so its thinking cannot cut a reply off mid-sentence.

A Think or Deep turn then looks things up and checks its work before it answers
([`tutor-agent.md`](tutor-agent.md)): planner steps on the worker
(`agent_step`), and at most one independent working (`agent_check`), also on
the worker, inside one 16 s deadline -- logged as `agent.finished` with the
step count, tools, why it stopped and what the look-ups found, as counts.

Each turn logs `routing.decided` with its tier, role, reason and the student's
setting. A slow quick or think answer almost always means the worker's
endpoints are refusing it: look for `provider.model_fallback` and a supervisor
`modelName` on those turns, then run `npm run check:ai-release`.

## Content-free telemetry

Aggregate only these fields from `ai.provider` events:

- logical role and stable route reason;
- approved provider endpoint and configured model ID (operations access only);
- latency, input/output/total token counts, and estimated cost;
- success/failure category and numeric upstream status;
- workflow stage, duration, retry count, cancellation count, and queue depth.

Do not attach a user ID, email, folder/notebook/source/paper ID, free-form error
message, request URL, prompt, answer, citation, source title, file name, or any
student content. Dashboards should show p50/p95 latency, error rate, escalation
rate, queue age, jobs per stage, token/cost totals, and quota rejection counts.

Alert on:

- privacy/release-check failure (page immediately; keep the gate closed);
- spend threshold or abnormal token growth;
- sustained provider failure or empty/invalid structured responses;
- stuck paper stages, expired leases, repeated retries, or growing queue age;
- image validation failures, marking disagreement spikes, or score-bound errors.

## Workflow recovery

Practice-paper steps are idempotent and persist checkpoints. A retry must reuse
the same job and paper IDs, completed artifacts, allowance grant, and assets.
Operators must never create a replacement job merely to resume a clarification.

- A cancellation request takes effect between stages. Remove unfinished paper
  assets and workflow artifacts; only refund an allowance when provider work has
  not started.
- Expired global concurrency leases are safe to reclaim. Never manually edit a
  live lease without first checking its job and workflow run.
- A deployment-interruption drill passes only when the same job resumes without
  duplicate papers, assets, hidden mark schemes, or allowance charges.
- Student-facing failures stay generic. Investigate using content-free failure
  category, workflow stage, timing, and run ID in restricted Vercel tooling.

## Multiple Choice in Learn

Owned study-asset queries include the active user's ID. Session startup gives
saved questions a bounded read. The preparation response delivers each checked
question as soon as its write commits. A ready question can move ahead of one still in
preparation. The visible wait in Multiple Choice ends after five seconds.

Pinned Multiple Choice uses a compact draft request and checks each proposed
set independently. The juror is preferred, with the worker available if that
check fails. The prompt starts from a standalone stem and asks for plausible,
distinct misconceptions. Checked sets are saved as they arrive. The session
rotates past recently seen sets and asks for fresh ones when the current sets
have all been seen, with a cooldown between refreshes. Existing questions stay
available while fresh options are checked.

## Flashcards from notes or files

The review accepts follow-up requests against its original source. Numbered
page and slide requests select those positions in the file before any card
drafting. The job saves current edits and selection before starting a follow-up,
keeps them available if the request fails, and inserts new drafts alongside
the cards from the same source location. The source and evidence are temporary
review inputs and are removed on approval, discard or after 24 hours.

Short PDFs are read as explicitly numbered page images. For longer PDFs, page 1
gets a separate visual read, as do pages missed by both selectable text
extraction and the whole-document visual read. A page's selectable text and its
visual read stay in one section. A page with no draft, or whose review didn't
finish, gets an isolated check that sees the cards its section already kept, so
it fills gaps without repeating them. Warnings name only known file pages and
say when Jami couldn't determine the page count.

From the flashcard creator, the student chooses the material, depth of coverage,
and optionally the topics or study level to focus on. The import job preserves
slide numbers, document headings and speaker notes. The document-vision role reads
images and checks PDFs up to 80 pages for scans and diagram details. PowerPoint
and Word use extracted text. PDF is the way to include their diagrams.

The job uses the same bounded, private provider routing as the Tutor agent.
It sends each passage in a supported import to small drafting and review calls.
The worker inventories individual teaching points and proposes cards. The juror
then reads the original passages independently, accounts for each draft, rewrites
or removes unsuitable cues and adds missing teaching points from the same slide
as well as from slides without cards. The supervisor can replace a failed
review. Code verifies citations and blocks cues that repeat the answer or rely
on seeing the slide. The card count follows the material. If a section cannot
be reviewed, its location appears in the review warning.

An import above the 40-section processing budget or the size a single
Firestore review and approval transaction can safely hold is returned with
instructions to split the source. Jami does not sample sections or trim a
source review to a default card count. Video keeps its existing limit.

The job spends one existing card-import allowance. It runs on request, without
web research or access to unrelated sources. Original material is read in memory
during generation. Supporting excerpts are kept with drafts during review and
removed with the temporary upload on approval or discard.

## Past Paper Practice marking and mark checks

Both AI steps a student can trigger are durable jobs, not parts of the request
that asks for them, and both are bounded by `EXAM_AI_JOB_DEADLINE_MS` and
declared stranded by `EXAM_OPERATION_LEASE_MS`.

### Marking an answer

Marking one exam question is a durable job, not part of the submit request. The
request validates the answer, freezes it, takes the daily allowance and
returns; `markExamQuestionWorkflow` does the marking and writes the result back
to the attempt. The page already polls a `marking` attempt, so the student sees
"being marked now" and the mark arrives when it arrives.

It moved because the request could not hold it. Marking is up to three
sequential provider calls, and `markerTimeoutMs` sizes a single supervisor
report at 408 seconds from measured p99 output and p5 generation rate; the
route had 55 seconds for all three and gave the primary 30. The stage that
overran was reliably the adjudicator -- bought only when two markers disagree
-- so both paid reports were discarded on exactly the answers that most needed
them.

- The job's deadline is `EXAM_AI_JOB_DEADLINE_MS` (10 minutes), a chosen bound
  rather than a measured one. It is not a target: observed markings ran 9.6 to
  28.6 seconds.
- Each marker report is checkpointed on the attempt as it arrives, so a resumed
  job does not buy a report it already has. Their costs still count against the
  marking's audit and ceiling.
- Every write a job makes is conditional on `marking.token`. A resubmission
  issues a new token, and the superseded job can no longer write a mark, a
  failure, or a checkpoint.
- An attempt reading `marking` past `EXAM_OPERATION_LEASE_MS` is stranded, not
  slow. The page offers to mark it again; the evidence is unchanged.
- Failures are recorded on the attempt as a code and a sentence, because the
  request that submitted the answer is long gone. `input_too_large` reopens the
  answer as a draft; `question_changed` and `marking_failed` leave it frozen.

### Checking a mark

A student may ask for one independent check per answer, and
`reviewExamQuestionWorkflow` runs it the same way. It moved for the same reason
and a worse ratio: a check is a juror read and then, when it disagrees, a
supervisor reconciliation -- reports sized at 515 and 408 seconds -- and the
route gave both of them 55 between them.

- The job's identity is `review.token`, a server-generated value, **not**
  `reviewKey`. The key is the client's idempotency token and is derived from the
  session and question, so it is the same string for every check of a given
  answer; a stranded job whose student asked again would still match it.
- The juror report is checkpointed, so a resumed check does not buy the
  expensive half twice.
- **A check that produced nothing is not spent.** `reviewUsed` stays false, the
  mark and feedback are untouched, and the daily allowance is refunded. Every
  route path that does not start a job refunds it too.
- Failures land on the attempt as `reviewFailure`, in the mark check's own
  words: the student's mark stands and their check is still available, which is
  not what the marking sentences say.
- A finished session does **not** cancel a check, unlike a marking. The mark
  report stays reachable from history, and a student may ask there.

## Spend controls

Application quotas are the primary control. Every metered action has a daily
limit and a short burst window in `lib/ai/budgets.ts`: for example 40 Tutor
replies, six generated papers, eight full-paper markings and ten Tutor
illustrations per day, and eight raster visuals per generated paper. When
billing is on (`enableBilling`), monthly plan allowances in
`lib/billing/plans.ts` apply on top of the daily limits; see
[`plans-and-stardust.md`](plans-and-stardust.md). Also set OpenRouter/Google
hard or soft budgets and Vercel spend alerts, and use `npm run report:ai-spend`
to see spend by user and action. Keep paper-job concurrency configurable and
start at four globally active jobs.

Re-run privacy approval, the live provider check, and the quality benchmark
after any model, provider allowlist, prompt, routing threshold, privacy term,
retention policy, SDK, or material price change.
