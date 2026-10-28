import type { JamiAssistantContext } from "@/lib/ai/jami-assistant";

/**
 * What Tutor knows about Jami itself, and the few things it can do in it.
 *
 * Tutor used to know nothing about the app it lives in, so "where do I make
 * flashcards?" got a guess, and "add ten pages" got an apology. It now has a
 * short guide to where things are, a list of places it can link to, and a
 * fixed menu of actions the app carries out -- never anything the model makes
 * up. Every link and action is checked here against that list before a student
 * can press it.
 */

/** Somewhere in Jami that Tutor can send a student. */
export type JamiDestination = {
  key: string;
  label: string;
  href: string;
};

/** What the current conversation sits in, for links and actions that need it. */
export type JamiAppScope = {
  folderId?: string;
  deckId?: string;
  notebookId?: string;
};

const STATIC_DESTINATIONS: readonly JamiDestination[] = [
  { key: "today", label: "Today", href: "/dashboard" },
  { key: "learn", label: "Learn", href: "/dashboard/study" },
  { key: "flashcards", label: "Flashcards", href: "/dashboard/decks" },
  { key: "all_cards", label: "All cards", href: "/dashboard/cards" },
  { key: "practice", label: "Practice", href: "/dashboard/practice" },
  { key: "exam_questions", label: "Past Paper Practice", href: "/dashboard/practice/questions/new" },
  { key: "practice_history", label: "Practice history", href: "/dashboard/practice/history" },
  { key: "practice_paper", label: "Build a practice paper", href: "/dashboard/practice/new" },
  { key: "sources", label: "Sources", href: "/dashboard/library" },
  { key: "jami", label: "Jami", href: "/dashboard/tutor" },
  { key: "revision_plan", label: "Revision plan", href: "/dashboard/tutor/plan" },
  { key: "revision_session", label: "Start a revision session", href: "/dashboard/revision/start" },
  { key: "personalise_jami", label: "Your Jami", href: "/dashboard/tutor/personalise" },
  { key: "topics", label: "Topics", href: "/dashboard/topics" },
  { key: "goals", label: "Goals", href: "/dashboard/goals" },
  { key: "stars", label: "Stars", href: "/dashboard/constellation" },
  { key: "progress", label: "Progress", href: "/dashboard/progress" },
  { key: "practice_progress", label: "Practice progress", href: "/dashboard/progress/practice" },
  { key: "account", label: "Account", href: "/dashboard/profile" },
  { key: "appearance", label: "Personalise appearance", href: "/dashboard/profile/personalise" },
];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * Every place Tutor may link to in this conversation: the app's own pages,
 * and the folder, deck or notebook the conversation is about.
 */
export function jamiDestinations(scope: JamiAppScope = {}): JamiDestination[] {
  const destinations = [...STATIC_DESTINATIONS];
  const folderId = scope.folderId && ID_PATTERN.test(scope.folderId) ? scope.folderId : "";
  const deckId = scope.deckId && ID_PATTERN.test(scope.deckId) ? scope.deckId : "";
  const notebookId = scope.notebookId && ID_PATTERN.test(scope.notebookId) ? scope.notebookId : "";
  if (folderId) {
    const id = encodeURIComponent(folderId);
    destinations.push(
      { key: "this_folder", label: "This folder", href: `/dashboard/folders/${id}` },
      { key: "this_folder_exam_questions", label: "Past paper questions for this folder", href: `/dashboard/practice/questions/new?folderId=${id}` },
      { key: "this_folder_revision", label: "Revise this folder", href: `/dashboard/revision/start?folder=${id}` }
    );
  }
  if (deckId) {
    const id = encodeURIComponent(deckId);
    destinations.push(
      { key: "this_deck", label: "This deck", href: `/dashboard/decks/${id}` },
      { key: "study_this_deck", label: "Study this deck", href: `/dashboard/study?mode=custom&decks=${id}` }
    );
  }
  if (notebookId) {
    destinations.push({
      key: "this_notebook",
      label: "This notebook",
      href: `/dashboard/notebooks/${encodeURIComponent(notebookId)}`,
    });
  }
  return destinations;
}

/**
 * Where Jami's things are and how to do them, as a student sees them.
 *
 * Written from the app's own labels, so Tutor can name the button a student is
 * looking for. Kept short: it rides on every Tutor request.
 */
export const JAMI_APP_GUIDE = `HOW JAMI WORKS (the app you are part of; use it when the student asks how to do something in Jami, or where something is)
Sidebar: Study -- Today, Learn, Practice, Jami. Workspace -- Flashcards, Topics, Goals, Stars, Progress, Account.
- Today: what to do now. "Jami suggests" gives one main next step (start review, continue a notebook, review drafts, set a goal...), plus "Any time today".
- Learn: review flashcards. "Start Daily Review" for what is due; "Focused Review" ("Choose decks or Topics", then "Start Focused Review"); "Simple Study" for one quick pass. "How to study" picks Classic, Smart Mix, Type Answer, Gap Fill or Multiple Choice. During a card, the "Jami" button asks about it.
- Flashcards: "Decks" and "All cards". Make a deck: "New deck", type a name, "Create deck". Add cards on a deck's page or All cards under "Add cards": "Single card" (Front, Back, "Add card"), "Diagram" (cover the labels on a picture), "From notes or file" and "From video" (Jami drafts cards to review, then "Add selected cards"). "Import cards" brings in an Anki deck. Each deck has "Study", "Add card" and "Edit".
- Practice: folders ("Study spaces", "New folder"), recent notebooks, "Past Paper Practice" ("Exam questions" -> pick a folder; a school folder sets its exam board and course once; choose easy/medium/hard counts; "Start practice"; answers are marked by Jami) and "Practice paper" (a whole paper: generated in the exam's format, built from a university module's own past papers and notes, or uploaded). "Ready to practice" holds practice sets Jami wrote, with "Start".
- A folder page has tabs "Notebooks", "Practice", "Decks", "Sources"; "Create notebook" makes a notebook (blank, or from a PDF or image); "Edit folder" sets the level and exam course.
- Notebook: write by pen or text. Toolbar: Pen, Highlighter, Eraser, Text box, Add image, Add graph, Undo, Redo. "New page" (+) at the bottom right on the last page, or in "Pages" (top), which also has "Import PDF or image" and page deletion. "Ask Jami" opens this chat; "Check my working" finds the first step that goes wrong; "Mark my work" gets feedback; answers and graphs can be put on the page with "Add to page".
- Sources (in Jami): "Add source" (text, link or upload: PDF, image, Word, PowerPoint). Select one for "Ask Jami about this" or "Create from this" (flashcards, or a practice set saved to Practice).
- Jami page: ask about your material, drafts "Waiting for your OK", "Revision plan" (Jami plans revision around exam dates), and "Your Jami", a tab of its own (first what Jami remembers, as a galaxy per subject -- memory can be corrected, forgotten or switched off; then what you study, how Jami teaches, and notes for every subject).
- Revision sessions: Jami teaches one topic step by step, with short exercises. Start from Today, a topic page, or "Revision session" in a folder.
- Topics: concepts that connect cards, notebooks and sources. Goals: "New goal" -- review flashcards, answer practice questions Jami marks, or get a topic to strong; as a total or a daily amount, optionally by a date or before an exam in the plan, with suggested goals to start from. Stars: finishing goals earns stars in your sky. Progress: what needs attention, deck health, practice results.
- Account: name, reminders, sign-in and data. "Personalise" (appearance): colour theme, background photo, typeface.
In this chat you can also make flashcards and practice sets from the conversation (see the study-material instruction).`;

/** The actions Tutor can carry out, beyond links. */
export type TutorAppActionType = "open" | "add_pages" | "create_deck" | "create_notebook";

export type TutorAppAction =
  | { type: "open"; destination: string; label: string; href: string }
  | { type: "add_pages"; count: number }
  | { type: "create_deck"; name: string }
  | { type: "create_notebook"; title: string };

/** A proposed action, and whether the student asked for it in so many words. */
export type TutorAppActionProposal = TutorAppAction & { autoRun: boolean };

export const MAX_TUTOR_APP_ACTIONS = 3;
export const MAX_ADDED_PAGES = 20;
const MAX_NAME_LENGTH = 80;

/** Which actions make sense here: pages only in a notebook, a notebook only with a folder to put it in. */
export function availableTutorAppActions(input: {
  context: JamiAssistantContext;
  scope: JamiAppScope;
}): TutorAppActionType[] {
  const available: TutorAppActionType[] = ["open", "create_deck"];
  if (input.context.surface === "notebook") available.push("add_pages");
  if (input.scope.folderId) available.push("create_notebook");
  return available;
}

/*
 * The student's own words decide whether an action runs by itself. Tutor may
 * suggest a page or a deck when it would help, but only something the student
 * asked for happens without a press; anything else is a button.
 */
const ADD_PAGES_REQUEST =
  /\b(?:add|insert|create|make|give me|append|need|want)\b[^.?!\n]{0,40}?\b(?:\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|another|more|new|extra|blank|some)?\s*(?:more\s+|new\s+|extra\s+|blank\s+)*pages?\b/i;
// A new one, not "this notebook" or "my deck": asking to add pages to a notebook is not asking for another.
const CREATE_DECK_REQUEST =
  /\b(?:create|make|start|set up|add|give me)\b[^.?!\n]{0,20}?\b(?:a|an|new|another|one more)\s+(?:[\w-]+\s+){0,3}?deck\b/i;
const CREATE_NOTEBOOK_REQUEST =
  /\b(?:create|make|start|set up|add|give me)\b[^.?!\n]{0,20}?\b(?:a|an|new|another|one more)\s+(?:[\w-]+\s+){0,3}?notebook\b/i;
const DECLINED =
  /\b(?:don'?t|do not|no need to|not|without|stop)\b[^.?!\n]{0,20}?\b(?:add|create|make|pages?|deck|notebook)\b/i;

export function requestedTutorAppActions(message: string): Set<TutorAppActionType> {
  const requested = new Set<TutorAppActionType>();
  const text = message.trim();
  if (!text || text.length > 1_200 || DECLINED.test(text)) return requested;
  if (ADD_PAGES_REQUEST.test(text)) requested.add("add_pages");
  if (CREATE_DECK_REQUEST.test(text)) requested.add("create_deck");
  if (CREATE_NOTEBOOK_REQUEST.test(text)) requested.add("create_notebook");
  return requested;
}

const PAGE_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** How many pages the student asked for, when they said; the model's number otherwise. */
export function requestedPageCount(message: string) {
  const match = /\b(\d{1,2}|a|an|one|another|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more\s+|new\s+|extra\s+|blank\s+)*pages?\b/i.exec(message);
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : PAGE_WORDS[raw] ?? 0;
  return value > 0 ? Math.min(MAX_ADDED_PAGES, value) : null;
}

function cleanName(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH)
    : "";
}

/**
 * The model's proposed actions, kept only where they are on the menu, make
 * sense here and are well formed. A count the student said outright beats
 * the model's, and nothing runs by itself unless the student asked for it.
 */
export function readTutorAppActions(
  value: unknown,
  input: {
    available: readonly TutorAppActionType[];
    destinations: readonly JamiDestination[];
    message: string;
  }
): TutorAppActionProposal[] {
  if (!Array.isArray(value)) return [];
  const requested = requestedTutorAppActions(input.message);
  const byKey = new Map(input.destinations.map((destination) => [destination.key, destination]));
  const seen = new Set<string>();
  const actions: TutorAppActionProposal[] = [];
  for (const candidate of value) {
    if (actions.length >= MAX_TUTOR_APP_ACTIONS) break;
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const type = item.type;
    if (typeof type !== "string" || !input.available.includes(type as TutorAppActionType)) continue;
    let action: TutorAppAction | null = null;
    if (type === "open") {
      const destination = byKey.get(typeof item.destination === "string" ? item.destination : "");
      if (destination) {
        action = { type: "open", destination: destination.key, label: destination.label, href: destination.href };
      }
    } else if (type === "add_pages") {
      const said = requestedPageCount(input.message);
      const proposed = typeof item.count === "number" && Number.isFinite(item.count) ? Math.round(item.count) : 1;
      action = { type: "add_pages", count: Math.max(1, Math.min(MAX_ADDED_PAGES, said ?? proposed)) };
    } else if (type === "create_deck") {
      const name = cleanName(item.name);
      if (name) action = { type: "create_deck", name };
    } else if (type === "create_notebook") {
      const title = cleanName(item.name ?? item.title);
      if (title) action = { type: "create_notebook", title };
    }
    if (!action) continue;
    const key = action.type === "open" ? `open:${action.destination}` : action.type;
    if (seen.has(key)) continue;
    seen.add(key);
    // Navigation always waits for a press: moving the student away is never automatic.
    actions.push({ ...action, autoRun: action.type !== "open" && requested.has(action.type) });
  }
  return actions;
}

/** A scope read back from a response or a saved answer: ids only, each well formed. */
export function normalizeJamiAppScope(value: unknown): JamiAppScope {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const id = (candidate: unknown) =>
    typeof candidate === "string" && ID_PATTERN.test(candidate) ? candidate : undefined;
  const folderId = id(record.folderId);
  const deckId = id(record.deckId);
  const notebookId = id(record.notebookId);
  return {
    ...(folderId ? { folderId } : {}),
    ...(deckId ? { deckId } : {}),
    ...(notebookId ? { notebookId } : {}),
  };
}

/** Stored actions read back from a saved answer, without trusting their shape. */
export function normalizeTutorAppActions(
  value: unknown,
  destinations: readonly JamiDestination[] = jamiDestinations()
): TutorAppActionProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): TutorAppActionProposal[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const autoRun = item.autoRun === true;
    if (item.type === "open") {
      const href = typeof item.href === "string" ? item.href : "";
      const label = cleanName(item.label);
      const destination = typeof item.destination === "string" ? item.destination : "";
      return isJamiAppHref(href, destinations) && label
        ? [{ type: "open", destination, label, href, autoRun: false }]
        : [];
    }
    if (item.type === "add_pages" && typeof item.count === "number" && Number.isFinite(item.count)) {
      return [{ type: "add_pages", count: Math.max(1, Math.min(MAX_ADDED_PAGES, Math.round(item.count))), autoRun }];
    }
    if (item.type === "create_deck" && cleanName(item.name)) {
      return [{ type: "create_deck", name: cleanName(item.name), autoRun }];
    }
    if (item.type === "create_notebook" && cleanName(item.title)) {
      return [{ type: "create_notebook", title: cleanName(item.title), autoRun }];
    }
    return [];
  }).slice(0, MAX_TUTOR_APP_ACTIONS);
}

/**
 * Whether a link is one of Jami's own pages that Tutor may send a student to.
 *
 * The listed destinations exactly, or the shape of one of the per-item pages
 * (a folder, deck or notebook) -- which a stored answer from another
 * conversation may hold.
 */
export function isJamiAppHref(href: string, destinations: readonly JamiDestination[] = jamiDestinations()) {
  if (destinations.some((destination) => destination.href === href)) return true;
  return /^\/dashboard\/(?:folders|decks|notebooks)\/[A-Za-z0-9_%-]{1,200}$/.test(href) ||
    /^\/dashboard\/study\?mode=custom&decks=[A-Za-z0-9_%,-]{1,400}$/.test(href) ||
    /^\/dashboard\/practice\/questions\/new\?folderId=[A-Za-z0-9_%-]{1,200}$/.test(href) ||
    /^\/dashboard\/revision\/start\?folder=[A-Za-z0-9_%-]{1,200}$/.test(href);
}

/**
 * Turns the answer's in-app links into real ones, and drops any that point
 * nowhere.
 *
 * Tutor writes a link to a place as [words](jami:key), naming the place by its
 * key rather than its path, so it can never invent a page. A key that is not
 * on the list -- or a raw /dashboard path that is not a real page -- leaves the
 * words and loses the link.
 */
export function resolveTutorAppLinks(answer: string, destinations: readonly JamiDestination[]) {
  const byKey = new Map(destinations.map((destination) => [destination.key, destination]));
  return answer.replace(/\[([^\]\n]{1,120})\]\(\s*([^)\s]{1,400})\s*\)/g, (whole, text: string, target: string) => {
    if (target.startsWith("jami:")) {
      const destination = byKey.get(target.slice("jami:".length));
      return destination ? `[${text}](${destination.href})` : text;
    }
    if (target.startsWith("/")) return isJamiAppHref(target, destinations) ? whole : text;
    return whole;
  });
}

/** What Tutor is told about the app, the places it can link to and what it can do. */
export function buildTutorAppInstruction(input: {
  destinations: readonly JamiDestination[];
  available: readonly TutorAppActionType[];
}) {
  const places = input.destinations.map((destination) => `${destination.key} (${destination.label})`).join(", ");
  const actionLines = [
    "open: a button that takes the student to a place; set destination to one of the place keys.",
    input.available.includes("add_pages")
      ? "add_pages: add blank pages to the end of the notebook the student is in; set count (1-20)."
      : "",
    "create_deck: make a new, empty flashcard deck; set name.",
    input.available.includes("create_notebook")
      ? "create_notebook: make a new blank notebook in the student's current folder; set name."
      : "",
  ].filter(Boolean);
  return `${JAMI_APP_GUIDE}
When pointing the student somewhere in Jami, link to it in the answer as [words](jami:key), using only these place keys: ${places}. Never write a /dashboard path or any other in-app address yourself, and never name a button or page that is not in the guide above; if you are not sure where something is, say so.
You can also do things in Jami through the appActions field (at most ${MAX_TUTOR_APP_ACTIONS}; an empty array otherwise):
${actionLines.map((line) => `- ${line}`).join("\n")}
Use appActions when the student asks you to do one of these, or when one would plainly help ("open" to the place you are recommending). When the student asks you to do one, do it -- put it in appActions and say in a short sentence what you are doing ("Adding ten pages to this notebook.") -- rather than explaining how they could do it themselves. For anything not on this list, explain how to do it in Jami instead, and never claim to have done something you have not.`;
}
