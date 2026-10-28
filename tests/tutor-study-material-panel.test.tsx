// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import TutorStudyMaterialPanel from "@/components/ai/TutorStudyMaterialPanel";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import type { TutorStudyMaterialResult } from "@/lib/ai/tutor-study-material";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  getDecks: vi.fn(),
  createDeck: vi.fn(),
  convert: vi.fn(),
  updateStatus: vi.fn(),
  getDrafts: vi.fn(),
  updatePracticeSet: vi.fn(),
}));

vi.mock("@/services/ai/tutor-study-material", () => ({
  requestTutorStudyMaterial: mocks.request,
}));
vi.mock("@/services/study/decks", () => ({
  getDecks: mocks.getDecks,
  createDeck: mocks.createDeck,
}));
vi.mock("@/services/study/generated-content", () => ({
  convertFlashcardDraftToCard: mocks.convert,
  updateGeneratedContentDraftStatus: mocks.updateStatus,
  getGeneratedContentDrafts: mocks.getDrafts,
}));
vi.mock("@/services/practice/practice-sets", () => ({
  updatePracticeSet: mocks.updatePracticeSet,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const CONTEXT = { surface: "sources", sourceIds: ["source-1"] } as JamiAssistantContext;

let container: HTMLDivElement;
let root: Root;
let onResult: Mock<(result: TutorStudyMaterialResult) => void>;

function render(props: Partial<Parameters<typeof TutorStudyMaterialPanel>[0]> = {}) {
  act(() => {
    root.render(
      <TutorStudyMaterialPanel
        userId="user-1"
        kind="flashcards"
        threadId="thread-1"
        messageId={props.messageId ?? `answer-${Math.random()}`}
        focus="separating variables"
        getContext={async () => CONTEXT}
        onResult={onResult}
        {...props}
      />
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(name: RegExp) {
  return [...container.querySelectorAll("button")].find((candidate) =>
    name.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? "")
  );
}

const flashcardResult: TutorStudyMaterialResult = {
  kind: "flashcards",
  draftIds: ["d1", "d2"],
  focus: "separating variables",
  folderId: "maths",
  createdAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  onResult = vi.fn();
  mocks.getDecks.mockResolvedValue([
    { id: "newest", name: "Everything", folderIds: [] },
    { id: "calc", name: "Calculus", folderIds: ["maths"] },
  ]);
  mocks.convert.mockResolvedValue("card");
  mocks.updateStatus.mockResolvedValue(undefined);
  mocks.updatePracticeSet.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TutorStudyMaterialPanel", () => {
  it("says flashcards are being made, then lets them be kept from the chat", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.request.mockReturnValue(new Promise((done) => (resolve = done)));

    render();
    await settle();
    expect(container.textContent).toContain("Making your flashcards");
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => {
      resolve({
        result: flashcardResult,
        drafts: [
          { id: "d1", front: "Which side does g(y) go?", back: "With dy." },
          { id: "d2", front: "What goes with dx?", back: "Terms in x only." },
        ],
      });
    });
    expect(onResult).toHaveBeenCalledWith(flashcardResult);
    render({ result: flashcardResult, messageId: "stable" });
    await settle();

    expect(container.textContent).toContain("Which side does g(y) go?");
    // The deck in the conversation's folder is chosen for them.
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("calc");

    await act(async () => {
      button(/Add all/)?.click();
    });
    await settle();

    expect(mocks.convert).toHaveBeenCalledWith("user-1", { draftId: "d1", deckId: "calc" });
    expect(mocks.convert).toHaveBeenCalledWith("user-1", { draftId: "d2", deckId: "calc" });
    expect(container.textContent).toContain("2 added to Calculus");
  });

  it("reloads a reopened chat's drafts with what was already kept", async () => {
    mocks.getDrafts.mockResolvedValue([
      { id: "d1", kind: "flashcard", front: "Kept", back: "Yes", contentStatus: "approved" },
      { id: "d2", kind: "flashcard", front: "Waiting", back: "Maybe", contentStatus: "draft" },
    ]);

    render({ result: flashcardResult, autoStart: false });
    await settle();

    expect(mocks.request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Added");
    await act(async () => {
      button(/Discard this card/)?.click();
    });
    await settle();
    expect(mocks.updateStatus).toHaveBeenCalledWith("user-1", "d2", "rejected");
  });

  it("offers a button rather than spending anything for an unfinished request in old history", async () => {
    mocks.request.mockResolvedValue({ result: flashcardResult, drafts: [] });

    render({ autoStart: false });
    await settle();
    expect(mocks.request).not.toHaveBeenCalled();

    await act(async () => {
      button(/Make flashcards/)?.click();
    });
    await settle();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("shows a failure and makes them again on request", async () => {
    mocks.request.mockRejectedValueOnce(new Error("Jami has reached today's limit for this."));

    render();
    await settle();
    expect(container.textContent).toContain("Jami has reached today's limit for this.");

    mocks.request.mockResolvedValueOnce({ result: flashcardResult, drafts: [] });
    await act(async () => {
      button(/Try again/)?.click();
    });
    await settle();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(flashcardResult);
  });

  it("lets a practice set be started, kept or dismissed from the chat", async () => {
    const result: TutorStudyMaterialResult = {
      kind: "practice",
      sessionId: "session-1",
      title: "Separating variables",
      focus: "separating variables",
      questionCount: 5,
      totalMarks: 18,
      createdAt: 1,
    };

    render({ kind: "practice", result, autoStart: false });
    await settle();

    expect(container.textContent).toContain("Practice set: Separating variables");
    expect(container.textContent).toContain("5 questions · 18 marks");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/dashboard/practice/questions/session-1");

    await act(async () => {
      button(/Save for later/)?.click();
    });
    await settle();
    expect(mocks.updatePracticeSet).toHaveBeenCalledWith("session-1", "accept");
    expect(container.textContent).toContain("Ready to practice");
  });
});
