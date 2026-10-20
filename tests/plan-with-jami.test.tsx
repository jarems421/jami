// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanWithJami from "@/components/planning/PlanWithJami";
import { usePlanInterview, type PlanAssistantProposal } from "@/hooks/usePlanInterview";
import type { PlanInterviewContext } from "@/lib/planning/plan-interview";
import { normalizeRevisionPlanDraft } from "@/lib/planning/normalize-plan";
import type { RevisionPlanDraft } from "@/lib/planning/types";

/**
 * Planning with Jami, the way a student does it: one question at a time,
 * answered by tapping or typing -- and, at any point, asking for particular
 * things on particular days, which come back as a proposal to apply or not.
 */

const service = vi.hoisted(() => ({
  draftPlanWithJami: vi.fn(),
  PlanDraftError: class PlanDraftError extends Error {},
}));

vi.mock("@/services/planning/plan-draft", () => service);

const OPTIONS = [
  { key: "folder:chem", label: "Chemistry", folderId: "chem" },
  { key: "folder:bio", label: "Biology", folderId: "bio" },
];

const CONTEXT: PlanInterviewContext = {
  notices: [
    { scopeKey: "folder:bio", subject: "Biology", detail: "Enzymes has been slipping", reason: "declining_mastery" },
  ],
  scopeNames: new Map(OPTIONS.map((option) => [option.key, option.label])),
};

const RUNNING = normalizeRevisionPlanDraft({
  title: "Summer exams",
  scopes: [{ folderId: "bio", weight: 2 }],
  sessions: [{ id: "mon", weekday: 1, minutes: 45 }],
  startDayKey: "2026-10-19",
  endDayKey: "2026-11-30",
}).draft;

const TIMETABLE = [{ dayKey: "2026-10-19", activities: [], doneIds: [] }];

function Harness({
  onSave = vi.fn(),
  onApply = vi.fn(async () => true),
  running = false,
}: {
  onSave?: (draft: RevisionPlanDraft) => void;
  onApply?: (proposal: PlanAssistantProposal) => Promise<boolean>;
  running?: boolean;
}) {
  const interview = usePlanInterview(CONTEXT, {
    mode: running ? "change" : "build",
    timetable: () => TIMETABLE,
    ...(running ? { startFrom: RUNNING } : {}),
  });
  return (
    <>
      <PlanWithJami
        interview={interview}
        options={OPTIONS}
        notices={CONTEXT.notices}
        saving={false}
        canSave={normalizeRevisionPlanDraft(interview.draft).valid}
        onSave={() => onSave(interview.draft)}
        onOpenSettings={vi.fn()}
        describeProposal={(proposal) => ({
          headline: proposal.changes.length > 0 ? `${proposal.changes.length} changes` : "Changes to your plan",
          lines: proposal.plan ? ["Usual week: Mon, Thu · 45 min"] : proposal.changes.map((change) => change.kind),
        })}
        onApplyProposal={onApply}
        onDiscardProposal={vi.fn()}
      />
      <output data-testid="draft">{JSON.stringify(interview.draft.sessions)}</output>
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  service.draftPlanWithJami.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
}

function click(element: HTMLElement) {
  act(() => element.click());
}

function priority(subject: string, level: string) {
  const group = container.querySelector(`[aria-label="How much time for ${subject}"]`);
  const option = [...(group?.querySelectorAll('[role="radio"]') ?? [])].find((entry) => entry.textContent === level);
  if (!option) throw new Error(`No ${level} for ${subject}`);
  return option as HTMLButtonElement;
}

function lastJamiTurn() {
  const turns = [...container.querySelectorAll('[aria-label="Planning with Jami"] > li')];
  return turns.at(-1)?.textContent ?? "";
}

async function type(text: string) {
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    button("Send to Jami").click();
  });
}

describe("building a plan with Jami", () => {
  it("builds the whole plan from taps, and saves it from the last check", () => {
    const onSave = vi.fn();
    act(() => root.render(<Harness onSave={onSave} />));

    expect(lastJamiTurn()).toContain("What are you working towards?");
    click(button("No exams coming up"));
    // What the Learning Engine noticed is said in the question it bears on.
    expect(lastJamiTurn()).toContain("From your answers in Biology: Enzymes has been slipping.");
    expect(button("These are my subjects").disabled).toBe(true);

    click(priority("Biology", "Most"));
    click(priority("Chemistry", "Light"));
    click(button("These are my subjects"));
    expect(lastJamiTurn()).toContain("When can you study?");

    click(button("Monday"));
    click(button("Thursday"));
    click([...container.querySelectorAll('[role="radio"]')].find((entry) => entry.textContent === "30 min") as HTMLButtonElement);
    click(button("That’s my week"));
    expect(lastJamiTurn()).toContain("Anything else I should fit around?");
    click(button("Nothing else"));

    expect(lastJamiTurn()).toContain("There's your timetable.");
    click(button("Save plan"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0] as RevisionPlanDraft;
    expect(saved.scopes).toEqual([
      { folderId: "bio", weight: 3 },
      { folderId: "chem", weight: 1 },
    ]);
    expect(saved.sessions.map((session) => [session.weekday, session.minutes])).toEqual([
      [1, 30],
      [4, 30],
    ]);
    expect(service.draftPlanWithJami).not.toHaveBeenCalled();
  });

  it("goes back to a finished question to change what it decided", () => {
    act(() => root.render(<Harness />));
    click(button("No exams coming up"));
    click(priority("Chemistry", "Normal"));
    click(button("These are my subjects"));

    click(button("Go back to subjects"));
    expect(lastJamiTurn()).toContain("Which subjects should this cover?");
    expect(priority("Chemistry", "Normal").getAttribute("aria-checked")).toBe("true");
  });

  it("reads a typed answer against the step it answers, with the timetable on screen", async () => {
    service.draftPlanWithJami.mockResolvedValue({
      reply: "Chemistry paper 1 on the 12th of November, noted.",
      plan: normalizeRevisionPlanDraft({
        title: "Chemistry mocks",
        exams: [{ id: "e1", label: "Chemistry Paper 1", dayKey: "2026-11-12", scopeKey: "folder:chem" }],
        scopes: [{ folderId: "chem", weight: 2 }],
      }).draft,
      changes: [],
      notices: [],
    });
    act(() => root.render(<Harness />));
    await type("Chemistry paper 1 on 12 November");

    expect(service.draftPlanWithJami).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Chemistry paper 1 on 12 November", step: "goal", timetable: TIMETABLE })
    );
    expect(container.textContent).toContain("Chemistry paper 1 on the 12th of November, noted.");
    expect(lastJamiTurn()).toContain("I've put Chemistry in because of your exams.");
  });

  it("turns particular days into a proposal the student applies, whatever step they are on", async () => {
    const onApply = vi.fn(async () => true);
    service.draftPlanWithJami.mockResolvedValue({
      reply: "I've put homeostasis practice at 5pm on Monday, with flashcards straight after.",
      plan: null,
      changes: [
        { kind: "add", dayKey: "2026-10-19", startTime: "17:00", minutes: 20, scopeKey: "folder:bio", title: "Homeostasis practice", method: "practice" },
        { kind: "add", dayKey: "2026-10-19", startTime: "17:20", minutes: 15, scopeKey: "folder:bio" },
      ],
      notices: [],
    });
    act(() => root.render(<Harness onApply={onApply} />));
    await type("Biology on Monday at 5pm, 20 minutes of homeostasis practice, and finish with flashcards");

    expect(container.querySelector('[aria-label="Proposed change"]')?.textContent).toContain("2 changes");
    await act(async () => {
      button("Apply changes").click();
    });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ changes: expect.arrayContaining([expect.objectContaining({ title: "Homeostasis practice" })]) }));
    expect(container.querySelector('[aria-label="Proposed change"]')?.textContent).toContain("Applied");
  });

  it("keeps the tapped answers when Jami cannot answer", async () => {
    service.draftPlanWithJami.mockRejectedValue(new Error("offline"));
    act(() => root.render(<Harness />));
    await type("mocks soon");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("change the timetable yourself");
    expect(button("No exams coming up")).toBeTruthy();
  });
});

describe("changing a running plan with Jami", () => {
  it("offers a few starting points, and changes nothing until a proposal is applied", async () => {
    service.draftPlanWithJami.mockResolvedValue({
      reply: "I can make Thursdays a study day instead of Mondays.",
      plan: normalizeRevisionPlanDraft({ ...RUNNING, sessions: [{ id: "thu", weekday: 4, minutes: 45 }] }).draft,
      changes: [],
      notices: [],
    });
    act(() => root.render(<Harness running />));
    expect(container.textContent).toContain("What would you like to change?");

    await act(async () => {
      button("I'm busy on Thursday").click();
    });
    // No step: a running plan is a conversation, not the interview.
    expect(service.draftPlanWithJami).toHaveBeenCalledWith(expect.not.objectContaining({ step: expect.anything() }));
    expect(container.querySelector('[aria-label="Proposed change"]')?.textContent).toContain("Usual week");
    // The plan is exactly as it was.
    expect(container.querySelector('[data-testid="draft"]')?.textContent).toContain('"weekday":1');

    click(button("Discard"));
    expect(container.querySelector('[aria-label="Proposed change"]')?.textContent).toContain("Discarded");
  });
});
