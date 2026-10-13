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
| `work_out` | the worker at high effort, solving the problem the planner stated in full, with one 16 s deadline across its attempts | 1 | V1, an independent working the answer must check itself against |

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
   W1, R1 and V1 are said and shown. When the student's material was searched
   and had nothing on the question, and none of it was in hand already
   (`tutorAgentFoundNoMaterial`), the answer is told to say so in a clause,
   so the student checks it against their course. Where W1 and their material
   differ on a definition or convention, the answer teaches their material's
   version and says that other sources differ. The turn's deadline grows by
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
  which tools ran, why it stopped, how long it took, and the ledger as counts
  (material read up front, searches of it, passages they added, whether the web
  found something, whether a working came back to check against).

## Cost and limits

An agent turn counts as one Tutor question. Its planner calls are small worker
calls; `work_out` is one worker call at high effort, at most 16 s for all its
attempts (`checkTimeoutMs`); `search_web` spends one of the student's monthly
searches (1.5p). On maths problems a turn that checks costs about 0.05p more
than one that doesn't, so roughly 1.2× a real 0.28p answer. Re-measure on real
turns from `providerDiagnostics` and `agent.finished`. The limits are
`TUTOR_AGENT_LIMITS` and `TUTOR_AGENT_TOOL_USES`.

### Measured

`npm run eval:tutor-agent` answers maths problems with known answers twice on
the live providers, once without the agent and once with it. There are two
sets: 21 everyday problems (`--set everyday`) and 24 harder ones (`--set
hard`): counting traps, non-standard integrals, problems of several steps. The
harder answers were computed by brute force, not recalled. Measured
13 October 2026:

| Check on | Planner | Set | Right without / with | Checked | Wait before the answer, p50 / p95 | Cost a turn, without / with |
| --- | --- | --- | --- | --- | --- | --- |
| Kimi K3 | checks everything | everyday ×2 | 42 / 42 of 42 | 100% | 7.8 s / 17.6 s | 0.008p / 0.50p |
| Kimi K3 | checks everything | hard ×2 | 43 / 46 of 48 (2 provider failures) | 92% | 9.3 s / 17.7 s | 0.011p / 0.64p |
| Kimi K3 | checks risky problems | everyday ×1 | 21 / 21 | 48% | 6.3 s / 28 s | 0.008p / 0.23p |
| Kimi K3 | checks risky problems | hard ×2 | 46 / 45 of 48 | 81% | 13.4 s / 28 s | 0.014p / 0.52p |
| Kimi K3, 16 s deadline | checks risky problems | hard ×4 | 91 / 92 of 96 | 55% | 15.8 s / 20.4 s | 0.011p / 0.11–0.48p |
| **Worker** | checks risky problems | hard ×4 | 92 / 92 of 96 | 85% | 4.2 s / 10.3 s | 0.011p / 0.04p |

Every run missed #43 ("how many n² + n + 41 are composite"), with and without
the check; most of those misses were the provider failing to answer at all.

- **The check fixes hard answers when the answer slips.** The Kimi check
  turned four wrong answers right across its runs and broke none. In the worker
  runs the answers never slipped, so its check had nothing to fix.
- **The check runs on the worker, for every tier.** A check from another
  family is better in principle, but Kimi came back inside the deadline on only
  half its checks, at a p50 of 16 s and three to ten times the cost. A check
  that has not arrived catches nothing. The worker came back on 85% at 4 s.
  Deep answers are Kimi's or Qwen's, so their check is from another family
  anyway.
- **On everyday problems the check changes nothing.** So the planner is told to
  check only where a careful tutor could plausibly slip. That halved checks and
  cost there.
- **A slow check used to cost the whole 28 s.** A slow Kimi fell through to
  Qwen, which took the rest of the time. The check now has one deadline for all
  its attempts, and drops an endpoint that sends nothing for `checkStallMs`
  (6 s).

## Turning it off

Set `NEXT_PUBLIC_ENABLE_TUTOR_AGENT=false` and redeploy: every answer is the
single call it was before. Web searches alone stop with
`AI_WEB_RESEARCH_ENABLED=false`, as for the up-front research.
