// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Card } from "@/lib/study/cards";
import type { Topic } from "@/lib/material/topics";

const { setCardTopicsInBulk } = vi.hoisted(() => ({ setCardTopicsInBulk: vi.fn() }));
vi.mock("@/services/study/cards", () => ({ setCardTopicsInBulk, deleteCards: vi.fn(), moveCardsToDeck: vi.fn() }));
vi.mock("@/services/study/card-images", () => ({ deleteCardImageFiles: vi.fn() }));
vi.mock("@/services/study/image-occlusion", () => ({ releaseDiagramLabels: vi.fn() }));

const { useCardBulkActions } = await import("@/hooks/useCardBulkActions");
const { default: CardBulkActions } = await import("@/components/cards/CardBulkActions");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const topic = { id: "topic-heart", name: "Oxygenated blood", normalizedName: "oxygenated blood", status: "active" } as Topic;
const feedback = { clear: vi.fn(), showError: vi.fn(), success: vi.fn() };
let root: Root;
let host: HTMLDivElement;

function Harness({ initial }: { initial: Card[] }) {
  const [cards, setCards] = useState(initial);
  const [selected, setSelected] = useState(initial.map(({ id }) => id));
  const bulk = useCardBulkActions({
    cards, setCards, visibleCardIds: cards.map(({ id }) => id), selectedCardIds: selected,
    setSelectedCardIds: setSelected, topicSelectionResetKey: 0, feedback,
  });
  return <CardBulkActions userId="student" visibleCount={cards.length} decks={[]} topics={[topic]} onTopicsChange={() => undefined} bulk={bulk} />;
}

const card = (id: string, extra: Partial<Card> = {}) =>
  ({ id, deckId: "deck", userId: "student", front: `Q ${id}`, back: `A ${id}`, createdAt: 1, ...extra }) as Card;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  setCardTopicsInBulk.mockResolvedValue(undefined);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function applyTopic(cards: Card[]) {
  await act(async () => root.render(<Harness initial={cards} />));
  const search = host.querySelector<HTMLInputElement>('input[aria-label^="Search or create"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Oxygen");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const choice = [...host.querySelectorAll("button")].find((button) => button.textContent === "Oxygenated blood")!;
  await act(async () => choice.click());
  const apply = [...host.querySelectorAll("button")].find((button) => button.textContent === "Apply Topics")!;
  expect(apply.disabled).toBe(false);
  await act(async () => apply.click());
}

it("adds a Topic to several flashcards at once", async () => {
  await applyTopic([card("c1"), card("c2"), card("c3")]);
  expect(setCardTopicsInBulk).toHaveBeenCalledWith([
    { id: "c1", topicIds: ["topic-heart"] }, { id: "c2", topicIds: ["topic-heart"] }, { id: "c3", topicIds: ["topic-heart"] },
  ]);
  expect(feedback.success).toHaveBeenCalled();
});
