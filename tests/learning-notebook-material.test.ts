import { describe, expect, it } from "vitest";
import {
  buildNotebookMaterialIndex,
  locateNotebookMaterial,
} from "@/lib/learning/actions/notebook-material";
import { buildStudyActions } from "@/lib/learning/actions/study-actions";
import { buildLearnerProfile } from "@/lib/learning/profile/build-learner-profile";
import type { LearnerExposureItem } from "@/lib/learning/profile/exposure";
import type { NotebookMarkedWorking } from "@/lib/learning/profile/notebook-signals";

/**
 * Sending a student back to their own notebook page.
 *
 * The engine still decides what is needed; this pins where it can be done:
 * the page they worked on the concept and lost marks, then any page marked on
 * it, then a notebook filed under it -- and the Topic page when there is none.
 */

const NOW = Date.UTC(2026, 8, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

function marking(
  pageId: string,
  daysAgo: number,
  awardedMarks: number,
  topicKeys: string[] = ["topic:eigen"]
): NotebookMarkedWorking {
  return {
    id: `m-${pageId}`,
    notebookId: "nb-1",
    pageId,
    topicKeys,
    itemId: `notebook:nb-1:${pageId}`,
    markedAt: NOW - daysAgo * DAY,
    result: { attempted: true, counted: true, awardedMarks, maxMarks: 4 },
  };
}

const NOTES: LearnerExposureItem = { kind: "notebook", id: "nb-notes", topicIds: ["eigen"], at: NOW - DAY };

describe("finding notebook material on a concept", () => {
  it("prefers the most recent page where marks were lost", () => {
    const index = buildNotebookMaterialIndex({
      markings: [marking("p1", 1, 4), marking("p2", 5, 1), marking("p3", 9, 0)],
      exposureItems: [NOTES],
    });
    expect(locateNotebookMaterial(index, "topic:eigen")).toEqual({ notebookId: "nb-1", pageId: "p2" });
  });

  it("takes any marked page before a notebook that is only filed under it", () => {
    const index = buildNotebookMaterialIndex({ markings: [marking("p1", 3, 4)], exposureItems: [NOTES] });
    expect(locateNotebookMaterial(index, "topic:eigen")).toEqual({ notebookId: "nb-1", pageId: "p1" });
  });

  it("falls back to a notebook filed under the concept, without a page", () => {
    const index = buildNotebookMaterialIndex({ markings: [], exposureItems: [NOTES] });
    expect(locateNotebookMaterial(index, "topic:eigen")).toEqual({ notebookId: "nb-notes" });
  });

  it("finds nothing for a concept with no notebook material", () => {
    const index = buildNotebookMaterialIndex({
      markings: [marking("p1", 1, 0, ["topic:matrix"])],
      exposureItems: [{ ...NOTES, topicIds: ["matrix"] }],
    });
    expect(locateNotebookMaterial(index, "topic:eigen")).toBeUndefined();
  });
});

describe("a study action that opens the student's own page", () => {
  // Strong a month ago, wrong all week: slipping, on a Topic with notebook work and no cards.
  const markings = [
    ...Array.from({ length: 8 }, (_, index) => marking(`old-${index}`, 40 - index, 4)),
    ...Array.from({ length: 8 }, (_, index) => marking(`new-${index}`, 6 - (index % 6), 0)),
  ];
  const exposureItems = [{ kind: "notebook" as const, id: "nb-1", topicIds: ["eigen"], at: NOW - DAY }];
  const profile = buildLearnerProfile({
    scope: { folderId: "f1" },
    now: NOW,
    evidence: {
      cards: [],
      flashcardReviewEvents: [],
      pastPaperAttempts: [],
      practicePaperAttempts: [],
      notebookMarkings: markings,
      exposureItems,
      topicLabels: { "topic:eigen": { label: "Eigenvectors", source: "student-topic" } },
    },
  });

  it("goes to the page, carrying the advice it answers", () => {
    const [action] = buildStudyActions(profile, {
      questionPracticeAvailable: false,
      notebookMaterial: buildNotebookMaterialIndex({ markings, exposureItems }),
    });
    expect(action?.intervention?.type).toBe("review_material");
    expect(action?.destination).toMatchObject({
      kind: "notebook",
      notebook: { notebookId: "nb-1", pageId: "new-5" },
    });
    expect(action?.destination?.href).toBe(
      `/dashboard/notebooks/nb-1?page=new-5&from=${encodeURIComponent(action!.id)}`
    );
  });

  it("keeps the engine's decision whatever the destination", () => {
    const [withPage] = buildStudyActions(profile, {
      questionPracticeAvailable: false,
      notebookMaterial: buildNotebookMaterialIndex({ markings, exposureItems }),
    });
    const [without] = buildStudyActions(profile, { questionPracticeAvailable: false });
    expect(withPage?.id).toBe(without?.id);
    expect(withPage?.reason).toBe(without?.reason);
    expect(withPage?.intervention).toEqual(without?.intervention);
    // Without an index the material is looked for on the Topic page, as before.
    expect(without?.destination).toMatchObject({ kind: "topic", href: "/dashboard/topics/eigen" });
  });
});
