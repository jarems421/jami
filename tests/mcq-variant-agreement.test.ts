import { describe, expect, it } from "vitest";
import { parseStudyAssetResponse } from "@/lib/ai/study-assets";
import type { Card } from "@/lib/study/cards";
import { buildMultipleChoiceQuestion, getPlayableMcqVariantIds } from "@/lib/study/mcq";
import { condensesAnswer } from "@/lib/study/mcq-shape";

/**
 * The validator that stores a multiple-choice variant and the builder that
 * shows it have to agree.
 *
 * They did not, and a Multiple Choice session lost most of its queue to it. The
 * prompt asks the model to write the correct option in the distractors' shape --
 * "same length, same opening" -- so on a card with a long answer it comes back
 * shortened, deliberately. The validator checked that shortened option against
 * the distractors and stored it. The builder then tested it with
 * `equivalentOption`, which is an answer-marking check and does not recognise a
 * summary, threw it away, put the card's raw answer back in its place, and
 * refused the question a line later because the long answer stood out against
 * three short wrong ones. The card was admitted to the session and could never
 * be asked.
 *
 * So: a variant the validator accepts must be one the builder can build.
 */

const LONG_ANSWER =
  "A catalyst speeds up a reaction by providing an alternative reaction pathway with a lower activation energy, so a greater proportion of colliding particles have enough energy to react.";

function storedVariants(input: {
  front: string;
  back: string;
  correctAnswer: string;
  distractors: string[];
}) {
  const payload = {
    assets: [
      {
        cardId: "c1",
        confidence: 0.9,
        ambiguous: false,
        answerShape: "prose",
        mcqVariants: [
          {
            id: "v1",
            correctAnswer: input.correctAnswer,
            distractors: input.distractors,
            explanations: Object.fromEntries(
              [input.correctAnswer, ...input.distractors].map((option) => [option, "because"])
            ),
          },
        ],
      },
    ],
  };
  const parsed = parseStudyAssetResponse(JSON.stringify(payload), [
    { id: "c1", front: input.front, back: input.back },
  ]);
  return parsed[0]?.mcqVariants ?? [];
}

function cardWith(back: string, variants: ReturnType<typeof storedVariants>, front: string): Card {
  return {
    id: "c1",
    front,
    back,
    studySettings: {
      generatedStudy: { gapVariants: [], mcqVariants: variants, retiredVariantIds: [] },
    },
  } as unknown as Card;
}

describe("a correct option written in the distractors' shape", () => {
  const front = "Why does a catalyst speed up a reaction?";
  const correctAnswer = "It provides an alternative pathway with a lower activation energy";
  const distractors = [
    "It provides an alternative pathway with a higher activation energy",
    "It increases the average kinetic energy of the colliding particles",
    "It raises the concentration of the reactants in the mixture",
  ];

  it("is stored, and then actually builds", () => {
    const variants = storedVariants({ front, back: LONG_ANSWER, correctAnswer, distractors });
    expect(variants).toHaveLength(1);

    const question = buildMultipleChoiceQuestion({
      card: cardWith(LONG_ANSWER, variants, front),
      seed: 1,
    });
    expect(question, "a stored variant could not be built").not.toBeNull();
    expect(question?.options.map((option) => option.text)).toContain(correctAnswer);
  });

  it("shows four options a student could actually read", () => {
    const variants = storedVariants({ front, back: LONG_ANSWER, correctAnswer, distractors });
    const question = buildMultipleChoiceQuestion({
      card: cardWith(LONG_ANSWER, variants, front),
      seed: 1,
    });
    // The card's own answer is long; what matters is the length of the options
    // shown, which is why the cap moved off the card and onto them.
    expect(question?.options).toHaveLength(4);
    for (const option of question?.options ?? []) {
      expect(option.text.length).toBeLessThanOrEqual(160);
    }
  });

  it("still refuses a long answer when nothing was prepared for it", () => {
    // No variant means the card's own answer is the option, and a paragraph is
    // not an option.
    const bare = { id: "c1", front, back: LONG_ANSWER } as unknown as Card;
    expect(buildMultipleChoiceQuestion({ card: bare, seed: 1 })).toBeNull();
  });
});

describe("what counts as the card's answer said more briefly", () => {
  it("accepts a faithful condensation", () => {
    expect(
      condensesAnswer("It provides an alternative pathway with a lower activation energy", LONG_ANSWER)
    ).toBe(true);
  });

  it("refuses one that flips the claim", () => {
    /*
     * The dangerous case, and the reason this is containment rather than a
     * proportion of words matched: one word changed is still a different
     * answer, and a student marked against it is marked on something their card
     * never said.
     */
    expect(
      condensesAnswer("It provides an alternative pathway with a higher activation energy", LONG_ANSWER)
    ).toBe(false);
  });

  it("refuses one that brings in a claim of its own", () => {
    expect(
      condensesAnswer("It provides an alternative pathway and raises the temperature", LONG_ANSWER)
    ).toBe(false);
  });

  it("tolerates the rewording that shortening forces", () => {
    // "by providing" becomes "it provides"; the ending changes and the claim
    // does not.
    expect(condensesAnswer("It provides a lower activation energy", LONG_ANSWER)).toBe(true);
  });

  it("is not a licence to restate the answer at full length", () => {
    expect(condensesAnswer(LONG_ANSWER, LONG_ANSWER)).toBe(false);
    expect(condensesAnswer(`${LONG_ANSWER} It is never consumed.`, LONG_ANSWER)).toBe(false);
  });
});

describe("the validator refuses a correct option that is not the card's answer", () => {
  it("drops a variant whose correct option says something else", () => {
    /*
     * Nothing checked this before. A variant could be stored, shown, and marked
     * against, while asserting something the card does not.
     */
    const variants = storedVariants({
      front: "Why does a catalyst speed up a reaction?",
      back: LONG_ANSWER,
      correctAnswer: "It raises the temperature of the reacting mixture",
      distractors: [
        "It lowers the temperature of the reacting mixture",
        "It removes the products from the reacting mixture",
        "It increases the pressure on the reacting mixture",
      ],
    });
    expect(variants).toHaveLength(0);
  });
});

it("tries the next usable set and rotates away from the most recent one", () => {
  const front = "Which unit measures force?";
  const variants = [
    { id: "broken", correctAnswer: "Watt", distractors: ["Joule", "Pascal", "Kelvin"], explanations: {} },
    { id: "older", correctAnswer: "Newton", distractors: ["Joule", "Pascal", "Kelvin"], explanations: {} },
    { id: "newer", correctAnswer: "Newton", distractors: ["Coulomb", "Hertz", "Watt"], explanations: {} },
  ];
  const card = cardWith("Newton", variants, front);
  expect(getPlayableMcqVariantIds(card)).toEqual(["older", "newer"]);
  expect(buildMultipleChoiceQuestion({ card, recentVariantIds: ["older"] })?.variantId).toBe("newer");
  expect(buildMultipleChoiceQuestion({ card, recentVariantIds: ["older", "newer"] })?.variantId).toBe("older");
});
