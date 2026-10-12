import { expect, test, type Page } from "@playwright/test";
import {
  E2E_FOLDER_ID,
  E2E_IMAGE_ALT,
  E2E_IMAGE_PAGE_ID,
  E2E_NOTEBOOK_ID,
  E2E_PAGE_IDS,
  E2E_TEXT_MARKER,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./fixtures";

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

async function openNotebook(page: Page, pageId: string = E2E_PAGE_IDS[0]) {
  await page.goto(
    `/dashboard/notebooks/${E2E_NOTEBOOK_ID}?page=${pageId}`
  );
  const editor = page.getByTestId("notebook-editor");
  await expect(editor).toHaveAttribute("data-notebook-id", E2E_NOTEBOOK_ID);
  await expect(editor).toHaveAttribute(
    "data-notebook-selected-page-id",
    pageId
  );
  await expect(editor).toHaveAttribute("data-notebook-ink-ready", "true");
  await expect(
    page.getByRole("status", { name: "All changes saved" })
  ).toBeVisible();
  return editor;
}

test("signed-in notebook work autosaves and survives navigation and reload", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const editor = await openNotebook(page);

  await page.getByRole("button", { name: "Text box (T)" }).click();
  const drawingSurface = page.getByRole("img", {
    name: "Notebook drawing page",
  });
  const textSurfaceBox = await drawingSurface.boundingBox();
  expect(textSurfaceBox).not.toBeNull();
  await page.mouse.click(
    textSurfaceBox!.x + textSurfaceBox!.width * 0.52,
    textSurfaceBox!.y + textSurfaceBox!.height * 0.42
  );
  const textEditor = page.locator("[data-notebook-text-editor='true']");
  await textEditor.fill(E2E_TEXT_MARKER);
  await expect(
    page.getByRole("status", { name: "Unsaved changes" })
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "All changes saved" })
  ).toBeVisible({ timeout: 15_000 });
  await expect(textEditor).toBeVisible();
  await expect(textEditor).toBeFocused();
  await expect(textEditor).toHaveValue(E2E_TEXT_MARKER);

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(editor).toHaveAttribute(
    "data-notebook-selected-page-id",
    E2E_PAGE_IDS[1]
  );
  await expect(page).toHaveURL(
    new RegExp(`page=${E2E_PAGE_IDS[1]}(?:&|$)`)
  );
  await expect(editor).toHaveAttribute("data-notebook-ink-ready", "true");

  await page.getByRole("button", { name: "Pen (P)" }).click();
  const inkSurfaceBox = await drawingSurface.boundingBox();
  expect(inkSurfaceBox).not.toBeNull();
  const startX = inkSurfaceBox!.x + inkSurfaceBox!.width * 0.35;
  const startY = inkSurfaceBox!.y + inkSurfaceBox!.height * 0.4;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(
    startX + Math.min(140, inkSurfaceBox!.width * 0.2),
    startY + Math.min(90, inkSurfaceBox!.height * 0.14),
    { steps: 8 }
  );
  await page.mouse.up();
  await expect(editor).toHaveAttribute("data-notebook-has-ink", "true");
  await expect(
    page.getByRole("status", { name: "All changes saved" })
  ).toBeVisible({ timeout: 15_000 });

  const toolbar = page.getByRole("toolbar", { name: "Drawing tools" });
  // It starts in the top bar, clear of the page.
  await expect(toolbar).toHaveAttribute("data-toolbar-dock", "top");
  expect(
    await toolbar.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label"))
    )
  ).toEqual([
    "Pen (P)",
    "Highlighter (H)",
    "Eraser (E)",
    "Text box (T)",
    "Insert",
    "Undo (Ctrl+Z)",
    "Redo (Ctrl+Shift+Z)",
  ]);
  const floatingControlStyles = await page
    .locator(".notebook-floating-control")
    .evaluateAll((controls) =>
      controls.map((control) => {
        const style = window.getComputedStyle(control);
        return {
          backdropFilter: style.backdropFilter,
          boxShadow: style.boxShadow,
          webkitBackdropFilter: style.getPropertyValue(
            "-webkit-backdrop-filter"
          ),
        };
      })
    );
  // The page navigation: the toolbar floats only once it is dragged out of the top bar.
  expect(floatingControlStyles).toHaveLength(1);
  for (const style of floatingControlStyles) {
    expect(style).toMatchObject({
      backdropFilter: "none",
      boxShadow: "none",
    });
    expect(["", "none"]).toContain(style.webkitBackdropFilter);
  }
  const penControlBox = await page
    .getByRole("button", { name: "Pen (P)" })
    .boundingBox();
  expect(penControlBox).not.toBeNull();
  await page.mouse.move(
    penControlBox!.x + penControlBox!.width / 2,
    penControlBox!.y + penControlBox!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    penControlBox!.x + penControlBox!.width / 2 + 12,
    penControlBox!.y + penControlBox!.height / 2,
    { steps: 2 }
  );
  await expect(toolbar).toHaveAttribute("data-toolbar-dragging", "true");
  await page.mouse.move(
    18,
    inkSurfaceBox!.y + inkSurfaceBox!.height / 2,
    { steps: 12 }
  );
  await page.mouse.up();
  await expect(toolbar).toHaveAttribute("data-toolbar-dock", "left");
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");

  await page.reload();
  await expect(editor).toHaveAttribute(
    "data-notebook-selected-page-id",
    E2E_PAGE_IDS[1]
  );
  await expect(editor).toHaveAttribute("data-notebook-ink-ready", "true");
  await expect(editor).toHaveAttribute("data-notebook-has-ink", "true");
  await expect(toolbar).toHaveAttribute("data-toolbar-dock", "left");

  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(editor).toHaveAttribute(
    "data-notebook-selected-page-id",
    E2E_PAGE_IDS[0]
  );
  const persistedTextBlock = page
    .locator(".notebook-text-object")
    .filter({ hasText: E2E_TEXT_MARKER });
  const textBlockOptionsTrigger = page.getByRole("button", {
    name: "Text box options",
  });
  const textBlockOptionsMenu = page.getByRole("menu", {
    name: "Text box options",
  });
  const resizeHandles = page.locator("[data-text-resize-handle='true']");
  const clickPersistedTextBlockBody = async () => {
    const box = await persistedTextBlock.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(
      box!.x + Math.min(24, box!.width / 4),
      box!.y + box!.height / 2
    );
  };

  await expect(persistedTextBlock).toBeVisible();
  await expect(textEditor).toHaveCount(0);

  await clickPersistedTextBlockBody();
  await expect(textEditor).toHaveCount(0);
  await expect(textBlockOptionsTrigger).toBeVisible();
  await expect(resizeHandles).toHaveCount(4);

  await clickPersistedTextBlockBody();
  await expect(textEditor).toBeVisible();
  await expect(textEditor).toBeFocused();
  await textEditor.press("Escape");
  await expect(textEditor).toHaveCount(0);
  await expect(textBlockOptionsTrigger).toBeVisible();

  await textBlockOptionsTrigger.click();
  const outlineOption = page.getByRole("menuitemcheckbox", {
    name: "Show outline",
  });
  const deleteTextBlockOption = page.getByRole("menuitem", {
    name: "Delete text box",
  });
  await expect(textBlockOptionsMenu).toBeVisible();
  await expect(outlineOption).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(deleteTextBlockOption).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(textBlockOptionsMenu).toBeHidden();
  await expect(textBlockOptionsTrigger).toBeFocused();

  const originalTextBlockBox = await persistedTextBlock.boundingBox();
  const rightResizeHandle = page.getByRole("button", {
    name: "Resize text box from right edge",
  });
  const rightResizeHandleBox = await rightResizeHandle.boundingBox();
  expect(originalTextBlockBox).not.toBeNull();
  expect(rightResizeHandleBox).not.toBeNull();
  await page.mouse.move(
    rightResizeHandleBox!.x + rightResizeHandleBox!.width / 2,
    rightResizeHandleBox!.y + rightResizeHandleBox!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    rightResizeHandleBox!.x + rightResizeHandleBox!.width / 2 + 56,
    rightResizeHandleBox!.y + rightResizeHandleBox!.height / 2,
    { steps: 6 }
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await persistedTextBlock.boundingBox())?.width ?? 0)
    .toBeGreaterThan(originalTextBlockBox!.width + 20);

  const undoButton = page.getByRole("button", { name: "Undo (Ctrl+Z)" });
  await expect(undoButton).toBeEnabled();
  await undoButton.click();
  await expect
    .poll(async () => {
      const box = await persistedTextBlock.boundingBox();
      return Math.abs((box?.width ?? 0) - originalTextBlockBox!.width);
    })
    .toBeLessThan(2);
  await expect(
    page.getByRole("status", { name: "All changes saved" })
  ).toBeVisible({ timeout: 15_000 });

  await clickPersistedTextBlockBody();
  await clickPersistedTextBlockBody();
  await expect(textEditor).toBeVisible();
  await textBlockOptionsTrigger.click();
  await expect(textBlockOptionsMenu).toBeVisible();
  await expect(resizeHandles).toHaveCount(4);

  const nextPageButton = page.getByRole("button", { name: "Next page" });
  await nextPageButton.focus();
  await expect(textBlockOptionsMenu).toBeVisible();
  await nextPageButton.press("Enter");
  await expect(editor).toHaveAttribute(
    "data-notebook-selected-page-id",
    E2E_PAGE_IDS[1]
  );
  await expect(editor).toHaveAttribute("data-notebook-ink-ready", "true");
  await expect(textEditor).toHaveCount(0);
  await expect(textBlockOptionsMenu).toHaveCount(0);
  await expect(resizeHandles).toHaveCount(0);

  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(editor).toHaveAttribute(
    "data-notebook-selected-page-id",
    E2E_PAGE_IDS[0]
  );
  await expect(persistedTextBlock).toBeVisible();

  await page.getByRole("link", { name: "Back to folder" }).click();
  await expect(page).toHaveURL(`/dashboard/folders/${E2E_FOLDER_ID}`, {
    timeout: 60_000,
  });
  expect(pageErrors).toEqual([]);
});

test("a placed visual resizes from every corner and holds its place while it saves", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openNotebook(page, E2E_IMAGE_PAGE_ID);

  const moveHandle = page.getByRole("button", { name: `Move ${E2E_IMAGE_ALT}` });
  const cornerHandles = page.locator("[data-image-resize-handle]");
  const savedStatus = page.getByRole("status", { name: "All changes saved" });

  // A notebook opens on the pen, which draws over a visual rather than
  // grabbing it. Escape drops to select, where placed visuals are handled.
  await expect(moveHandle).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(moveHandle).toBeVisible();

  await moveHandle.click();
  await expect(cornerHandles).toHaveCount(4);
  expect(
    await cornerHandles.evaluateAll((handles) =>
      handles
        .map((handle) => handle.getAttribute("data-image-resize-handle"))
        .sort()
    )
  ).toEqual(["bottom-left", "bottom-right", "top-left", "top-right"]);
  await expect(savedStatus).toBeVisible({ timeout: 15_000 });

  /*
   * Drags are a fraction of the visual as it is drawn, not a pixel count, so
   * the gesture stays clear of the page edge whatever the notebook is zoomed
   * to and the resize maths is what gets tested.
   */
  const imageFrame = async () => {
    await moveHandle.scrollIntoViewIfNeeded();
    const box = await moveHandle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.width).toBeGreaterThan(40);
    return box!;
  };

  const dragCorner = async (
    corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
    widthRatio: number,
    heightRatio: number
  ) => {
    const frame = await imageFrame();
    const handleBox = await page
      .locator(`[data-image-resize-handle='${corner}']`)
      .boundingBox();
    expect(handleBox).not.toBeNull();
    const fromX = handleBox!.x + handleBox!.width / 2;
    const fromY = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(
      fromX + frame.width * widthRatio,
      fromY + frame.height * heightRatio,
      { steps: 8 }
    );
    await page.mouse.up();
  };

  /*
   * Sample the frame across the whole save round-trip. Dropping the drag
   * preview at pointer-up used to snap the visual back to its old size and
   * place until the write returned, so a single after-the-fact assertion would
   * have passed while the student still saw it jump.
   */
  const sampleWhileSaving = async () => {
    const frames: Array<{ left: number; top: number; width: number }> = [];
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const box = await moveHandle.boundingBox();
      if (box) frames.push({ left: box.x, top: box.y, width: box.width });
    }
    expect(frames.length).toBeGreaterThan(10);
    await expect(savedStatus).toBeVisible({ timeout: 15_000 });
    return frames;
  };

  // Pulling the top-left grip up and out grows the visual and leaves the
  // opposite corner where the student put it.
  const beforeGrow = await imageFrame();
  await dragCorner("top-left", -0.2, -0.2);
  const grownFrames = await sampleWhileSaving();
  const grown = await imageFrame();
  expect(grown.width).toBeGreaterThan(beforeGrow.width * 1.1);
  expect(
    Math.abs(grown.x + grown.width - (beforeGrow.x + beforeGrow.width))
  ).toBeLessThan(4);
  expect(
    Math.abs(grown.y + grown.height - (beforeGrow.y + beforeGrow.height))
  ).toBeLessThan(4);
  for (const frame of grownFrames) {
    expect(Math.abs(frame.width - grown.width)).toBeLessThan(4);
  }

  // The bottom-left grip pins the top-right corner, and dragging it inwards
  // shrinks rather than grows.
  const beforeShrink = await imageFrame();
  await dragCorner("bottom-left", 0.2, -0.2);
  const shrunkFrames = await sampleWhileSaving();
  const shrunk = await imageFrame();
  expect(shrunk.width).toBeLessThan(beforeShrink.width * 0.9);
  expect(
    Math.abs(shrunk.x + shrunk.width - (beforeShrink.x + beforeShrink.width))
  ).toBeLessThan(4);
  expect(Math.abs(shrunk.y - beforeShrink.y)).toBeLessThan(4);
  for (const frame of shrunkFrames) {
    expect(Math.abs(frame.width - shrunk.width)).toBeLessThan(4);
  }

  // The student's own report: shrink it, drag it to the top left, and it has
  // to stay there rather than teleport back and jitter into place.
  const beforeMove = await imageFrame();
  await page.mouse.move(
    beforeMove.x + beforeMove.width / 2,
    beforeMove.y + beforeMove.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    beforeMove.x + beforeMove.width * 0.2,
    beforeMove.y + beforeMove.height * 0.2,
    { steps: 10 }
  );
  await page.mouse.up();
  const movedFrames = await sampleWhileSaving();
  const moved = await imageFrame();
  expect(moved.x).toBeLessThan(beforeMove.x - beforeMove.width * 0.2);
  expect(moved.y).toBeLessThan(beforeMove.y - beforeMove.height * 0.2);
  expect(Math.abs(moved.width - beforeMove.width)).toBeLessThan(4);
  for (const frame of movedFrames) {
    expect(Math.abs(frame.left - moved.x)).toBeLessThan(4);
    expect(Math.abs(frame.top - moved.y)).toBeLessThan(4);
  }

  // Everything above has to be what was written, not just what was drawn.
  await page.reload();
  await expect(page.getByRole("img", { name: E2E_IMAGE_ALT })).toBeVisible();
  await page.keyboard.press("Escape");
  const reloaded = await imageFrame();
  expect(Math.abs(reloaded.x - moved.x)).toBeLessThan(4);
  expect(Math.abs(reloaded.y - moved.y)).toBeLessThan(4);
  expect(Math.abs(reloaded.width - moved.width)).toBeLessThan(4);
  expect(pageErrors).toEqual([]);
});

test("the pen settings carry the scribble-to-erase switch, on by default", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1366 });
  await signIn(page);
  await openNotebook(page);

  // Pressing the active tool opens its options, the GoodNotes pattern. The pen
  // is the tool a notebook opens on.
  await page.getByRole("button", { name: "Pen (P)" }).click();

  const scribbleSwitch = page.getByRole("switch", {
    name: "Scribble to erase",
  });
  await expect(scribbleSwitch).toBeVisible();
  await expect(scribbleSwitch).toHaveAttribute("aria-checked", "true");

  await scribbleSwitch.click();
  await expect(scribbleSwitch).toHaveAttribute("aria-checked", "false");

  // The preference is device-local and has to survive a reload.
  await page.reload();
  await page.getByRole("button", { name: "Pen (P)" }).click();
  await expect(
    page.getByRole("switch", { name: "Scribble to erase" })
  ).toHaveAttribute("aria-checked", "false");
});

test("tablet keeps notebook controls usable", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1366 });
  await signIn(page);
  await openNotebook(page);

  await expect(
    page.getByRole("toolbar", { name: "Drawing tools" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Pages" }).click();
  const drawer = page.getByRole("complementary", {
    name: "Notebook pages",
  });
  const pageList = page.getByRole("region", {
    name: "Notebook page list",
  });
  await expect(drawer).toBeVisible();
  await expect(pageList).toBeVisible();
  expect(
    await drawer.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        display: style.display,
        minHeight: style.minHeight,
      };
    })
  ).toEqual({
    display: "flex",
    minHeight: "0px",
  });
  expect(
    await pageList.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        minHeight: style.minHeight,
        overflowY: style.overflowY,
      };
    })
  ).toEqual({
    minHeight: "0px",
    overflowY: "auto",
  });
  await expect(page.getByRole("button", { name: "Open page 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New page" })).toBeVisible();
  await page.getByRole("button", { name: "Open page 1" }).click();
  await expect(page.getByRole("button", { name: "Open page 1" })).toBeHidden();
  await expect(
    page.getByLabel("Page navigation")
  ).toBeVisible();
});

test("phone stays in light editing mode by default", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await openNotebook(page);

  await expect(
    page.getByText(
      "Notebook editing works best on iPad or desktop.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue anyway" })
  ).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Drawing tools" })
  ).toHaveCount(0);
});
