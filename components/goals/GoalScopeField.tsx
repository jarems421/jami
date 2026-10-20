"use client";

import GoalChips from "@/components/goals/GoalChips";
import { Select } from "@/components/ui";
import type { GoalMeasure, GoalScope, GoalScopeType } from "@/lib/goals/model";

export type GoalScopeOption = { id: string; label: string };

const TYPE_LABEL: Record<Exclude<GoalScopeType, "all">, string> = {
  folder: "A folder",
  deck: "A deck",
  topic: "A topic",
};

/**
 * Where a goal's work has to come from: everything, or one folder, deck or
 * topic. Practice questions belong to folders, so that is the only narrowing
 * they offer.
 */
export default function GoalScopeField({
  measure,
  value,
  options,
  onChange,
}: {
  measure: Exclude<GoalMeasure, "topic">;
  value: GoalScope;
  options: Record<Exclude<GoalScopeType, "all">, readonly GoalScopeOption[]>;
  onChange: (scope: GoalScope) => void;
}) {
  const types: GoalScopeType[] = measure === "questions" ? ["all", "folder"] : ["all", "folder", "deck", "topic"];
  const pickType = (type: GoalScopeType) => {
    if (type === "all") return onChange({ type: "all" });
    const first = options[type][0];
    onChange(first ? { type, id: first.id, label: first.label } : { type });
  };
  const narrowed = value.type === "all" ? null : value.type;

  return (
    <div className="space-y-3">
      <GoalChips
        label="Counts from"
        value={value.type}
        onChange={pickType}
        options={types.map((type) =>
          type === "all"
            ? { value: type, label: measure === "questions" ? "Any practice" : "All flashcards" }
            : {
                value: type,
                label: TYPE_LABEL[type],
                disabled: options[type].length === 0,
              }
        )}
      />
      {narrowed ? (
        <Select
          label={`Which ${narrowed}?`}
          value={value.id ?? ""}
          onChange={(event) => {
            const chosen = options[narrowed].find((option) => option.id === event.target.value);
            onChange(chosen ? { type: narrowed, id: chosen.id, label: chosen.label } : { type: narrowed });
          }}
          className="!py-2.5 text-sm"
        >
          {options[narrowed].map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
