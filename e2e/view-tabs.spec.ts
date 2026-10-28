import { expect, test, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./fixtures";

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

const surfaces = [
  { route: "/dashboard/decks", nav: "Flashcard views", active: "Decks", other: "All cards" },
  { route: "/dashboard/cards", nav: "Flashcard views", active: "All cards", other: "Decks" },
  { route: "/dashboard/tutor", nav: "Jami views", active: "Ask Jami", other: "Sources" },
  { route: "/dashboard/library", nav: "Jami views", active: "Sources", other: "Ask Jami" },
  { route: "/dashboard/tutor/personalise", nav: "Jami views", active: "Your Jami", other: "Ask Jami" },
  { route: "/dashboard/planner", nav: "Plan views", active: "Revision plan", other: "Goals" },
  { route: "/dashboard/goals", nav: "Plan views", active: "Goals", other: "Revision plan" },
] as const;

const widths = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 1024, height: 1366 },
  { name: "phone", width: 390, height: 844 },
] as const;

test("view tabs live in the top bar on every flashcards and tutor view", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);

  for (const surface of surfaces) {
    for (const size of widths) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(surface.route);

      const tabs = page.getByRole("navigation", { name: surface.nav });
      await expect(tabs).toBeVisible();

      // Both views stay visible; the one you are on is the one marked current.
      await expect(tabs.getByRole("link", { name: surface.active })).toHaveAttribute(
        "aria-current",
        "page"
      );
      const other = tabs.getByRole("link", { name: surface.other });
      await expect(other).toBeVisible();
      await expect(other).not.toHaveAttribute("aria-current", "page");

      // The tabs sit inside the top bar card, not in a shell of their own.
      const inTopBar = await tabs.evaluate(
        (node) => Boolean(node.closest(".app-topbar"))
      );
      expect(inTopBar, `${surface.route} @ ${size.name}`).toBe(true);

      // The sidebar entry stays lit across both views of the pair.
      if (size.width >= 768) {
        const rail = page.locator("nav[data-nav='sidebar']");
        await expect(
          rail.locator("[aria-current='page']")
        ).toHaveCount(1);
      }

      const scrollWidth = await page.evaluate(() =>
        Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
      );
      expect(scrollWidth, `${surface.route} @ ${size.name}`).toBeLessThanOrEqual(
        size.width + 1
      );

      const slug = surface.route.split("/").pop();
      await page.screenshot({
        path: `test-results/view-tabs-${slug}-${size.name}.png`,
      });
    }
  }

  expect(errors).toEqual([]);
});

test("a source deep link still lands on the right panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  await page.goto("/dashboard/library?source=e2e-source&panel=tutor");
  await expect(
    page.getByRole("navigation", { name: "Jami views" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Jami views" }).getByRole("link", {
      name: "Sources",
    })
  ).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: "test-results/view-tabs-source-deeplink.png" });
});
