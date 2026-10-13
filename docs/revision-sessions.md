# Revision Sessions

A Revision Session is Jami actually teaching the thing the Learning Engine says a
student needs taught. When the engine decides `teach`, a session is how Jami
acts on it: Jami explains the idea, makes the student do the thinking, checks
each answer, and hands structured evidence back to the engine.

Stage 1 and Stage 1.5 (below) are built and on, behind the rollback flag
`enableRevisionSessions`. The
state machine is in `lib/revision/`, the server side in
`services/learning/revision-sessions.ts` and `app/api/learning/revision-sessions/`,
and the screens at `/dashboard/revision/`.

The test for Stage 1 was:

> Can a student go from "Jami thinks I need teaching on X" to being taught X,
> actively practising X, being checked on X, and returning to Today with useful
> evidence — without ever feeling like they are using a chatbot?

## 1. Principles

- **The product owns the structure; the model fills it in.** The sequence of a
  session is a deterministic state machine in `lib/`. The model writes the
  teaching and the questions inside each step and marks answers. It never
  chooses the next step, never decides a student has understood, and never
  writes to learner data.
- **Not a chat.** A full-screen learning canvas with one thing on it at a time.
  Jami's words are short and sit above the activity, never in bubbles.
- **Tiny explanations.** Nothing over about 120 words at once, always with a
  worked example.
- **The student does the thinking.** Most of a session is the student answering.
- **No engine vocabulary.** No mastery, confidence, percentages or "evidence".
  Plain tutoring language only.
- **Calm.** No confetti, no XP, no red crosses. "Not quite." and a reason.

## 2. What the student sees

**Entry — Today.** When the engine's top recommendation is a `teach`
intervention, Today's mission card becomes a session invitation:

```
REVISION SESSION
Completing the square
Let's get this properly understood.
~15 min · Based on your recent work
[Start session]                                   Why this?
```

"Why this?" shows the engine's existing explanation lines
(`lib/learning/interventions/explain.ts`) — student language, no numbers.

**Intro.** Starting opens `/dashboard/revision/[sessionId]` full screen. The
intro names the topic and the three things the session will cover, while the
lesson is prepared behind it. "Start" enables when it is ready.

**The session.** One step at a time:

```
COMPLETING THE SQUARE                                   ● ● ○ ○ ○   ✕
─────────────────────────────────────────────────────────────────────
Your turn
Complete x² + 8x + 3 in the form (x + a)² + b.

[ answer field                                                  ]
                                           Show a hint     [Check]
```

After checking: a quiet confirmation ("Yes — half of 8 is 4.") or "Not quite."
with one sentence of why, then **Continue**. A wrong answer on the guided step
gets the idea explained a different way and one more try.

**Completion.**

```
That's enough for today.

✓ Explained the idea back
✓ Completed one on your own
· The unfamiliar question was harder — Jami will keep an eye on it.

[Back to Today]
```

Ticks only appear for steps the student actually got right. The closing line
is chosen by code from the step outcomes, not written by the model.

**Back on Today.** The mission card shows the existing completion moment
(`MissionComplete`) and the engine's next recommendation.

## 3. Session framework

A session is a **policy** — an ordered path of step kinds — run by one state
machine (`lib/revision/session-machine.ts`, pure and unit-tested).

Stage 1 implements the `teach` policy only:

```
INTRO → ORIENT → EXPLAIN → GUIDED_TRY → CHECK
                                          ├─ correct/partial → INDEPENDENT_TRY
                                          └─ incorrect → RETRY (explain differently, one more try) → INDEPENDENT_TRY
INDEPENDENT_TRY → CHECK → APPLY → CHECK → RETRIEVE → CHECK → COMPLETE → HANDOFF
```

- `CHECK` is not a screen of its own; it is what happens when an answer is
  submitted. The machine records the result and moves on.
- Only the guided step can branch, and only once. A retry that is still wrong
  moves on — Stage 1 never loops.
- Every answered step can be skipped ("I'm not sure — show me"), which records
  it as not answered and reveals the worked answer.

Later policies reuse the same machine with different paths (Stage 2+):

```
diagnose:  ORIENT → TRY → CHECK → TARGETED_TEACH → RETRY → APPLY
reinforce: RETRIEVE → APPLY → EXAM → RETRIEVE
```

The step names are internal. The student sees "Start here", "Your turn",
"On your own", "Use it", "Without looking back".

## 4. What the model does, per step

All generation goes through `generateAiText` with the `worker` role and a new
`revisionSession` budget action. Student-written names (topic, folder) are
quoted inside per-request boundary markers, as everywhere else.

| Step | Model job | Output (validated server-side) |
| --- | --- | --- |
| Prepare (once) | Write the whole lesson for one concept: three goals, a short explanation with one worked example, a guided task with hint and expected answer, an independent task, an application task in an unfamiliar form, and a retrieval prompt. | One JSON object; every field length-capped; rejected and retried once if malformed. Kept shallow on purpose — the example sits beside the explanation, and worked solutions are lists of lines — because the worker miscounts closing brackets on deeper nesting. Measure with `npm run eval:revision-lesson`. |
| CHECK | Mark one answer against that step's expected answer. | `verdict` (correct / partial / incorrect), `score` 0–1, one sentence of feedback, `errorCategory` from the fixed list or null. |
| RETRY | Explain the same idea a different way, and give one new guided task. | Same shape as the guided task. |
| ASK (any step) | Answer a question the student asks about the step on screen: "Ask Jami about this" under every step. | Plain text, at most 1,500 characters, shown once beside the step. Budget action `revisionQuestion`, which spends no allowance of its own. |

The model never sees learner history, mastery or the student's other answers.
Its context is: the concept's label, the course and level from the folder (if
set), the verified specification heading (if the concept is a specification
concept), and — for marking — the one step and the one answer.

**Course material (13 Oct 2026).** Preparing a lesson, writing the second
explanation and answering a question each search the folder's active sources
once (`loadRevisionConceptContext` with a `materialQuery`). The search is for
the concept, or for the concept and the question, and passes up to three
passages of 1,200 characters, inside their own untrusted markers. The model is
told to teach in the course's notation and conventions, never to copy the
material's sentences or questions, and to ignore passages off the concept. A
search that fails or takes more than six seconds leaves the lesson taught as
before. Nothing found is stored, and the lesson written from it is deleted with
the session like any other. Marking never gets material.

**Questions mid-session.** `POST /api/learning/revision-sessions/[id]/ask`
answers from `projectRevisionSession(record).step`, the same view the browser
was sent. So a hint or an answer the student has not unlocked never reaches the
prompt, and while a question is unanswered the model is told not to give its
answer or the working to it. The session, its steps and its evidence are
unchanged, and neither the question nor the answer is stored.

Expected answers and hints stay on the server until the step is answered or
the hint is asked for.

## 5. Data

One document per session, **server-written only**:

`users/{uid}/revisionSessions/{sessionId}`

| Field | Holds |
| --- | --- |
| `schemaVersion`, `policy` | `1`, `"teach"` |
| `status` | `preparing` · `active` · `completed` · `abandoned` · `failed` |
| `target` | `topicKey`, `source`, `folderId?`, `deckId?`, `conceptLabel` (resolved on the server from the engine, never from the request) |
| `actionId` | The recommendation that opened it |
| `lesson` | The generated lesson, including expected answers. **Deleted when the session ends.** |
| `steps[]` | Per step: `kind`, `attempts`, `verdict`, `score`, `errorCategory?`, `hintUsed`, `skipped`, `answeredAt` |
| `position` | The current step |
| `createdAt`, `updatedAt`, `completedAt` | Epoch ms |

What is **never** stored: anything the student typed, the model's feedback
text, or a transcript. An answer is marked in memory and discarded — the same
rule as `/api/ai/study-answer/check`.

Rules: read by the owner; no client create or update, and only the owner may
delete. Generated lesson content is teaching material, not learner
data, and it is removed at completion either way.

One active session per student: starting a new one abandons the old one and
deletes its lesson.

## 6. Evidence and the Learning Engine

On completion the server:

1. Keeps the text-free `steps[]` as the session's evidence.
2. Records a `completed` study-action event against `actionId` (the existing
   mechanism), so the engine knows its advice was carried out.
3. Makes the evidence available to the learner profile as a new evidence kind,
   `revision`.

How it is scored:

- Only **independent** steps count: `INDEPENDENT_TRY`, `APPLY` and `RETRIEVE`.
  The guided step and its retry are scaffolded, so they say little about what
  the student can do alone.
- A skipped step counts as a score of 0. A step whose marking failed and was
  self-graded does not count at all — a self-report is not evidence.
- Each counted step is one observation, carrying the session's `actionId` as
  its `interventionId`.
- **Trust:** model-marked work, so `revision` is weighted exactly as `notebook`
  is — a fraction of scheme-marked work, and never enough to call a topic on
  its own. No new tuning constant is introduced; it reuses the notebook weight.

The model never estimates mastery. It marks answers; the engine turns marks
into mastery the same way it does for every other source.

## 7. Error taxonomy

Marking may name at most one category per answer, chosen from the engine's
existing fixed list (`LEARNING_ERROR_CATEGORIES` in `lib/learning/types.ts`),
or none. Anything else the model returns is dropped. Categories flow into
`errorChecks` on the observation exactly as marked answers' do.

Stage 1 deliberately adds no new categories. Teaching sessions will want some
the exam-oriented list lacks (a calculation slip, a method error, a
misconception); that belongs with Stage 2's persistent mistake memory, where
their detection and display wording can be designed together.

## 8. Entry points

- **Stage 1:** Today's mission, when the chosen intervention is `teach`.
  `resolveInterventionDestination` returns a `revision-session` destination
  pointing at `/dashboard/revision/new?action=<actionId>`.
- The session is created on the server from the `actionId`: the server
  re-derives the student's study actions and refuses an id that is not one of
  them. The client never supplies the topic.
- **Not in Stage 1:** manual start ("What do you want to revise?"), Topic-page
  entry, focus choices, lengths.

## 9. Failure states

| Situation | What the student sees |
| --- | --- |
| Feature flag off, or no AI provider | Today keeps linking to the Topic page, as now. |
| Budget exhausted | "Jami has done a lot of teaching today. Try again tomorrow." Back to Today. |
| Preparing fails or times out | "Jami couldn't prepare this session just now." Try again / Back to Today. The session is marked `failed`, and nothing counts. |
| Marking fails for one answer | The expected answer is shown with "Did you get it?" Yes / Not quite. Recorded as self-graded: shown in the flow, excluded from evidence. |
| Leaves mid-session | Reopening within four hours resumes at the same step. Older than that it is `abandoned`, its lesson is deleted, and nothing counts. |
| Network drops on submit | The answer stays in the field; "Couldn't reach Jami — try again." |

## 10. Stage 1 scope

**In:** the `teach` policy end to end; Today entry and handback; intro,
explanation, guided try with hint, one retry, independent try, application,
retrieval, completion; server-side marking; text-free evidence; the `revision`
evidence kind; the rules; the flag `enableRevisionSessions`; budget action;
resuming a session.

**Added 13 Oct 2026:** course-material grounding and questions about any step
("Why?", "Explain it differently"), as described in §4.

**Not in Stage 1:** notebook "Work it out" (Stage 3), persistent mistake memory
and "quick check from last time", adaptive branching beyond the single retry,
planner follow-ups, session lengths, diagnose/reinforce policies, manual start.

## 11. Acceptance criteria

1. With a `teach` recommendation on Today, the mission card reads as a
   Revision Session with "Why this?", and Start opens the session.
2. The session opens full screen, prepares in the background, and shows no
   chat UI.
3. The student is taught (explanation with worked example), answers a guided
   question, is marked, gets one different explanation and retry when wrong,
   then answers an independent, an application and a retrieval question.
4. Every answer is marked by the server; expected answers never reach the
   browser before the step is answered.
5. Completion shows only ticks the student earned, and a closing line chosen
   by code.
6. Back on Today: the completion moment shows, and the recommendation has been
   recorded as completed.
7. The learner profile includes the independent steps as `revision` evidence at
   notebook weight, tagged with the intervention.
8. Nothing the student typed, and no model feedback text, is stored anywhere.
9. Leaving and returning resumes; a failed preparation or marking never strands
   the student.
10. Works on desktop, iPad and phone.

---

# Stage 1.5 — starting anywhere, next steps, and the Tutor shelf

## Starting a session

A student can start a session on any concept in a folder, not only when Today
recommends one.

- **Where:** Today (the engine's teach recommendation, as before), the folder's
  Notebooks tab (a "Revision session" pill beside Exam questions and Practice
  papers), the Tutor page, a Topic page, and the notebook Tutor drawer. The
  notebook's chip always opens the folder's list, never a session directly: a
  student asking about their notes has not yet chosen to be taught something.
- **One start page**, `/dashboard/revision/start?folder=…&topic=…`. It lists
  the folder's concepts: specification concepts grouped under their headings,
  and the student's own Topics. Search filters the list. The ones the engine
  has decided need work sit at the top as "Jami suggests". No free text yet.
- A concept that has specification concepts under it asks "Which part?" before
  starting.
- **What the server accepts:** a recommendation id, as in Stage 1, or a folder
  and a concept key. The key must be a declared concept in that folder's
  learner profile. A student Topic or a verified specification concept is
  accepted; anything else is refused.
- A session started this way carries the engine's action id if the engine has
  a recommendation on that concept. Otherwise it has none. It counts as
  evidence either way, because its concept is real.

## Why an answer went wrong

Marking now also names what kind of mistake a wrong or partial answer was,
from a fixed list, and nothing else:

| `mistake` | Means |
| --- | --- |
| `concept` | The idea itself is wrong or missing: what it is, or why it works |
| `method` | The idea is right; a step is missing, out of order or misapplied |
| `slip` | The method is right; an arithmetic or copying error |

It is stored on the step like the error category, and is used only to choose
next steps. It is not a learner-memory record and does not change mastery.

## Next steps

When a session finishes, the server chooses up to three next steps by rule
(`lib/revision/next-steps.ts`), stores them on the session, and the completion
screen offers each with **Do it now** and **Do later**.

| Signal in the session | Offer |
| --- | --- |
| The idea didn't land: a `concept` mistake, a retry was needed, or recall without help failed | **Flashcards on this**: Jami writes them, the student reviews them before anything is saved. For a student Topic, where Jami cannot write cards, "Review your cards on this" if cards exist |
| The steps didn't hold: a `method` mistake, the unfamiliar question failed while the on-your-own one held, or hints were needed on the unscaffolded questions | **Practice questions**: real exam questions on the concept where the course has them, otherwise a short set Jami writes |
| Everything held | **An exam-style question** on it, where the course has them |
| Always considered | **A session on a neighbouring concept**: under the same specification heading, or another Topic in the folder, that the engine currently marks as needing work. Never suggested by the model |

Only slips, and nothing else wrong, produce no remedial offer.

## The Tutor shelf

A small list on the Tutor page, stored per student at
`users/{uid}/revisionShelf/{id}`:

- **Saved for later:** anything "Do later" was pressed on, with Start and
  Remove.
- **Made for you:** practice sets and cards Jami wrote from a session and the
  student kept, with a link to open them.

Each item holds a kind, a concept key and label, a folder, and a link target —
never questions, answers or text the student wrote. The practice sets
themselves live where all practice papers live, in the folder. This is a
to-do list, not a question bank: nothing here is a student-authored question
collection, and generated questions stay on the server as practice papers
already do.

The student writes and removes their own shelf items. The rules validate the
shape and refuse edits.
