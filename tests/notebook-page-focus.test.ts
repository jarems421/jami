import { describe, expect, it } from "vitest";
import { describeNotebookPageFocus } from "@/lib/workspace/notebook-page-focus";

/** What Tutor tells a student marking the open page will count towards. */

const names: Record<string, string> = { eigen: "Eigenvectors", algebra: "Linear algebra" };
const topicName = (id: string) => names[id];

describe("where marking a page counts", () => {
  it("names a linked question's concepts, with nothing to change", () => {
    const copy = describeNotebookPageFocus(
      { attribution: "linked-question", concepts: [{ key: "spec:cts", label: "Completing the square" }] },
      topicName
    );
    expect(copy.names).toEqual(["Completing the square"]);
    expect(copy.changeLabel).toBeUndefined();
  });

  it("names the student's Topics from their own list, and lets them change the page's", () => {
    const page = describeNotebookPageFocus(
      { attribution: "page-topics", concepts: [{ key: "topic:eigen" }] },
      topicName
    );
    expect(page).toMatchObject({ names: ["Eigenvectors"], changeLabel: "Change" });
    const notebook = describeNotebookPageFocus(
      { attribution: "notebook-topics", concepts: [{ key: "topic:eigen" }, { key: "topic:algebra" }] },
      topicName
    );
    expect(notebook).toMatchObject({
      names: ["Eigenvectors", "Linear algebra"],
      changeLabel: "Choose this page's topic",
    });
  });

  it("says plainly when marking will count towards nothing", () => {
    const copy = describeNotebookPageFocus({ attribution: "none", concepts: [] }, topicName);
    expect(copy.lead).toMatch(/won't count towards your progress/);
    expect(copy.changeLabel).toBe("Choose a topic");
  });
});
