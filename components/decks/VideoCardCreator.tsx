"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AllowanceHint from "@/components/billing/AllowanceHint";
import { notifyAllowanceSpent } from "@/services/billing/plan-summary-store";
import TopicPicker from "@/components/topics/TopicPicker";
import CardImportProgress from "@/components/decks/CardImportProgress";
import { useCardImportJob } from "@/hooks/useCardImportJob";
import { Button, Card as Panel, FileField, Input, OptionSwitch, Select, Textarea } from "@/components/ui";
import {
  VIDEO_CARD_REVIEW_CEILING,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_SECONDS,
  formatVideoTimestamp,
  type VideoCardDraft,
  type VideoCardEvidence,
  type VideoCoverage,
} from "@/lib/ai/video-card-jobs";
import type { Topic } from "@/lib/material/topics";
import type { Card } from "@/lib/study/cards";
import type { Deck } from "@/lib/study/decks";
import {
  createStorageFileId,
  deleteStorageFile,
  getStorageFileDownloadUrl,
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

/*
 * What earns a card, not how many. The counts these used to advertise were a
 * promise the video had to keep: ask a two-minute clip for 20 to 35 cards and
 * it pads or apologises. How many there are is what the video decides.
 */
const COVERAGE = [
  { value: "focused" as const, label: "Key points", detail: "Core teaching only" },
  { value: "standard" as const, label: "Standard", detail: "Core teaching and worked examples" },
  { value: "thorough" as const, label: "Thorough", detail: "Plus definitions and detail" },
];

const STAGE = {
  preparing: "Preparing",
  reading_video: "Reading video",
  creating_cards: "Creating cards",
  checking_cards: "Checking cards",
  ready: "Ready",
} as const;

async function videoDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Jami could not read that video's duration."));
    };
    video.src = url;
  });
}

/**
 * What the card was made from, in the student's own words rather than an id.
 *
 * The generator already records which moment each card came from, and used to
 * keep it entirely to itself -- so a card that looked wrong could only be
 * deleted, never checked. Showing the moment turns reviewing a batch into
 * something a person can actually do.
 */
function CardEvidence({ evidence, onSeek }: { evidence: VideoCardEvidence[]; onSeek?: (seconds: number) => void }) {
  if (!evidence.length) return null;

  return (
    <details className="mt-3 border-t border-[var(--color-border)] pt-3">
      <summary className="cursor-pointer text-xs font-medium text-text-muted transition-colors duration-fast hover:text-text-secondary">
        Where this came from
      </summary>
      <ul className="mt-3 space-y-3">
        {evidence.map((entry) => (
          <li key={entry.id} className="text-xs leading-relaxed text-text-secondary">
            <div className="flex flex-wrap items-center gap-2">
              {onSeek ? (
                <button
                  type="button"
                  onClick={() => onSeek(entry.timestampSeconds)}
                  className="app-chip rounded-full px-2 py-0.5 font-medium tabular-nums transition-colors duration-fast hover:text-text-primary"
                >
                  {formatVideoTimestamp(entry.timestampSeconds)}
                </button>
              ) : (
                <span className="app-chip rounded-full px-2 py-0.5 font-medium tabular-nums">
                  {formatVideoTimestamp(entry.timestampSeconds)}
                </span>
              )}
              {entry.visualType ? (
                <span className="text-text-muted">{entry.visualType.replace(/_/g, " ")}</span>
              ) : null}
            </div>
            <p className="mt-1.5">{entry.summary}</p>
            {entry.facts.length ? (
              <ul className="mt-1.5 space-y-1 border-l border-[var(--color-border)] pl-3 text-text-muted">
                {entry.facts.map((fact, index) => (
                  <li key={index}>{fact}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function VideoCardCreator({
  userId,
  decks,
  topics,
  defaultDeckId,
  onTopicsChange,
  onCardsCreated,
  onMessage,
}: Props) {
  const [source, setSource] = useState<"youtube" | "upload">("youtube");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [deckId, setDeckId] = useState(defaultDeckId || decks[0]?.id || "");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<VideoCoverage>("standard");
  // Blank means "as many as the video supports", which is the normal case.
  const [maxCards, setMaxCards] = useState("");
  const [focus, setFocus] = useState("");
  const [job, setJob] = useCardImportJob(["youtube", "upload"]);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const player = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setDeckId((current) => current || defaultDeckId || decks[0]?.id || "");
  }, [decks, defaultDeckId]);

  /*
   * The uploaded video is kept until the import is approved or discarded, so a
   * timestamp on a draft card is something the student can actually watch.
   * Once they approve, the object is deleted server-side and this resolves to
   * nothing -- which is the point.
   */
  const jobStoragePath = job?.storagePath;
  useEffect(() => {
    setPlaybackUrl("");
    if (!jobStoragePath) return;
    let live = true;
    void getStorageFileDownloadUrl(jobStoragePath)
      .then((resolved) => {
        if (live) setPlaybackUrl(resolved);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [jobStoragePath]);

  const evidenceById = useMemo(
    () => new Map((job?.evidence ?? []).map((entry) => [entry.id, entry])),
    [job?.evidence]
  );

  const youtubeUrl = job?.youtubeUrl;
  const seek = useCallback(
    (seconds: number) => {
      if (playbackUrl && player.current) {
        player.current.currentTime = seconds;
        void player.current.play().catch(() => undefined);
        player.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      if (youtubeUrl) {
        window.open(`${youtubeUrl}&t=${Math.floor(seconds)}s`, "_blank", "noopener,noreferrer");
      }
    },
    [playbackUrl, youtubeUrl]
  );
  const canSeek = Boolean(playbackUrl || youtubeUrl);

  const start = async () => {
    if (!deckId || (source === "youtube" ? !url.trim() : !file)) {
      onMessage("Add a video and choose a deck.", true);
      return;
    }
    setBusy(true);
    const id = createStorageFileId();
    let storagePath = "";
    try {
      let durationSeconds: number | undefined;
      if (source === "upload" && file) {
        if (file.size > VIDEO_MAX_BYTES) throw new Error("Videos must be 500 MB or smaller.");
        durationSeconds = await videoDuration(file);
        if (durationSeconds > VIDEO_MAX_SECONDS) throw new Error("Videos must be 90 minutes or shorter.");
        storagePath = `users/${userId}/videoCardImports/${id}/${sanitizeStorageFileName(file.name, "video")}`;
        await uploadStorageFile({ storagePath, file, contentType: file.type, onProgress: setUploadProgress });
      }
      const created = await createVideoCardJob({
        id,
        sourceKind: source,
        ...(source === "youtube"
          ? { youtubeUrl: url.trim() }
          : { storagePath, fileName: file?.name, durationSeconds }),
        deckId,
        topicIds,
        coverage,
        ...(maxCards.trim() ? { maxCards: Number(maxCards) } : {}),
        focus: focus.trim() || undefined,
      });
      notifyAllowanceSpent();
      setJob(created);
      onMessage("Video import started.");
    } catch (error) {
      if (storagePath) await deleteStorageFile(storagePath).catch(() => undefined);
      onMessage(error instanceof Error ? error.message : "Could not start that import.", true);
    } finally {
      setBusy(false);
      setUploadProgress(0);
    }
  };

  const update = (id: string, field: "front" | "back", value: string) =>
    setJob((current) =>
      current
        ? { ...current, drafts: current.drafts.map((card) => (card.id === id ? { ...card, [field]: value } : card)) }
        : current
    );

  const toggle = (id: string) =>
    setJob((current) =>
      current
        ? {
            ...current,
            drafts: current.drafts.map((card) => (card.id === id ? { ...card, selected: !card.selected } : card)),
          }
        : current
    );

  const approve = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await saveVideoCardDrafts(job.id, job.drafts);
      const cards = await approveVideoCardJob(job.id);
      onCardsCreated(cards);
      onMessage(`Added ${cards.length} cards.`);
      setJob(null);
      setFile(null);
      setUrl("");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Could not add those cards.", true);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await cancelVideoCardJob(job.id);
      setJob(null);
    } finally {
      setBusy(false);
    }
  };

  const renderDraft = (card: VideoCardDraft, index: number) => {
    const evidence = card.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((entry): entry is VideoCardEvidence => Boolean(entry));

    return (
      <Panel
        key={card.id}
        tone="subtle"
        padding="md"
        className={`transition-opacity duration-fast ${card.selected ? "" : "opacity-55"}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-text-muted">
            <input
              type="checkbox"
              className="accent-[var(--color-accent)]"
              checked={card.selected}
              onChange={() => toggle(card.id)}
            />
            Card {index + 1}
          </label>
          <div className="flex items-center gap-2 text-xs text-text-muted">
            {card.visualType ? (
              <span className="app-chip rounded-full px-2 py-0.5">{card.visualType.replace(/_/g, " ")}</span>
            ) : null}
            {card.timestampSeconds !== undefined ? (
              canSeek ? (
                <button
                  type="button"
                  onClick={() => seek(card.timestampSeconds ?? 0)}
                  className="app-chip rounded-full px-2 py-0.5 font-medium tabular-nums transition-colors duration-fast hover:text-text-primary"
                >
                  Watch {formatVideoTimestamp(card.timestampSeconds)}
                </button>
              ) : (
                <span className="tabular-nums">{formatVideoTimestamp(card.timestampSeconds)}</span>
              )
            ) : null}
          </div>
        </div>

        <Input
          className="mt-3"
          aria-label={`Card ${index + 1} front`}
          value={card.front}
          onChange={(event) => update(card.id, "front", event.target.value)}
        />
        <Textarea
          className="mt-3"
          aria-label={`Card ${index + 1} back`}
          rows={3}
          value={card.back}
          onChange={(event) => update(card.id, "back", event.target.value)}
        />
        <CardEvidence evidence={evidence} onSeek={canSeek ? seek : undefined} />
      </Panel>
    );
  };

  if (job) {
    const selectedCount = job.drafts.filter((card) => card.selected).length;

    return (
      <div className="mt-5 space-y-4 animate-fade-in">
        <CardImportProgress
          job={job}
          stageLabels={STAGE}
          onTryAnother={() => setJob(null)}
          onCancel={() => void cancel()}
        />

        {job.status === "ready" ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-text-primary">{job.title}</p>
                <p className="mt-1 text-xs text-text-muted">
                  {selectedCount} of {job.drafts.length} selected
                </p>
              </div>
              <Button variant="ghost" onClick={() => void cancel()}>
                Discard
              </Button>
            </div>

            {playbackUrl ? (
              // No caption track exists to offer: this is the student's own
              // upload, played back only so a timestamp on a draft card can be
              // checked, and deleted as soon as the import is approved.
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                ref={player}
                src={playbackUrl}
                controls
                preload="metadata"
                className="w-full rounded-2xl border border-[var(--color-border)] bg-black"
              />
            ) : null}

            {job.warnings.length ? (
              <ul className="space-y-2">
                {job.warnings.map((warning) => (
                  <li
                    key={warning.id}
                    className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-text-secondary"
                  >
                    {warning.message}
                    {warning.timestampSeconds !== undefined ? (
                      <>
                        {" · "}
                        <span className="tabular-nums">{formatVideoTimestamp(warning.timestampSeconds)}</span>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="space-y-3">{job.drafts.map(renderDraft)}</div>

            <p className="text-xs text-text-muted">
              Adding these keeps only the questions and answers. The video and its timestamps are deleted.
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
    <div className="mt-5 space-y-4 animate-fade-in">
      <div className="flex gap-2">
        <Button variant={source === "youtube" ? "secondary" : "ghost"} onClick={() => setSource("youtube")}>
          YouTube link
        </Button>
        <Button variant={source === "upload" ? "secondary" : "ghost"} onClick={() => setSource("upload")}>
          Upload
        </Button>
      </div>

      {source === "youtube" ? (
        <Input
          label="YouTube link"
          placeholder="https://youtube.com/watch?v=…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      ) : (
        <FileField
          label="Video file"
          hint="MP4, MOV, WebM or MPEG, up to 500 MB and 90 minutes"
          accept="video/mp4,video/quicktime,video/webm,video/mpeg"
          file={file}
          disabled={busy}
          onChange={setFile}
        />
      )}

      {!defaultDeckId ? (
        <Select label="Deck" value={deckId} onChange={(event) => setDeckId(event.target.value)}>
          <option value="" disabled>
            Choose a deck
          </option>
          {decks.map((deck) => (
            <option key={deck.id} value={deck.id}>
              {deck.name}
            </option>
          ))}
        </Select>
      ) : null}

      <OptionSwitch label="Coverage" value={coverage} options={COVERAGE} disabled={busy} onChange={setCoverage} />

      <Input
        label="Most cards to make (optional)"
        type="number"
        min={1}
        max={VIDEO_CARD_REVIEW_CEILING}
        inputMode="numeric"
        placeholder="As many as the video supports"
        value={maxCards}
        disabled={busy}
        onChange={(event) => setMaxCards(event.target.value)}
      />

      <Input
        label="Focus (optional)"
        placeholder="e.g. causes and consequences"
        value={focus}
        onChange={(event) => setFocus(event.target.value)}
        maxLength={500}
      />

      <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-text-secondary">
          Topics <span className="font-normal text-text-muted">(optional)</span>
        </summary>
        <div className="mt-4">
          <TopicPicker
            userId={userId}
            topics={topics}
            selectedTopicIds={topicIds}
            onChange={setTopicIds}
            onTopicsChange={onTopicsChange}
            disabled={busy}
          />
        </div>
      </details>

      <Button size="lg" disabled={busy || !deckId} onClick={() => void start()}>
        {busy ? (uploadProgress ? `Uploading ${uploadProgress}%` : "Preparing…") : "Create cards"}
      </Button>
      <AllowanceHint allowance="videos" mode="low" />
    </div>
  );
}
