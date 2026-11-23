import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, type DocumentData } from "firebase/firestore";
import {
  E2E_MODES_CARDS,
  E2E_MODES_DECK_ID,
  E2E_PROJECT_ID,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./fixtures";

/**
 * One pass through the study modes, in one browser, for eyes rather than CI.
 *
 * The assertion-per-step version cost half an hour a run on this machine
 * because every miss sat on its timeout. This walks the whole thing once,
 * reports what is actually on screen at each step, and asserts only at the end
 * -- so a single run tells you what happened instead of which selector missed.
 */

const EMAIL = E2E_USER_EMAIL;
const PASSWORD = E2E_USER_PASSWORD;
const DECK = E2E_MODES_DECK_ID;
const OUT = "test-results/shots";

const log = (...parts: unknown[]) => console.log("·", ...parts);

test("study modes walkthrough", async ({ page }) => {
  test.setTimeout(420_000);
  mkdirSync(OUT, { recursive: true });

  const shoot = async (name: string) => {
    await page.screenshot({ path: `${OUT}/${name}.png` });
    log("shot", name);
  };

  const describeStudyScreen = async () =>
    page.evaluate(() => ({
      // The mode control is a dropdown now, so the options only exist in the
      // DOM while it is open. What is always on screen is the trigger, showing
      // whichever mode this session would start in.
      picker: Boolean(document.querySelector("[data-study-mode-picker]")),
      pickers: document.querySelectorAll("[data-study-mode-picker]").length,
      mode:
        document
          .querySelector("[data-study-mode-picker] button")
          ?.textContent?.trim() ?? null,
      openOptions: document.querySelectorAll(
        "[data-study-mode-picker] [role=\"option\"]"
      ).length,
      preparing: Boolean(document.querySelector("[data-study-preparing]")),
      inSession: Boolean(document.querySelector("[data-study-current-card-id]")),
      answerField: Boolean(document.querySelector("#study-answer-entry")),
      mcqOptions: document.querySelectorAll(
        '[aria-label="Answer choices"] [role="radio"]'
      ).length,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      heading: document.querySelector("h2")?.textContent?.trim() ?? null,
    }));

  const seen: Record<string, unknown> = {};

    await page.goto("/auth");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 60_000 });
    log("signed in");

    await page.goto(`/dashboard/study?decks=${DECK}`);
    // Wait for the surface rather than a fixed sleep: the first load reads
    // decks, cards, topics and the daily-review state, and on a loaded machine
    // that is well past any timeout worth hard-coding.
    await page
      .locator("[data-study-mode-picker]")
      .or(page.getByRole("button", { name: "End session" }))
      .first()
      .waitFor({ state: "visible", timeout: 90_000 });
    log("study screen:", JSON.stringify(await describeStudyScreen()));

    const endSession = page.getByRole("button", { name: "End session" });
    if (await endSession.count()) {
      await endSession.click();
      await page.waitForTimeout(3_000);
      log("ended a restored session");
      // Ending it leaves the builder on that session's decks -- another
      // spec's, usually the offline deck -- so open this walk's own link again.
      await page.goto(`/dashboard/study?decks=${DECK}`);
      await page
        .locator("[data-study-mode-picker]")
        .first()
        .waitFor({ state: "visible", timeout: 90_000 });
      log("study screen:", JSON.stringify(await describeStudyScreen()));
    }

    for (const { name, width, height } of [
      { name: "home-desktop", width: 1440, height: 900 },
      { name: "home-tablet", width: 834, height: 1112 },
      { name: "home-phone", width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(800);
      const state = await describeStudyScreen();
      seen[name] = state;
      log(name, JSON.stringify(state));
      await shoot(name);
    }

    await page.setViewportSize({ width: 1440, height: 900 });

    const builder = page.locator("#focused-review-builder");
    const start = builder.getByRole("button", { name: "Start Focused Review" });
    // The builder opens inside the Focused Review card, and its own copy of the
    // mode dropdown is the one this walk drives.
    const modeTrigger = builder
      .locator("[data-study-mode-picker] button")
      .first();

    for (const mode of ["Type Answer", "Gap Fill", "Multiple Choice"]) {
      if (!(await modeTrigger.count())) {
        log(`SKIP ${mode}: no mode dropdown on screen`);
        continue;
      }
      await modeTrigger.click();
      await page.waitForTimeout(300);
      const option = builder.getByRole("option", {
        name: new RegExp(`^${mode}`),
      });
      if (!(await option.count())) {
        log(`SKIP ${mode}: not offered by the dropdown`);
        await page.keyboard.press("Escape");
        continue;
      }
      await option.click();
      await page.waitForTimeout(600);
      await shoot(`picked-${mode.replace(/\s+/g, "-").toLowerCase()}`);

      if (!(await start.count())) {
        log(`SKIP ${mode}: no start button`);
        continue;
      }
      await start.click();
      // A mode that needs questions written first shows a preparing screen.
      // The emulator has no AI provider, so nothing will arrive: start now,
      // the way a student would, instead of waiting out the budget.
      const startNow = page.getByRole("button", { name: "Start now" });
      await startNow.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);
      if (await startNow.count()) {
        await startNow.click();
        log(`${mode}: started without waiting for preparation`);
      }
      await expect(page.locator("[data-study-preparing]")).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator("[data-study-current-card-id]")).toBeVisible({ timeout: 45_000 });
      await page.waitForTimeout(1_000);
      const modeState = await describeStudyScreen();
      seen[mode] = modeState;
      log(mode, JSON.stringify(modeState));
      await shoot(`session-${mode.replace(/\s+/g, "-").toLowerCase()}`);

      if (mode === "Type Answer" && (await page.locator("#study-answer-entry").count())) {
        await page.locator("#study-answer-entry").fill("not the answer at all");
        await page.getByRole("button", { name: "Check answer" }).click();
        await page.waitForTimeout(1_500);
        await shoot("type-answer-missed");
        log("after a miss:", JSON.stringify(await describeStudyScreen()));
      }

      const end = page.getByRole("button", { name: "End session" });
      if (await end.count()) {
        await end.click();
        await page.waitForTimeout(3_000);
      }
    }
  // Asserted once, at the end, on what the walk actually saw.
  expect(seen["home-desktop"], "the mode dropdown renders").toMatchObject({
    picker: true,
    mode: expect.stringContaining("Classic"),
  });
  for (const width of ["home-desktop", "home-tablet", "home-phone"]) {
    expect(
      (seen[width] as { overflow: number }).overflow,
      `${width} must not scroll sideways`
    ).toBeLessThanOrEqual(1);
  }
  expect(seen["Type Answer"], "Type Answer asks for an answer").toMatchObject({
    answerField: true,
  });
  expect(seen["Gap Fill"], "Gap Fill asks for an answer").toMatchObject({
    answerField: true,
  });
  expect(
    (seen["Multiple Choice"] as { mcqOptions: number }).mcqOptions,
    "Multiple Choice offers four options"
  ).toBe(4);
});

type StudyAssetTestWindow = Window & {
  testStudyAssetReceivers?: ReadableStreamDefaultController<Uint8Array>[];
};

test("checked options arrive during a cold Multiple Choice session", async ({ page }) => {
  const emulator = await initializeTestEnvironment({ projectId: E2E_PROJECT_ID });
  const stored = new Map<string, DocumentData>();
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    const receivers: ReadableStreamDefaultController<Uint8Array>[] = [];
    (window as StudyAssetTestWindow).testStudyAssetReceivers = receivers;
    window.fetch = async (request, options) => {
      if (typeof request !== "string" || request !== "/api/ai/study-assets/jobs") return originalFetch(request, options);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"started"}\n'));
          receivers.push(controller);
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    };
  });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  try {
    await emulator.withSecurityRulesDisabled(async (context) => {
      await Promise.all(E2E_MODES_CARDS.map(async ({ id }) => {
        const asset = doc(context.firestore(), "cardStudyAssets", id);
        const data = (await getDoc(asset)).data();
        if (!data) throw new Error("Missing prepared test asset");
        stored.set(id, data);
        await deleteDoc(asset);
      }));
    });
    await page.goto("/auth");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/dashboard$/);
    await page.goto(`/dashboard/study?decks=${DECK}`);
    const restored = page.getByRole("button", { name: "End session" });
    if (await restored.count()) {
      await restored.click();
      await page.goto(`/dashboard/study?decks=${DECK}`);
    }
    const builder = page.locator("#focused-review-builder");
    await builder.locator("[data-study-mode-picker] button").first().click();
    await builder.getByRole("option", { name: /^Multiple Choice/ }).click();
    await builder.getByRole("button", { name: "Start Focused Review" }).click();
    await expect(page.getByRole("heading", { name: "Writing this question" })).toBeVisible();
    const currentId = await page.locator("[data-study-current-card-id]").getAttribute("data-study-current-card-id");
    const asset = currentId ? stored.get(currentId) : undefined;
    expect(asset).toBeDefined();
    await expect.poll(() => page.evaluate(() =>
      (window as StudyAssetTestWindow).testStudyAssetReceivers?.length ?? 0
    )).toBeGreaterThan(0);
    await page.evaluate((storedAsset) => {
      const { asset, ...metadata } = storedAsset;
      const ready = new TextEncoder().encode(JSON.stringify({ type: "asset", asset: { ...asset, ...metadata } }) + "\n");
      (window as StudyAssetTestWindow).testStudyAssetReceivers?.forEach((controller) => controller.enqueue(ready));
    }, asset!);
    const choices = page.getByRole("radiogroup", { name: "Answer choices" }).getByRole("radio");
    await expect(choices).toHaveCount(4);
    const shown = await choices.allTextContents();
    // The response is still open. Rendering came from the first completed card.
    for (const width of [820, 390]) {
      await page.setViewportSize({ width, height: 840 });
      await expect(choices.first()).toBeVisible();
      await expect(choices).toHaveText(shown);
    }
    expect(errors).toEqual([]);
    await page.getByRole("button", { name: "End session" }).click();
  } finally {
    await emulator.withSecurityRulesDisabled(async (context) => {
      await Promise.all([...stored].map(([id, data]) => setDoc(doc(context.firestore(), "cardStudyAssets", id), data)));
    });
    await emulator.cleanup();
  }
});
