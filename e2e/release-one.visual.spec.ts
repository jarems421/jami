import { expect, test, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./fixtures";

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

async function expectNoHorizontalOverflow(page: Page, viewportWidth: number) {
  const width = await page.evaluate(() =>
    Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
  );
  expect(width).toBeLessThanOrEqual(viewportWidth + 1);
}

test("Release 1 landing stays clear at desktop and phone sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Practice like the exam. Revise what it shows you.",
    })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Get marked" })).toBeVisible();
  await expectNoHorizontalOverflow(page, 1440);
  await page.screenshot({ path: "test-results/release-one-landing-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, 390);

  // On a phone the reason to sign in has to sit under the headline, not below
  // everything else on the page.
  const headline = await page
    .getByRole("heading", { level: 1 })
    .boundingBox();
  const signIn = await page
    .getByRole("button", { name: "Continue with Google" })
    .boundingBox();
  const steps = await page
    .getByRole("button", { name: "Get marked" })
    .boundingBox();
  expect(headline && signIn && steps).toBeTruthy();
  expect(signIn!.y).toBeGreaterThan(headline!.y);
  expect(signIn!.y).toBeLessThan(steps!.y);

  await page.screenshot({ path: "test-results/release-one-landing-phone.png", fullPage: true });
});

test("Release 1 navigation and study workspace stay usable across sizes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  const desktopNav = page.locator("nav[data-nav='sidebar']");
  await expect(desktopNav).toBeVisible();
  await expect(desktopNav.getByText("Study", { exact: true }).last()).toBeVisible();
  await expect(desktopNav.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Getting today ready.")).toBeHidden({ timeout: 45_000 });
  await expectNoHorizontalOverflow(page, 1440);
  await page.screenshot({ path: "test-results/release-one-today-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 1024, height: 1366 });
  await page.goto("/dashboard/practice");
  await expect(page.getByRole("heading", { name: "Folders", level: 1 })).toBeVisible();
  await expect(
    page.getByLabel("Loading folders and notebooks")
  ).toBeHidden({ timeout: 45_000 });
  await expectNoHorizontalOverflow(page, 1024);
  await page.screenshot({ path: "test-results/release-one-practice-tablet.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  await expect(page.getByText("Getting today ready.")).toBeHidden({ timeout: 45_000 });
  /*
   * One scrolling row, not a "More" sheet.
   *
   * This checked for a sheet behind a More button until b351da8 removed it and
   * left the test behind, so it had been failing on a design decision rather
   * than on a defect. What the check is actually for is that every destination
   * is reachable from the phone nav, and that is still true -- they are all in
   * one snap-scrolling row, which auto-scrolls to whichever is current.
   */
  const mobileNav = page.locator("nav[data-nav='bar']");
  await expect(mobileNav).toBeVisible();
  for (const label of ["Today", "Learn", "Practice", "Jami", "Cards"]) {
    await expect(mobileNav.getByText(label, { exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page, 390);
  await page.screenshot({ path: "test-results/release-one-today-phone.png", fullPage: true });

  // The workspace entries live in the same row, reached by scrolling it.
  for (const label of ["Topics", "Goals", "Stars", "Progress", "Account"]) {
    const entry = mobileNav.getByText(label, { exact: true });
    await expect(entry).toHaveCount(1);
    await entry.scrollIntoViewIfNeeded();
    await expect(entry).toBeVisible();
  }
  // Scrolling the nav must not drag the page sideways with it.
  await expectNoHorizontalOverflow(page, 390);
  await page.screenshot({ path: "test-results/release-one-nav-phone.png", fullPage: true });
  expect(errors).toEqual([]);
});
