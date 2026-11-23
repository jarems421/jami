import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import {
  buildPdfPageText,
  docxNodesToPages,
  extractSourcePagesForIndex,
  pptxNodesToPages,
  splitTextIntoPages,
} from "@/lib/ai/source-extraction";
import { detectSourceOutline } from "@/lib/ai/source-outline";
import type { Source } from "@/lib/material/sources";
import { renderPdfPages } from "@/services/ai/notebook-page-render.server";

it("renders a PDF with a clipped vector region on the first page", async () => {
  const document = new PDFDocument({ size: [160, 120] });
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const data: Buffer[] = [];
    document.on("data", (chunk: Buffer) => data.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(data)));
    document.save().rect(10, 10, 80, 60).clip().circle(32, 32, 30).fill("black").restore();
    document.end();
  });
  const pages = await renderPdfPages(bytes, [0]);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({ pageIndex: 0, width: 320, height: 240 });
  expect(pages[0].bytes.subarray(1, 4).toString()).toBe("PNG");
});

function fileSource(fileType: string): Source {
  return {
    id: "source-1",
    title: "Thermal physics",
    type: "file",
    fileName: "pack",
    fileType,
    storagePath: "users/u/sourceFiles/source-1/pack",
    folderIds: [],
    topicIds: [],
    status: "active",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A small slide-shaped PDF: a big title and body text on each page. */
function lecturePdf(lectures: number, slidesPerLecture: number) {
  return new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument({ size: [960, 540], autoFirstPage: false });
    const parts: Buffer[] = [];
    doc.on("data", (part: Buffer) => parts.push(part));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    for (let lecture = 1; lecture <= lectures; lecture += 1) {
      for (let slide = 0; slide < slidesPerLecture; slide += 1) {
        doc.addPage();
        doc.fontSize(32).text(slide === 0 ? `Lecture ${lecture}: Topic ${lecture}` : `Slide ${lecture}.${slide}`, 40, 30);
        doc.fontSize(16).text(`Body of lecture ${lecture}, slide ${slide}.`, 40, 120, { width: 860 });
      }
    }
    doc.end();
  });
}

describe("extracting a whole source for its index", () => {
  it("keeps a PDF page's lines, and finds its heading by size", () => {
    const { text, heading } = buildPdfPageText([
      { str: "Lecture 4: Entropy", hasEOL: true, height: 32, transform: [32, 0, 0, 32, 40, 480] },
      { str: "Entropy measures", height: 16, transform: [16, 0, 0, 16, 40, 400] },
      { str: " disorder.", hasEOL: true, height: 16, transform: [16, 0, 0, 16, 180, 400] },
      { str: "It always increases.", hasEOL: true, height: 16, transform: [16, 0, 0, 16, 40, 380] },
      { str: "A new paragraph.", hasEOL: true, height: 16, transform: [16, 0, 0, 16, 40, 300] },
    ]);
    expect(heading).toBe("Lecture 4: Entropy");
    expect(text).toBe(
      "Lecture 4: Entropy\n\nEntropy measures disorder.\nIt always increases.\n\nA new paragraph."
    );
  });

  it("reads every page of a long PDF, past where a whole read stops", async () => {
    const bytes = await lecturePdf(14, 3);
    const extracted = await extractSourcePagesForIndex(fileSource("application/pdf"), async () => bytes);
    expect(extracted?.pages).toHaveLength(42);
    expect(extracted?.pages[39]).toMatchObject({ pageNumber: 40, heading: "Lecture 14: Topic 14" });
    const outline = detectSourceOutline(extracted?.pages ?? []);
    expect(outline.sections).toHaveLength(14);
    expect(outline.sections[3]).toMatchObject({ label: "Lecture 4: Topic 4", pageStart: 10, pageEnd: 12 });
  });

  it("makes one page per slide, titled by the slide's title, with its speaker notes", () => {
    const pages = pptxNodesToPages([
      {
        type: "slide",
        metadata: { slideNumber: 7 },
        children: [
          { type: "heading", text: "Lecture 2: Heat engines" },
          { type: "paragraph", text: "Efficiency is work out over heat in." },
        ],
        notes: [{ type: "paragraph", text: "Mention Carnot." }],
      },
      { type: "slide", metadata: { slideNumber: 8 }, children: [] },
    ]);
    expect(pages).toEqual([
      {
        pageNumber: 7,
        heading: "Lecture 2: Heat engines",
        text: "Lecture 2: Heat engines\n\nEfficiency is work out over heat in.\n\nSpeaker notes: Mention Carnot.",
      },
    ]);
  });

  it("splits a Word document at its headings and keeps their level", () => {
    const pages = docxNodesToPages([
      { type: "paragraph", text: "Preface text." },
      { type: "heading", text: "Chapter 1: Cells", metadata: { level: 1 } },
      { type: "paragraph", text: "Cells are the unit of life." },
      { type: "heading", text: "Organelles", metadata: { level: 2 } },
      { type: "paragraph", text: "Mitochondria." },
      { type: "heading", text: "A small heading", metadata: { level: 3 } },
      { type: "paragraph", text: "Detail." },
    ]);
    expect(pages).toEqual([
      { text: "Preface text." },
      { heading: "Chapter 1: Cells", headingLevel: 1, text: "Chapter 1: Cells\n\nCells are the unit of life." },
      {
        heading: "Organelles",
        headingLevel: 2,
        text: "Organelles\n\nMitochondria.\n\nA small heading\n\nDetail.",
      },
    ]);
  });

  it("splits pasted text where a new lecture or top-level heading starts", () => {
    const pages = splitTextIntoPages(
      "Intro line\nLecture 1: Heat\nHeat flows.\n# Summary\nAll done.\nLecture 2 was about work."
    );
    expect(pages.map((page) => page.heading)).toEqual([undefined, "Lecture 1: Heat", "Summary"]);
    expect(pages[2]).toMatchObject({ headingLevel: 1 });
    // A sentence that mentions a lecture does not start one.
    expect(pages[2].text).toContain("Lecture 2 was about work.");
  });

  it("leaves an image to be indexed from its picture", async () => {
    expect(await extractSourcePagesForIndex(fileSource("image/png"), async () => Buffer.from("x"))).toBeNull();
  });
});
