import { describe, expect, it } from "vitest";
import { decideTutorRoute } from "@/lib/ai/provider-policy";
import { chooseTutorThinking } from "@/lib/ai/tutor-thinking";
import { PRACTICE_TUTOR_QUICK_ACTIONS } from "@/lib/practice/practice-tutor-actions";

describe("Tutor from a marked practice answer", () => {
  const lostMarks = PRACTICE_TUTOR_QUICK_ACTIONS.find((action) => action.label === "Why did I lose marks?");

  it("goes through the scheme a mark at a time, pointing to their own notes, without awarding anything", () => {
    expect(lostMarks?.prompt).toMatch(/mark scheme .* point by point/);
    expect(lostMarks?.prompt).toMatch(/my own notes/);
    expect(lostMarks?.prompt).not.toMatch(/\b(?:mark (?:this|my|it)|give me a mark|grade)\b/i);
  });

  it("is thought about on Auto, so the agent can look in their notes and check the working", () => {
    const message = lostMarks?.prompt ?? "";
    const choice = chooseTutorThinking({
      preference: "auto",
      decision: decideTutorRoute({ message, sourceCount: 0 }),
      message,
      routineNotebookMarking: false,
    });
    expect(choice.tier).not.toBe("quick");
  });
});
