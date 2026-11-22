"use client";

import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  getCardFacesError,
  MAX_BACK_LENGTH,
  MAX_FRONT_LENGTH,
  normalizeCardContentInput,
  type Card,
} from "@/lib/study/cards";
import type { CardImageDraft } from "@/lib/study/card-images";
import {
  applyStudySettingsDraft,
  EMPTY_STUDY_SETTINGS_DRAFT,
  type StudySettingsDraft,
} from "@/lib/study/card-study-settings";
import {
  cardSaveErrorMessage,
  commitCardImageDrafts,
  releaseCardImageDraft,
} from "@/services/study/card-images";
import CardFaceImage from "@/components/cards/CardFaceImage";
import CardImageField from "@/components/decks/CardImageField";
import CardStudyOptions from "@/components/decks/CardStudyOptions";
import type { Feedback } from "@/lib/app/feedback";
import type { Topic } from "@/lib/material/topics";
import { createCard } from "@/services/study/cards";
import type { Deck } from "@/lib/study/decks";
import { featureFlags } from "@/lib/app/feature-flags";
import TopicPicker from "@/components/topics/TopicPicker";
import CardBackEditor from "@/components/decks/CardBackEditor";
import CardBackAutocomplete from "@/components/decks/CardBackAutocomplete";
import VideoCardCreator from "@/components/decks/VideoCardCreator";
import SourceCardCreator from "@/components/decks/SourceCardCreator";
import PastedCardCreator from "@/components/decks/PastedCardCreator";
import DiagramEditorDialog, {
  type DiagramEditorStart,
} from "@/components/decks/diagram/DiagramEditorDialog";
import DiagramPictureSource from "@/components/decks/diagram/DiagramPictureSource";
import type { DiagramPicture } from "@/lib/study/diagram-image";
import { Button, FormDisclosure, Input, SectionHeader, StudyText } from "@/components/ui";

type CreationMode = "single" | "diagram" | "source" | "list" | "video";

type CardCreationPanelProps = {
  userId: string;
  decks: Deck[];
  /**
   * An empty `decks` while the page is still fetching is not the same as having
   * no decks, and telling someone with a deck to "create a deck first" is worse
   * than saying nothing for a moment.
   */
  decksLoading?: boolean;
  existingCards: Card[];
  topics: Topic[];
  onTopicsChange: (topics: Topic[]) => void;
  defaultDeckId?: string;
  onCardsCreated: (
    cards: Card[],
    meta: { source: CreationMode; selectCreated: boolean }
  ) => void;
  onFeedback: (feedback: Feedback) => void;
};

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-sm font-medium transition duration-fast ${
        active
          ? "app-selected ring-1 ring-warm-accent/15"
          : "app-chip hover:border-border-strong hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

export default function CardCreationPanel({
  userId,
  decks,
  decksLoading = false,
  existingCards,
  topics,
  onTopicsChange,
  defaultDeckId,
  onCardsCreated,
  onFeedback,
}: CardCreationPanelProps) {
  const [mode, setMode] = useState<CreationMode>("single");
  const [openedPasteList, setOpenedPasteList] = useState(false);
  const fallbackDeckId = defaultDeckId ?? decks[0]?.id ?? "";
  const deckIsFixed = Boolean(defaultDeckId);

  const [singleDeckId, setSingleDeckId] = useState(fallbackDeckId);
  const [singleFront, setSingleFront] = useState("");
  const [singleBack, setSingleBack] = useState("");
  const [singleFrontImage, setSingleFrontImage] = useState<CardImageDraft>();
  const [singleBackImage, setSingleBackImage] = useState<CardImageDraft>();
  const [singleTopicIds, setSingleTopicIds] = useState<string[]>([]);
  const [singleStudySettings, setSingleStudySettings] = useState<StudySettingsDraft>(EMPTY_STUDY_SETTINGS_DRAFT);
  /** Bumped per card added, so the folded sections start the next card empty. */
  const [singleCardCount, setSingleCardCount] = useState(0);
  const [addingSingleCard, setAddingSingleCard] = useState(false);
  const [diagramStart, setDiagramStart] = useState<DiagramEditorStart | null>(null);
  /** The page the last diagram was cut from, to cut another from it straight away. */
  const [lastDiagramSource, setLastDiagramSource] = useState<DiagramPicture | null>(null);

  useEffect(() => {
    if (!fallbackDeckId) {
      return;
    }

    setSingleDeckId((current) => current || fallbackDeckId);
  }, [fallbackDeckId]);

  const deckNamesById = useMemo(
    () => Object.fromEntries(decks.map((deck) => [deck.id, deck.name])),
    [decks]
  );
  const renderDeckSelect = (
    value: string,
    onChange: (value: string) => void,
    disabled: boolean
  ) => {
    if (deckIsFixed) {
      return null;
    }

    return (
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="app-field w-full appearance-none rounded-2xl px-5 py-[1rem] text-sm outline-none transition duration-fast disabled:opacity-60"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238f7de8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 1rem center",
          paddingRight: "2.5rem",
        }}
      >
        <option value="" disabled>Choose a deck</option>
        {decks.map((deck) => (
          <option key={deck.id} value={deck.id}>{deck.name}</option>
        ))}
      </select>
    );
  };

  const handleAddSingleCard = async () => {
    const front = normalizeCardContentInput(singleFront);
    const back = normalizeCardContentInput(singleBack);
    if (!singleDeckId) {
      onFeedback({ type: "error", message: "Choose a deck first." });
      return;
    }

    const problem = getCardFacesError({
      front,
      back,
      hasFrontImage: Boolean(singleFrontImage),
      hasBackImage: Boolean(singleBackImage),
    });
    if (problem) {
      onFeedback({ type: "error", message: problem });
      return;
    }

    setAddingSingleCard(true);
    // A picture answer is only ever turned over, so its options would never be read.
    const studySettings = singleBackImage ? undefined : applyStudySettingsDraft(undefined, singleStudySettings);

    try {
      const { result: card } = await commitCardImageDrafts({
        userId,
        drafts: { frontImage: singleFrontImage, backImage: singleBackImage },
        write: (images) =>
          createCard({
            deckId: singleDeckId,
            userId,
            front,
            back,
            topicIds: singleTopicIds,
            ...(images.frontImage ? { frontImage: images.frontImage } : {}),
            ...(images.backImage ? { backImage: images.backImage } : {}),
            ...(studySettings ? { studySettings } : {}),
          }),
      });

      releaseCardImageDraft(singleFrontImage);
      releaseCardImageDraft(singleBackImage);
      setSingleFront("");
      setSingleBack("");
      setSingleFrontImage(undefined);
      setSingleBackImage(undefined);
      setSingleTopicIds([]);
      setSingleStudySettings(EMPTY_STUDY_SETTINGS_DRAFT);
      setSingleCardCount((count) => count + 1);
      onCardsCreated([card], { source: "single", selectCreated: false });
      onFeedback({
        type: "success",
        message: "Card added. Review it in Learn when it becomes due.",
      });
    } catch (error) {
      console.error(error);
      onFeedback({ type: "error", message: cardSaveErrorMessage(error, "Failed to add card.") });
    } finally {
      setAddingSingleCard(false);
    }
  };

  const handleSingleCardShortcut = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !addingSingleCard
    ) {
      event.preventDefault();
      void handleAddSingleCard();
    }
  };

  return (
    <section id="add-card" className="app-panel p-4 sm:p-5">
      <SectionHeader title="Add cards" />
      <div role="group" aria-label="Card creation method" className="mt-3 flex flex-wrap gap-2">
        <ModeButton active={mode === "single"} onClick={() => setMode("single")}>Single card</ModeButton>
        <ModeButton active={mode === "diagram"} onClick={() => setMode("diagram")}>Diagram</ModeButton>
        <ModeButton active={mode === "source"} onClick={() => setMode("source")}>From notes or file</ModeButton>
        <ModeButton active={mode === "list"} onClick={() => { setOpenedPasteList(true); setMode("list"); }}>Paste list</ModeButton>
        <ModeButton active={mode === "video"} onClick={() => setMode("video")}>From video</ModeButton>
      </div>

      {decks.length === 0 && !decksLoading ? (
        <p className="app-subtle-panel mt-4 rounded-lg p-4 text-sm leading-6">
          Create a deck first. Then you can add cards here.
        </p>
      ) : null}

      {mode === "single" ? (
        <div className="mt-5 space-y-4 animate-fade-in">
          {!deckIsFixed ? (
            <div>
              <div className="mb-2 text-sm font-medium tracking-[0.01em] text-text-secondary">
                Deck
              </div>
              {renderDeckSelect(singleDeckId, setSingleDeckId, addingSingleCard)}
            </div>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
            <Input
              label="Front"
              symbols
              placeholder="Front"
              value={singleFront}
              onChange={(event) => setSingleFront(event.target.value)}
              onKeyDown={handleSingleCardShortcut}
              maxLength={MAX_FRONT_LENGTH}
              disabled={addingSingleCard}
            />
            <CardImageField
              label="Front image"
              value={singleFrontImage}
              disabled={addingSingleCard}
              onChange={setSingleFrontImage}
            />
            </div>
            <div className="space-y-2">
            <CardBackEditor
              label="Back"
              placeholder="Back"
              value={singleBack}
              onChange={setSingleBack}
              onKeyDown={handleSingleCardShortcut}
              maxLength={MAX_BACK_LENGTH}
              rows={6}
              disabled={addingSingleCard}
              action={
                featureFlags.enableFlashcardAi ? (
                  <CardBackAutocomplete
                    front={singleFront}
                    currentBack={singleBack}
                    deckId={singleDeckId || undefined}
                    deckName={deckNamesById[singleDeckId]}
                    topics={topics
                      .filter((topic) => singleTopicIds.includes(topic.id))
                      .map((topic) => topic.name)}
                    topicIds={singleTopicIds}
                    disabled={addingSingleCard}
                    onApply={setSingleBack}
                  />
                ) : null
              }
            />
            <CardImageField
              label="Back image"
              value={singleBackImage}
              disabled={addingSingleCard}
              onChange={setSingleBackImage}
            />
            </div>
          </div>

          {/*
            Card text is written as LaTeX now, both by hand and by the AI draft,
            and a textarea can only ever show the source. Without this the only
            way to find out what "$\frac{a}{b}$" becomes is to save the card and
            go and study it.
          */}
          {singleFront.trim() || singleBack.trim() || singleFrontImage || singleBackImage ? (
            <div className="app-subtle-panel rounded-lg p-4">
              <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                Preview
              </div>
              <div className="mt-3 space-y-2">
                {singleFrontImage ? (
                  <CardFaceImage
                    source={singleFrontImage}
                    alt="Front image"
                    className="max-h-40 rounded-md object-contain"
                  />
                ) : null}
                {singleFront.trim() ? (
                  <StudyText
                    as="div"
                    text={singleFront}
                    className="whitespace-pre-wrap text-sm font-medium leading-6 text-text-primary"
                  />
                ) : null}
                {singleBack.trim() || singleBackImage ? (
                  <div className="space-y-2 border-t border-[var(--color-border)] pt-2">
                    {singleBackImage ? (
                      <CardFaceImage
                        source={singleBackImage}
                        alt="Back image"
                        className="max-h-40 rounded-md object-contain"
                      />
                    ) : null}
                    {singleBack.trim() ? (
                      <StudyText
                        as="div"
                        text={singleBack}
                        className="whitespace-pre-wrap text-sm leading-6 text-text-secondary"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <FormDisclosure
            title="Topics"
            summary={
              singleTopicIds.length === 0
                ? "Optional"
                : `${singleTopicIds.length} ${singleTopicIds.length === 1 ? "topic" : "topics"}`
            }
          >
            <TopicPicker
              userId={userId}
              topics={topics}
              selectedTopicIds={singleTopicIds}
              onChange={setSingleTopicIds}
              onTopicsChange={onTopicsChange}
              disabled={addingSingleCard}
            />
          </FormDisclosure>
          <CardStudyOptions
            key={singleCardCount}
            front={singleFront}
            back={singleBack}
            hasBackImage={Boolean(singleBackImage)}
            value={singleStudySettings}
            onChange={setSingleStudySettings}
            disabled={addingSingleCard}
          />
          <Button
            type="button"
            data-tutorial-target="create-card"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            disabled={
              addingSingleCard ||
              !singleDeckId ||
              (!singleFront.trim() && !singleFrontImage) ||
              (!singleBack.trim() && !singleBackImage)
            }
            onClick={() => void handleAddSingleCard()}
            size="lg"
            className="w-full sm:w-auto"
          >
            {addingSingleCard ? "Adding..." : "Add card"}
          </Button>
        </div>
      ) : null}

      {mode === "diagram" ? (
        <div className="mt-5 space-y-4 animate-fade-in">
          {!deckIsFixed ? (
            <div>
              <div className="mb-2 text-sm font-medium tracking-[0.01em] text-text-secondary">
                Deck
              </div>
              {renderDeckSelect(singleDeckId, setSingleDeckId, diagramStart !== null)}
            </div>
          ) : null}
          <p className="max-w-2xl text-sm leading-6 text-text-secondary">
            Cover the labels on a picture, like a heart or a cell, and each label becomes its own
            card. You name what is under the box, and Jami schedules every label separately.
          </p>
          {lastDiagramSource ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-text-secondary">
                Diagram saved. Is there another diagram on the same page?
              </p>
              <div className="flex shrink-0 gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setLastDiagramSource(null)}>
                  No
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!singleDeckId || diagramStart !== null}
                  onClick={() => setDiagramStart({ kind: "new", picture: lastDiagramSource, next: "crop" })}
                >
                  Crop another from it
                </Button>
              </div>
            </div>
          ) : null}
          <DiagramPictureSource
            userId={userId}
            disabled={!singleDeckId || diagramStart !== null}
            onPicture={(picture, next) => {
              setLastDiagramSource(null);
              setDiagramStart({ kind: "new", picture, next });
            }}
          />
          {!singleDeckId && decks.length > 0 ? (
            <p className="text-sm text-text-muted">Choose a deck first.</p>
          ) : null}
        </div>
      ) : null}

      <DiagramEditorDialog
        start={diagramStart}
        userId={userId}
        deckId={singleDeckId}
        deckName={deckNamesById[singleDeckId] ?? "Deck"}
        topics={topics}
        onTopicsChange={onTopicsChange}
        onClose={() => setDiagramStart(null)}
        onSaved={(result, { sourcePicture }) => {
          setDiagramStart(null);
          setLastDiagramSource(sourcePicture);
          onCardsCreated(result.cards, { source: "diagram", selectCreated: false });
          onFeedback({
            type: "success",
            message: `Diagram saved: ${result.cards.length} label card${result.cards.length === 1 ? "" : "s"}. Each one joins review on its own schedule.`,
          });
        }}
      />

      {openedPasteList ? (
        <div hidden={mode !== "list"}>
          <PastedCardCreator
            userId={userId}
            decks={decks}
            defaultDeckId={defaultDeckId}
            existingCards={existingCards}
            topics={topics}
            onTopicsChange={onTopicsChange}
            onCardsCreated={(cards) => onCardsCreated(cards, { source: "list", selectCreated: true })}
            onMessage={(message, error) => onFeedback({ type: error ? "error" : "success", message })}
          />
        </div>
      ) : null}

      {mode === "video" ? (
        <VideoCardCreator
          userId={userId}
          decks={decks}
          topics={topics}
          defaultDeckId={defaultDeckId}
          onTopicsChange={onTopicsChange}
          onCardsCreated={(cards) =>
            onCardsCreated(cards, { source: "video", selectCreated: true })
          }
          onMessage={(message, error) =>
            onFeedback({ type: error ? "error" : "success", message })
          }
        />
      ) : null}

      {mode === "source" ? (
        <SourceCardCreator
          userId={userId}
          decks={decks}
          topics={topics}
          defaultDeckId={defaultDeckId}
          onTopicsChange={onTopicsChange}
          onCardsCreated={(cards) =>
            onCardsCreated(cards, { source: "source", selectCreated: true })
          }
          onMessage={(message, error) =>
            onFeedback({ type: error ? "error" : "success", message })
          }
        />
      ) : null}

    </section>
  );
} 
