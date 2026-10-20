import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { expect, test, type Page } from "@playwright/test";
import { deleteDoc, doc, setDoc } from "firebase/firestore";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";
import { E2E_FOLDER_ID, E2E_PROJECT_ID, E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./fixtures";

/**
 * The revision plan, on Home and in the planner, at the three widths students
 * use them at.
 *
 * A plan is seeded for this spec alone and removed after it: a running plan
 * changes what Home leads with, and every other spec expects Home without one.
 * It is a version 2 plan -- the kind every student had before dated
 * activities -- so the walkthrough also checks that one reads forward: its
 * usual week shows as sessions, Jami fills them as it always did, and nothing
 * anywhere promises that Jami will decide on the day. The student adds their
 * own task to today and it is there on Home and in the planner alike.
 */

const PLAN_ID = "e2e-plan";

/*
 * The app's day, not the calendar's: a study day runs from 4am to 4am London
 * time. Seeding from the calendar put "today's" session on the wrong day for
 * any run between midnight and 4am in London.
 */
function studyDayKey(offsetDays = 0) {
  return shiftStudyDayKey(getStudyDayKey(), offsetDays);
}

function studyWeekday() {
  return new Date(`${getStudyDayKey()}T12:00:00Z`).getUTCDay();
}

async function uidFor(email: string, password: string) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const response = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-browser-api-key`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  return ((await response.json()) as { localId: string }).localId;
}

let environment: RulesTestEnvironment;
let uid: string;

test.beforeAll(async () => {
  environment = await initializeTestEnvironment({ projectId: E2E_PROJECT_ID });
  uid = await uidFor(E2E_USER_EMAIL, E2E_USER_PASSWORD);
  const weekday = studyWeekday();
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "users", uid, "revisionPlans", PLAN_ID), {
      schemaVersion: 2,
      title: "Mocks in November",
      status: "active",
      origin: "manual",
      startDayKey: studyDayKey(-3),
      endDayKey: studyDayKey(55),
      scopes: [{ folderId: E2E_FOLDER_ID, weight: 2 }],
      sessions: [
        { id: "today-1", weekday, minutes: 60, startTime: "16:30", scopeKey: `folder:${E2E_FOLDER_ID}` },
        { id: "tomorrow", weekday: (weekday + 1) % 7, minutes: 45, startTime: "10:00" },
      ],
      emphasis: [],
      exams: [{ id: "exam-1", label: "Chemistry Paper 1", dayKey: studyDayKey(49), scopeKey: `folder:${E2E_FOLDER_ID}` }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
});

test.afterAll(async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    // Jami fills this week and next, so every day the plan could have written is cleared.
    for (let offset = -7; offset <= 21; offset += 1) {
      await deleteDoc(doc(context.firestore(), "users", uid, "revisionPlans", PLAN_ID, "entries", studyDayKey(offset)));
    }
    await deleteDoc(doc(context.firestore(), "users", uid, "revisionPlans", PLAN_ID));
  });
  await environment.cleanup();
});

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER_EMAIL);
  await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 45_000 });
}

async function expectNoHorizontalOverflow(page: Page, width: number) {
  const scrollWidth = await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth));
  expect(scrollWidth, `page scrolls sideways at ${width}px`).toBeLessThanOrEqual(width + 1);
}

const TASK = "Redo question 3 from Monday's paper";

test("the plan leads Home and the planner at every width", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  await expect(page.getByRole("link", { name: "Open your plan" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("navigation", { name: "This week in your plan" })).toBeVisible();
  await expect(page.getByText("Chemistry Paper 1")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today’s plan", level: 2 })).toBeVisible();

  // The student's own task, added to today in the same editor the planner uses.
  await page.getByRole("button", { name: "Add to today" }).click();
  await page.getByLabel("What you'll do").fill(TASK);
  await page.getByRole("radio", { name: "Your own task" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(TASK).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, 1440);
  await page.screenshot({ path: "test-results/plan-home-desktop.png", fullPage: true, animations: "disabled" });

  for (const [width, height, name] of [[820, 1180, "tablet"], [390, 844, "phone"]] as const) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.getByText(TASK).first()).toBeVisible({ timeout: 45_000 });
    await expectNoHorizontalOverflow(page, width);
    await page.screenshot({ path: `test-results/plan-home-${name}.png`, fullPage: true, animations: "disabled" });
  }

  // The planner: the timetable, with the task where it was put and the exam counted down to.
  for (const [width, height, name] of [[1440, 1000, "desktop"], [820, 1180, "tablet"], [390, 844, "phone"]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/dashboard/tutor/plan");
    await expect(page.getByRole("heading", { name: "Mocks in November" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByLabel("Counting down")).toContainText("Chemistry Paper 1");
    await expect(page.getByLabel("Your week")).toContainText(TASK);
    // Nothing anywhere promises a task that will only be decided on the day.
    await expect(page.getByText("Jami fills this in on the day")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, width);
    await page.screenshot({ path: `test-results/plan-planner-${name}.png`, fullPage: true, animations: "disabled" });
  }

  // On a phone, Jami opens in a drawer over the timetable rather than beside it.
  await page.getByRole("button", { name: "Plan with Jami" }).first().click();
  await expect(page.getByLabel("Tell Jami what you need")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // Tomorrow's usual sitting is on the timetable already, as a session or as Jami's picks.
  // On a Sunday, tomorrow is next week and not in this view.
  if (studyWeekday() !== 0) {
    await expect(page.getByLabel("Your week")).toContainText("10:00");
  }

  expect(errors, errors.join("\n")).toEqual([]);
});
