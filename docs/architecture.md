# Jami Architecture Boundaries

This document describes the boundaries that should remain stable while Jami adds
new workflows. It is a map for implementation, not a proposal to change routes or
stored data.

The current collection-read inventory and deliberately retained full-input
calculations are recorded in [data-access-audit.md](./data-access-audit.md).

## Dependency direction

```text
app routes and pages
        |
        v
feature components --------> components/ui
        |
        +-------------------> pure lib modules
        |
        v
domain services ------------> Firebase and server Route Handlers
```

- `app` owns routing and page-level orchestration. Pages may coordinate state and
  domain operations, but should not contain reusable rendering engines or direct
  Firestore and Storage queries.
- `components` owns reusable presentation and focused interaction surfaces.
  Feature components may call callbacks or hooks supplied by their page, but they
  should not know collection paths.
- `lib` owns models, parsing, calculations, validation, and browser-only utilities.
  New domain modules should remain pure. A few older auth and server-AI adapters
  still perform I/O from `lib`; they are migration candidates, not precedents.
- `services` owns external I/O: Firebase reads and writes, uploads, and calls to
  internal Route Handlers. Services preserve ownership checks and stored shapes.
- `components/ui` remains the shared visual language described by
  [`ui-design-system.md`](ui-design-system.md).

Dependencies should flow downward through this list. A service may use `lib`, but
`lib` must not import a service or a React component.

- `hooks` holds stateful React controllers shared by pages and components, such
  as the notebook editor's. Hooks call services; they do not query Firebase.
- `workflows` holds durable Vercel Workflow jobs (paper generation and marking,
  question marking and review, imports). Each step is idempotent and
  checkpointed; see [`ai-operations.md`](ai-operations.md).

### Enforced by tooling

- ESLint refuses `firebase/firestore`, `firebase/storage` and the Firebase
  client adapters in `app/dashboard`, `components` and `hooks`.
- ESLint refuses `@/components` and `@/services` imports inside `lib`.
- Only `lib/ai/gemini.ts` may import the provider SDK (`@google/genai`); other
  code describes model input with `@/lib/ai/content-parts`.
- `console` is refused in Route Handlers, workflows and `*.server.ts` files; use
  `createLogger` from `lib/observability/logger`.
- `npm run check:sizes` fails CI for any tracked source file over 1,200 lines
  (1,500 for tests), and names every file past 1,000 (1,200 for tests) on each
  run. It checks `app`, `components`, `hooks`, `lib`, `services`, `workflows`,
  `scripts`, `e2e` and `tests`, and has no exceptions.

## Keeping modules small

The notebook page once reached 4,525 lines before anything stopped it, and
fifteen files were over the gate when the October 2026 cleanup began. The gate
now stops a file at 1,200 lines; these habits keep one from getting there.

- **Split before adding.** When a change would add to a file the size check
  names, move one concern out of it first, in its own commit.
- **Split by concern, not by line count.** A large screen becomes a
  composition root: it creates its controllers in dependency order, routes
  input between them and lays out what they render.
  - State and effects move into hooks named for one concern
    (`useNotebookPageTurn`, `useNotebookTutorBridge`, `useStudyQuestionWait`).
  - Pure rules move to `lib/`, with tests of their own.
  - Multi-step I/O moves to `services/`, each step undone if a later one fails
    (`services/study/practice-paper-builder.ts`).
  - Drawing and engine code takes what it needs from its frame as a plain
    object rather than reaching into a class
    (`components/ai/memory-map/aurora-draw.ts`).
- **Tests first.** A screen with no tests gets characterization tests of what
  it does now, committed before it is split, so the history shows them passing
  on the old code.
- **Hooks never import from component files.** A helper two of them need moves
  to `lib/`.
- **One implementation per behaviour.** Search before writing a helper, hook
  or check. Twenty-two copies of "the caller's uid, or null" once spread across
  28 routes; they are now `authenticateRequest`. The deck page kept its own copy
  of the card editor's logic until it moved onto `useCardEditing`. Fold a second
  copy into the first in the change that finds it.
- **Nothing left behind.** A change deletes what it replaces: the old path,
  unused exports, flags nothing reads, and their tests.

The React Compiler is not enabled in the build, but its lint rules run, and the
compiler silently skips a component it cannot analyse. Splitting a large one
lets it read the whole component, and it then reports faults that were there
all along (refs read during render, effects that set state); fix those rather
than suppress them. The notebook editor page is still skipped: its
frame-measuring effects stop the analysis, and moving them out surfaces
thirteen hand-memoised callbacks the compiler cannot prove stable through the
controllers' return objects. Make those stable before moving the effects.

## Server routes

- Every route that acts for a student calls `authenticateRequest`
  (`services/auth/authenticate-request.server.ts`), the one token check, and
  reads or writes only under `users/{uid}` for the uid it returns. Routes use
  the Admin SDK, which goes past the Firestore rules, so this check is the
  gate.
- What a student sees in an error is worded for them. Storage paths, bucket
  names and provider messages are logged, never returned.
- Cron routes check `CRON_SECRET` in constant time and fail closed
  (`services/auth/cron-authorization.ts`); owner routes check an environment
  allowlist.

## Learning Engine

Pure learning logic (scoring, profiles, topic states, recommendations, study
actions) lives in `lib/learning/`; Firestore loading lives in
`services/learning/`. Today, Tutor and Revision Sessions consume the engine;
none of them computes mastery or chooses a plan. The product rules are in
`AGENTS.md`, and production checks in
[`learning-engine-verification.md`](learning-engine-verification.md).

The revision planner is a consumer in the same way
([`revision-planner.md`](revision-planner.md)): it fills free sessions with the
engine's actions for each of the plan's subjects, in the engine's order, and
suggests a replacement when a planned task stops being recommended -- both
deterministic, in `lib/planning/plan-drafting.ts`. Its ticks are plan data,
never evidence.

Goals (`lib/goals/`) are consumers too, and only consumers. A topic goal reads
its topic's demonstration and the engine's study action for it through
`/api/learning/topic-standing`; goal suggestions take the engine's topic
recommendations in its own order. Nothing about a goal is learner evidence or
ever reaches a profile. Goal progress is counted by one rule,
`applyGoalEvent`, run where the work is recorded: on the device as a
flashcard answer saves, and on the server as a practice answer is marked
(`services/study/goal-progress.server.ts`, keyed by a receipt so a marking
counts once). A goal finished away from a screen is left `rewardPending`, and
the next screen to load lights its star. Tutor reads the running goals as a
marked, read-only block (`lib/goals/tutor-context.ts`), agreed 20 Oct 2026.

## Sources

Sources is a reference workspace. Its page should orchestrate selection, loading,
and mutations while focused components render the browser, selected-source view,
drawers, folder picker, tutor, and draft editors.

New AI work must enter through a typed service or server Route Handler. It must not
embed provider calls, Firebase queries, or prompt construction in the page.

When a student adds or changes a source, `services/study/sources.ts` asks
`/api/ai/source-index` to rebuild that source's private search index
(`users/{uid}/sourceChunks` and `sourceOutlines`). Tutor and paper generation
read matching passages from it only after the student asks. No other
background processing of uploads should be introduced without a deliberate,
privacy-reviewed design.

## Notebook editor

The notebook route is the composition root for the editor. Keep these concerns
separate:

- fixed-page coordinates, zoom, pan, swipe, and toolbar calculations in pure
  `lib/workspace` modules;
- canvas/PDF rendering and focused controls in `components/workspace`;
- loading, autosave, conflict handling, and file operations in domain services;
- route-level state and lifecycle coordination in the notebook page.

The 900 x 1240 coordinate model, immutable uploaded files, existing page records,
and compatibility readers are invariants. Refactors must not rewrite saved ink or
silently migrate user data.

## Compatibility rules

- Keep `/dashboard/practice` canonical and preserve `/dashboard/practise` as a
  permanent compatibility redirect.
- Treat Firestore collection paths and stored fields as public persistence
  contracts. Remove a compatibility reader only after an explicit migration and
  production count check.
- Keep API routes through a deprecation window when an installed PWA or external
  caller could still use them.
- Prefer small extractions with characterization tests over full page rewrites.
- Do not combine structural cleanup with a visual or behavioral redesign.

## Completion gate

A structural change is ready when:

1. TypeScript and ESLint pass, and no file crosses the size gate.
2. Pure extracted logic has focused tests.
3. Related tests pass before the complete suite is run.
4. A production build and a signed-in browser check have run where the risk
   split in `AGENTS.md` (Fast UI Verification) calls for them.
5. Any skipped migration, compatibility path, or manual check is recorded in the
   handoff.
