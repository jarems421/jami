import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./fixtures";

const screenshotDirectory = "test-results/tutor-settings";

/**
 * Your Jami (memory and how Jami teaches), at the three widths the design system asks about.
 *
 * Tutor's settings were a drawer on the Tutor page; they are a page of their
 * own now, opened from it. This runs whenever Tutor personalisation is enabled
 * (the default). It proves the page opens from Tutor, its settings arrive
 * loaded, and nothing overflows a phone.
 */

/*
 * An explicit false value keeps the test aligned with deployments where the
 * feature has deliberately been disabled.
 */
test.skip(
  process.env.NEXT_PUBLIC_ENABLE_TUTOR_PERSONALISATION === "false",
  "Tutor personalisation is disabled for this run."
);

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

test("Your Jami holds up at every width", async ({ page }) => {
  mkdirSync(screenshotDirectory, { recursive: true });

  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await signIn(page);
  await page.goto("/dashboard/tutor");
  await expect(
    page.getByRole("heading", { name: "Jami", level: 1 })
  ).toBeVisible({ timeout: 45_000 });

  await page.getByRole("link", { name: /Your Jami/ }).first().click();
  await page.waitForURL(/\/dashboard\/tutor\/personalise$/, { timeout: 45_000 });
  await expect(page.getByText("How Jami teaches you")).toBeVisible({ timeout: 45_000 });

  // The settings must arrive loaded, not as a permanent skeleton: a settings
  // screen that never resolves looks identical to one that is slow.
  await expect(page.getByText("How Jami teaches", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("What each subject needs", { exact: true })).toBeVisible();

  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["tablet", 834, 1100],
    ["phone", 390, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${screenshotDirectory}/personalise-${name}.png`,
      fullPage: true,
    });

    const scrollWidth = await page.evaluate(() =>
      Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
    );
    expect(scrollWidth, `${name}: no sideways scroll`).toBeLessThanOrEqual(width + 1);
  }

  expect(errors).toEqual([]);
});
