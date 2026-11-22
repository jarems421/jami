"use client";

import { useEffect, useMemo, useState } from "react";
import TopicPicker from "@/components/topics/TopicPicker";
import CardImportProgress from "@/components/decks/CardImportProgress";
import JamiTutorIcon from "@/components/ui/JamiTutorIcon";
import { useCardImportJob } from "@/hooks/useCardImportJob";
import {
  Button,
  Card as Panel,
  FileField,
  FormDisclosure,
  Input,
  OptionSwitch,
  Select,
  Textarea,
} from "@/components/ui";
import {
  CARD_SOURCE_TEXT_MAX_LENGTH,
  type VideoCardDraft,
  type VideoCardEvidence,
  type VideoCoverage,
} from "@/lib/ai/video-card-jobs";
import type { Topic } from "@/lib/material/topics";
import { MAX_BACK_LENGTH, MAX_FRONT_LENGTH, type Card } from "@/lib/study/cards";
import type { Deck } from "@/lib/study/decks";
import { resolveSourceFileMimeType } from "@/lib/material/source-files";
import { validateSourceUploadFile } from "@/services/study/source-files";
import {
  createStorageFileId,
  deleteStorageFile,
  sanitizeStorageFileName,
  uploadStorageFile,
} from "@/services/firebase/storage-files";
import {
  approveVideoCardJob,
  cancelVideoCardJob,
  createVideoCardJob,
  saveVideoCardDrafts,
} from "@/services/ai/video-card-jobs";

type Props = {
  userId: string;
  decks: Deck[];
  topics: Topic[];
  defaultDeckId?: string;
  onTopicsChange: (topics: Topic[]) => void;
  onCardsCreated: (cards: Card[]) => void;
  onMessage: (message: string, error?: boolean) => void;
};

const COVERAGE_OPTIONS = [
  { value: "focused" as const, label: "Key points", detail: "The essentials for a quick review" },
  { value: "standard" as const, label: "Balanced", detail: "Main ideas, key details and worked examples" },
  { value: "thorough" as const, label: "In-depth", detail: "Mechanisms, exceptions and finer details" },
];

const ACCEPTED_SOURCE_FILES = [
  ".pdf", ".docx", ".pptx", ".txt", ".jpg", ".jpeg", ".png", ".webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "image/jpeg", "image/png", "image/webp",
].join(",");

const STAGE_LABELS = {
  preparing: "Preparing source",
  reading_video: "Reading source",
  creating_cards: "Drafting cards across the source",
  checking_cards: "Checking accuracy and coverage",
  ready: "Ready to review",
} as const;

function Evidence({ entries }: { entries: VideoCardEvidence[] }) {
  if (!entries.length) return null;
  return (
    <details className="mt-3 border-t border-[var(--color-border)] pt-3">
      <summary className="cursor-pointer text-xs font-medium text-text-muted transition-colors duration-fast hover:text-text-secondary">
        Evidence from the source
      </summary>
      <ul className="mt-3 space-y-2 border-l border-[var(--color-border)] pl-3">
        {entries.map((entry) => (
          <li key={entry.id} className="text-xs leading-relaxed text-text-secondary">
            {entry.summary}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function SourceCardCreator({
  userId,
  decks,
  topics,
  defaultDeckId,
  onTopicsChange,
  onCardsCreated,
  onMessage,
}: Props) {
  const [inputKind, setInputKind] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [deckId, setDeckId] = useState(defaultDeckId || decks[0]?.id || "");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<VideoCoverage>("standard");
  const [focus, setFocus] = useState("");
  const [job, setJob] = useCardImportJob(["file", "text"], defaultDeckId);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  useEffect(() => {
    setDeckId((current) => current || defaultDeckId || decks[0]?.id || "");
  }, [decks, defaultDeckId]);

  const evidenceById = useMemo(
    () => new Map((job?.evidence ?? []).map((entry) => [entry.id, entry])),
    [job?.evidence]
  );

  const start = async () => {
    const text = sourceText.trim();
    if (!deckId || (inputKind === "file" ? !file : !text)) {
      onMessage("Add a source and choose a deck.", true);
      return;
    }
    if (text.length > CARD_SOURCE_TEXT_MAX_LENGTH) {
      onMessage(`Pasted text must be ${CARD_SOURCE_TEXT_MAX_LENGTH.toLocaleString()} characters or fewer.`, true);
      return;
    }

    setBusy(true);
    const id = createStorageFileId();
    let storagePath = "";
    try {
      if (inputKind === "file" && file) {
        const mimeType = validateSourceUploadFile(file) || resolveSourceFileMimeType(file.name, file.type);
        if (!mimeType) throw new Error("This file type is not supported.");
        storagePath = `users/${userId}/cardSourceImports/${id}/${sanitizeStorageFileName(file.name, "source")}`;
        await uploadStorageFile({
          storagePath,
          file,
          contentType: mimeType,
          onProgress: setUploadProgress,
        });
      }

      const created = await createVideoCardJob({
        id,
        sourceKind: inputKind,
        ...(inputKind === "file"
          ? { storagePath, fileName: file?.name, mimeType: file?.type }
          : { contentText: text }),
        deckId,
        topicIds,
        coverage,
        focus: focus.trim() || undefined,
      });
      setJob(created);
      onMessage("Source import started.");
    } catch (error) {
      if (storagePath) await deleteStorageFile(storagePath).catch(() => undefined);
      onMessage(error instanceof Error ? error.message : "Could not start that import.", true);
    } finally {
      setBusy(false);
      setUploadProgress(0);
    }
  };

  const updateDraft = (id: string, field: "front" | "back", value: string) =>
    setJob((current) => current ? {
      ...current,
      drafts: current.drafts.map((draft) => draft.id === id ? { ...draft, [field]: value } : draft),
    } : current);

  const toggleDraft = (id: string) =>
    setJob((current) => current ? {
      ...current,
      drafts: current.drafts.map((draft) => draft.id === id ? { ...draft, selected: !draft.selected } : draft),
    } : current);

  const approve = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await saveVideoCardDrafts(job.id, job.drafts);
      const cards = await approveVideoCardJob(job.id);
      onCardsCreated(cards);
      onMessage(`Added ${cards.length} ${cards.length === 1 ? "card" : "cards"}.`);
      setJob(null);
      setFile(null);
      setSourceText("");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Could not add those cards.", true);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await cancelVideoCardJob(job.id);
      setJob(null);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Could not discard these drafts.", true);
    } finally {
      setBusy(false);
    }
  };

  const renderDraft = (draft: VideoCardDraft, index: number) => {
    const evidence = draft.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((entry): entry is VideoCardEvidence => Boolean(entry));
    return (
      <Panel key={draft.id} tone="subtle" padding="md" className={draft.selected ? "" : "opacity-55"}>
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-text-muted">
          <input
            type="checkbox"
            className="accent-[var(--color-accent)]"
            checked={draft.selected}
            onChange={() => toggleDraft(draft.id)}
          />
          Card {index + 1}
        </label>
        <Input
          className="mt-3"
          aria-label={`Card ${index + 1} front`}
          value={draft.front}
          maxLength={MAX_FRONT_LENGTH}
          disabled={busy}
          onChange={(event) => updateDraft(draft.id, "front", event.target.value)}
        />
        <Textarea
          className="mt-3"
          aria-label={`Card ${index + 1} back`}
          rows={3}
          value={draft.back}
          maxLength={MAX_BACK_LENGTH}
          disabled={busy}
          onChange={(event) => updateDraft(draft.id, "back", event.target.value)}
        />
        <Evidence entries={evidence} />
      </Panel>
    );
  };

  if (job) {
    const selectedCount = job.drafts.filter((draft) => draft.selected).length;
    return (
      <div className="mt-5 space-y-4 animate-fade-in">
        <CardImportProgress
          job={job}
          stageLabels={STAGE_LABELS}
          onTryAnother={() => setJob(null)}
          onCancel={() => void discard()}
        />

        {job.status === "ready" ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h4 className="text-base font-semibold text-text-primary">Review {job.drafts.length} {job.drafts.length === 1 ? "draft" : "drafts"}</h4>
                <p className="mt-1 text-sm text-text-muted">{job.title} · {selectedCount} selected</p>
              </div>
              <Button variant="ghost" disabled={busy} onClick={() => void discard()}>Discard</Button>
            </div>
            {job.warnings.length ? (
              <ul className="space-y-2">
                {job.warnings.map((warning) => (
                  <li key={warning.id} className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-text-secondary">
                    {warning.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="space-y-3">{job.drafts.map(renderDraft)}</div>
            <p className="text-xs leading-5 text-text-muted">
              The uploaded file and source evidence are removed after you add or discard this batch.
            </p>
            <Button size="lg" disabled={busy || !selectedCount} onClick={() => void approve()}>
              Add selected cards
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-5 animate-fade-in">
      <p className="max-w-2xl text-sm leading-6 text-text-secondary">
        Jami drafts cards section by section and checks them against your material. You can edit each draft and choose what to add.
      </p>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel tone="subtle" padding="md" className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant={inputKind === "file" ? "secondary" : "ghost"}
              disabled={busy}
              onClick={() => setInputKind("file")}
            >
              Upload
            </Button>
            <Button
              variant={inputKind === "text" ? "secondary" : "ghost"}
              disabled={busy}
              onClick={() => setInputKind("text")}
            >
              Paste text
            </Button>
          </div>

          {inputKind === "file" ? (
            <FileField
              label="Study file"
              hint="PDF, PowerPoint, Word, text or image under 20 MB. For diagrams in slides, export as PDF."
              accept={ACCEPTED_SOURCE_FILES}
              file={file}
              disabled={busy}
              onChange={setFile}
            />
          ) : (
            <Textarea
              label="Study text"
              placeholder="Paste the notes or transcript you want to study."
              rows={7}
              maxLength={CARD_SOURCE_TEXT_MAX_LENGTH}
              value={sourceText}
              disabled={busy}
              onChange={(event) => setSourceText(event.target.value)}
            />
          )}

          {!defaultDeckId ? (
            <Select label="Deck" value={deckId} disabled={busy} onChange={(event) => setDeckId(event.target.value)}>
              <option value="" disabled>Choose a deck</option>
              {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
            </Select>
          ) : null}
        </Panel>
        <Panel tone="subtle" padding="md" className="space-y-4">
          <OptionSwitch label="Coverage" detail="selected" value={coverage} options={COVERAGE_OPTIONS} disabled={busy} onChange={setCoverage} />
          <div className="space-y-2">
            <Input
              label="Focus or study level (optional)"
              placeholder="e.g. GCSE definitions or university-level mechanisms"
              aria-describedby="source-card-focus-hint"
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              maxLength={500}
              disabled={busy}
            />
            <p id="source-card-focus-hint" className="text-xs leading-5 text-text-muted">
              Name the topics, question types or course level you want. Leave blank to cover the material at its own level.
            </p>
          </div>
          <FormDisclosure title="Topics" summary={topicIds.length ? `${topicIds.length} selected` : "Optional"}>
            <TopicPicker
              userId={userId}
              topics={topics}
              selectedTopicIds={topicIds}
              onChange={setTopicIds}
              onTopicsChange={onTopicsChange}
              disabled={busy}
            />
          </FormDisclosure>
        </Panel>
      </div>

      <Button
        size="lg"
        className="w-full sm:w-auto"
        disabled={busy || !deckId || (inputKind === "file" ? !file : !sourceText.trim())}
        onClick={() => void start()}
      >
        {!busy ? <JamiTutorIcon className="size-4" /> : null}
        {busy ? (uploadProgress ? `Uploading ${uploadProgress}%` : "Preparing…") : "Create cards"}
      </Button>
    </div>
  );
}
