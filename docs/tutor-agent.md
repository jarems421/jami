# Tutor agent

Status: built 13 October 2026, on by the owner's decision of 12 October
(`enableTutorAgent`). The AGENTS.md exception "Tutor agent" is the rule; this
is how it works.

## What it does

Before a **Think** or **Deep** answer is written, Tutor looks things up and
checks its work, one step at a time, and the student watches each step start
("Searching your material for "entropy of mixing"", "Worked it through
separately to check"). Then the answer is written as before, with what was
found. **Quick** answers stay one fast call, and so does a reply already
reconciled with the juror's independent review.

The tools a step can use:

| Tool | Runs | Uses a turn | Goes to the answer as |
| --- | --- | --- | --- |
| `search_sources` | `retrieveTutorEvidence` over the study context's material, with the planner's own query; closest five new passages | 3 | passages inside the source's S-reference (a source not read up front gets the next S-number) |
| `search_web` | `generateGroundedResearch`, the query passed through `sanitizeTutorResearchQuery`; charges one of the month's searches and refunds a failed one | 1, and none when web research already ran | W1, with its citations |
| `recall_chats` | `loadTutorChatRecall` with the planner's query (other chats only while memory is on) | 1, and none when recall already ran | R1 |
| `work_out` | the worker at high effort, solving the problem the planner stated in full | 1 | V1, an independent working the answer must check itself against |

## How a turn runs

1. Everything up to the model call is unchanged: the gate, the saved chat,
   the study context, the plan, the budget, the up-front reading of material,
   the rules-based web research and recall, and routing.
2. When the route's tier is Think or Deep, `createTutorTurnStream` runs a
   `prepare` step inside the stream before the answer: `runTutorAgent`
   (`services/ai/tutor-agent.server.ts`).
3. Each step, `availableTutorAgentTools` (`lib/ai/tutor-agent.ts`) works out
   what this step may use, from the turn and what has already run; the
   planner (the worker, low effort, nine seconds) is offered exactly those, and
   `done`, as an enum in a strict JSON schema, and its choice is read against
   the same list. Each tool's start is sent as a `step` event.
4. It stops at `done`, after five planner calls, when the look-ups' 28 seconds
   are used, or when the planner fails or answers out of turn. A failure other
   than the student leaving leaves the answer to go ahead with what it had.
5. The route's `composeAnswer` builds the answer's schema, system instruction
   and contents again from what was gathered, so new sources can be cited and
   W1, R1 and V1 are said and shown. The turn's deadline grows by
   `TUTOR_AGENT_EXTRA_MS` (25 s), so the answer keeps its own reserve, still
   inside the route's `maxDuration`.
6. The finished answer carries `agentSteps`, which the chat saves with it and
   shows above it as one quiet line that opens to the list.

The planner runs on JSON-schema structured output rather than provider tool
calling: every Tutor call already goes through OpenRouter with
`require_parameters`, and structured output is what the approved endpoints are
known to support.

## What it may not do

- Grant itself anything: the tools offered are code's decision every step.
- Change anything of the student's: cards, decks, notebooks, pages and
  practice stay proposals in the answer, confirmed with a press.
- Run outside a request the student made, or touch the Learning Engine beyond
  what the answer already does.
- Log what it was asked or found: `agent.finished` records the step count,
  which tools ran, why it stopped and how long it took.

## Cost and limits

An agent turn counts as one Tutor question. Its planner calls are small worker
calls; `work_out` is one worker call at high effort; `search_web` spends one
of the student's monthly searches (1.5p). Estimated at 2–4× a single-call
answer, to be re-measured from `providerDiagnostics` once it has run for real.
The limits are `TUTOR_AGENT_LIMITS` and `TUTOR_AGENT_TOOL_USES`.

## Turning it off

Set `NEXT_PUBLIC_ENABLE_TUTOR_AGENT=false` and redeploy: every answer is the
single call it was before. Web searches alone stop with
`AI_WEB_RESEARCH_ENABLED=false`, as for the up-front research.
