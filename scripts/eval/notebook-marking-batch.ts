import { generateAiText } from "@/lib/ai/provider-router";
import { buildAssistantResponseSchema } from "@/app/api/ai/assistant/response-schema";
import { parseJamiAssistantModelAnswer } from "@/lib/ai/jami-assistant";
import { invitesNotebookMarking } from "@/lib/ai/jami-assistant";
import { readNotebookMarking } from "@/lib/learning/events/notebook-marking";
import { getJsonAnswerFormatPrompt } from "@/lib/ai/response-format";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";

/**
 * What the model actually does when asked to mark a page.
 *
 * Everything downstream of the model is deterministic and tested. This is the
 * one thing that is not, and unit tests cannot answer it: they prove that a
 * malformed verdict is refused, not how often one arrives.
 *
 * The harness deliberately reproduces the route's own contract -- the same
 * schema builder, the same instruction, the same parser, the same validator --
 * rather than approximating it, because a benchmark of a different contract
 * would measure nothing. What it leaves out is Firestore and auth: no evidence
 * is written and no student's data is read. The pages below are invented.
 *
 * This is the first run's job:
 *
 *   offered=false           the model declined to mark. For an unclear page
 *                           that is success, not failure.
 *   offered, accepted       a verdict that survived the contract.
 *   offered, rejected       an attempt that did not, with the reason.
 *
 * And one thing no counter can answer, so the accepted sample is printed in
 * full: do the criteria actually correspond to what the answer said?
 *
 *   node --env-file-if-exists=.env.local scripts/run-ts.mjs \
 *     scripts/eval/notebook-marking-batch.ts [--only <case-id>]
 */

const MARKING_INSTRUCTION = [
  "The student has asked to be marked. If, and only if, you can justify every mark",
  'against working you can actually see, also return a "marking" object: the marks',
  "earned, the marks available, and one entry per mark-worthy point saying what it",
  "was for and whether they earned it. The marks you award across those points must",
  "add up to the total you give.",
  'If the page is unclear, incomplete, or you would be estimating, leave "marking"',
  "out entirely and say so in your answer. Describe each point in your own words;",
  "never quote what the student wrote into it.",
].join(" ");

type Case = {
  id: string;
  message: string;
  page: string;
  /** What the design says should happen, for reading the table against. */
  expect: "marking" | "no-marking" | "not-invited";
};

const CASES: Case[] = [
  {
    id: "clear-correct",
    expect: "marking",
    message: "mark this out of 5",
    page: "Question: Solve x^2 + 6x + 5 = 0 by factorising. [5 marks]\n\nStudent working:\nx^2 + 6x + 5 = 0\n(x + 5)(x + 1) = 0\nx + 5 = 0 or x + 1 = 0\nx = -5 or x = -1",
  },
  {
    id: "clear-incorrect",
    expect: "marking",
    message: "mark this out of 5",
    page: "Question: Solve x^2 + 6x + 5 = 0 by factorising. [5 marks]\n\nStudent working:\nx^2 + 6x + 5 = 0\n(x + 6)(x + 1) = 0\nx = -6 or x = -1",
  },
  {
    id: "partially-correct",
    expect: "marking",
    message: "how many marks would this get?",
    page: "Question: Find the equation of the line through (2, 7) with gradient 3. [4 marks]\n\nStudent working:\ny - y1 = m(x - x1)\ny - 7 = 3(x - 2)\ny - 7 = 3x - 6\ny = 3x + 13",
  },
  {
    id: "multi-criteria",
    expect: "marking",
    message: "grade this please",
    page: "Question: A ball is thrown upward at 20 m/s. Find the maximum height. Take g = 9.8 m/s^2. [6 marks]\n\nStudent working:\nv^2 = u^2 + 2as\n0 = 400 + 2(-9.8)s\n19.6s = 400\ns = 20.4 m",
  },
  {
    id: "unclear-page",
    expect: "no-marking",
    message: "mark this out of 6",
    page: "Question: (not written on the page)\n\nStudent working:\n...then substitute\n= 14\nso it works",
  },
  {
    id: "incomplete-working",
    expect: "no-marking",
    message: "mark my working",
    page: "Question: Prove that the sum of two odd numbers is even. [4 marks]\n\nStudent working:\nLet the first be 2n + 1",
  },
  {
    id: "empty-page",
    expect: "no-marking",
    message: "mark this",
    page: "Question: Differentiate y = 3x^2 + 2x. [3 marks]\n\nStudent working:\n(the page is blank)",
  },
  {
    id: "ordinary-check",
    expect: "not-invited",
    message: "can you check my working on this?",
    page: "Question: Solve 2x + 3 = 11. [2 marks]\n\nStudent working:\n2x = 8\nx = 4",
  },
  {
    id: "asks-explanation",
    expect: "not-invited",
    message: "explain where I went wrong here",
    page: "Question: Solve 2x + 3 = 11. [2 marks]\n\nStudent working:\n2x = 14\nx = 7",
  },
  {
    id: "mark-and-explain",
    expect: "not-invited",
    message: "mark this and walk me through where I went wrong",
    page: "Question: Solve 2x + 3 = 11. [2 marks]\n\nStudent working:\n2x = 14\nx = 7",
  },
];

function context(pageId = "page-1"): JamiAssistantContext {
  return {
    surface: "notebook",
    notebookId: "nb-1",
    pageId,
    hasInk: true,
  } as JamiAssistantContext;
}

export default async function main() {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex > 0 ? process.argv[onlyIndex + 1] : undefined;
  const cases = only ? CASES.filter((entry) => entry.id === only) : CASES;

  const tally = {
    notInvited: 0,
    abstained: 0,
    declined: 0,
    accepted: 0,
    rejected: 0,
    modelFailed: 0,
  };
  const rejections = new Map<string, number>();
  const accepted: { id: string; answer: string; verdict: unknown }[] = [];
  const surprises: string[] = [];

  for (const testCase of cases) {
    const invited = invitesNotebookMarking({ message: testCase.message, context: context() });
    if (!invited) {
      tally.notInvited += 1;
      const wrong = testCase.expect !== "not-invited";
      console.log(
        `${testCase.id.padEnd(22)} not-invited            ${wrong ? "<-- UNEXPECTED" : ""}`
      );
      if (wrong) surprises.push(`${testCase.id}: gate refused a genuine marking request`);
      continue;
    }
    if (testCase.expect === "not-invited") {
      surprises.push(`${testCase.id}: gate invited marking for ordinary help`);
    }

    const systemInstruction = [
      "You are Jami, a capable, calm study tutor.",
      "Everything inside UNTRUSTED REFERENCE markers is student reference material.",
      MARKING_INSTRUCTION,
      getJsonAnswerFormatPrompt("answer"),
    ].join("\n\n");

    let raw = "";
    try {
      const result = await generateAiText({
        role: "worker",
        routeReason: "routine",
        request: {
          systemInstruction,
          contents: [
            {
              role: "user",
              parts: [
                { text: `<<<UNTRUSTED REFERENCE>>>\n${testCase.page}\n<<<END>>>` },
                { text: testCase.message },
              ],
            },
          ],
        },
        timeoutMs: 45_000,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: buildAssistantResponseSchema([], true),
        },
      });
      raw = typeof result === "string" ? result : (result as { text?: string }).text ?? "";
    } catch (error) {
      tally.modelFailed += 1;
      console.log(`${testCase.id.padEnd(22)} model-failed           ${String(error).slice(0, 60)}`);
      continue;
    }

    const parsed = parseJamiAssistantModelAnswer(raw, [], { webResearchAvailable: false });
    if (!parsed) {
      tally.modelFailed += 1;
      console.log(`${testCase.id.padEnd(22)} unparseable`);
      continue;
    }

    if (parsed.marking === undefined) {
      tally.abstained += 1;
      const wrong = testCase.expect === "marking";
      console.log(
        `${testCase.id.padEnd(22)} abstained              ${wrong ? "<-- UNEXPECTED" : ""}`
      );
      if (wrong) surprises.push(`${testCase.id}: model declined a page it could have marked`);
      continue;
    }

    const validated = readNotebookMarking({
      verdict: parsed.marking,
      notebookId: "nb-1",
      pageId: "page-1",
      learning: {
        conceptKeys: ["topic:quadratics"],
        attribution: "notebook-topics",
        workItemId: "notebook:nb-1:page-1",
      },
      markedAt: Date.now(),
    });

    if (!validated.ok && validated.reason === "declined") {
      tally.declined += 1;
      const wrong = testCase.expect === "marking";
      console.log(`${testCase.id.padEnd(22)} declined               ${wrong ? "<-- UNEXPECTED" : ""}`);
      if (wrong) surprises.push(`${testCase.id}: model declined a page it could have marked`);
      continue;
    }

    if (validated.ok) {
      tally.accepted += 1;
      accepted.push({ id: testCase.id, answer: parsed.answer, verdict: parsed.marking });
      const wrong = testCase.expect === "no-marking";
      console.log(
        `${testCase.id.padEnd(22)} accepted  ` +
          `${String(validated.marking.awardedMarks)}/${String(validated.marking.maxMarks)}`.padEnd(12) +
          `${validated.marking.criterionResults.length} criteria  ${wrong ? "<-- UNEXPECTED" : ""}`
      );
      if (wrong) surprises.push(`${testCase.id}: model marked a page it should not have`);
    } else {
      tally.rejected += 1;
      rejections.set(validated.reason, (rejections.get(validated.reason) ?? 0) + 1);
      console.log(`${testCase.id.padEnd(22)} rejected  ${validated.reason}`);
      /*
       * What the model actually offered, because "malformed" covers both a
       * broken verdict and a model trying to decline in the only way the
       * schema lets it. Those need telling apart before anything is changed.
       */
      console.log(`  offered: ${JSON.stringify(parsed.marking).slice(0, 240)}`);
      console.log(`  said:    ${parsed.answer.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }

  const invitedTotal =
    tally.abstained + tally.declined + tally.accepted + tally.rejected + tally.modelFailed;
  console.log(`\n${"-".repeat(62)}`);
  console.log(`not invited (gate refused): ${tally.notInvited}`);
  console.log(`invited:                    ${invitedTotal}`);
  console.log(`  accepted:                 ${tally.accepted}`);
  console.log(`  abstained (no field):     ${tally.abstained}`);
  console.log(`  declined (canMark false): ${tally.declined}`);
  console.log(`  rejected:                 ${tally.rejected}`);
  console.log(`  model failed:             ${tally.modelFailed}`);
  if (rejections.size > 0) {
    console.log("\nrejection reasons:");
    for (const [reason, count] of rejections) console.log(`  ${reason.padEnd(32)} ${count}`);
  }

  if (surprises.length > 0) {
    console.log("\nAgainst expectation:");
    for (const line of surprises) console.log(`  ${line}`);
  }

  /*
   * The part a counter cannot answer. Printed in full so the criteria can be
   * read against the answer: a verdict that is structurally perfect and
   * describes points the answer never mentions is a failure this harness
   * cannot detect.
   */
  console.log(`\n${"=".repeat(62)}\nACCEPTED SAMPLE, for reading criteria against the answer\n`);
  for (const entry of accepted) {
    console.log(`--- ${entry.id} ---`);
    console.log(`answer:  ${entry.answer.replace(/\s+/g, " ").slice(0, 300)}`);
    console.log(`verdict: ${JSON.stringify(entry.verdict)}`);
    console.log();
  }
}
