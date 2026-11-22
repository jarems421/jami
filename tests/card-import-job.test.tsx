// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CardImportProgress from "@/components/decks/CardImportProgress";
import { useCardImportJob } from "@/hooks/useCardImportJob";
import type { CardImportSourceKind, VideoCardJob } from "@/lib/ai/video-card-jobs";

/**
 * A card import the student left running is picked up again by the creator
 * that owns its kind of source, and followed until it is ready.
 */

const services = vi.hoisted(() => ({
  getRecentVideoCardJobs: vi.fn(),
  getVideoCardJob: vi.fn(),
}));
vi.mock("@/services/ai/video-card-jobs", () => services);

function job(overrides: Partial<VideoCardJob>): VideoCardJob {
  return {
    id: "job-1",
    sourceKind: "file",
    status: "running",
    stage: "creating_cards",
    progress: 40,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "Chapter 2",
    drafts: [],
    warnings: [],
    evidence: [],
    ...overrides,
  } as VideoCardJob;
}

let container: HTMLDivElement;
let root: Root;

function Probe({ kinds }: { kinds: readonly CardImportSourceKind[] }) {
  const [current] = useCardImportJob(kinds);
  return (
    <output
      data-id={current?.id ?? ""}
      data-status={current?.status ?? ""}
      data-progress={current?.progress ?? ""}
    />
  );
}

const seen = () => container.querySelector("output")!.dataset;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  services.getRecentVideoCardJobs.mockReset();
  services.getVideoCardJob.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useCardImportJob", () => {
  it("picks up an unfinished import of its own kind only", async () => {
    services.getRecentVideoCardJobs.mockResolvedValue([
      job({ id: "video", sourceKind: "youtube" }),
      job({ id: "old", sourceKind: "file", status: "approved" }),
      job({ id: "notes", sourceKind: "text", status: "ready" }),
    ]);
    act(() => root.render(<Probe kinds={["file", "text"]} />));
    await flush();

    expect(seen().id).toBe("notes");
  });

  it("follows an import while it is being made, and stops once it is ready", async () => {
    services.getRecentVideoCardJobs.mockResolvedValue([job({ status: "running" })]);
    services.getVideoCardJob
      .mockResolvedValueOnce(job({ status: "running", progress: 70 }))
      .mockResolvedValueOnce(job({ status: "ready", progress: 100, stage: "ready" }));
    act(() => root.render(<Probe kinds={["file"]} />));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await flush();
    expect(seen().progress).toBe("70");

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await flush();
    expect(seen().status).toBe("ready");

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(services.getVideoCardJob).toHaveBeenCalledTimes(2);
  });
});

describe("CardImportProgress", () => {
  const labels = {
    preparing: "Preparing",
    reading_video: "Reading",
    creating_cards: "Creating cards",
    checking_cards: "Checking cards",
    ready: "Ready",
  };

  it("says why an import failed, with the way to start another", () => {
    const onTryAnother = vi.fn();
    act(() =>
      root.render(
        <CardImportProgress
          job={job({ status: "failed", failureMessage: "That file had no text." })}
          stageLabels={labels}
          onTryAnother={onTryAnother}
          onCancel={vi.fn()}
        />
      )
    );

    expect(container.textContent).toContain("That file had no text.");
    act(() => container.querySelector("button")!.click());
    expect(onTryAnother).toHaveBeenCalled();
  });

  it("shows the stage an import has reached, with the way to stop it", () => {
    const onCancel = vi.fn();
    act(() =>
      root.render(
        <CardImportProgress job={job({})} stageLabels={labels} onTryAnother={vi.fn()} onCancel={onCancel} />
      )
    );

    expect(container.textContent).toContain("Creating cards");
    expect(container.textContent).toContain("40%");
    act(() => container.querySelector("button")!.click());
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows nothing once the cards are ready", () => {
    act(() =>
      root.render(
        <CardImportProgress
          job={job({ status: "ready", stage: "ready" })}
          stageLabels={labels}
          onTryAnother={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    );

    expect(container.innerHTML).toBe("");
  });
});
