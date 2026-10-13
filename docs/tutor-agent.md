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
| `work_out` | a model of another family from the answer's, at high effort, solving the problem the planner stated in full: Kimi K3 (the supervisor's standby) for a Think answer, the worker for a Deep or disputed one (`tutorAgentCheckRoute`) | 1 | V1, an independent working the answer must check itself against |

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
calls; `work_out` is one call at high effort, on Kimi K3 for a Think answer
and on the worker for a Deep one; `search_web` spends one
of the student's monthly searches (1.5p). Measured below on maths problems;
re-measure on real turns from `providerDiagnostics` and `agent.finished`. The
limits are `TUTOR_AGENT_LIMITS` and `TUTOR_AGENT_TOOL_USES`.

### Measured

`npm run eval:tutor-agent` answers maths problems with known answers twice on
the live providers, once without the agent and once with it. There are two
sets: 21 everyday problems (`--set everyday`) and 24 harder ones (`--set
hard`): counting traps, non-standard integrals, problems of several steps. The
harder answers were computed by brute force, not recalled. Measured
13 October 2026, with Kimi K3 checking Think answers:

| Planner | Set | Right without / with | Checked | Wait before the answer, p50 / p95 | Cost a turn, without / with |
| --- | --- | --- | --- | --- | --- |
| Checks everything | everyday ×2 | 42 / 42 of 42 | 100% | 7.8 s / 17.6 s | 0.008p / 0.50p |
| Checks everything | hard ×2 | 43 / 46 of 48 (2 provider failures) | 92% | 9.3 s / 17.7 s | 0.011p / 0.64p |
| Checks risky problems | everyday ×1 | 21 / 21 | 48% | 6.3 s / 28 s | 0.008p / 0.23p |
| Checks risky problems | hard ×2 | 46 / 45 of 48 | 81% | 13.4 s / 28 s | 0.014p / 0.52p |
| Checks risky problems, check on the worker (`--check worker`) | hard ×1 | 23 / 23 of 24 | 83% | 5.8 s / 21.4 s | 0.014p / 0.05p |
| Checks risky problems, one 16 s deadline for the check | hard ×1 | 22 / 23 of 24 (one provider failure) | 71% | 11.1 s / 20.4 s | 0.011p / 0.48p |

- **The check fixes hard answers.** In the first hard run it turned three
  wrong answers right (6% of answers) and broke none, and in the last it fixed
  one more. In the second the worker
  was right on its own throughout. The one "broken" answer there gave a
  probability as a percentage, which the grader marked wrong. Neither arm ever
  got "how many n² + n + 41 are composite" right.
- **On everyday problems it changes nothing.** So the planner is told to check
  only where a careful tutor could plausibly slip. That halved checks and cost
  there and kept nearly all of them on the hard set.
- **A slow check cost the whole 28 s.** Between one in ten and one in three
  Kimi checks reached the look-ups' limit with nothing back, depending on the
  hour. Kimi was not silent but slow, and when it ran out of time the router
  fell through to Qwen, which took the rest. The check now has one deadline for
  all its attempts (`checkTimeoutMs`, 16 s), and drops an endpoint that sends
  nothing for `checkStallMs` (6 s). That brought the p95 wait from 28 s to
  about 20 s.
- **The worker checks faster and for a tenth of the cost.** Checking on the
  same family as the answer is weaker in principle. But Kimi's three fixes all
  came from one run, so the evidence does not yet favour either. Run
  `--check worker` against the default a few more times before settling which
  model checks Think answers.
- In a real turn the answer itself is about 0.28p, so a turn that checks costs
  about 2–3× one that doesn't, within the 2–4× estimated in
  `plans-and-stardust.md`.

## Turning it off

Set `NEXT_PUBLIC_ENABLE_TUTOR_AGENT=false` and redeploy: every answer is the
single call it was before. Web searches alone stop with
`AI_WEB_RESEARCH_ENABLED=false`, as for the up-front research.
