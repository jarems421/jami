import { expect, test, type Page } from "@playwright/test";
import {
  E2E_CARDS,
  E2E_DECK_NAME,
  E2E_GOAL,
  E2E_SOURCE,
  E2E_TOPIC,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./fixtures";
import { FLASHCARDS_TITLE } from "@/lib/app/flashcard-views";
import { TUTOR_TITLE } from "@/lib/app/tutor-views";

/**
 * Headings come from the same constants the pages render, deliberately.
 *
 * Seven of these timed out for two days, waiting 45 seconds each for "Decks",
 * "Cards" and "Sources". None of those headings existed: the surfaces were
 * renamed to Flashcards and Tutor and the tests were not. Nothing was flaky and
 * no timeout was too short -- raising one would only have made them fail
 * slower.
 *
 * What a smoke test earns its place doing here is proving the screen loads and
 * renders its own heading. Which words that heading uses is a product decision,
 * and pinning it to a literal turns every rename into a red suite that says
 * nothing about the thing it broke.
 */

/**
 * The browse screens had no browser coverage at all, so a page that threw on
 * load, rendered its empty state over real data, or lost its filters would
 * have reached the deploy unnoticed. These are deliberately shallow: each one
 * signs in, opens a screen, and proves the seeded row is on it.
 */

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

/** Opens a dashboard screen and waits for its heading. */
async function openScreen(page: Page, path: string, heading: string) {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible({
    timeout: 45_000,
  });
  return errors;
}

/**
 * Installed as a PWA, the app launches at `/`, which is the sign-in page. It
 * used to render the sign-in form straight away and only redirect once the
 * session finished restoring, so every launch flashed "sign in" at somebody who
 * already had.
 */
test("launching while already signed in never offers to sign in", async ({
  page,
}) => {
  await signIn(page);

  // The launch an installed app makes: straight to the start URL.
  await page.goto("/");

  // Whatever is on screen while the session restores, it is not this.
  await expect(
    page.getByRole("button", { name: "Continue with Google" })
  ).toHaveCount(0);
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
});

/**
 * A launch that is the same session resumed returns to the page that was open;
 * one after the app was properly closed opens at home.
 */
test("relaunching returns to the page that was open, unless the app was closed", async ({
  page,
}) => {
  await signIn(page);
  await openScreen(page, "/dashboard/decks", FLASHCARDS_TITLE);

  await page.goto("/");
  await page.waitForURL(/\/dashboard\/decks/, { timeout: 45_000 });

  // Closing the app properly ends the session, and with it the memory of where
  // they were. Playwright cannot close a PWA, so this clears what closing one
  // clears.
  await page.evaluate(() => window.sessionStorage.clear());
  await page.goto("/");
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
});

test("the legacy Practice route redirects permanently and keeps its query", async ({
  request,
}) => {
  const response = await request.get(
    "/dashboard/practise?agent=1&source=first&source=second",
    { maxRedirects: 0 }
  );
  expect(response.status()).toBe(308);

  const destination = new URL(
    response.headers().location ?? "",
    "http://127.0.0.1:3100"
  );
  expect(destination.pathname).toBe("/dashboard/practice");
  expect(destination.searchParams.get("agent")).toBe("1");
  expect(destination.searchParams.getAll("source")).toEqual([
    "first",
    "second",
  ]);
});

test("Sources lists saved sources and filters them", async ({ page }) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/library", TUTOR_TITLE);

  // The first screen in the run that reads anything, so it pays for the
  // Firestore connection and this route's first render on top of its own work.
  // Measured at 28s running second and past 45s running first, which is why
  // this one wait is longer than its neighbours rather than the suite reporting
  // a different failure depending on how busy the machine was.
  await expect(page.getByText(E2E_SOURCE.title).first()).toBeVisible({ timeout: 90_000 });

  // A search that cannot match must not leave the previous list on screen.
  const search = page.getByLabel("Search Sources");
  await search.fill("zzzz-no-such-source");
  await expect(page.getByText(E2E_SOURCE.title)).toHaveCount(0);

  await search.fill("");
  await expect(page.getByText(E2E_SOURCE.title).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("Cards lists seeded cards and searches their fronts", async ({ page }) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/cards", FLASHCARDS_TITLE);

  const search = page.getByPlaceholder("Search card fronts");
  await search.fill(E2E_CARDS[0].front);
  await expect(page.getByText(E2E_CARDS[0].front).first()).toBeVisible({
    timeout: 45_000,
  });

  // The other seeded card must drop out, or the filter is not applied.
  await expect(page.getByText(E2E_CARDS[1].front)).toHaveCount(0);

  await page.getByRole("button", { name: "From notes or file" }).click();
  await expect(page.getByText("PDF, PowerPoint, Word, text or image · under 20 MB")).toBeVisible();
  // How much of the material becomes cards is a choice of coverage, not a count.
  const coverage = page.getByRole("radiogroup", { name: "Coverage" });
  await expect(coverage.getByRole("radio", { name: /^Key points/ })).toBeVisible();
  await expect(coverage.getByRole("radio", { name: /^Standard/ })).toBeChecked();
  await expect(coverage.getByRole("radio", { name: /^Thorough/ })).toBeVisible();
  await expect(page.getByLabel("Most cards to make (optional)")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("Topics lists topics and filters them", async ({ page }) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/topics", "Topics");

  const search = page.getByLabel("Search Topics");
  await search.fill(E2E_TOPIC.name);
  await expect(page.getByText(E2E_TOPIC.name).first()).toBeVisible({
    timeout: 45_000,
  });

  await search.fill("zzzz-no-such-topic");
  await expect(page.getByText(E2E_TOPIC.name)).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("Decks lists the seeded deck", async ({ page }) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/decks", FLASHCARDS_TITLE);

  await expect(page.getByText(E2E_DECK_NAME).first()).toBeVisible({
    timeout: 45_000,
  });
  // Each deck's count is asked of the server once the list is shown, rather
  // than worked out from every card the student owns; the seeded deck has two.
  await expect(page.getByText(/^2 cards\b/).first()).toBeVisible({
    timeout: 45_000,
  });
  // The create field is the page's main action; losing it makes the screen
  // read-only without anything failing.
  await expect(page.getByPlaceholder("Deck name")).toBeVisible();

  expect(errors).toEqual([]);
});

test("Goals lists an active goal", async ({ page }) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/goals", "Plan");

  await expect(page.getByText(E2E_GOAL.name).first()).toBeVisible({
    timeout: 45_000,
  });

  expect(errors).toEqual([]);
});

test("Progress renders its sections rather than failing to load them", async ({
  page,
}) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/progress", "Progress");

  // Progress shows numbers rather than charts now; each section is read
  // separately, so one failing would leave a gap rather than an error.
  await expect(page.getByRole("heading", { name: "How well you remember" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole("heading", { name: "Deck health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This week" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: /^Browser smoke deck: remembering/ })).toBeVisible();

  expect(errors).toEqual([]);
});

test("Stars opens the constellation view", async ({ page }) => {
  await signIn(page);
  const errors = await openScreen(page, "/dashboard/constellation", "Stars");

  // The canvas background is lazily loaded behind an error boundary, so the
  // check is that the screen itself survives rather than what it draws.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  expect(errors).toEqual([]);
});

test("phone keeps the browse screens usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  for (const [path, heading] of [
    ["/dashboard/cards", FLASHCARDS_TITLE],
    ["/dashboard/decks", FLASHCARDS_TITLE],
    ["/dashboard/topics", "Topics"],
  ] as const) {
    await openScreen(page, path, heading);
    const main = page.locator("main").first();
    const box = await main.boundingBox();
    expect(box).not.toBeNull();
    // Content wider than the viewport is the classic phone regression.
    expect(box!.width).toBeLessThanOrEqual(390);
  }
});

test("every response carries the security headers", async ({ request }) => {
  const response = await request.get("/dashboard");
  const headers = response.headers();

  // Enforced: these cannot break resource loading, so a regression here is a
  // real loss of protection rather than a policy still being tuned.
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");

  // The restrictive policy rides along as Report-Only until a real session
  // proves connect-src is complete.
  expect(headers["content-security-policy-report-only"] ?? "").toContain(
    "default-src 'self'"
  );

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
});
