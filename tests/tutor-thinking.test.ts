import { describe, expect, it } from "vitest";
import { decideTutorRoute } from "@/lib/ai/provider-policy";
import { chooseTutorThinking, tutorThinkingRoute, type TutorThinkingTier } from "@/lib/ai/tutor-thinking";

function auto(message: string, extra: { sourceCount?: number; hasAttachments?: boolean; routineNotebookMarking?: boolean } = {}) {
  return chooseTutorThinking({
    preference: "auto",
    decision: decideTutorRoute({ message, sourceCount: extra.sourceCount ?? 0 }),
    message,
    routineNotebookMarking: extra.routineNotebookMarking ?? false,
    hasAttachments: extra.hasAttachments,
  });
}

describe("Auto thinks as much as each question needs", () => {
  const cases: [string, TutorThinkingTier][] = [
    // Recall and chat: answered at once.
    ["What is osmosis?", "quick"],
    ["Define enthalpy change.", "quick"],
    ["Who discovered penicillin?", "quick"],
    ["When was the Battle of Hastings?", "quick"],
    ["List the organelles in an animal cell.", "quick"],
    ["Give me a hint", "quick"],
    ["thanks!", "quick"],
    // Working something out: the fast model, thinking.
    ["What is the derivative of x^3 sin x?", "think"],
    ["Solve 2x + 5 = 17", "think"],
    ["Find the remainder when 3^100 is divided by 7.", "think"],
    ["How many ordered pairs of positive integers (m, n) satisfy m^2 n = 20^20?", "think"],
    ["Prove that root 2 is irrational.", "think"],
    ["Why does ice float on water?", "think"],
    ["Explain how a transformer steps down voltage.", "think"],
    ["Show that $\\sum_{k=1}^n k = n(n+1)/2$", "think"],
    ["Can you do part (b) for me?", "think"],
    ["Mark my answer to question 3", "think"],
    ["Where did I go wrong here?", "think"],
  ];

  it.each(cases)("%s -> %s", (message, tier) => {
    expect(auto(message).tier).toBe(tier);
  });

  it("thinks deeply for a long request, many sources, or an idea that keeps coming back", () => {
    expect(auto("Summarise and compare everything in these. ".repeat(40)).tier).toBe("deep");
    expect(auto("Summarise my notes", { sourceCount: 9 }).tier).toBe("deep");
    const repeated = chooseTutorThinking({
      preference: "auto",
      decision: decideTutorRoute({ message: "Osmosis again?", sourceCount: 0, repeatedConcept: true }),
      message: "Osmosis again?",
      routineNotebookMarking: false,
    });
    expect(repeated).toMatchObject({ tier: "deep", reason: "repeated_concept" });
  });

  it("works through a picture of a question, and through a page sent to be marked", () => {
    expect(auto("Can you look at this?", { hasAttachments: true }).tier).toBe("think");
    expect(auto("Mark my work", { routineNotebookMarking: true }).tier).toBe("think");
  });

  it("settles what the rules can read, and leaves the rest to the preflight", () => {
    expect(auto("What is osmosis?").settled).toBe(true);
    expect(auto("Solve 2x + 5 = 17").settled).toBe(true);
    expect(auto("Can you help me with my revision plan for chemistry?")).toMatchObject({ tier: "think", settled: false });
  });
});

describe("the levels a student can choose", () => {
  const hard = "Prove that root 2 is irrational.";
  const choose = (preference: "low" | "medium" | "high") =>
    chooseTutorThinking({ preference, decision: decideTutorRoute({ message: hard, sourceCount: 0 }), message: hard, routineNotebookMarking: false });

  it("chooses a tier outright, and never asks the preflight", () => {
    expect(choose("low")).toEqual({ tier: "quick", reason: "student_preference", settled: true });
    expect(choose("medium")).toEqual({ tier: "think", reason: "student_preference", settled: true });
    expect(choose("high")).toEqual({ tier: "deep", reason: "student_preference", settled: true });
  });

  it("keeps a challenged answer on its stronger route at every level, the juror included", () => {
    for (const preference of ["auto", "low", "medium", "high"] as const) {
      const challenged = chooseTutorThinking({
        preference,
        decision: decideTutorRoute({ message: "That's wrong, check again.", sourceCount: 0 }),
        message: "That's wrong, check again.",
        routineNotebookMarking: false,
      });
      expect(challenged).toMatchObject({ tier: "deep", reason: "student_correction" });
      const disputed = chooseTutorThinking({
        preference,
        decision: decideTutorRoute({ message: "Still wrong.", sourceCount: 0, repeatedSupervisorChallenge: true }),
        message: "Still wrong.",
        routineNotebookMarking: false,
      });
      expect(disputed.tier).toBe("deep");
    }
  });
});

describe("how each tier is answered", () => {
  it("answers quickly and with thought on the fast model, and deeply on the thinking role's fastest model first", () => {
    expect(tutorThinkingRoute("quick", "routine")).toEqual({ role: "worker", reasoningEffort: "low", preferStandby: false });
    expect(tutorThinkingRoute("think", "complex_request")).toEqual({ role: "worker", reasoningEffort: "high", preferStandby: false });
    expect(tutorThinkingRoute("deep", "student_preference")).toEqual({ role: "supervisor", reasoningEffort: "high", preferStandby: true });
  });

  it("keeps the answer that reconciles a juror's review off the juror's own model family", () => {
    expect(tutorThinkingRoute("deep", "second_correction").preferStandby).toBe(false);
  });
});

describe("a working check", () => {
  it("is thought about, so the agent works the problem through, unless the student chose Low", () => {
    const decision = decideTutorRoute({ message: "Check my working", sourceCount: 0 });
    const base = { decision, message: "Check my working", routineNotebookMarking: false, workingCheck: true };
    expect(chooseTutorThinking({ ...base, preference: "auto" }).tier).toBe("think");
    expect(chooseTutorThinking({ ...base, preference: "low" }).tier).toBe("quick");
    expect(chooseTutorThinking({ ...base, preference: "high" }).tier).toBe("deep");
  });
});
