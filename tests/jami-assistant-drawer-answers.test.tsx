// @vitest-environment jsdom

/*
 * Everything under an answer: where it came from, what it offers to make or
 * do, pictures and graphs for the page, pinning it beside the page, and what
 * a chat begun somewhere else is not allowed to do here.
 *
 * Written against the drawer before it was split into hooks and smaller
 * components, so the split could be checked against what it already did.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JamiAssistantDrawer from "@/components/ai/JamiAssistantDrawer";
import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";
import {
  getJamiAssistantContextKey,
  type JamiAssistantStoredMessage,
  type JamiAssistantThread,
} from "@/lib/ai/jami-assistant-history";
import type { NotebookGraphDraft } from "@/lib/workspace/notebook-graphs";
import type { TutorAttachment } from "@/lib/ai/tutor-attachments";

const GRAPH: NotebookGraphDraft = {
  view: { xMin: -5, xMax: 5, yMin: -5, yMax: 5 },
  showGrid: true,
  series: [],
};

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getThreads: vi.fn(),
  getThreadMessages: vi.fn(),
  createIllustration: vi.fn(),
  insertIllustration: vi.fn(),
  loadIllustrationBlob: vi.fn(),
  requestStudyMaterial: vi.fn(),
  noteOutcome: vi.fn(),
  createDeck: vi.fn(),
  createNotebook: vi.fn(),
  drawnFigureToPng: vi.fn(),
}));

vi.mock("@/services/ai/jami-assistant", () => ({ sendJamiAssistantMessage: mocks.send }));

vi.mock("@/services/ai/jami-assistant-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/jami-assistant-history")>()),
  getJamiAssistantThreads: mocks.getThreads,
  getJamiAssistantThreadMessages: mocks.getThreadMessages,
}));

vi.mock("@/services/firebase/client", () => ({
  auth: { currentUser: { uid: "user-1", getIdToken: async () => "token" } },
}));

vi.mock("@/services/profile", () => ({
  loadReasoningEffort: vi.fn().mockResolvedValue("medium"),
  saveReasoningEffort: vi.fn().mockResolvedValue("medium"),
}));

vi.mock("@/services/ai/ai-privacy-notice", () => ({
  hasAcknowledgedAiPrivacyNotice: vi.fn().mockResolvedValue(true),
  acknowledgeAiPrivacyNotice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/ai/assistant-illustrations", () => ({
  createAssistantIllustration: mocks.createIllustration,
  insertAssistantIllustration: mocks.insertIllustration,
  loadAssistantIllustrationBlob: mocks.loadIllustrationBlob,
}));

vi.mock("@/services/ai/tutor-study-material", () => ({
  requestTutorStudyMaterial: mocks.requestStudyMaterial,
}));
vi.mock("@/services/study/generated-content", () => ({
  getGeneratedContentDrafts: vi.fn().mockResolvedValue([]),
  createFlashcardDraft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/practice/practice-sets", () => ({ updatePracticeSet: vi.fn() }));
vi.mock("@/services/learning/study-action-events", () => ({ noteStudyActionOutcomeById: mocks.noteOutcome }));
vi.mock("@/services/ai/tutor-app-actions", () => ({
  createDeckFromTutor: mocks.createDeck,
  createNotebookFromTutor: mocks.createNotebook,
}));
vi.mock("@/services/ai/tutor-attachments", () => ({
  uploadTutorAttachment: vi.fn(),
  discardTutorAttachment: vi.fn(),
  getTutorAttachmentUrl: vi.fn(() => new Promise(() => undefined)),
  saveTutorAttachmentAsSource: vi.fn(),
}));
vi.mock("@/services/study/folders", () => ({ getActiveStudyFolders: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/ai/drawn-figure-image", () => ({ drawnFigureToPng: mocks.drawnFigureToPng }));
vi.mock("@/components/billing/AllowanceHint", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- a stand-in for next/image
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

/*
 * The markdown renderer, stubbed: it shows the text, and offers the graph
 * actions the drawer provides, the way a graph or drawn figure in a real
 * answer would.
 */
vi.mock("@/components/ai/AiResponse", async () => {
  const { useAssistantGraphActions } = await import("@/components/ai/AssistantGraphActions");
  function AiResponseStub({ content }: { content: string }) {
    const actions = useAssistantGraphActions();
    return (
      <div data-ai-response>
        {content}
        {actions?.canInsert ? (
          <button type="button" onClick={() => actions.insert("graph-1", GRAPH)}>
            {actions.isInserted("graph-1")
              ? "Graph added"
              : actions.insertingKey === "graph-1"
                ? "Adding graph"
                : "Add graph"}
          </button>
        ) : null}
        {actions?.canInsertDrawing ? (
          <button type="button" onClick={() => actions.insertDrawing("drawing-1", "<svg></svg>")}>
            {actions.isInserted("drawing-1") ? "Drawing added" : "Add drawing"}
          </button>
        ) : null}
      </div>
    );
  }
  return { default: AiResponseStub };
});

const CONTEXT: JamiAssistantContext = { surface: "notebook", notebookId: "notebook-1", pageId: "page-1" };
const CONTEXT_KEY = getJamiAssistantContextKey(CONTEXT);
const SOURCES_CONTEXT: JamiAssistantContext = { surface: "sources", sourceIds: ["source-1"] };

let container: HTMLDivElement;
let root: Root;
let getContext: ReturnType<typeof vi.fn<() => Promise<JamiAssistantContext>>>;

type DrawerProps = Partial<Parameters<typeof JamiAssistantDrawer>[0]>;

function drawer(props: DrawerProps = {}) {
  return (
    <JamiAssistantDrawer
      userId="user-1"
      open
      onOpenChange={vi.fn()}
      resetKey="reset-1"
      contextKey={CONTEXT_KEY}
      contextLabel="Current notebook page"
      historyContextLabel="Biology notebook"
      getContext={getContext}
      {...props}
    />
  );
}

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function field() {
  const el = document.querySelector<HTMLTextAreaElement>("#jami-assistant-message");
  if (!el) throw new Error("no message field");
  return el;
}

function typeMessage(text: string) {
  const el = field();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string | RegExp) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
    const name = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
}

function buttons(label: string | RegExp) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) => {
    const name = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
}

async function click(target: Element | undefined | null) {
  if (!target) throw new Error("nothing to click");
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function ask(text: string) {
  typeMessage(text);
  await click(button("Send message to Jami"));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function bodyText() {
  return document.body.textContent ?? "";
}

let threadCounter = 0;
/** A saved chat with a fresh answer id, so per-answer work never carries between tests. */
function savedThread(over: Partial<JamiAssistantThread> = {}): JamiAssistantThread {
  threadCounter += 1;
  return {
    id: "thread-1",
    title: "Enzymes",
    surface: "notebook",
    contextKey: CONTEXT_KEY,
    contextLabel: "Biology notebook",
    context: { surface: "notebook", notebookId: "notebook-1", pageId: "page-1" },
    lastMessagePreview: "",
    messageCount: 2,
    createdAt: 1,
    updatedAt: 1,
    lastAssistantMessageId: `answer-${threadCounter}`,
    ...over,
  };
}

function stored(over: Partial<JamiAssistantStoredMessage> & Pick<JamiAssistantStoredMessage, "id" | "role" | "text">): JamiAssistantStoredMessage {
  return { threadId: "thread-saved", createdAt: 1, ...over };
}

const SHEET: TutorAttachment = {
  storagePath: "users/user-1/sourceFiles/chat/sheet.pdf",
  fileName: "sheet.pdf",
  fileType: "application/pdf",
  sizeBytes: 1_000,
};

const OFFER = {
  actionId: "practice-offer-1",
  reason: "weak",
  target: { kind: "topic", topicKey: "topic:enzymes", label: "Enzymes", source: "student-topic" },
  scope: { folderId: "folder-1" },
  title: "Practice enzymes",
  description: "Five questions on enzymes.",
  label: "Start practice",
  href: "/dashboard/practice/enzymes",
};

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  stubMatchMedia(false);
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  mocks.send.mockReset();
  mocks.getThreads.mockReset().mockResolvedValue([]);
  mocks.getThreadMessages.mockReset().mockResolvedValue([]);
  mocks.createIllustration.mockReset();
  mocks.insertIllustration.mockReset();
  mocks.loadIllustrationBlob.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  mocks.requestStudyMaterial.mockReset().mockReturnValue(new Promise(() => undefined));
  mocks.drawnFigureToPng.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:visual");
  URL.revokeObjectURL = vi.fn();
  getContext = vi.fn<() => Promise<JamiAssistantContext>>().mockResolvedValue(CONTEXT);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("JamiAssistantDrawer under an answer", () => {
  it("says where the answer came from, links its web sources, and offers cards and a source to keep", async () => {
    mocks.send.mockResolvedValueOnce({
      reply: "Enzymes lower activation energy.",
      used: [
        { kind: "source", label: "Cells notes" },
        { kind: "web", label: "BBC Bitesize" },
      ],
      citations: [{ title: "Enzymes - BBC Bitesize", url: "https://example.org/enzymes" }],
      suggestedCards: [
        { front: "What do enzymes lower?", back: "Activation energy", sourceId: "source-1", sourceTitle: "Cells notes", topicIds: [] },
      ],
      sourceSaveOffer: { attachment: SHEET, title: "Rates sheet" },
    });
    await render(drawer({ settingsFolderIds: ["folder-1"] }));
    await ask("What do enzymes do?");

    expect(bodyText()).toContain("Used: Cells notes and BBC Bitesize");
    const links = [...document.querySelectorAll<HTMLAnchorElement>("[aria-label='Web sources'] a")];
    expect(links.map((link) => [link.textContent, link.href, link.target, link.rel])).toEqual([
      ["Enzymes - BBC Bitesize", "https://example.org/enzymes", "_blank", "noreferrer"],
    ]);
    expect(bodyText()).toContain("What do enzymes lower?");
    expect(bodyText()).toContain("Save as a source");
  });

  it("shows what Jami is looking up while it works, then what it looked up above the answer", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.send.mockImplementationOnce(
      (_input: unknown, _onChunk: unknown, _signal: unknown, onStep: (step: unknown) => void) => {
        onStep({ tool: "search_sources", doing: "Searching your material for “enzymes”", done: "Searched your material for “enzymes”" });
        onStep({ tool: "work_out", doing: "Working it through separately to check", done: "Worked it through separately to check" });
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    );
    await render(drawer());
    await ask("What do enzymes do?");

    // The one under way is the waiting line; the one before it is ticked off above.
    expect(document.querySelector("[role='status']")?.textContent).toContain("Searched your material for “enzymes”");
    expect(document.querySelector("[role='status']")?.textContent).toContain("Working it through separately to check");

    await act(async () => {
      finish({
        reply: "Enzymes lower activation energy.",
        used: [{ kind: "general-knowledge", label: "general knowledge" }],
        agentSteps: [
          { tool: "search_sources", label: "Searched your material for “enzymes”" },
          { tool: "work_out", label: "Worked it through separately to check" },
        ],
      });
    });
    await settle();
    expect(document.querySelector("[role='status']")).toBeNull();
    expect(bodyText()).toContain("Looked into 2 things first");
  });

  it("offers the engine's practice once per chat, and the next step on the answer that asked", async () => {
    mocks.send.mockResolvedValueOnce({ reply: "First.", used: [], practiceOffer: OFFER });
    await render(drawer());
    await ask("Explain enzymes");
    mocks.send.mockResolvedValueOnce({
      reply: "Second.",
      used: [],
      practiceOffer: OFFER,
      nextStepOffer: { ...OFFER, actionId: "next-step-1", title: "Review denaturation" },
    });
    await ask("What should I do next?");

    expect(document.querySelectorAll("section[aria-label='Exam practice']")).toHaveLength(1);
    const next = document.querySelectorAll("section[aria-label='Your next step']");
    expect(next).toHaveLength(1);
    expect(next[0]?.textContent).toContain("Review denaturation");
    expect(next[0]?.textContent).toContain("Your next step");
  });

  it("does what was asked in the app, offers the rest, and adds pages only in a notebook", async () => {
    const addPages = vi.fn().mockResolvedValue(2);
    mocks.send.mockResolvedValueOnce({
      reply: "Added two pages and here is your deck.",
      used: [],
      appActions: [
        { type: "add_pages", count: 2, autoRun: true },
        { type: "create_deck", name: "Enzymes", autoRun: false },
        { type: "open", destination: "flashcards", label: "Flashcards", href: "/dashboard/decks", autoRun: false },
      ],
      appScope: { notebookId: "notebook-1" },
      savedThread: savedThread(),
    });
    await render(drawer({ onAddNotebookPages: addPages }));
    await ask("Add two pages please");
    await settle();

    expect(addPages).toHaveBeenCalledWith(2);
    expect(bodyText()).toContain("Added 2 pages to the end of this notebook.");
    expect(button("Make deck “Enzymes”")).toBeDefined();
    expect(mocks.createDeck).not.toHaveBeenCalled();
    expect(document.querySelector("a[href='/dashboard/decks']")?.textContent).toContain("Flashcards");
  });

  it("does not add pages outside a notebook, even when a surface could", async () => {
    const addPages = vi.fn().mockResolvedValue(2);
    getContext.mockResolvedValue(SOURCES_CONTEXT);
    mocks.send.mockResolvedValueOnce({
      reply: "Here.",
      used: [],
      appActions: [
        { type: "add_pages", count: 2, autoRun: true },
        { type: "open", destination: "flashcards", label: "Flashcards", href: "/dashboard/decks", autoRun: false },
      ],
      appScope: {},
      savedThread: savedThread({ contextKey: getJamiAssistantContextKey(SOURCES_CONTEXT) }),
    });
    await render(drawer({ contextKey: getJamiAssistantContextKey(SOURCES_CONTEXT), onAddNotebookPages: addPages }));
    await ask("Add two pages");
    await settle();
    expect(addPages).not.toHaveBeenCalled();
    expect(bodyText()).not.toContain("Add 2 pages");
    expect(document.querySelector("a[href='/dashboard/decks']")).not.toBeNull();
  });

  it("shows app actions only on an answer that was saved", async () => {
    mocks.send.mockResolvedValueOnce({
      reply: "Here.",
      used: [],
      appActions: [{ type: "open", destination: "flashcards", label: "Flashcards", href: "/dashboard/decks", autoRun: false }],
      appScope: {},
    });
    await render(drawer());
    await ask("Where are my decks?");
    expect(document.querySelector("a[href='/dashboard/decks']")).toBeNull();
  });

  it("makes a visual on a press, and offers it on the page", async () => {
    const thread = savedThread();
    let finish: (value: unknown) => void = () => undefined;
    mocks.createIllustration.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    mocks.insertIllustration.mockResolvedValueOnce({ imageRef: { id: "img-1" }, contentRevision: 4 });
    const onBefore = vi.fn().mockResolvedValue(true);
    const onInserted = vi.fn();
    mocks.send.mockResolvedValueOnce({ reply: "The heart has four chambers.", used: [], canIllustrate: true, savedThread: thread });
    await render(drawer({ onBeforeIllustrationInsert: onBefore, onIllustrationInserted: onInserted }));
    await ask("How many chambers?");

    await click(button("Show visually"));
    expect(mocks.createIllustration).toHaveBeenCalledWith({
      threadId: "thread-1",
      messageId: thread.lastAssistantMessageId,
      context: CONTEXT,
    });
    expect(button("Creating visual...")?.disabled).toBe(true);

    const illustration = {
      kind: "image",
      id: "visual-1",
      storagePath: "users/user-1/visuals/visual-1.png",
      mimeType: "image/png",
      altText: "A heart with four chambers",
      caption: "The four chambers",
      createdAt: 1,
    };
    await act(async () => finish(illustration));
    await settle();
    expect(button("Show visually")).toBeUndefined();
    expect(bodyText()).toContain("The four chambers");

    await click(button("Add to page"));
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(mocks.insertIllustration).toHaveBeenCalledWith({
      illustration,
      messageId: thread.lastAssistantMessageId,
      notebookId: "notebook-1",
      pageId: "page-1",
    });
    expect(onInserted).toHaveBeenCalledWith({ imageRef: { id: "img-1" }, contentRevision: 4 });
    expect(button("Added to page")).toBeDefined();
  });

  it("will not put a visual on a page that has not saved", async () => {
    mocks.createIllustration.mockResolvedValueOnce({
      kind: "image",
      id: "visual-2",
      storagePath: "users/user-1/visuals/visual-2.png",
      mimeType: "image/png",
      altText: "A cell",
      caption: "A cell",
      createdAt: 1,
    });
    mocks.send.mockResolvedValueOnce({ reply: "A cell.", used: [], canIllustrate: true, savedThread: savedThread() });
    await render(drawer({ onBeforeIllustrationInsert: () => false, onIllustrationInserted: vi.fn() }));
    await ask("What is a cell?");
    await click(button("Show visually"));
    await settle();
    await click(button("Add to page"));
    expect(mocks.insertIllustration).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Save this page before adding the visual.");
  });

  it("draws straight away when a picture was asked for, and reports a failure", async () => {
    const thread = savedThread();
    mocks.createIllustration.mockRejectedValueOnce(new Error("The visual could not be drawn."));
    mocks.send.mockResolvedValueOnce({ reply: "Here is the heart.", used: [], canIllustrate: true, savedThread: thread });
    await render(drawer());
    await ask("Draw a diagram of the heart");
    await settle();
    expect(mocks.createIllustration).toHaveBeenCalledWith({
      threadId: "thread-1",
      messageId: thread.lastAssistantMessageId,
      context: CONTEXT,
    });
    expect(document.querySelector("[role='alert']")?.textContent).toContain("The visual could not be drawn.");
  });

  it("adds a graph or a drawn figure from an answer to the notebook page", async () => {
    const onGraphInsert = vi.fn().mockResolvedValue(true);
    const onDrawingInsert = vi.fn().mockResolvedValue(true);
    const png = new File(["png"], "figure.png", { type: "image/png" });
    mocks.drawnFigureToPng.mockResolvedValueOnce(png);
    mocks.send.mockResolvedValueOnce({ reply: "Plot y = x^2.", used: [] });
    await render(drawer({ onGraphInsert, onDrawingInsert }));
    await ask("Graph it");

    await click(button("Add graph"));
    expect(onGraphInsert).toHaveBeenCalledWith(GRAPH);
    await settle();
    expect(button("Graph added")).toBeDefined();

    await click(button("Add drawing"));
    await settle();
    expect(mocks.drawnFigureToPng).toHaveBeenCalledWith("<svg></svg>");
    expect(onDrawingInsert).toHaveBeenCalledWith(png);
    expect(button("Drawing added")).toBeDefined();
  });

  it("reports a drawn figure that could not be turned into a picture", async () => {
    mocks.drawnFigureToPng.mockRejectedValueOnce(new Error("That figure is too large."));
    mocks.send.mockResolvedValueOnce({ reply: "A figure.", used: [] });
    await render(drawer({ onDrawingInsert: vi.fn() }));
    await ask("Sketch it");
    await click(button("Add drawing"));
    await settle();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("That figure is too large.");
  });

  it("offers no graph button where there is no page to add to", async () => {
    getContext.mockResolvedValue(SOURCES_CONTEXT);
    mocks.send.mockResolvedValueOnce({ reply: "Plot it.", used: [] });
    await render(drawer({ contextKey: getJamiAssistantContextKey(SOURCES_CONTEXT), onGraphInsert: vi.fn(), onDrawingInsert: vi.fn() }));
    await ask("Graph it");
    expect(button("Add graph")).toBeUndefined();
    expect(button("Add drawing")).toBeUndefined();
  });

  it("asks what to make first, then makes it with the student's choice", async () => {
    const thread = savedThread();
    mocks.send.mockResolvedValueOnce({
      reply: "Happy to make flashcards. What should they be on?",
      used: [],
      studyMaterialSetup: { kind: "flashcards", kinds: ["flashcards"], topics: ["Osmosis", "Diffusion"] },
      savedThread: thread,
    });
    await render(drawer());
    await ask("Make me some flashcards");
    expect(bodyText()).toContain("What should they be on?");

    await click(button("Osmosis"));
    const make = buttons(/^Make \d+ flashcards$/)[0];
    await act(async () => {
      make?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(bodyText()).not.toContain("Pick a topic or type your own.");
    expect(mocks.requestStudyMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        messageId: thread.lastAssistantMessageId,
        kind: "flashcards",
        context: CONTEXT,
        choice: expect.objectContaining({ focus: "Osmosis" }),
      })
    );
  });

  it("confirms an answer added to the page for a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubMatchMedia(true);
    const onAnswerInsert = vi.fn(() => true);
    mocks.send.mockResolvedValueOnce({ reply: "An answer.", used: [] });
    await render(drawer({ layout: "floating", onAnswerInsert }));
    await ask("A question");
    await click(button("Add this answer to the page"));
    expect(button("Answer added to page")).toBeDefined();
    await act(async () => vi.advanceTimersByTime(2_400));
    expect(button("Answer added to page")).toBeUndefined();
    expect(button("Add this answer to the page")).toBeDefined();
  });

  it("puts the words around a sketch on the page once a visual replaced it", async () => {
    stubMatchMedia(true);
    const onAnswerInsert = vi.fn(() => true);
    mocks.createIllustration.mockResolvedValueOnce({
      kind: "diagram",
      id: "diagram-1",
      svg: "<svg></svg>",
      altText: "A lever",
      caption: "A lever",
      createdAt: 1,
    });
    mocks.send.mockResolvedValueOnce({
      reply: "Before the sketch.\n\n```svg\n<svg></svg>\n```\n\nAfter the sketch.",
      used: [],
      canIllustrate: true,
      savedThread: savedThread(),
    });
    await render(drawer({ layout: "floating", onAnswerInsert }));
    await ask("Explain levers");
    await click(button("Show visually"));
    await settle();
    await click(button("Add this answer to the page"));
    expect(onAnswerInsert).toHaveBeenCalledWith("Before the sketch.\n\nAfter the sketch.");
  });
});

describe("JamiAssistantDrawer carrying on a chat from elsewhere", () => {
  const messagesWithEverything = (threadId: string, answerId: string) => [
    stored({ id: `${answerId}-q`, role: "user", text: "Old question", threadId }),
    stored({
      id: answerId,
      role: "assistant",
      text: "Old answer.",
      threadId,
      canIllustrate: true,
      studyMaterialSetup: { kind: "flashcards", kinds: ["flashcards"], topics: ["Osmosis"] },
      appActions: [{ type: "create_deck", name: "Osmosis", autoRun: false }],
      appScope: {},
      followUps: [{ label: "Explain more", prompt: "Explain more." }],
    }),
  ];

  async function openSaved(thread: JamiAssistantThread, contextControls?: () => ReactNode) {
    mocks.getThreads.mockResolvedValue([thread]);
    mocks.getThreadMessages.mockResolvedValue(messagesWithEverything(thread.id, `${thread.id}-answer`));
    stubMatchMedia(true);
    // A wide card, so its own actions sit in the header rather than a menu.
    localStorage.setItem(
      "jami:tutor-card:v1",
      JSON.stringify({ rect: { x: 20, y: 20, width: 600, height: 600 }, maximised: false })
    );
    await render(
      drawer({
        layout: "floating",
        onAnswerInsert: vi.fn(() => true),
        onGraphInsert: vi.fn(),
        onDrawingInsert: vi.fn(),
        contextControls,
      })
    );
    await settle();
    await click(button("Open Jami chat history"));
    const open = [...document.querySelectorAll<HTMLButtonElement>("section[aria-label='Jami chat history'] button")].find(
      (candidate) => candidate.textContent?.startsWith(thread.title)
    );
    await click(open);
  }

  it("acts on an answer from this place", async () => {
    const controls = vi.fn(() => <p data-controls>controls</p>);
    await openSaved(savedThread({ id: "thread-here", title: "Here chat" }), controls);
    expect(bodyText()).toContain("Old answer.");
    expect(button("Add this answer to the page")).toBeDefined();
    expect(button("Show visually")).toBeDefined();
    expect(bodyText()).toContain("What should they be on?");
    expect(button("Make deck “Osmosis”")).toBeDefined();
    expect(button("Add graph")).toBeDefined();
    expect(button("Explain more")).toBeDefined();
    expect(document.querySelector("[data-controls]")).not.toBeNull();
  });

  it("only reads an answer from somewhere else", async () => {
    const controls = vi.fn(() => <p data-controls>controls</p>);
    await openSaved(
      savedThread({
        id: "thread-away",
        title: "Away chat",
        surface: "learn",
        contextKey: "learn:card-9",
        contextLabel: "Mitosis flashcard",
        context: { surface: "learn", cardId: "card-9" },
      }),
      controls
    );
    expect(bodyText()).toContain("Old answer.");
    expect(button("Add this answer to the page")).toBeUndefined();
    expect(button("Show visually")).toBeUndefined();
    expect(bodyText()).not.toContain("What should they be on?");
    expect(button("Make deck “Osmosis”")).toBeUndefined();
    expect(button("Add graph")).toBeUndefined();
    expect(button("Add drawing")).toBeUndefined();
    // Asking more is still fine; it carries the chat on here.
    expect(button("Explain more")).toBeDefined();
    expect(document.querySelector("[data-controls]")).toBeNull();
    expect(bodyText()).toContain("This chat started on your flashcards (Mitosis flashcard).");
  });
});

describe("JamiAssistantDrawer answers beside the page", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  beforeEach(() => {
    stubMatchMedia(true);
    onOpenChange = vi.fn<(open: boolean) => void>();
  });

  function floating(open: boolean) {
    return drawer({ layout: "floating", open, onOpenChange, onAnswerInsert: vi.fn(() => true) });
  }

  const pinnedTexts = () =>
    [...document.querySelectorAll("[aria-label='Pinned answer from Jami'] [data-ai-response]")].map(
      (node) => node.textContent
    );

  it("keeps up to three answers, the oldest making way for a fourth", async () => {
    await render(floating(true));
    for (const turn of [1, 2, 3, 4]) {
      mocks.send.mockResolvedValueOnce({ reply: `Answer ${turn}`, used: [] });
      await ask(`Question ${turn}`);
    }
    const pins = buttons("Keep beside page");
    expect(pins).toHaveLength(4);
    await click(pins[0]);
    await click(pins[0]);
    expect(pinnedTexts()).toEqual(["Answer 1"]);
    await click(pins[1]);
    await click(pins[2]);
    expect(pinnedTexts()).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
    await click(pins[3]);
    expect(pinnedTexts()).toHaveLength(3);
    expect(pinnedTexts()).toEqual(expect.arrayContaining(["Answer 2", "Answer 3", "Answer 4"]));

    // Put away, only the newest pin carries the way back, and no pill repeats it.
    await render(floating(false));
    expect(buttons(/^Open chat/)).toHaveLength(1);
    expect(button("Open Jami")).toBeUndefined();
    await click(buttons(/^Open chat/)[0]);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("offers nothing to add or pin on the answer still being written", async () => {
    let onChunk: (text: string) => void = () => undefined;
    let finish: (value: unknown) => void = () => undefined;
    mocks.send.mockImplementationOnce(
      (_input: unknown, chunk: (text: string) => void) =>
        new Promise((resolve) => {
          onChunk = chunk;
          finish = resolve;
        })
    );
    await render(floating(true));
    await ask("Go on");
    await act(async () => onChunk("Half an"));
    expect(button("Keep beside page")).toBeUndefined();
    expect(button("Add this answer to the page")).toBeUndefined();
    expect(document.querySelector("[data-answer-hold='true']")).toBeNull();

    await act(async () => finish({ reply: "Half an answer, now whole.", used: [] }));
    expect(button("Keep beside page")).toBeDefined();
    expect(button("Add this answer to the page")).toBeDefined();
    expect(document.querySelector("[data-answer-hold='true']")).not.toBeNull();
  });

  it("steps its footer back on a small card", async () => {
    await render(floating(true));
    expect(bodyText()).toContain("Jami can make mistakes. Check important answers.");
    expect(bodyText()).not.toContain("Folder sources on");
    expect(field().rows).toBe(1);
  });

  it("names what it is looking at, or the history, in its header", async () => {
    await render(floating(true));
    expect(bodyText()).toContain("Current notebook page");
  });
});
