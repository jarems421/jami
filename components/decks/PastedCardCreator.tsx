"use client";

import { useMemo, useRef, useState } from "react";
import TopicPicker from "@/components/topics/TopicPicker";
import { Button, Card as Panel, FormDisclosure, Select, StudyText, Textarea } from "@/components/ui";
import type { Topic } from "@/lib/material/topics";
import { getCardContentKey, parseCardImportText, type Card } from "@/lib/study/cards";
import type { Deck } from "@/lib/study/decks";
import { CardBatchCreateError, createCardsInBatches } from "@/services/study/cards";

export default function PastedCardCreator({
  userId, decks, defaultDeckId, existingCards, topics, onTopicsChange, onCardsCreated, onMessage,
}: {
  userId: string;
  decks: Deck[];
  defaultDeckId?: string;
  existingCards: Card[];
  topics: Topic[];
  onTopicsChange: (topics: Topic[]) => void;
  onCardsCreated: (cards: Card[]) => void;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [chosenDeckId, setChosenDeckId] = useState("");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const saving = useRef(false);
  const deckId = defaultDeckId ?? (decks.some((deck) => deck.id === chosenDeckId) ? chosenDeckId : decks[0]?.id ?? "");
  const parsed = useMemo(() => parseCardImportText(text), [text]);
  const knownKeys = useMemo(() => new Set(existingCards
    .filter((card) => card.deckId === deckId)
    .map((card) => getCardContentKey(card.front, card.back))), [deckId, existingCards]);
  const drafts = useMemo(() => {
    const seen = new Set(knownKeys);
    return parsed.cards.filter(({ front, back }) => {
      const key = getCardContentKey(front, back);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [knownKeys, parsed.cards]);
  const duplicates = parsed.cards.length - drafts.length;
  const ready = Boolean(deckId && drafts.length && !parsed.skippedRows);

  async function addCards() {
    if (!ready || saving.current) return;
    saving.current = true;
    setProgress({ completed: 0, total: drafts.length });
    try {
      const cards = await createCardsInBatches({ drafts, deckId, userId, topicIds },
        (completed, total) => setProgress({ completed, total }));
      onCardsCreated(cards);
      setText("");
      setTopicIds([]);
      onMessage(`Added ${cards.length} ${cards.length === 1 ? "card" : "cards"}.`);
    } catch (error) {
      const cards = error instanceof CardBatchCreateError ? error.createdCards : [];
      if (cards.length) onCardsCreated(cards);
      onMessage(cards.length
        ? `Added ${cards.length} cards before saving stopped. Try again to add the remaining cards.`
        : "Could not add these cards. Try again.", true);
    } finally {
      saving.current = false;
      setProgress(null);
    }
  }

  return (
    <div className="mt-5 space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {!defaultDeckId ? (
            <Select label="Deck" value={deckId} disabled={Boolean(progress)} onChange={(event) => setChosenDeckId(event.target.value)}>
              <option value="" disabled>Choose a deck</option>
              {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
            </Select>
          ) : null}
          <Textarea
            aria-describedby="pasted-cards-format"
            label="Paste your cards"
            placeholder={"Osmosis | Net movement of water across a partially permeable membrane\nDiffusion | Net movement of particles from higher to lower concentration"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            disabled={Boolean(progress)}
          />
          <p id="pasted-cards-format" className="text-sm leading-6 text-text-muted">
            Put one card on each line with <code className="font-mono text-text-primary">Front | Back</code>.
          </p>
          <FormDisclosure title="Topics" summary={topicIds.length ? `${topicIds.length} selected` : "Optional"}>
            <TopicPicker
              userId={userId}
              topics={topics}
              selectedTopicIds={topicIds}
              onChange={setTopicIds}
              onTopicsChange={onTopicsChange}
              disabled={Boolean(progress)}
            />
          </FormDisclosure>
        </div>
        <Panel tone="subtle" padding="md">
          <p className="text-sm font-semibold text-text-primary">Preview</p>
          <p aria-live="polite" className="mt-1 text-sm leading-6 text-text-muted">
            {drafts.length ? `${drafts.length} new ${drafts.length === 1 ? "card" : "cards"}` : "New cards will appear here as you paste."}
            {duplicates > 0 ? ` · ${duplicates} ${duplicates === 1 ? "duplicate" : "duplicates"} will be skipped.` : ""}
          </p>
          {drafts.length ? (
            <ul className="mt-3 divide-y divide-[var(--color-border)]">
              {drafts.slice(0, 4).map(({ front, back }) => (
                <li key={getCardContentKey(front, back)} className="min-w-0 break-words py-2">
                  <StudyText as="div" text={front} className="text-sm font-medium text-text-primary" />
                  <StudyText as="div" text={back} className="mt-1 text-sm text-text-secondary" />
                </li>
              ))}
            </ul>
          ) : null}
          {drafts.length > 4 ? <p className="mt-2 text-xs text-text-muted">Plus {drafts.length - 4} more</p> : null}
        </Panel>
      </div>
      {parsed.skippedRows ? (
        <div role="status" className="rounded-lg border border-error/35 bg-error-muted p-4 text-sm text-[var(--color-error-text)]">
          <p className="font-semibold">Fix {parsed.skippedRows} {parsed.skippedRows === 1 ? "row" : "rows"} before adding cards.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {parsed.errors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </div>
      ) : null}
      <Button size="lg" className="w-full sm:w-auto" disabled={!ready || Boolean(progress)} onClick={() => void addCards()}>
        {progress ? `Adding cards · ${progress.completed} of ${progress.total}`
          : drafts.length ? `Add ${drafts.length} ${drafts.length === 1 ? "card" : "cards"}` : "Add cards"}
      </Button>
    </div>
  );
}
