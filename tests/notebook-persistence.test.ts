import { describe, expect, it } from "vitest";
import { svgNotebookInkData } from "@/lib/workspace/notebook-ink-data";
import {
  MAX_NOTEBOOK_IMAGE_REFS,
  MAX_NOTEBOOK_INK_SVG_LENGTH,
  MAX_NOTEBOOK_STROKE_POINTS,
  MAX_NOTEBOOK_TEXT_BLOCKS,
  MAX_NOTEBOOK_TEXT_BLOCK_TEXT,
  mapNotebookPageData,
  normalizeNotebookImageRefs,
  type NotebookInkData,
  type NotebookTextBlock,
} from "@/lib/workspace/notebooks";
import {
  buildNotebookPagePayload,
  NotebookPagePersistenceError,
  prepareNotebookPageSnapshotForPersistence,
} from "@/lib/workspace/notebook-page-writes";
import {
  createCenteredNotebookImageRef,
  moveNotebookImageRef,
  resizeNotebookImageRef,
} from "@/lib/workspace/notebook-placement";

function makeTextBlock(index: number, text = "Notes"): NotebookTextBlock {
  return {
    id: `block-${index}`,
    x: 10,
    y: 10,
    width: 320,
    height: 120,
    text,
    outlineVisible: true,
  };
}

function expectPersistenceCode(run: () => unknown, code: string) {
  try {
    run();
    throw new Error("Expected the notebook snapshot to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(NotebookPagePersistenceError);
    expect((error as NotebookPagePersistenceError).code).toBe(code);
  }
}

describe("notebook page persistence contract", () => {
  it("keeps oversized legacy values visible instead of clipping them on load", () => {
    const longText = "t".repeat(MAX_NOTEBOOK_TEXT_BLOCK_TEXT + 25);
    const textBlocks = Array.from(
      { length: MAX_NOTEBOOK_TEXT_BLOCKS + 2 },
      (_, index) => makeTextBlock(index, index === 0 ? longText : "Notes")
    );
    const legacyInk = `<svg>${"x".repeat(MAX_NOTEBOOK_INK_SVG_LENGTH + 1)}</svg>`;
    const page = mapNotebookPageData("page-1", {
      notebookId: "notebook-1",
      folderId: "folder-1",
      pageNumber: 1,
      pageType: "blank",
      textBlocks,
      inkData: { version: 2, format: "js-draw-svg", svg: legacyInk },
    });

    expect(page.textBlocks).toHaveLength(MAX_NOTEBOOK_TEXT_BLOCKS + 2);
    expect(page.textBlocks[0]?.text).toBe(longText);
    expect(page.inkData).toEqual(svgNotebookInkData(legacyInk));
  });

  it("rejects unsafe ink and text explicitly at the shared write boundary", () => {
    expectPersistenceCode(
      () =>
        prepareNotebookPageSnapshotForPersistence({
          typedContent: "",
          textBlocks: [],
          inkData: svgNotebookInkData(`<svg>${"x".repeat(MAX_NOTEBOOK_INK_SVG_LENGTH)}</svg>`),
          pageColor: "white",
          pageStyle: "plain",
          status: "working",
        }),
      "ink-too-large"
    );
    expectPersistenceCode(
      () =>
        prepareNotebookPageSnapshotForPersistence({
          typedContent: "",
          textBlocks: Array.from(
            { length: MAX_NOTEBOOK_TEXT_BLOCKS + 1 },
            (_, index) => makeTextBlock(index)
          ),
          pageColor: "white",
          pageStyle: "plain",
          status: "working",
        }),
      "too-many-text-blocks"
    );
    expectPersistenceCode(
      () =>
        prepareNotebookPageSnapshotForPersistence({
          typedContent: "",
          textBlocks: [
            makeTextBlock(1, "x".repeat(MAX_NOTEBOOK_TEXT_BLOCK_TEXT + 1)),
          ],
          pageColor: "white",
          pageStyle: "plain",
          status: "working",
        }),
      "text-block-too-large"
    );
  });

  it("accounts for the complete UTF-8 snapshot before a Firestore write", () => {
    expectPersistenceCode(
      () =>
        prepareNotebookPageSnapshotForPersistence({
          typedContent: "x".repeat(30_000),
          textBlocks: Array.from({ length: 20 }, (_, index) =>
            makeTextBlock(index, "y".repeat(4_000))
          ),
          inkData: {
            version: 2,
            format: "js-draw-svg",
            svg: `<svg>${"z".repeat(820_000)}</svg>`,
          },
          pageColor: "white",
          pageStyle: "plain",
          status: "working",
        }),
      "snapshot-too-large"
    );
  });

  describe("Jami Ink's page, with its SVG copy", () => {
    const prepare = (inkData: NotebookInkData) =>
      prepareNotebookPageSnapshotForPersistence({
        typedContent: "",
        textBlocks: [],
        inkData,
        pageColor: "white",
        pageStyle: "plain",
        status: "working",
      });
    const svg = (length: number) => `<svg>${"x".repeat(length)}</svg>`;
    const encoding = (length: number) => `j3:${"A".repeat(length)}`;

    it("keeps the copy while both fit the record", () => {
      const ink: NotebookInkData = {
        version: 2,
        format: "js-draw-svg",
        svg: svg(1_000),
        jamiInk: encoding(400),
      };
      expect(prepare(ink).inkData).toEqual(ink);
    });

    it("drops the copy, keeping the encoding alone, when the two together would not fit", () => {
      const ink: NotebookInkData = {
        version: 2,
        format: "js-draw-svg",
        svg: svg(600_000),
        jamiInk: encoding(300_000),
      };
      expect(prepare(ink).inkData).toEqual({ version: 3, format: "jami-ink", data: encoding(300_000) });
    });

    it("refuses an encoding too big even alone", () => {
      expectPersistenceCode(
        () =>
          prepare({
            version: 2,
            format: "js-draw-svg",
            svg: svg(1_000),
            jamiInk: encoding(MAX_NOTEBOOK_INK_SVG_LENGTH),
          }),
        "ink-too-large"
      );
    });
  });

  it("maps old pages to revision zero and preserves stored revisions", () => {
    expect(mapNotebookPageData("legacy", {}).contentRevision).toBe(0);
    expect(
      mapNotebookPageData("current", { contentRevision: 7 }).contentRevision
    ).toBe(7);
  });

  it("preserves legacy stroke points and image references but rejects new overflow writes", () => {
    const strokePoints = Array.from(
      { length: MAX_NOTEBOOK_STROKE_POINTS + 1 },
      (_, index) => ({ x: index, y: index })
    );
    const imageRefs = Array.from(
      { length: MAX_NOTEBOOK_IMAGE_REFS + 1 },
      (_, index) => ({ id: `image-${index}` })
    );
    const page = mapNotebookPageData("legacy", {
      strokeData: {
        version: 1,
        strokes: [
          { points: strokePoints, color: "black", width: 5, tool: "pen" },
        ],
      },
      imageRefs,
    });

    expect(page.strokeData?.strokes[0]?.points).toHaveLength(
      MAX_NOTEBOOK_STROKE_POINTS + 1
    );
    expect(page.imageRefs).toHaveLength(MAX_NOTEBOOK_IMAGE_REFS + 1);
    expectPersistenceCode(
      () =>
        buildNotebookPagePayload({
          notebookId: "notebook-1",
          folderId: "folder-1",
          pageNumber: 1,
          imageRefs,
        }),
      "too-many-images"
    );
  });

  it("normalizes, centres, moves and proportionally resizes notebook visuals", () => {
    const centred = createCenteredNotebookImageRef({
      id: "image-1",
      storagePath: "users/user-1/notebookFiles/notebook-1/asset.png",
      width: 1600,
      height: 900,
      altText: "A labelled cell",
      sourceAssetId: "assistant-asset-1",
    });
    expect(centred.displayWidth).toBe(520);
    expect(centred.displayHeight).toBe(293);
    expect(centred.x).toBe(190);

    const moved = moveNotebookImageRef(centred, 10_000, -10_000);
    expect(moved.x).toBe(900 - moved.displayWidth!);
    expect(moved.y).toBe(0);

    const resized = resizeNotebookImageRef(centred, 120, 0);
    expect(resized.displayWidth).toBeGreaterThan(centred.displayWidth!);
    expect(
      resized.displayWidth! / resized.displayHeight!
    ).toBeCloseTo(centred.displayWidth! / centred.displayHeight!, 1);

    expect(
      normalizeNotebookImageRefs([{ id: "legacy-image" }])[0]
    ).toMatchObject({
      id: "legacy-image",
      displayWidth: 480,
      displayHeight: 360,
    });
  });

  it("resizes a visual from anywhere along a side, keeping its shape and centre", () => {
    const centred = createCenteredNotebookImageRef({
      id: "image-1",
      storagePath: "users/user-1/notebookFiles/notebook-1/asset.png",
      width: 1600,
      height: 900,
      altText: "A labelled cell",
    });
    const ratio = centred.displayWidth! / centred.displayHeight!;
    const centreX = centred.x! + centred.displayWidth! / 2;
    const centreY = centred.y! + centred.displayHeight! / 2;

    const fromRight = resizeNotebookImageRef(centred, 100, 400, "right");
    expect(fromRight.displayWidth).toBeCloseTo(centred.displayWidth! + 100, 0);
    expect(fromRight.x).toBeCloseTo(centred.x!, 0);
    // Placement is stored in whole units, so a centre can land half a unit out.
    expect(Math.abs(fromRight.y! + fromRight.displayHeight! / 2 - centreY)).toBeLessThanOrEqual(1);
    expect(fromRight.displayWidth! / fromRight.displayHeight!).toBeCloseTo(ratio, 1);

    const fromLeft = resizeNotebookImageRef(centred, 80, 0, "left");
    expect(fromLeft.displayWidth).toBeCloseTo(centred.displayWidth! - 80, 0);
    expect(fromLeft.x! + fromLeft.displayWidth!).toBeCloseTo(centred.x! + centred.displayWidth!, 0);

    const fromBottom = resizeNotebookImageRef(centred, 999, 50, "bottom");
    expect(fromBottom.displayHeight).toBeCloseTo(centred.displayHeight! + 50, 0);
    expect(fromBottom.y).toBeCloseTo(centred.y!, 0);
    expect(Math.abs(fromBottom.x! + fromBottom.displayWidth! / 2 - centreX)).toBeLessThanOrEqual(1);

    const fromTop = resizeNotebookImageRef(centred, 0, -40, "top");
    expect(fromTop.displayHeight).toBeCloseTo(centred.displayHeight! + 40, 0);
    expect(fromTop.y! + fromTop.displayHeight!).toBeCloseTo(centred.y! + centred.displayHeight!, 0);

    // A side never pushes the image off the page, and never below its smallest size.
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      const stretched = resizeNotebookImageRef(centred, 5_000, 5_000, edge);
      const pulled = resizeNotebookImageRef(centred, -5_000, -5_000, edge);
      for (const image of [stretched, pulled]) {
        expect(image.x).toBeGreaterThanOrEqual(0);
        expect(image.y).toBeGreaterThanOrEqual(0);
        expect(image.x! + image.displayWidth!).toBeLessThanOrEqual(900.5);
        expect(image.y! + image.displayHeight!).toBeLessThanOrEqual(1240.5);
        expect(Math.min(image.displayWidth!, image.displayHeight!)).toBeGreaterThanOrEqual(119.5);
      }
    }
  });

  it("resizes a visual from any corner and pins the opposite one", () => {
    const centred = createCenteredNotebookImageRef({
      id: "image-1",
      storagePath: "users/user-1/notebookFiles/notebook-1/asset.png",
      width: 1600,
      height: 900,
      altText: "A labelled cell",
    });
    const right = centred.x! + centred.displayWidth!;
    const bottom = centred.y! + centred.displayHeight!;

    // Dragging up and left from the top-left grip grows the image outwards
    // while its bottom-right corner stays where the student left it.
    const fromTopLeft = resizeNotebookImageRef(centred, -120, -68, "top-left");
    expect(fromTopLeft.displayWidth).toBeGreaterThan(centred.displayWidth!);
    expect(fromTopLeft.x! + fromTopLeft.displayWidth!).toBeCloseTo(right, 0);
    expect(fromTopLeft.y! + fromTopLeft.displayHeight!).toBeCloseTo(bottom, 0);

    const fromTopRight = resizeNotebookImageRef(centred, 120, -68, "top-right");
    expect(fromTopRight.displayWidth).toBeGreaterThan(centred.displayWidth!);
    expect(fromTopRight.x).toBeCloseTo(centred.x!, 0);
    expect(fromTopRight.y! + fromTopRight.displayHeight!).toBeCloseTo(bottom, 0);

    const fromBottomLeft = resizeNotebookImageRef(
      centred,
      -120,
      68,
      "bottom-left"
    );
    expect(fromBottomLeft.displayWidth).toBeGreaterThan(centred.displayWidth!);
    expect(fromBottomLeft.x! + fromBottomLeft.displayWidth!).toBeCloseTo(
      right,
      0
    );
    expect(fromBottomLeft.y).toBeCloseTo(centred.y!, 0);

    // Dragging a corner inwards shrinks rather than grows.
    const shrunk = resizeNotebookImageRef(centred, 120, 68, "top-left");
    expect(shrunk.displayWidth).toBeLessThan(centred.displayWidth!);
    expect(shrunk.x! + shrunk.displayWidth!).toBeCloseTo(right, 0);

    // Every corner keeps the aspect ratio and the minimum display size.
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const) {
      const growsRight = corner.endsWith("right");
      const growsDown = corner.startsWith("bottom");
      for (const [dx, dy] of [[growsRight ? -60 : 60, 0], [0, growsDown ? -40 : 40]]) {
        const smaller = resizeNotebookImageRef(centred, dx, dy, corner);
        expect(smaller.displayWidth).toBeLessThan(centred.displayWidth!);
        expect(smaller.displayHeight).toBeLessThan(centred.displayHeight!);
        expect(growsRight ? smaller.x : smaller.x! + smaller.displayWidth!)
          .toBeCloseTo(growsRight ? centred.x! : right, 0);
        expect(growsDown ? smaller.y : smaller.y! + smaller.displayHeight!)
          .toBeCloseTo(growsDown ? centred.y! : bottom, 0);
      }
      const collapsed = resizeNotebookImageRef(centred, -5_000, -5_000, corner);
      expect(collapsed.displayWidth).toBeGreaterThanOrEqual(120);
      expect(collapsed.displayHeight).toBeGreaterThanOrEqual(120);
      const stretched = resizeNotebookImageRef(centred, 5_000, 5_000, corner);
      expect(
        stretched.displayWidth! / stretched.displayHeight!
      ).toBeCloseTo(centred.displayWidth! / centred.displayHeight!, 1);
      expect(stretched.x).toBeGreaterThanOrEqual(0);
      expect(stretched.y).toBeGreaterThanOrEqual(0);
      expect(stretched.x! + stretched.displayWidth!).toBeLessThanOrEqual(900);
      expect(stretched.y! + stretched.displayHeight!).toBeLessThanOrEqual(1240);
    }
  });

  /*
   * Firestore refuses an explicit `undefined`, and neither SDK in this app
   * enables `ignoreUndefinedProperties`. Every page image is built here, so an
   * absent optional field written as `undefined` made the whole page write
   * throw -- which is what stopped a Jami illustration, whose `localPreviewUrl`
   * is absent by definition, from ever being added to a page.
   */
  it("leaves absent optional fields out rather than writing undefined", () => {
    const fromAssistant = createCenteredNotebookImageRef({
      id: "jami-asset-1",
      storagePath: "users/user-1/notebookFiles/notebook-1/asset.png",
      width: 1024,
      height: 768,
    });

    expect(Object.hasOwn(fromAssistant, "localPreviewUrl")).toBe(false);
    expect(Object.hasOwn(fromAssistant, "altText")).toBe(false);
    expect(Object.hasOwn(fromAssistant, "sourceAssetId")).toBe(false);
    expect(
      Object.values(fromAssistant).some((value) => value === undefined)
    ).toBe(false);

    const legacy = normalizeNotebookImageRefs([{ id: "legacy-image" }])[0];
    expect(
      Object.values(legacy).some((value) => value === undefined)
    ).toBe(false);
    expect(Object.hasOwn(legacy, "storagePath")).toBe(false);

    // Values that are present still survive the round trip.
    const full = normalizeNotebookImageRefs([
      {
        id: "image-2",
        storagePath: "users/user-1/notebookFiles/notebook-1/b.png",
        altText: "A labelled cell",
        sourceAssetId: "assistant-asset-2",
        width: 800,
        height: 600,
      },
    ])[0];
    expect(full.storagePath).toBe("users/user-1/notebookFiles/notebook-1/b.png");
    expect(full.altText).toBe("A labelled cell");
    expect(full.sourceAssetId).toBe("assistant-asset-2");
  });
});
