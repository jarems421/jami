import { describe, expect, it } from "vitest";
import {
  createNotebookPageDraft,
  getNotebookDraftDecision,
  parseNotebookPageDraft,
  storedNotebookPageDraft,
} from "@/lib/workspace/notebook-drafts";
import { jamiInkData, svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";
import type { NotebookInkData } from "@/lib/workspace/notebooks";
import { docOf, outline } from "./support/ink-fixtures";

function makeDraft(ink: NotebookInkData = svgNotebookInkData("<svg></svg>")) {
  return createNotebookPageDraft({
    userId: "alice",
    notebookId: "notebook-1",
    pageId: "page-1",
    baseContentRevision: 3,
    remoteUpdatedAt: 100,
    localRevision: 2,
    savedAt: 200,
    textBlocks: [
      {
        id: "text-1",
        x: 10,
        y: 20,
        width: 320,
        height: 120,
        text: "Recovered notes",
        outlineVisible: false,
      },
    ],
    ink,
    pageColor: "white",
    pageStyle: "lined",
    status: "working",
  });
}

/** What a draft is kept as on the device, as the synchronous copy writes it. */
const kept = (ink?: NotebookInkData) => JSON.stringify(storedNotebookPageDraft(makeDraft(ink)));

const jamiInk = jamiInkData(docOf(outline("a", [{ op: "M", x: 10, y: 10 }, { op: "L", x: 60, y: 30 }])));

describe("notebook local drafts", () => {
  it("round-trips a versioned recovery draft without clipping content", () => {
    const draft = makeDraft();
    expect(parseNotebookPageDraft(kept())).toEqual(draft);
  });

  it("keeps Jami Ink's encoding beside the SVG every older build reads", () => {
    const draft = makeDraft(jamiInk);
    const stored = storedNotebookPageDraft(draft);
    expect(stored.inkSvg).toBe(jamiInk.format === "js-draw-svg" ? jamiInk.svg : undefined);
    expect(stored.jamiInk).toMatch(/^j3:/);
    expect(parseNotebookPageDraft(JSON.stringify(stored))).toEqual(draft);
  });

  it("keeps a page too big to carry both as the encoding alone", () => {
    const encoded = jamiInk.format === "js-draw-svg" ? jamiInk.jamiInk! : "";
    const draft = makeDraft({ version: 3, format: "jami-ink", data: encoded });
    expect(storedNotebookPageDraft(draft)).not.toHaveProperty("inkSvg");
    expect(parseNotebookPageDraft(kept(draft.ink))).toEqual(draft);
  });

  it("keeps an SVG-only draft in the shape drafts had before Jami Ink, so either build restores it", () => {
    const stored = storedNotebookPageDraft(makeDraft(svgNotebookInkData("<svg><path d='M0 0L1 1'/></svg>")));
    expect(stored).not.toHaveProperty("ink");
    expect(stored).not.toHaveProperty("jamiInk");
    expect(stored.inkSvg).toBe("<svg><path d='M0 0L1 1'/></svg>");
  });

  /*
   * The most recent version wins, wherever it was made. There is no conflict
   * to ask about: one student, one device at a time.
   */
  it("restores the device copy only when it is newer than the synced page", () => {
    const draft = makeDraft(); // saved at 200
    expect(
      getNotebookDraftDecision(draft, {
        id: "page-1",
        notebookId: "notebook-1",
        updatedAt: 150,
      })
    ).toBe("restore");
    // Changed on another device after this copy was made: that change stands.
    expect(
      getNotebookDraftDecision(draft, {
        id: "page-1",
        notebookId: "notebook-1",
        updatedAt: 250,
      })
    ).toBe("discard");
  });

  it("discards corrupt or unrelated recovery records", () => {
    expect(parseNotebookPageDraft("not-json")).toBeNull();
    const stored = storedNotebookPageDraft(makeDraft());
    expect(parseNotebookPageDraft({ ...stored, inkSvg: "not svg" })).toBeNull();
    // No SVG, and no encoding either.
    expect(parseNotebookPageDraft({ ...stored, inkSvg: undefined, jamiInk: "not ink" })).toBeNull();
    expect(
      getNotebookDraftDecision(makeDraft(), {
        id: "other-page",
        notebookId: "notebook-1",
        updatedAt: 150,
      })
    ).toBe("discard");
  });
});
