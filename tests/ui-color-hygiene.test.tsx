import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import AuthPage from "@/app/auth/page";
import Button from "@/components/ui/Button";
import { getConstellationBackgroundActionLabel } from "@/lib/constellation/background";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const root = process.cwd();

// Intentional static policy scope: these files must not bypass semantic theme
// tokens. This is not a page-structure or implementation-snippet assertion.
const auditedFiles = [
  "components/ui/Button.tsx",
  "components/ui/Input.tsx",
  "components/ui/Textarea.tsx",
  "components/ui/EmptyState.tsx",
  "components/ui/StatTile.tsx",
  "components/ui/FeedbackBanner.tsx",
  "components/layout/Refreshable.tsx",
  "components/layout/TabBar.tsx",
  "components/decks/CardBackEditor.tsx",
  "components/decks/CardBackAutocomplete.tsx",
  "components/decks/CardQualityWarnings.tsx",
  "components/decks/CardEditorDialog.tsx",
  "components/decks/CardCreationPanel.tsx",
  "components/cards/CardBrowserControls.tsx",
  "components/cards/CardBrowserWorkspace.tsx",
  "components/cards/CardBulkActions.tsx",
  "components/cards/CardGrid.tsx",
  "components/cards/CardsGettingStarted.tsx",
  "components/notifications/NotificationSettingsCard.tsx",
  "app/page.tsx",
  "app/auth/page.tsx",
  "app/auth/action/page.tsx",
  "components/auth/AuthShell.tsx",
  "components/auth/EmailCodeInput.tsx",
  "components/auth/SignUpCodeStep.tsx",
  "components/auth/PasswordField.tsx",
  "components/auth/PasswordStrength.tsx",
  "components/landing/LandingPreview.tsx",
  "app/dashboard/goals/page.tsx",
  "components/goals/GoalAmountField.tsx",
  "components/goals/GoalCard.tsx",
  "components/goals/GoalChips.tsx",
  "components/goals/GoalComposer.tsx",
  "components/goals/GoalDeadlineField.tsx",
  "components/goals/GoalHistory.tsx",
  "components/goals/GoalIcons.tsx",
  "components/goals/GoalKindPicker.tsx",
  "components/goals/GoalProgress.tsx",
  "components/goals/GoalScopeField.tsx",
  "components/goals/GoalSuggestions.tsx",
  "components/goals/GoalTopicPicker.tsx",
  "components/today/TodayGoals.tsx",
  "components/planning/PlanGoals.tsx",
  "app/dashboard/decks/page.tsx",
  "app/dashboard/profile/page.tsx",
  "app/dashboard/profile/personalise/page.tsx",
  "components/profile/ThemePreferenceCard.tsx",
  "app/dashboard/page.tsx",
  "app/dashboard/study/page.tsx",
  "components/study/StudyCardStage.tsx",
  "components/study/StudyDailyReviewCard.tsx",
  "components/study/StudyOfflineBanner.tsx",
  "components/study/StudyOtherWays.tsx",
  "components/study/StudySessionComplete.tsx",
  "components/study/StudySessionEmpty.tsx",
  "app/dashboard/cards/page.tsx",
  "app/dashboard/library/page.tsx",
  "app/dashboard/folders/page.tsx",
  "app/dashboard/folders/[folderId]/page.tsx",
  "components/workspace/FolderLoadStates.tsx",
  "components/workspace/FolderOverview.tsx",
  "components/workspace/FolderTabBar.tsx",
  "components/workspace/FolderNotebooksSection.tsx",
  "components/workspace/FolderShelfSection.tsx",
  "components/workspace/FolderLoadMoreButton.tsx",
  "app/dashboard/topics/page.tsx",
  "app/dashboard/progress/page.tsx",
  "components/workspace/PracticeWorkspace.tsx",
  "components/stats/AnalyticsPanels.tsx",
  "components/layout/AppTopBar.tsx",
  "components/decks/DeckDetailPageClient.tsx",
  "components/ui/DateField.tsx",
  "components/planning/RevisionPlanner.tsx",
  "components/planning/PlanHeader.tsx",
  "components/planning/PlanWeekView.tsx",
  "components/planning/PlanDayView.tsx",
  "components/planning/PlanMonthView.tsx",
  "components/planning/PlanActivityItem.tsx",
  "components/planning/PlanActivityEditor.tsx",
  "components/planning/PlanProposalCard.tsx",
  "components/planning/PlanSummaryBar.tsx",
  "components/planning/PlanSettingsDialog.tsx",
  "components/today/TodayPlanPanel.tsx",
  "components/today/TodayHeader.tsx",
  "components/today/TodayAnytime.tsx",
  "components/today/TodayWeekList.tsx",
  "components/planning/RevisionPlanBuilder.tsx",
  "components/planning/PlanWithJami.tsx",
  "components/planning/PlanStepAnswers.tsx",
  "components/planning/TutorPlanCard.tsx",
  "components/ai/TutorAskPanel.tsx",
  "components/ai/TutorDoor.tsx",
  "components/ai/TutorSourcePicker.tsx",
  "app/dashboard/tutor/plan/page.tsx",
];

const unsafePatterns = [
  /\btext-white\b/,
  /\btext-black\b/,
  /\bplaceholder:text-white\b/,
  /\bplaceholder:text-black\b/,
  /\bborder-white\/\[/,
  /\bbg-white\/\[/,
];

describe("theme colour hygiene", () => {
  it("keeps shared forms and creation surfaces on semantic theme tokens", () => {
    const offenders = auditedFiles.flatMap((file) => {
      const contents = readFileSync(join(root, file), "utf8");
      return unsafePatterns
        .filter((pattern) => pattern.test(contents))
        .map((pattern) => `${file}: ${pattern}`);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps same-family accent pairings guarded by global contrast policy", () => {
    const globals = readFileSync(join(root, "app/globals.css"), "utf8");

    expect(globals).toContain('body [class*="bg-accent/"] .text-accent');
    expect(globals).toContain('body [class*="bg-warm-glow"] .text-warm-accent');
    expect(globals).toContain('body [class*="bg-error-muted"] [class*="text-rose"]');
    expect(globals).toContain('body [class*="bg-success-muted"] [class*="text-emerald"]');
    // Keyed on lightness rather than on paper-white by name, so every light
    // theme is covered rather than only the first one that existed.
    expect(globals).toContain('body.app-theme-light [class*="bg-white/"][class*="text-white"]');
    expect(globals).toContain('body.app-theme-light [class*="bg-accent"].text-white');
    expect(globals).toContain("--button-secondary-text: #101827;");
    expect(globals).toContain("--button-surface-text: #101827;");
    expect(globals).toContain(".study-flashcard-face {");
    expect(globals).toContain(
      "var(--study-card-border, var(--color-border-strong)) 14%"
    );
    expect(globals).toContain("var(--shadow-card);");
    expect(globals).not.toContain(
      "0 0 0 1px color-mix(in srgb, var(--study-card-border"
    );
    expect(globals).toContain("background-color: var(--color-surface-panel);");
    // The flashcard front is opaque under the constellation background, not
    // 0.92: the same colour, but a card is the one surface a student is reading
    // and a star drifting behind the answer is a distraction rather than
    // atmosphere. Panels around it went the other way and got more transparent.
    expect(globals).toContain("background: #080512;");
    expect(globals).toContain("--color-text-primary: #fff8ff;");
  });

  it("renders named controls through semantic variants and disabled tokens", () => {
    // The email sign-in screen rather than the launch screen: the latter shows
    // nothing but the brand until it knows whether anyone is signed in, so an
    // installed app does not flash its sign-in form at somebody who already is.
    const signInMarkup = renderToStaticMarkup(createElement(AuthPage));
    const googleLabelIndex = signInMarkup.indexOf("Continue with Google");
    const googleButtonStart = signInMarkup.lastIndexOf("<button", googleLabelIndex);
    const googleButton = signInMarkup.slice(googleButtonStart, googleLabelIndex);
    expect(googleButton).toContain("app-button-primary");

    const disabledButton = renderToStaticMarkup(
      createElement(Button, { disabled: true }, "Unavailable")
    );
    expect(disabledButton).toContain(
      "disabled:!bg-[var(--button-disabled-bg)]"
    );
    expect(disabledButton).toContain("disabled:saturate-[0.82]");
    expect(disabledButton).not.toContain("disabled:opacity-50");

    expect(getConstellationBackgroundActionLabel(false)).toBe(
      "Use as background"
    );
    expect(getConstellationBackgroundActionLabel(true)).toBe(
      "Remove background"
    );
  });

  /**
   * Installed as a PWA, this page is the launch screen. It used to render the
   * sign-in form on its first paint and only redirect once the session finished
   * restoring, so every launch flashed "sign in" at somebody who already had.
   */
  it("shows nothing to sign in with until it knows whether anyone is", () => {
    const launchMarkup = renderToStaticMarkup(createElement(Home));

    expect(launchMarkup).toContain('data-auth-restoring="true"');
    expect(launchMarkup).not.toContain("Continue with Google");
    expect(launchMarkup).not.toContain("Continue with email");
    // The app's own background, so the launch reads as the app opening rather
    // than as a page that has failed to load.
    expect(launchMarkup).toContain("var(--app-background)");
  });
});
