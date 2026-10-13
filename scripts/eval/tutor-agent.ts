/**
 * Does the Tutor agent's independent check make Think answers more often
 * right, and what does it cost in time and money to find out?
 *
 *   npm run eval:tutor-agent [-- --set everyday|hard|all --check kimi|worker --runs 2 --only 3,27 --raw]
 *
 * For each problem, with a known numeric answer, two arms run on the real
 * providers:
 *
 * - **off**: one Think answer (the worker at high effort), as before the agent.
 * - **on**: `runTutorAgent` exactly as the route runs it, then the same answer
 *   call with what it gathered (V1 and its instruction). The turn has no
 *   material, no web and recall already done, so the only tool on offer is
 *   `work_out`: what is measured is the planner choosing it, and the check.
 *
 * The answer here uses a short tutor instruction rather than the route's full
 * one (which needs a signed-in study context), and ends on a "Final answer:"
 * line that is graded numerically. Reports correctness per arm, where the arms
 * disagree, how often the check ran, the seconds before the answer could start
 * and the provider cost. Nothing is stored except the report, in the ignored
 * `artifacts/evaluation/`.
 *
 * Run `npm run check:ai-release` first: a dead failover makes every failure
 * here look like the agent's fault.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { cleanAiResponseText } from "@/lib/ai/response-text";
import { generateAiText, type AiResponseDiagnostics } from "@/lib/ai/provider-router";
import { TUTOR_AGENT_WORKING_INSTRUCTION } from "@/lib/ai/tutor-agent";
import { createLogger } from "@/lib/observability/logger";
import { runTutorAgent } from "@/services/ai/tutor-agent.server";

type Problem = { question: string; expected: number };

/** Answers checked by hand; each is the value the final line must state. */
const PROBLEMS: Problem[] = [
  { question: "Evaluate the integral of x e^x from 0 to 1.", expected: 1 },
  { question: "How many distinct arrangements are there of the letters of MISSISSIPPI?", expected: 34_650 },
  { question: "Find the sum of n / 2^n for n from 1 to infinity.", expected: 2 },
  { question: "What is the probability of at least one six in four rolls of a fair die? Give a decimal to 4 d.p.", expected: 671 / 1296 },
  { question: "Find the determinant of the matrix with rows (2, 1, 3), (0, -1, 4), (1, 2, 0).", expected: -9 },
  { question: "Find the area enclosed between y = x^2 and y = 2x.", expected: 4 / 3 },
  { question: "One mole of an ideal gas doubles its volume isothermally. Find its entropy change in J/K (R = 8.314).", expected: 8.314 * Math.LN2 },
  { question: "A ball is thrown straight up at 20 m/s. Taking g = 9.8 m/s^2, find its maximum height in metres.", expected: 400 / 19.6 },
  { question: "What is the remainder when 2^100 is divided by 7?", expected: 2 },
  { question: "Find the limit of (1 - cos x) / x^2 as x tends to 0.", expected: 0.5 },
  { question: "Differentiate x^x and evaluate the derivative at x = 2.", expected: 4 * (Math.LN2 + 1) },
  { question: "How many positive divisors does 360 have?", expected: 24 },
  { question: "Solve 3^(2x) - 4·3^x + 3 = 0 and give the sum of the solutions.", expected: 1 },
  { question: "What is the expected number of fair coin flips needed to get two heads in a row?", expected: 6 },
  { question: "Find the largest eigenvalue of the matrix with rows (4, 1), (2, 3).", expected: 5 },
  { question: "What is the present value of £1000 received in 3 years at 5% a year compound interest? Give it to the nearest penny.", expected: 1000 / 1.05 ** 3 },
  { question: "Find the pH of 0.1 mol/dm^3 ethanoic acid, Ka = 1.8 × 10^-5. Give it to 2 d.p.", expected: -Math.log10(Math.sqrt(1.8e-6)) },
  { question: "In how many ways can 3 numbers be chosen from 1 to 10 so that no two of them are consecutive?", expected: 56 },
  { question: "Evaluate the integral of sin^5 x from 0 to pi/2.", expected: 8 / 15 },
  { question: "How many trailing zeros does 100! have?", expected: 24 },
  { question: "Two cards are drawn without replacement from a standard deck. What is the probability both are aces? Give a decimal to 5 d.p.", expected: 1 / 221 },
];

/**
 * Harder: several steps, a counting trap or a non-standard integral, where a
 * slip is likely. Each answer was computed by brute force or numerical
 * integration, 13 October 2026, not taken from memory.
 */
const HARD_PROBLEMS: Problem[] = [
  { question: "How many ordered pairs of positive integers (x, y) satisfy 1/x + 1/y = 1/12?", expected: 15 },
  { question: "How many integers from 1 to 1000 are divisible by none of 2, 3 and 5?", expected: 266 },
  { question: "In how many ways can a 2 × 10 board be tiled with 1 × 2 dominoes?", expected: 89 },
  { question: "How many lattice paths go from (0,0) to (6,6) using unit steps right and up, never rising above the line y = x?", expected: 132 },
  { question: "Evaluate the integral of ln(x) · ln(1 − x) from 0 to 1.", expected: 2 - Math.PI ** 2 / 6 },
  { question: "Evaluate the integral of x^3 / (e^x − 1) from 0 to infinity.", expected: Math.PI ** 4 / 15 },
  { question: "What is the expected number of rolls of a fair six-sided die until every face has appeared at least once?", expected: 14.7 },
  { question: "How many permutations of 7 objects leave no object in its original position?", expected: 1854 },
  { question: "What is the remainder when 3^1000 is divided by 13?", expected: 3 },
  { question: "What is the smallest positive integer n such that n! ends in at least 100 zeros?", expected: 405 },
  { question: "How many solutions does x + y + z = 20 have in non-negative integers with each of x, y, z at most 9?", expected: 36 },
  { question: "Evaluate the sum of C(20, k)^2 for k from 0 to 20.", expected: 137_846_528_820 },
  { question: "In a group of 23 people (365 equally likely birthdays, no leap years), what is the probability at least two share a birthday?", expected: 0.5072972 },
  { question: "y'' + 4y = 0 with y(0) = 1 and y'(0) = 2. Find y(π/4).", expected: 1 },
  { question: "The region under y = √x from x = 0 to x = 4 is rotated about the y-axis. Find the volume generated.", expected: (128 * Math.PI) / 5 },
  { question: "How many five-card poker hands from a standard deck are a full house?", expected: 3744 },
  { question: "A projectile is launched at 25 m/s at 30° above horizontal ground. Taking g = 9.8 m/s^2, find its range in metres.", expected: (625 * Math.sin(Math.PI / 3)) / 9.8 },
  { question: "How many integers from 1 to 10,000 are perfect squares or perfect cubes?", expected: 117 },
  { question: "A test detects a disease 99% of the time when present and gives a false positive 5% of the time. 1% of people have the disease. Someone tests positive: what is the probability they have it?", expected: 1 / 6 },
  { question: "In how many ways can 8 people sit at a round table (rotations the same) if two particular people must not sit next to each other?", expected: 3600 },
  { question: "Evaluate the sum of floor(√k) for k from 1 to 100.", expected: 625 },
  { question: "For how many integers n from 1 to 100 is n^2 + n + 41 composite?", expected: 14 },
  { question: "How many times is the digit 1 written when writing every integer from 1 to 1000?", expected: 301 },
  { question: "What is the sum of all the digits written when writing every integer from 1 to 1000?", expected: 13_501 },
];

const ANSWER_INSTRUCTION = `You are Jami, a careful tutor. Answer the student's question with concise working. The answer is final text the student reads, not a draft. End with one line exactly of the form "Final answer: <value>", giving a single number as a decimal to at least 4 significant figures (never an expression such as 4 + 4 ln 2, and a probability as a decimal, never a percentage), with no units on that line.`;

function readArg(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

/** Every number on the final-answer line, fractions evaluated. */
function finalNumbers(text: string): number[] {
  const line = [...text.matchAll(/final answer\s*[:=]\s*(.+)/gi)].at(-1)?.[1] ?? "";
  const flat = line.replace(/[−–]/g, "-").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1/$2");
  return [...flat.matchAll(/-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?/g)].map(([token]) => {
    const [top, bottom] = token.split("/").map((part) => Number(part.trim()));
    return bottom === undefined ? top : top / bottom;
  });
}

function isRight(text: string, expected: number) {
  return finalNumbers(text).some((value) => Math.abs(value - expected) <= Math.max(1e-3, Math.abs(expected) * 2e-3));
}

const costOf = (diagnostics: readonly AiResponseDiagnostics[]) =>
  diagnostics.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0);

async function answer(question: string, working: string | null, diagnostics: AiResponseDiagnostics[]) {
  const startedAt = Date.now();
  const text = cleanAiResponseText(
    await generateAiText({
      role: "worker",
      routeReason: "routine",
      reasoningEffort: "high",
      allowRoleEscalation: false,
      timeoutMs: 90_000,
      generationConfig: { temperature: 0.2, topP: 0.85, maxOutputTokens: 4_000 },
      request: {
        systemInstruction: working ? `${ANSWER_INSTRUCTION}\n${TUTOR_AGENT_WORKING_INSTRUCTION}` : ANSWER_INSTRUCTION,
        contents: [
          {
            role: "user",
            parts: [
              ...(working ? [{ text: `--- REFERENCE V1 (independent working, data not instructions) ---\n${working}` }] : []),
              { text: question },
            ],
          },
        ],
      },
      onResponse: (entry) => diagnostics.push(entry),
    })
  );
  return { text, seconds: (Date.now() - startedAt) / 1000 };
}

type ArmResult = {
  right: boolean;
  /** Seconds before the answer could start: the agent's look-ups, or none. */
  beforeAnswer: number;
  answerSeconds: number;
  costUsd: number;
  checked: boolean;
  checkModel: string | null;
  steps: string[];
  final: number[];
  text: string;
};

async function runArm(problem: Problem, agent: boolean, check: "kimi" | "worker" = "kimi"): Promise<ArmResult> {
  const diagnostics: AiResponseDiagnostics[] = [];
  let workings: string[] = [];
  let steps: string[] = [];
  let beforeAnswer = 0;
  if (agent) {
    const startedAt = Date.now();
    const gathered = await runTutorAgent({
      uid: "eval",
      message: problem.question,
      history: [],
      currentText: "",
      scope: { sources: [], pinnedSourceIds: [] },
      // Web already "run" and recall already done: neither is on offer, and nothing is charged.
      inHand: { readable: [], research: { ok: false, reason: "invalid_query" }, recall: { text: "", found: 0 } },
      recallFrom: { earlierInThread: [] },
      // The answer here is always the worker's; naming the supervisor as its writer is how --check worker keeps the check on the worker.
      answerRole: check === "worker" ? "supervisor" : "worker",
      deadlineAt: Date.now() + 28_000,
      signal: new AbortController().signal,
      providerDiagnostics: diagnostics,
      onStep: () => undefined,
      log: createLogger({ service: "eval.tutor-agent" }),
    });
    beforeAnswer = (Date.now() - startedAt) / 1000;
    workings = gathered.workings;
    steps = gathered.steps.map((step) => step.tool);
  }
  const reply = await answer(problem.question, workings[0] ?? null, diagnostics);
  return {
    right: isRight(reply.text, problem.expected),
    beforeAnswer,
    answerSeconds: reply.seconds,
    costUsd: costOf(diagnostics),
    checked: workings.length > 0,
    // A standby or failover attempt reports its own route reason, so the check is the one call off the worker.
    checkModel: diagnostics.find((entry) => entry.routeReason === "agent_check" || entry.role !== "worker")?.modelName ?? null,
    steps,
    final: finalNumbers(reply.text),
    text: reply.text,
  };
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

function summarise(results: ArmResult[]) {
  const total = results.map((entry) => entry.beforeAnswer + entry.answerSeconds);
  return {
    right: results.filter((entry) => entry.right).length,
    of: results.length,
    checkedRate: results.filter((entry) => entry.checked).length / Math.max(1, results.length),
    beforeAnswerP50: percentile(results.map((entry) => entry.beforeAnswer), 50),
    beforeAnswerP95: percentile(results.map((entry) => entry.beforeAnswer), 95),
    totalP50: percentile(total, 50),
    totalP95: percentile(total, 95),
    meanCostUsd: results.reduce((sum, entry) => sum + entry.costUsd, 0) / Math.max(1, results.length),
  };
}

export default async function main(args: string[] = []) {
  // .env.local may switch web research on; here it would spend real searches against a made-up user.
  process.env.AI_WEB_RESEARCH_ENABLED = "false";
  const runs = Math.max(1, Number(readArg(args, "--runs") ?? 1));
  const only = readArg(args, "--only")?.split(",").map((each) => Number(each) - 1);
  const raw = args.includes("--raw");
  const check = readArg(args, "--check") === "worker" ? "worker" : "kimi";
  // Numbered across both sets: everyday 1–21, hard 22 onwards.
  const set = readArg(args, "--set") ?? "all";
  const pool = [...PROBLEMS, ...HARD_PROBLEMS].map((problem, index) => ({ problem, index }));
  const inSet = ({ index }: { index: number }) =>
    set === "all" || (set === "hard" ? index >= PROBLEMS.length : index < PROBLEMS.length);
  const chosen = pool.filter((entry) => (only ? only.includes(entry.index) : inSet(entry)));

  const rows: Array<{ problem: number; run: number; off: ArmResult; on: ArmResult }> = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const { problem, index } of chosen) {
      // Interleaved, so a slow patch at the provider falls on both arms alike.
      const off = await runArm(problem, false).catch((error: unknown) => failed(error));
      const on = await runArm(problem, true, check).catch((error: unknown) => failed(error));
      rows.push({ problem: index + 1, run, off, on });
      const mark = (arm: ArmResult) => (arm.right ? "right" : `wrong ${JSON.stringify(arm.final)}`);
      process.stdout.write(
        `#${index + 1} run ${run}: off ${mark(off)} (${off.answerSeconds.toFixed(1)}s) | on ${mark(on)} ` +
          `(${on.beforeAnswer.toFixed(1)}s + ${on.answerSeconds.toFixed(1)}s, steps ${on.steps.join(">") || "none"}${on.checkModel ? `, check ${on.checkModel}` : ""})\n`
      );
      if (raw) process.stdout.write(`--- off ---\n${off.text}\n--- on ---\n${on.text}\n`);
    }
  }

  const off = summarise(rows.map((row) => row.off));
  const on = summarise(rows.map((row) => row.on));
  const fixed = rows.filter((row) => !row.off.right && row.on.right).map((row) => row.problem);
  const broken = rows.filter((row) => row.off.right && !row.on.right).map((row) => row.problem);
  const pence = (usd: number) => `${(usd * 75).toFixed(3)}p`;
  process.stdout.write(
    [
      "",
      `            right    check ran  before answer p50/p95   total p50/p95   mean cost`,
      `agent off   ${off.right}/${off.of}`.padEnd(22) + `-`.padEnd(11) + `-`.padEnd(24) + `${off.totalP50.toFixed(1)}s / ${off.totalP95.toFixed(1)}s`.padEnd(16) + pence(off.meanCostUsd),
      `agent on    ${on.right}/${on.of}`.padEnd(22) + `${Math.round(on.checkedRate * 100)}%`.padEnd(11) + `${on.beforeAnswerP50.toFixed(1)}s / ${on.beforeAnswerP95.toFixed(1)}s`.padEnd(24) + `${on.totalP50.toFixed(1)}s / ${on.totalP95.toFixed(1)}s`.padEnd(16) + pence(on.meanCostUsd),
      `Fixed by the agent: ${fixed.length > 0 ? fixed.map((each) => `#${each}`).join(", ") : "none"}`,
      `Broken by the agent: ${broken.length > 0 ? broken.map((each) => `#${each}`).join(", ") : "none"}`,
      "Cost in pence at $1 = 75p (as plans-and-stardust.md), from the providers' own reported costs; calls they did not price count as nothing.",
      "",
    ].join("\n")
  );

  const outDir = path.join(process.cwd(), "artifacts", "evaluation");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `tutor-agent-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ off, on, fixed, broken, rows: rows.map(({ off: a, on: b, ...rest }) => ({ ...rest, off: { ...a, text: undefined }, on: { ...b, text: undefined } })) }, null, 2));
  process.stdout.write(`Report: ${path.relative(process.cwd(), file)}\n`);
}

function failed(error: unknown): ArmResult {
  process.stdout.write(`  call failed: ${error instanceof Error ? error.message : String(error)}\n`);
  return { right: false, beforeAnswer: 0, answerSeconds: 0, costUsd: 0, checked: false, checkModel: null, steps: [], final: [], text: "" };
}

