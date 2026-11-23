// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/study/cards";
import type { StudyAsset } from "@/lib/ai/study-assets";

vi.mock("@/services/study/study-assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/study/study-assets")>()),
  loadStudyAssets: vi.fn().mockResolvedValue({}),
  prepareStudyAssets: vi.fn(),
}));

const { loadStudyAssets, prepareStudyAssets, StudyAssetPreparationError } = await import(
  "@/services/study/study-assets"
);
const { useStudyPreparation } = await import("@/hooks/useStudyPreparation");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Preparation = ReturnType<typeof useStudyPreparation>;

let container: HTMLDivElement;
let root: Root;
let preparation: Preparation;
const onAssetsReady = vi.fn();

function Harness({ expose }: { expose: (value: Preparation) => void }) {
  const value = useStudyPreparation({
    enabled: true,
    modePolicy: { kind: "fixed", mode: "multiple-choice" },
    onAssetsReady,
  });
  useLayoutEffect(() => {
    expose(value);
  });
  return null;
}

function cards(count: number): Card[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `card-${index + 1}`,
    deckId: "deck-1",
    userId: "user-1",
    front: `Question ${index + 1}`,
    back: `Answer number ${index + 1} in a sentence`,
  })) as unknown as Card[];
}

const done = { jobId: "job", status: "completed" as const, requested: 1, prepared: 1, reused: 0, failed: 0 };
const requestedIds = () =>
  vi.mocked(prepareStudyAssets).mock.calls.map(([input]) => input.cardIds);

const exampleAsset: StudyAsset = {
  cardId: "card-1", answerShape: "short", acceptedAliases: [], requiredConcepts: [],
  clozeCandidates: [], distractors: [], misconceptions: {}, confidence: 1, ambiguous: false,
  mcqVariants: [{ id: "v1", correctAnswer: "a", distractors: ["b", "c", "d"], explanations: {} }],
};

beforeEach(() => {
  vi.mocked(prepareStudyAssets).mockReset();
  onAssetsReady.mockClear();
  vi.mocked(loadStudyAssets).mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness expose={(value) => (preparation = value)} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("background preparation", () => {
  it("opens Multiple Choice without waiting on generation and publishes a question before the request finishes", async () => {
    let arrived: Parameters<typeof prepareStudyAssets>[1];
    vi.mocked(prepareStudyAssets).mockImplementation((_, callback) => {
      arrived = callback;
      return new Promise(() => {});
    });
    const queue = cards(2);
    const ready = await preparation.prepareSessionAssets(queue);
    expect(ready.remainder).toEqual(queue);
    expect(preparation.progress).toBeNull();
    expect(prepareStudyAssets).not.toHaveBeenCalled();
    await act(async () => { void preparation.prepareRemainingAssets(ready.remainder); });
    const sample = { "card-1": exampleAsset };
    arrived?.(sample);
    expect(onAssetsReady).toHaveBeenCalledWith(sample);
    act(() => preparation.cancel());
    onAssetsReady.mockClear();
    arrived?.(sample);
    expect(onAssetsReady).not.toHaveBeenCalled();
  });

  it("requests a fresh set behind cold cards when the available variant has been seen", async () => {
    const queue = cards(2);
    vi.mocked(loadStudyAssets).mockResolvedValueOnce({ "card-1": exampleAsset });
    vi.mocked(prepareStudyAssets).mockResolvedValue(done);
    const prepared = await preparation.prepareSessionAssets(queue, Promise.resolve({ variants: { "card-1": ["v1"] } }));
    await preparation.prepareRemainingAssets(prepared.remainder);
    expect(prepareStudyAssets).toHaveBeenCalledWith({
      deckId: "deck-1", cardIds: ["card-2", "card-1"], purpose: "multiple-choice", refreshCardIds: ["card-1"],
    }, expect.any(Function));
  });

  /*
   * Being asked to slow down used to end preparation for the whole session,
   * so every card after the refusal arrived with no question.
   */
  it("keeps going after being asked to slow down", async () => {
    vi.mocked(prepareStudyAssets)
      .mockRejectedValueOnce(new StudyAssetPreparationError("Too quick", 429, "burst_limit", 0.001))
      .mockResolvedValue(done);
    await act(async () => {
      await preparation.prepareRemainingAssets(cards(3));
    });
    expect(requestedIds()).toEqual([
      ["card-1", "card-2", "card-3"],
      ["card-1", "card-2", "card-3"],
    ]);
  });

  it("stops once the day's allowance is spent", async () => {
    vi.mocked(prepareStudyAssets).mockRejectedValue(
      new StudyAssetPreparationError("No more today", 429, "daily_limit", 3600)
    );
    await act(async () => {
      await preparation.prepareRemainingAssets(cards(24));
    });
    // Two requests were already in flight together; the third is never sent.
    expect(vi.mocked(prepareStudyAssets)).toHaveBeenCalledTimes(2);
  });

  it("asks for cards in queue order, eight to a request", async () => {
    vi.mocked(prepareStudyAssets).mockResolvedValue(done);
    await act(async () => {
      await preparation.prepareRemainingAssets(cards(10));
    });
    expect(requestedIds()).toEqual([
      ["card-1", "card-2", "card-3", "card-4", "card-5", "card-6", "card-7", "card-8"],
      ["card-9", "card-10"],
    ]);
  });

  it("does not ask for a card twice while it is already on its way", async () => {
    vi.mocked(prepareStudyAssets).mockImplementation(() => new Promise(() => {}));
    const queue = cards(3);
    void preparation.prepareRemainingAssets(queue);
    await act(async () => {
      await Promise.resolve();
    });
    let result: Awaited<ReturnType<Preparation["prepareCardNow"]>> | undefined;
    await act(async () => {
      result = await preparation.prepareCardNow(queue[0]);
    });
    expect(result).toBe("pending");
    expect(requestedIds()).toEqual([["card-1", "card-2", "card-3"]]);
  });
});
