import { describe, expect, it } from "vitest";
import {
  parseStudyAssetReply,
  readModelJson,
  StudyAssetReplyUnreadableError,
} from "@/lib/ai/study-assets";
import { isStudyAssetRecordCurrent } from "@/lib/study/study-asset-cache";
import {
  STUDY_ASSET_PROMPT_VERSION,
  STUDY_ASSET_VALIDATOR_VERSION,
} from "@/lib/study/study-asset-versions";
import { getCardContentHash } from "@/lib/study/study-modes";
import {
  getGapFillEligibility,
  getMultipleChoiceEligibility,
} from "@/lib/study/mode-eligibility";
import type { Card } from "@/lib/study/cards";
import { mergeMcqVariants, needsFreshMcq } from "@/lib/study/mcq-rotation";

/*
 * Why a Multiple Choice session kept saying a card could not be asked.
 *
 * Three things, each of which left a card with no question for good: a reply
 * that failed to parse was stored as if the model had turned the card down; a
 * card prepared with no question was reported as still waiting, so the page
 * waited and then refused; and a formula answer was reported as waiting for
 * preparation it was never going to be sent for.
 */

const card = { front: "What is osmosis?", back: "Water moving across a membrane" };
const cacheKey = "key-1";

function stored(over: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    sourceFingerprint: getCardContentHash(card),
    cacheKey,
    validatorVersion: STUDY_ASSET_VALIDATOR_VERSION,
    generationFailed: false,
    asset: { mcqVariants: [{ id: "v1" }] },
    ...over,
  };
}

const current = (data: Record<string, unknown> | undefined, wantsMultipleChoice = false) =>
  isStudyAssetRecordCurrent(data, { uid: "user-1", card, cacheKey, wantsMultipleChoice });

describe("which stored preparation counts as done", () => {
  it("keeps a success and a considered refusal", () => {
    expect(current(stored())).toBe(true);
    expect(current(stored({ generationFailed: true, failureKind: "declined", asset: undefined }))).toBe(true);
  });

  it("asks again after a failure that was not a refusal, including old records with no kind", () => {
    expect(current(stored({ generationFailed: true, failureKind: "transient" }))).toBe(false);
    expect(current(stored({ generationFailed: true, asset: undefined }))).toBe(false);
  });

  it("gives a card with no question one more try, once, when multiple choice is wanted", () => {
    const empty = stored({ asset: { mcqVariants: [] } });
    expect(current(empty, false)).toBe(true);
    expect(current(empty, true)).toBe(false);
    expect(current({ ...empty, mcqRetryPromptVersion: STUDY_ASSET_PROMPT_VERSION }, true)).toBe(true);
  });

  it("asks again when the card changed", () => {
    expect(current(stored({ sourceFingerprint: "something else" }))).toBe(false);
    expect(current(stored({ cacheKey: "other" }))).toBe(false);
  });

  it("uses an MCQ-only preparation while still allowing gaps and marking hints to be prepared later", () => {
    expect(current(stored({ mcqOnly: true }), true)).toBe(true);
    expect(current(stored({ mcqOnly: true }), false)).toBe(false);
  });
});

describe("rotating prepared options", () => {
  const first = { id: "a", distractors: ["Beta", "Gamma", "Delta"] };
  const shuffled = { id: "b", distractors: ["delta", "beta", "gamma"] };
  const minorChange = { id: "c", distractors: ["Delta", "Beta", "Epsilon"] };
  const fresh = { id: "d", distractors: ["Gamma", "Iota", "Omega"] };

  it("adds genuinely different wrong options and preserves the current variant's ID", () => {
    expect(mergeMcqVariants([first], [shuffled, minorChange, fresh])).toEqual([first, fresh]);
  });

  it("refreshes once all options have been seen and respects the cooldown", () => {
    expect(needsFreshMcq([first.id, fresh.id], ["a"], 0, 100)).toBe(false);
    expect(needsFreshMcq([first.id, fresh.id], ["a", "d"], 0, 100)).toBe(true);
    expect(needsFreshMcq([first.id, fresh.id], ["a", "d"], 150, 100)).toBe(false);
  });
});

describe("reading a preparation reply", () => {
  it("survives LaTeX the model forgot to escape, and a fence around the object", () => {
    const reply = '```json\n{"assets":[{"cardId":"c1","answer":"$\\frac{1}{2}mv^2$"}]}\n```';
    expect(readModelJson(reply)).toEqual({ assets: [{ cardId: "c1", answer: "$\\frac{1}{2}mv^2$" }] });
  });

  it("reads a bare list where an object holding one was asked for", () => {
    expect(readModelJson('[{"cardId":"c1"},{"cardId":"c2"}]')).toEqual([{ cardId: "c1" }, { cardId: "c2" }]);
  });

  it("throws on a reply it cannot read, rather than reporting every card as turned down", () => {
    expect(() => parseStudyAssetReply("the model wrote prose", [{ id: "c1", back: "x" }])).toThrow(
      StudyAssetReplyUnreadableError
    );
  });

  it("tells a card the model turned down from one it left out", () => {
    const reply = JSON.stringify({
      assets: [{ cardId: "c1", ambiguous: true, confidence: 0.2 }],
    });
    const { assets, declinedCardIds } = parseStudyAssetReply(reply, [
      { id: "c1", front: "Q", back: "A" },
      { id: "c2", front: "Q", back: "B" },
    ]);
    expect(assets).toEqual([]);
    expect(declinedCardIds).toEqual(["c1"]);
  });
});

describe("whether a card is waiting for its question or has none coming", () => {
  const base = { id: "c1", deckId: "d1", userId: "u1", front: "What is osmosis?" } as unknown as Card;

  it("waits for a card nobody has prepared yet", () => {
    expect(getMultipleChoiceEligibility({ ...base, back: "Water moving across a membrane" })).toEqual({
      eligible: false,
      reason: "needs-preparation",
    });
  });

  it("stops waiting once the card has been read and no question came of it", () => {
    const prepared = {
      ...base,
      back: "Water moving across a membrane from dilute to concentrated",
      studySettings: {
        generatedStudy: { bundleVersion: 3, sourceHash: "h", gapVariants: [], mcqVariants: [], retiredVariantIds: [] },
      },
    } as unknown as Card;
    expect(getMultipleChoiceEligibility(prepared)).toEqual({ eligible: false, reason: "no-prepared-options" });
  });

  it("stops waiting for gaps once the card has been read and none were worth hiding", () => {
    const prepared = {
      ...base,
      front: "What does the heart do?",
      back: "It pumps it around it all",
      studySettings: {
        generatedStudy: { bundleVersion: 3, sourceHash: "h", gapVariants: [], mcqVariants: [], retiredVariantIds: [] },
      },
    } as unknown as Card;
    const eligibility = getGapFillEligibility(prepared);
    // Either a gap the rules can find on their own, or a settled "none" -- never a wait.
    expect(eligibility).not.toEqual({ eligible: false, reason: "needs-preparation" });
  });

  it("waits on a formula answer like any other, now that formulas are prepared", () => {
    expect(getMultipleChoiceEligibility({ ...base, back: "$E_k = \\frac{1}{2}mv^2$" })).toEqual({
      eligible: false,
      reason: "needs-preparation",
    });
  });
});

/*
 * Asked about `$3x^2$`, the model writes its options as `3x^2` -- the right
 * maths without the delimiters. Compared as text, the correct option was not
 * the card's answer, and half of all maths cards lost their question to it.
 */
describe("multiple choice for a maths answer", () => {
  const explained = (options: string[]) =>
    Object.fromEntries(options.map((option) => [option, "Why."]));

  it("reads options as maths, keeps the card's own answer, and typesets every option", () => {
    const reply = JSON.stringify({
      assets: [
        {
          cardId: "m1",
          confidence: 0.95,
          ambiguous: false,
          mcqVariants: [
            {
              id: "v1",
              correctAnswer: "3x^2",
              distractors: ["x^3", "3x^3", "x^2"],
              explanations: explained(["3x^2", "x^3", "3x^3", "x^2"]),
            },
          ],
        },
      ],
    });
    const { assets } = parseStudyAssetReply(reply, [{ id: "m1", front: "Differentiate $x^3$", back: "$3x^2$" }]);
    expect(assets[0].mcqVariants).toEqual([
      {
        id: "v1",
        correctAnswer: "$3x^2$",
        distractors: ["$x^3$", "$3x^3$", "$x^2$"],
        explanations: explained(["$3x^2$", "$x^3$", "$3x^3$", "$x^2$"]),
      },
    ]);
  });

  it("still refuses a correct option that is different maths from the card", () => {
    const reply = JSON.stringify({
      assets: [
        {
          cardId: "m1",
          confidence: 0.95,
          ambiguous: false,
          mcqVariants: [
            {
              id: "v1",
              correctAnswer: "0.5",
              distractors: ["0.577", "0.866", "0.707"],
              explanations: explained(["0.5", "0.577", "0.866", "0.707"]),
            },
          ],
        },
      ],
    });
    const { assets } = parseStudyAssetReply(reply, [{ id: "m1", front: "What is $\\sin 30^\\circ$?", back: "$\\frac{1}{2}$" }]);
    expect(assets[0].mcqVariants ?? []).toEqual([]);
  });
});
