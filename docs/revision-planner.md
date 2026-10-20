# Revision planner

Your plan. Built your way. Improved by Jami.

The planner (`/dashboard/tutor/plan`) is a calendar of study activities that
belongs to the student. A student who knows exactly what they want lays it out
themselves; one who would rather not tells Jami about their exams and their week
and watches it build one. Both arrive at the same editable timetable, and either
can switch to the other way at any time without starting again.

Three rules the design turns on:

1. **The timetable is the student's.** Every activity can be added, edited,
   moved, copied, removed, fixed or handed back to the usual week directly,
   without asking Jami.
2. **Jami is an assistant, not an invisible scheduler.** It fills free sessions
   when asked, proposes changes in conversation, and suggests better work as the
   evidence moves -- always visibly, and nothing it would change happens until
   the student applies it.
3. **A saved plan holds dependable work.** A day either has real activities on
   it, or says plainly that it holds free time from the usual week. Nothing
   promises that Jami will decide on the day.

## The model

`lib/planning/types.ts` holds the shapes; the plan lives at
`users/{uid}/revisionPlans/{planId}` and each day that has a timetable of its own
at `.../entries/{dayKey}`.

- **The plan**: title, dates, subjects (folder or deck scopes, weighted 1 to 3),
  exams, `autoFill`, and the **usual week** (`sessions`) -- when the student can
  normally study. The usual week may be empty: a plan can be nothing but
  activities placed by hand.
- **A day's timetable** (`entries/{dayKey}.activities`): the activities on that
  date, each with a title, method (practice, flashcards, revision session,
  notebook, notes, or the student's own task), length, optional time, subject and
  topic, and a link that starts it. Notebook work may name its notebook
  (`notebookId`), and then links to it. `done` beside them records what was
  done, one key per activity, so ticks merge without rewriting the day (offline
  too); a session timed in its notebook keeps how long it ran (`minutes`).
- **A day without a timetable** shows the usual week's sittings as **free
  sessions**: time set aside, honestly empty, with the subject the week's
  rotation gives it (`planFreeSessionsOn`). A subject drops out of the rotation
  after its last exam. Editing such a day first turns its free sessions into
  stored ones, so nothing the student could see vanishes on their first change.
- **Fixed** activities are the student's -- chosen, kept or written by them --
  and are never replaced. **Adaptive** activities are Jami's picks (or ones the
  student said Jami may adapt): Jami may *suggest* better work for them.

Version 2 plans (one recurring week, resolved against the engine every read)
are read forward without a migration: their days simply have no timetable yet,
their pinned tasks are read into activities, and `planAutoFills` treats them as
`autoFill: true`, which is what they always did. Version 1 `cadence` is still
read as the usual week.

## What fills a day

- **The student**, in the activity editor (`PlanActivityEditor`), from the
  planner or from Today. It asks in the order a student thinks: the kind of work
  (one tap, "Jami picks" among them), what it is about, when and for how long.
  Nothing else is required: an activity left unnamed is called after its
  notebook, its topic or its kind (`defaultPlanActivityTitle`), so "Notebook
  work, 30 minutes" is a whole plan. Notebook work can name the notebook it is
  done in (read the first time notebook work is chosen,
  `hooks/usePlanNotebookOptions.ts`).
- **Jami, when asked** -- "Jami picks" in the editor, "Let Jami pick" on a free
  session, a day's Fill button, "Let Jami fill them", a proposal in
  conversation, or "Let Jami fill my free sessions" in plan settings.
  `fillFreeSessions` splits each free session by length (45 minutes is 30 and
  15), and gives each piece the Learning Engine's next action for that subject,
  in the engine's order, each used once per fill. When the engine has nothing
  more, the task falls back to what the subject certainly has -- its due cards,
  its exam questions -- and with neither, the time stays a free session. No
  language model chooses what goes in a session.
- A pick never quietly does nothing. A subject the plan does not cover yet, or
  one the engine has not answered for, is asked about there and then
  (`usePlanDrafting().forScopes`) and the pick waits for the answer. When there
  is still nothing to pick from, Jami says which subject and why
  (`planFillNotice`): the editor offers to keep the time free instead, and the
  planner and Today show the same words beside the timetable.
- **Automatically, for plans that ask for it** (`autoFill`): Jami keeps this week
  and next filled (`planAutoFillWindow`), on Today and in the planner, each day
  once a visit. On by default for plans built with Jami and for version 2 plans;
  off for plans built by hand. Building with Jami, the first fortnight is
  drafted in front of the student before anything is saved, and drafted again
  when the usual week changes -- only days still exactly as Jami drafted them.

The engine is asked about the plan's own subjects (`GET
/api/learning/study-actions?scopes=...`, up to eight actions for each of up to
six subjects, nothing resting after a recent attempt), not Today's top four.

Scheduling an activity never generates material. A task whose material does not
exist yet (`writtenOnStart`) says so on the timetable -- "Jami writes them when
you start" -- rather than presenting itself as ready.

## Keeping Jami's picks current

`planRefreshSuggestions` compares each adaptive task still to do with what the
engine now recommends for its subject, and suggests a replacement only when the
planned work is no longer recommended at all, or was a fallback the engine now
has something specific for. A task still recommended is left alone however its
rank moved, and a subject the engine did not answer for is never flagged. The
student chooses "Use it" or "Keep mine" (which fixes it).

## What counts as done

`lib/planning/plan-completion.ts`. Each kind of evidence completes only what it
is evidence of:

- Finishing the session a task's link opened records a completed study action
  event for its action id; that completes that task, on any day.
- Flashcard tasks complete from reviews of their own cards -- the topic's, the
  deck's or the subject's -- shared out, never counted twice, and read only for
  today (a card keeps only its latest review). Work seen today is written down
  today (`by: "activity"`).
- Notebook work completes in its notebook. A notebook offers today's planned
  notebook work that belongs to it -- set in that notebook, then set for any
  notebook in its folder -- as a pill in its bar (`NotebookPlanSession`,
  `lib/planning/plan-notebook.ts`). Start runs a clock (kept on the device, so
  a reload keeps it); Finish ticks the activity `by: "activity"` with the
  minutes it ran; Stop leaves it unticked. It is a clock and a tick: nothing on
  the page is read for it, and it is hidden while an exam is in progress.
- Everything else, practice questions included, is the student's tick. Reviewing
  Biology cards no longer ticks "10 homeostasis exam questions".

None of this is learner evidence.

## Changing the timetable

Every change is an op (`lib/planning/timetable-ops.ts`): add, update, move,
duplicate, remove, clear a day, set a day. The planner, Today, Jami's applied
proposals, fills and undo all make the same ops (`hooks/usePlanEdits.ts`). On a
running plan they are applied on screen at once and written in order inside a
transaction that re-applies them to the stored days, so an edit from another
device is kept; a fill carries the ids it was worked out from (`ifIds`) and is
dropped if the day has changed. While a plan is being built, everything stays in
memory until "Save plan" writes the plan and its days in one batch. Every change
can be undone.

## Jami beside the timetable

`components/planning/PlanWithJami.tsx`, beside the timetable on wide screens and
in a drawer below 1280px. Building, the column is wider (27rem) and the answers
take its whole width; their rows lay out by the column's own width
(`.plan-answers`, `.plan-dates-grid` in `app/globals.css`), never the screen's.
Asking for Jami when it is already beside the timetable lights the panel and
puts the focus on its first answer.

- **Building**: the four questions of `lib/planning/plan-interview.ts` (working
  towards, subjects, the week, anything else), answered by tapping or typing,
  fill the plan in as before.
- **At any point**, a student can ask for particular things on particular days.
  The reply carries a proposal -- the changes in full, "Move 2 activities · Mon
  → Wed" -- to apply or discard. Changing a running plan, changes to the plan
  itself (exams, subjects, the usual week) are proposals too.

What the model may decide is held in code (`lib/planning/plan-proposal.ts`): it
refers to activities only by the refs it was shown (A1, A2) and to subjects only
by theirs; a title survives only if its topic words are the student's own
(`isInStudentWords`), otherwise the task is Jami's pick from the engine; fills
are done by `fillFreeSessions`. Planner chats count against the `planDraft`
daily budget, refunded when no answer came. Nothing from the conversation is
stored.

## Dates

Every date is a study day: London, turning over at 4am (`lib/study/day.ts`).
Between midnight and 4am the planner says it is still yesterday's plan. Within
a day, activities are ordered by the study day's clock, so 00:30 follows 23:00.
The model is never left to work out a weekday: the prompt names today's and
lists every date of the coming weeks with its weekday (`planCalendarLines`) --
told only "2026-10-20", a model put "next Thursday" a day out.

## Where things are

| Concern | Files |
| --- | --- |
| Model, bounds, words | `lib/planning/types.ts`, `plan-activities.ts`, `plan-format.ts`, `normalize-plan.ts` |
| Reading a day | `lib/planning/timetable.ts`, `plan-completion.ts`, `plan-schedule.ts` |
| Filling and suggestions | `lib/planning/plan-drafting.ts` |
| Changes | `lib/planning/timetable-ops.ts`, `hooks/usePlanEdits.ts`, `hooks/usePlanTimetable.ts` |
| Jami | `lib/planning/plan-interview.ts`, `plan-proposal.ts`, `plan-timetable-prompt.ts`, `services/ai/plan-draft.server.ts`, `app/api/ai/plan-draft/route.ts` |
| Screens | `components/planning/RevisionPlanner.tsx` and its views, `components/today/TodayPlanPanel.tsx`, `TodayWeekList.tsx` |
| In a notebook | `lib/planning/plan-notebook.ts`, `hooks/useNotebookPlanSession.ts`, `components/workspace/NotebookPlanSession.tsx` |
| Storage | `services/planning/revision-plans.ts` |
