"use client";

import GoalChips from "@/components/goals/GoalChips";
import { DateField } from "@/components/ui";
import { goalDayLabel } from "@/lib/goals/deadlines";
import type { GoalDeadlineChoice } from "@/lib/goals/drafts";
import type { GoalExamLink } from "@/lib/goals/model";
import { getStudyDayKey, shiftStudyDayKey } from "@/lib/study/day";

type ChoiceKey = "none" | "today" | "week" | "date" | `exam:${string}`;

function keyOf(choice: GoalDeadlineChoice): ChoiceKey {
  return choice.kind === "exam" ? `exam:${choice.examId}` : choice.kind;
}

/**
 * By when. A goal can be open-ended, due today or this week, due before one of
 * the exams in the student's revision plan, or due on a date they pick.
 */
export default function GoalDeadlineField({
  choice,
  exams,
  optional,
  onChange,
}: {
  choice: GoalDeadlineChoice;
  exams: readonly GoalExamLink[];
  /** A daily goal is often open-ended, and says so. */
  optional?: string;
  onChange: (choice: GoalDeadlineChoice) => void;
}) {
  const today = getStudyDayKey();
  const pick = (key: ChoiceKey) => {
    if (key.startsWith("exam:")) return onChange({ kind: "exam", examId: key.slice("exam:".length) });
    if (key === "date") {
      return onChange({ kind: "date", dayKey: choice.kind === "date" ? choice.dayKey : shiftStudyDayKey(today, 7) });
    }
    onChange({ kind: key as "none" | "today" | "week" });
  };

  return (
    <div className="space-y-3">
      <GoalChips<ChoiceKey>
        label="By when?"
        value={keyOf(choice)}
        onChange={pick}
        options={[
          { value: "none", label: "No deadline" },
          { value: "today", label: "Today" },
          { value: "week", label: "This week" },
          ...exams.map((exam) => ({
            value: `exam:${exam.examId}` as ChoiceKey,
            label: (
              <>
                <span>Before {exam.label}</span>
                <span className="font-normal text-text-muted">{goalDayLabel(exam.dayKey)}</span>
              </>
            ),
            ariaLabel: `Before ${exam.label}, on ${goalDayLabel(exam.dayKey)}`,
          })),
          { value: "date", label: "Pick a date" },
        ]}
      />
      {optional ? <p className="text-xs leading-5 text-text-muted">{optional}</p> : null}
      {choice.kind === "date" ? (
        <div className="max-w-xs">
          <DateField
            type="date"
            label="Finish by"
            value={choice.dayKey}
            min={today}
            placeholder="Choose a date"
            onValueChange={(dayKey) => onChange({ kind: "date", dayKey })}
          />
        </div>
      ) : null}
    </div>
  );
}
