import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./fixtures";

/**
 * Building a plan with Jami, at the widths students do it at: Jami's questions
 * beside the empty timetable on a laptop, in a drawer on a phone.
 *
 * Jami's answers were once laid out by the screen's width inside a column a
 * third of it: an exam's date and subject came out about eight rem each, and a
 * subject's name about two. The fields are measured here, not only pictured.
 * No plan is seeded, so the planner opens on building one.
 */

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

async function expectWiderThan(locator: Locator, pixels: number, what: string) {
  const box = await locator.boundingBox();
  expect(box?.width ?? 0, `${what} is ${Math.round(box?.width ?? 0)}px wide`).toBeGreaterThan(pixels);
}

test("Jami's questions have room to be answered", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  await page.goto("/dashboard/planner");
  await expect(page.getByText("Your timetable starts here")).toBeVisible({ timeout: 45_000 });

  // Asking for Jami when it is already beside the timetable puts the cursor in the first answer.
  await page.getByRole("button", { name: "Plan with Jami" }).click();
  const examName = page.getByPlaceholder("Chemistry Paper 1", { exact: true });
  await expect(examName).toBeFocused();
  await examName.fill("Chemistry Paper 1");
  await expectWiderThan(examName, 280, "The exam's name");
  await expectWiderThan(page.getByLabel("Date").first(), 280, "The exam's date");
  await expectWiderThan(page.getByLabel("Subject").first(), 280, "The exam's subject");
  await page.screenshot({ path: "test-results/plan-build-exams-desktop.png", fullPage: true, animations: "disabled" });

  await page.getByRole("button", { name: "That’s all of them" }).click();
  const subjectName = page.locator(".plan-subject-row p").first();
  await expect(subjectName).toBeVisible();
  await expectWiderThan(subjectName, 250, "A subject's name");
  await page.screenshot({ path: "test-results/plan-build-subjects-desktop.png", fullPage: true, animations: "disabled" });

  // On a phone the same questions open in a drawer, at the drawer's width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText("Your timetable starts here")).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Plan with Jami" }).first().click();
  await expect(page.getByLabel("Tell Jami what you need")).toBeVisible();
  await expectWiderThan(page.getByPlaceholder("Chemistry Paper 1", { exact: true }), 280, "The exam's name on a phone");
  const scrollWidth = await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth));
  expect(scrollWidth, "page scrolls sideways at 390px").toBeLessThanOrEqual(391);
  await page.screenshot({ path: "test-results/plan-build-phone.png", animations: "disabled" });

  expect(errors, errors.join("\n")).toEqual([]);
});
