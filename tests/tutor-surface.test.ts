import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSourcePanelHref,
  readSourcePanelLink,
  TUTOR_TITLE,
  TUTOR_VIEWS,
} from "@/lib/app/tutor-views";
import { PLAN_HOME, PLAN_TITLE, PLAN_VIEWS, PLANNER_PATH } from "@/lib/app/plan-views";
import {
  describeDraftCounts,
  describeDraftGroupOrigin,
  getDraftPreview,
  groupTutorDrafts,
} from "@/lib/app/tutor-drafts";
import type { GeneratedContentDraft } from "@/lib/material/generated-content";
import type { Source } from "@/lib/material/sources";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(join(root, relativePath), "utf8");

const tutorPage = read("app/dashboard/tutor/page.tsx");
// The page's ask box is its own component; what it promises is still the page's.
const tutorSurface = `${tutorPage}
${read("components/ai/TutorAskPanel.tsx")}`;
const libraryPage = read("app/dashboard/library/page.tsx");
const homePage = read("app/dashboard/page.tsx");
const tabBar = read("components/layout/TabBar.tsx");

/**
 * Drafts had nowhere to be reviewed. The only way in was to open Sources,
 * remember which source had produced them, and find the drawer -- and Home's
 * "Review drafts" button guessed at the first draft's own source, falling back
 * to Progress, which has nothing to do with drafts.
 */
describe("the drafts queue has a home", () => {
  it("is reachable in one press from Home", () => {
    // Matched on the destination rather than the whole element: the Study Hub
    // redesign swapped the button primitive, and this test is about where the
    // drafts queue lives, not which component draws the link.
    expect(homePage).toContain('<ButtonLink href="/dashboard/tutor"');
    expect(homePage).toContain("Review drafts");
    expect(homePage).not.toContain('plan.drafts[0]?.href ?? "/dashboard/progress"');
  });

  it("loads what is actually pending, not a sample", () => {
    expect(tutorPage).toContain("getPendingGeneratedContentDrafts");
  });

  it("says which source to open, and can open it", () => {
    // A queue you cannot act on is only a reminder.
    expect(tutorPage).toContain("groupTutorDrafts");
    expect(tutorPage).toContain("getSourcePanelHref");
    expect(getSourcePanelHref("abc", "drafts")).toBe(
      "/dashboard/library?source=abc&panel=drafts"
    );
    expect(getSourcePanelHref("a b/c", "tutor")).toContain("a%20b%2Fc");
  });

  it("reads that link back, and only the panels a link may name", () => {
    expect(readSourcePanelLink("?source=abc&panel=drafts")).toEqual({
      sourceId: "abc",
      panel: "drafts",
    });
    expect(readSourcePanelLink("?source=abc&panel=tutor").panel).toBe("tutor");
    // `details` is reached by choosing a source, not by being sent to one.
    expect(readSourcePanelLink("?source=abc&panel=details").panel).toBeNull();
    expect(readSourcePanelLink("?panel=drafts").sourceId).toBeNull();
    expect(readSourcePanelLink("")).toEqual({ sourceId: null, panel: null });
  });

  it("opens that source with its drafts already showing", () => {
    // The panel is initial state rather than something applied afterwards, and
    // the page already holds it shut until a source is actually selected.
    expect(libraryPage).toContain("readSourcePanelLink(window.location.search)");
    expect(libraryPage).toContain("browser.selectSource(requestedSourceId)");
    expect(libraryPage).toContain(
      "const visiblePanel = selectedSource ? activePanel : null;"
    );
  });
});

describe("the tutor owns the sidebar entry sources used to have", () => {
  it("replaces it rather than adding to the bar", () => {
    const entries = [...tabBar.matchAll(/href: "(\/dashboard\/[^"]*)"/g)].map(
      (match) => match[1]
    );

    expect(entries).toContain("/dashboard/tutor");
    expect(entries).not.toContain("/dashboard/library");
    expect(tabBar).toContain('label: "Jami"');
  });

  it("stays lit wherever the tutor's own surfaces are", () => {
    // Sources is a thing a student does with Jami, so it grows no second home
    // in the sidebar while they are in it.
    // The Tutor entry's own list, not whichever tab declares `owns` first.
    const owns =
      [...tabBar.matchAll(/owns: \[([^\]]*)\]/g)]
        .map((match) => match[1] ?? "")
        .find((entry) => entry.includes("/dashboard/library")) ?? "";
    expect(owns).toContain('"/dashboard/library"');
  });

  it("hands the revision plan to Plan, beside goals", () => {
    expect(TUTOR_VIEWS.map((view) => view.href)).not.toContain(PLANNER_PATH);
    expect(PLAN_VIEWS.map((view) => view.label)).toEqual(["Revision plan", "Goals"]);
    expect(PLAN_HOME).toBe(PLANNER_PATH);
    expect(PLAN_TITLE).toBe("Plan");
    expect(tabBar).toContain('label: "Plan"');
    expect(tabBar).toContain('owns: [PLANNER_PATH, "/dashboard/goals"]');
    // Old links to the plan still land on it.
    expect(read("app/dashboard/tutor/plan/page.tsx")).toContain("redirect(PLANNER_PATH)");
    for (const page of ["app/dashboard/planner/page.tsx", "app/dashboard/goals/page.tsx"]) {
      expect(read(page)).toContain("views={PLAN_VIEWS}");
    }
  });

  it("keeps the sources address working", () => {
    const hrefs = TUTOR_VIEWS.map((view) => view.href);
    // Asking comes first and sources last, whatever sits between them.
    expect(hrefs[0]).toBe("/dashboard/tutor");
    expect(hrefs[hrefs.length - 1]).toBe("/dashboard/library");
    expect(hrefs).toContain("/dashboard/library");
    for (const page of [tutorPage, libraryPage]) {
      expect(page).toContain("views={TUTOR_VIEWS}");
      expect(page).toContain("TUTOR_TITLE");
    }
    expect(TUTOR_TITLE).toBe("Jami");
  });

  it("gives Your Jami a tab of its own, with memory at the top", () => {
    const personalise = read("components/ai/TutorPersonaliseWorkspace.tsx");
    expect(personalise).toContain("views={TUTOR_VIEWS}");
    expect(personalise.indexOf("<TutorMemoryPanel")).toBeLessThan(
      personalise.indexOf("<TutorStudyProfileForm")
    );
    // A tab, not a settings button in the corner of the ask page.
    expect(tutorPage).not.toContain('href="/dashboard/tutor/personalise"');
  });
});

/**
 * Tutor reads up to fifteen deliberately selected sources on
 * demand, and extracted content is never persisted. A surface that implied a
 * standing memory would have a student ask about a source they never selected
 * and be quietly answered from general knowledge instead.
 */
describe("it does not promise Jami a memory it does not have", () => {
  it("avoids calling the material a context or a knowledge base", () => {
    // Comments are stripped first: the rule is about what a student reads, and
    // the source is entitled to explain why the phrase is avoided.
    const withoutComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    for (const page of [tutorSurface, read("lib/app/tutor-views.ts")]) {
      const copy = withoutComments(page);
      expect(copy).not.toMatch(/Jami'?s (context|memory|knowledge)/i);
      expect(copy).not.toMatch(/knowledge base/i);
    }
  });

  it("says plainly that Jami reads what it is given, when it is asked", () => {
    // Two short lines beside the offer rather than a paragraph inside it: a
    // wall of prose about what Jami does not retain is skipped exactly when it
    // matters, which is the first visit.
    expect(tutorSurface).toMatch(/Reads only what you hand it/i);
    // Tutor memory keeps a few notes between chats, so the line says so and where to change them.
    expect(tutorSurface).toMatch(/Remembers a few notes about you/i);
    expect(tutorSurface).not.toMatch(/Keeps nothing between conversations/i);
    expect(tutorSurface).toMatch(/for that conversation only/i);
  });

  it("keeps the student as the one who approves what Jami writes", () => {
    expect(tutorPage).toMatch(/until you have read it and said yes/i);
  });
});

/**
 * A queue that only counts is a reminder rather than something to act on: two
 * rows reading "4 drafts" say nothing about which to open first.
 */
describe("the queue says what is in it", () => {
  const source = (id: string, title: string) =>
    ({ id, title, type: "file", folderIds: [], topicIds: [] }) as unknown as Source;

  const draft = (over: Partial<GeneratedContentDraft>) =>
    ({
      id: "d1",
      kind: "flashcard",
      title: "Untitled",
      topicIds: [],
      origin: "ai",
      contentStatus: "draft",
      createdAt: 0,
      updatedAt: 0,
      ...over,
    }) as GeneratedContentDraft;

  it("shows the first draft's own words", () => {
    const groups = groupTutorDrafts(
      [
        draft({ id: "a", sourceId: "s1", front: "What is a matrix?" }),
        draft({ id: "b", sourceId: "s1", front: "Define orthogonality" }),
      ],
      [source("s1", "Linear algebra notes")]
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Linear algebra notes");
    expect(groups[0].preview).toBe("What is a matrix?");
  });

  it("reads a practice question from its question, not its front", () => {
    expect(
      getDraftPreview(
        draft({ kind: "practice-question", questionText: "Multiply these matrices." })
      )
    ).toBe("Multiply these matrices.");
  });

  it("counts the two kinds separately, and says neither when there are none", () => {
    const [group] = groupTutorDrafts(
      [
        draft({ id: "a", sourceId: "s1" }),
        draft({ id: "b", sourceId: "s1", kind: "practice-question" }),
        draft({ id: "c", sourceId: "s1", kind: "practice-question" }),
      ],
      [source("s1", "Notes")]
    );

    expect(describeDraftCounts(group)).toEqual(["1 card", "2 questions"]);
    expect(
      describeDraftCounts({ ...group, flashcards: 0, questions: 0 })
    ).toEqual([]);
  });

  it("puts the biggest pile first, and never hides an orphaned draft", () => {
    const groups = groupTutorDrafts(
      [
        draft({ id: "a", sourceId: "small" }),
        draft({ id: "b", sourceId: "big" }),
        draft({ id: "c", sourceId: "big" }),
        draft({ id: "d" }),
      ],
      [source("small", "One"), source("big", "Two")]
    );

    expect(groups.map((group) => group.title)).toEqual([
      "Two",
      "One",
      "From your Tutor chats",
    ]);
  });

  it("says where each group came from in a sentence that reads", () => {
    const groups = groupTutorDrafts(
      [draft({ id: "a", sourceId: "s1" }), draft({ id: "b" }), draft({ id: "c" })],
      [source("s1", "Chapter 2 notes")]
    );

    expect(groups.map(describeDraftGroupOrigin)).toEqual([
      "2 from your Tutor chats",
      "1 from Chapter 2 notes",
    ]);
  });

  it("still names a group whose source has since been removed", () => {
    const [group] = groupTutorDrafts([draft({ sourceId: "gone" })], []);
    expect(group.title).toMatch(/removed/i);
  });

  it("reviews a group in its source only while that source exists", () => {
    const groups = groupTutorDrafts(
      [
        draft({ id: "a", sourceId: "s1" }),
        draft({ id: "b", sourceId: "gone" }),
        draft({ id: "c", sourceType: "tutor" }),
        draft({ id: "d", sourceType: "tutor" }),
      ],
      [source("s1", "Notes")]
    );

    expect(
      groups.map(({ title, reviewInSource, draftIds }) => ({ title, reviewInSource, draftIds }))
    ).toEqual([
      { title: "From your Tutor chats", reviewInSource: false, draftIds: ["c", "d"] },
      { title: "Notes", reviewInSource: true, draftIds: ["a"] },
      { title: "A source you have removed", reviewInSource: false, draftIds: ["b"] },
    ]);
  });
});
