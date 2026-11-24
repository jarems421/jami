// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/study/cards";
import type { OcclusionDiagram, OcclusionLabel, OcclusionShape } from "@/lib/study/image-occlusion";
import { buildDeterministicExercise } from "@/lib/study/mode-eligibility";

vi.mock("@/services/firebase/storage-files", () => ({
  createStorageFileId: vi.fn(() => "file-1"),
  deleteStorageFile: vi.fn(async () => undefined),
  getStorageFileDownloadUrl: vi.fn(async (path: string) => `https://files.test/${path}`),
  getStorageUploadErrorMessage: vi.fn(() => "upload failed"),
  sanitizeStorageFileName: vi.fn((name: string) => name),
  uploadStorageFile: vi.fn(async () => undefined),
}));

const { default: StudyExerciseStage } = await import("@/components/study/StudyExerciseStage");
const { default: StudyFlashcard } = await import("@/components/study/StudyFlashcard");
const { default: DiagramCanvas } = await import("@/components/decks/diagram/DiagramCanvas");
const { default: ZoomableArea } = await import("@/components/cards/ZoomableArea");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function label(id: string, answer: string, x: number): OcclusionLabel {
  return { id, answer, shapes: [{ kind: "rect", x, y: 0.1, width: 0.1, height: 0.05 }] };
}

const HEART: OcclusionDiagram = {
  id: "heart",
  image: { storagePath: "users/u/cardImages/file-1/heart.png", width: 1000, height: 800 },
  labelMode: "cover",
  hideOthers: true,
  labels: [
    label("a", "Aorta", 0.1),
    label("b", "Left atrium", 0.3),
    label("c", "Right atrium", 0.5),
    label("d", "Left ventricle", 0.7),
    label("e", "Right ventricle", 0.85),
  ],
};

const card: Card = {
  id: "card-b",
  userId: "u",
  deckId: "d",
  front: "",
  back: "Left atrium",
  tags: [],
  createdAt: 1,
  occlusion: { diagram: HEART, labelId: "b" },
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const figureLabel = () => host.querySelector('[role="img"]')?.getAttribute("aria-label");

describe("a diagram label in study", () => {
  it("asks with its box covered and says what to do, then uncovers it once answered", async () => {
    const exercise = buildDeterministicExercise(card, "type-answer", "hash")!;
    await act(async () =>
      root.render(
        <StudyExerciseStage card={card} exercise={exercise} savingRating={null} onCommit={vi.fn()} onModeAnswered={vi.fn()} />
      )
    );
    await act(async () => {});

    expect(figureLabel()).toBe("Diagram with label 2 of 5 hidden");
    expect(host.textContent).toContain("What is under the highlighted box?");
    // Every other label is covered too, the asked one in the accent.
    expect(host.querySelectorAll(".occlusion-mask")).toHaveLength(5);
    expect(host.querySelectorAll(".occlusion-mask--target")).toHaveLength(1);

    const field = host.querySelector<HTMLInputElement>("#study-answer-entry")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(field, "left atrium");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(figureLabel()).toBe("Diagram with label 2 of 5 shown: Left atrium");
    expect(host.querySelectorAll(".occlusion-outline--target")).toHaveLength(1);
  });

  it("draws its covers blank, in the colour the diagram was given", async () => {
    const coloured: Card = { ...card, occlusion: { diagram: { ...HEART, coverColor: "coral" }, labelId: "b" } };
    const exercise = buildDeterministicExercise(coloured, "type-answer", "hash")!;
    await act(async () =>
      root.render(
        <StudyExerciseStage card={coloured} exercise={exercise} savingRating={null} onCommit={vi.fn()} onModeAnswered={vi.fn()} />
      )
    );
    await act(async () => {});

    const masks = [...host.querySelectorAll(".occlusion-mask")];
    expect(masks).toHaveLength(5);
    expect(masks.every((mask) => mask.textContent === "")).toBe(true);
    expect(host.querySelector(".occlusion-figure")?.classList.contains("occlusion-cover--coral")).toBe(true);
  });

  it("marks naming a neighbour wrong without asking, shows it, and sends the mix-up with the rating", async () => {
    const exercise = buildDeterministicExercise(card, "type-answer", "hash")!;
    const onCommit = vi.fn();
    // "right atrium" shares a word with "left atrium", so local marking alone
    // would be unsure; knowing the diagram, it needs no second opinion.
    const onSemanticCheck = vi.fn(async () => null);
    await act(async () =>
      root.render(
        <StudyExerciseStage
          card={card}
          exercise={exercise}
          savingRating={null}
          onCommit={onCommit}
          onModeAnswered={vi.fn()}
          onSemanticCheck={onSemanticCheck}
        />
      )
    );
    const field = host.querySelector<HTMLInputElement>("#study-answer-entry")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(field, "right atrium");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSemanticCheck).not.toHaveBeenCalled();
    expect(host.textContent).toContain("That is another label on this diagram.");
    expect(host.querySelectorAll(".occlusion-outline--confused")).toHaveLength(1);
    expect(host.textContent).toContain("Right atrium is the label with the dashed amber outline");
    const next = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Next card");
    if (next) {
      await act(async () => next.click());
    } else {
      const again = Array.from(host.querySelectorAll("button")).find((button) => /again/i.test(button.textContent ?? ""))!;
      await act(async () => again.click());
    }
    expect(onCommit).toHaveBeenCalledWith(expect.any(String), { requeueOnMiss: true, confusedWithLabelId: "c" });
  });

  it("uncovers every label of a group card and names them all, when the picture has no labels", async () => {
    const group: Card = {
      ...card,
      id: "card-group",
      back: "Left atrium; Right atrium",
      occlusion: { diagram: { ...HEART, labelMode: "name", groups: [{ id: "g", name: "Atria", labelIds: ["b", "c"] }] }, groupId: "g" },
    };
    await act(async () =>
      root.render(<StudyFlashcard card={group} flipped onReveal={vi.fn()} deckName="Anatomy" deckColor="#8f7de8" topicNames={[]} />)
    );
    const back = host.querySelector(".study-flashcard-face-back")!;
    expect(back.textContent).toContain("Left atrium · Right atrium");
    expect(back.querySelectorAll(".occlusion-outline--target")).toHaveLength(2);
    const front = host.querySelector(".study-flashcard-face-front")!;
    expect(front.textContent).toContain("Atria: name the 2 marked parts.");
  });

  const whole: Card = {
    ...card,
    id: "card-whole",
    back: HEART.labels.map((entry) => entry.answer).join("; "),
    occlusion: {
      diagram: {
        ...HEART,
        cardStyle: "whole",
        groups: [{ id: "whole-diagram", name: "", labelIds: HEART.labels.map((entry) => entry.id) }],
      },
      groupId: "whole-diagram",
    },
  };

  it("lets a whole-diagram card be checked label by label before it is turned", async () => {
    const onReveal = vi.fn();
    await act(async () =>
      root.render(<StudyFlashcard card={whole} flipped={false} onReveal={onReveal} deckName="Anatomy" deckColor="#8f7de8" topicNames={[]} />)
    );
    const front = host.querySelector(".study-flashcard-face-front")!;
    expect(front.textContent).toContain("Name every covered label. Tap each label to check it (0 of 5).");

    const uncover = front.querySelector<HTMLButtonElement>('button[aria-label="Uncover label 2"]')!;
    await act(async () => uncover.click());
    // The box opened; the card did not turn.
    expect(onReveal).not.toHaveBeenCalled();
    expect(front.textContent).toContain("(1 of 5)");
    expect(front.querySelector('button[aria-label^="Cover label 2"]')).not.toBeNull();

    // A stray tap elsewhere never ends it; only its own button does.
    await act(async () => (front as HTMLElement).click());
    expect(onReveal).not.toHaveBeenCalled();
    const showAll = [...front.querySelectorAll("button")].find((button) => button.textContent === "Show all labels")!;
    await act(async () => showAll.click());
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("turns a whole-diagram card on its own once every label is uncovered", async () => {
    vi.useFakeTimers();
    try {
      const onReveal = vi.fn();
      await act(async () =>
        root.render(<StudyFlashcard card={whole} flipped={false} onReveal={onReveal} deckName="Anatomy" deckColor="#8f7de8" topicNames={[]} />)
      );
      const front = host.querySelector(".study-flashcard-face-front")!;
      for (const index of [1, 2, 3, 4]) {
        const box = front.querySelector<HTMLButtonElement>(`button[aria-label="Uncover label ${index}"]`)!;
        await act(async () => box.click());
      }
      await act(async () => vi.advanceTimersByTime(2000));
      // One still covered: nothing turns.
      expect(onReveal).not.toHaveBeenCalled();

      const last = front.querySelector<HTMLButtonElement>('button[aria-label="Uncover label 5"]')!;
      await act(async () => last.click());
      expect(onReveal).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(onReveal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides every other label in multiple choice even when the diagram hides only one", async () => {
    const hideOne: Card = { ...card, occlusion: { diagram: { ...HEART, hideOthers: false }, labelId: "b" } };
    const exercise = buildDeterministicExercise(hideOne, "multiple-choice", "hash", { seed: 3 })!;
    expect(exercise.mcq?.options).toHaveLength(4);
    await act(async () =>
      root.render(
        <StudyExerciseStage card={hideOne} exercise={exercise} savingRating={null} onCommit={vi.fn()} onModeAnswered={vi.fn()} />
      )
    );
    expect(host.querySelectorAll(".occlusion-mask")).toHaveLength(5);

    const option = host.querySelector<HTMLElement>('[role="radio"]')!;
    await act(async () => option.click());
    expect(figureLabel()).toMatch(/shown/);
  });

  it("shows the answer and offers the whole picture on the back of a flip card", async () => {
    await act(async () =>
      root.render(
        <StudyFlashcard card={card} flipped onReveal={vi.fn()} deckName="Anatomy" deckColor="#8f7de8" topicNames={[]} />
      )
    );
    const back = host.querySelector(".study-flashcard-face-back")!;
    // The picture prints the covered word, so uncovering it is the answer: no list of names under it.
    expect(back.textContent).not.toContain("Left atrium");
    expect(back.querySelectorAll(".occlusion-outline--target")).toHaveLength(1);
    const toggle = Array.from(back.querySelectorAll("button")).find((button) => button.textContent === "Show every label")!;
    await act(async () => toggle.click());
    // Unmasked: nothing covers the picture's own labels any more.
    expect(back.querySelectorAll(".occlusion-mask")).toHaveLength(0);
    expect(back.querySelector('[aria-pressed="true"]')?.textContent).toBe("Hide the other labels");
  });
});

describe("drawing on the diagram", () => {
  beforeAll(() => {
    HTMLElement.prototype.setPointerCapture ??= () => undefined;
  });

  function pointer(type: string, target: Element, x: number, y: number, pointerType = "mouse") {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.assign(event, { pointerId: 1, pointerType });
    target.dispatchEvent(event);
  }

  async function renderCanvas(props: Partial<Parameters<typeof DiagramCanvas>[0]> = {}) {
    const onDrawShape = vi.fn<(shape: OcclusionShape, pointerType: string) => void>();
    const onSelect = vi.fn();
    const onChangeShape = vi.fn();
    const onSetPointer = vi.fn();
    await act(async () =>
      root.render(
        <DiagramCanvas
          imageUrl="blob:heart"
          width={1000}
          height={800}
          labels={[]}
          labelMode="cover"
          tool="rect"
          zoom={1}
          selection={null}
          onSelect={onSelect}
          onDrawShape={onDrawShape}
          onChangeShape={onChangeShape}
          onSetPointer={onSetPointer}
          {...props}
        />
      )
    );
    const stage = host.querySelector<HTMLElement>(".cursor-crosshair, .touch-pan-x")!;
    // A 1000 x 800 picture drawn at 500 x 400 from the top left.
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 400, right: 500, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return { stage, onDrawShape, onSelect, onChangeShape, onSetPointer };
  }

  it("draws a box by dragging", async () => {
    const { stage, onDrawShape } = await renderCanvas();
    await act(async () => {
      pointer("pointerdown", stage, 100, 40);
      pointer("pointermove", stage, 200, 80);
      pointer("pointerup", stage, 200, 80);
    });
    expect(onDrawShape).toHaveBeenCalledWith({ kind: "rect", x: 0.2, y: 0.1, width: 0.2, height: 0.1 }, "mouse");
  });

  it("drops a label-sized box on a tap", async () => {
    const { stage, onDrawShape } = await renderCanvas({ tool: "ellipse" });
    await act(async () => {
      pointer("pointerdown", stage, 250, 200, "touch");
      pointer("pointerup", stage, 251, 201, "touch");
    });
    const [shape, pointerType] = onDrawShape.mock.calls[0];
    expect(pointerType).toBe("touch");
    expect(shape.kind).toBe("ellipse");
    expect(shape.x + shape.width / 2).toBeCloseTo(0.5, 2);
  });

  it("selects an existing box on a tap instead of drawing over it", async () => {
    const { stage, onDrawShape, onSelect } = await renderCanvas({ labels: [label("a", "Aorta", 0.4)] });
    await act(async () => {
      pointer("pointerdown", stage, 225, 45);
      pointer("pointerup", stage, 225, 45);
    });
    expect(onDrawShape).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({ labelId: "a", shapeIndex: 0 });
  });

  it("moves a box as one gesture", async () => {
    const { onChangeShape } = await renderCanvas({ tool: "ellipse", labels: [label("a", "Aorta", 0.4)] });
    const box = host.querySelector<HTMLElement>(".occlusion-edit-shape")!;
    await act(async () => {
      pointer("pointerdown", box, 225, 45);
      pointer("pointermove", box, 250, 45);
      pointer("pointermove", box, 275, 45);
      pointer("pointerup", box, 275, 45);
    });
    const gestures = new Set(onChangeShape.mock.calls.map((call) => call[3]));
    expect(gestures.size).toBe(1);
    expect(onChangeShape.mock.calls.at(-1)?.[2]).toMatchObject({ x: 0.5, y: 0.1 });
  });

  it("moves a box dragged while drawing, without switching to Move", async () => {
    const { onChangeShape, onDrawShape, onSelect } = await renderCanvas({ tool: "rect", labels: [label("a", "Aorta", 0.4)] });
    const box = host.querySelector<HTMLElement>(".occlusion-edit-shape")!;
    await act(async () => {
      pointer("pointerdown", box, 225, 45);
      pointer("pointermove", box, 275, 45);
      pointer("pointerup", box, 275, 45);
    });
    expect(onSelect).toHaveBeenCalledWith({ labelId: "a", shapeIndex: 0 });
    expect(onChangeShape.mock.calls.at(-1)?.[2]).toMatchObject({ x: 0.5, y: 0.1 });
    expect(onDrawShape).not.toHaveBeenCalled();
  });

  it("draws a line from a box to the part it names", async () => {
    const { stage, onSetPointer, onSelect } = await renderCanvas({ tool: "pointer", labels: [label("a", "Aorta", 0.4)] });
    await act(async () => {
      pointer("pointerdown", stage, 225, 45);
      pointer("pointermove", stage, 260, 120);
      pointer("pointerup", stage, 300, 200);
    });
    expect(onSetPointer).toHaveBeenCalledWith("a", { x: 0.6, y: 0.5 });
    expect(onSelect).toHaveBeenLastCalledWith({ labelId: "a", shapeIndex: 0 });
  });

  it("points the selected label's line where a finger taps", async () => {
    const { stage, onSetPointer } = await renderCanvas({
      tool: "pointer",
      labels: [label("a", "Aorta", 0.4)],
      selection: { labelId: "a", shapeIndex: 0 },
    });
    await act(async () => {
      pointer("pointerdown", stage, 100, 300, "touch");
      pointer("pointerup", stage, 100, 300, "touch");
    });
    expect(onSetPointer).toHaveBeenCalledWith("a", { x: 0.2, y: 0.75 });
  });

  it("selects a box tapped with the Line tool instead of pointing at it", async () => {
    const { stage, onSetPointer, onSelect } = await renderCanvas({ tool: "pointer", labels: [label("a", "Aorta", 0.4)] });
    await act(async () => {
      pointer("pointerdown", stage, 225, 45);
      pointer("pointerup", stage, 225, 45);
    });
    expect(onSetPointer).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({ labelId: "a", shapeIndex: 0 });
  });

  it("does nothing with the Line tool when there is no box to draw from", async () => {
    const { stage, onSetPointer, onDrawShape } = await renderCanvas({ tool: "pointer", labels: [label("a", "Aorta", 0.4)] });
    await act(async () => {
      pointer("pointerdown", stage, 100, 300);
      pointer("pointerup", stage, 100, 300);
    });
    expect(onSetPointer).not.toHaveBeenCalled();
    expect(onDrawShape).not.toHaveBeenCalled();
  });

  it("traces an outline round a part", async () => {
    const { stage, onDrawShape } = await renderCanvas({ tool: "outline" });
    await act(async () => {
      // A circle round (200, 150), starting and ending at its top.
      pointer("pointerdown", stage, 200, 100);
      for (let step = 1; step <= 24; step += 1) {
        const angle = (step / 24) * Math.PI * 2;
        pointer("pointermove", stage, 200 + 50 * Math.sin(angle), 150 - 50 * Math.cos(angle));
      }
      pointer("pointerup", stage, 200, 100);
    });
    const [shape] = onDrawShape.mock.calls[0];
    expect(shape.kind).toBe("polygon");
    expect(shape.points?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("looking closer", () => {
  function press(type: string, target: Element, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.assign(event, { pointerId: 1, pointerType: "touch" });
    target.dispatchEvent(event);
  }

  it("lets a tap through to the picture, but not the end of a drag", async () => {
    HTMLElement.prototype.setPointerCapture ??= () => undefined;
    const onTap = vi.fn();
    await act(async () =>
      root.render(
        <div style={{ width: 400, height: 300 }}>
          <ZoomableArea>
            <button type="button" onClick={onTap}>
              Box
            </button>
          </ZoomableArea>
        </div>
      )
    );
    const box = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Box")!;
    await act(async () => {
      press("pointerdown", box, 10, 10);
      press("pointerup", box, 10, 10);
      box.click();
    });
    expect(onTap).toHaveBeenCalledTimes(1);

    await act(async () => {
      press("pointerdown", box, 10, 10);
      press("pointermove", box, 60, 60);
      press("pointerup", box, 60, 60);
      box.click();
    });
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});
