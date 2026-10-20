import { IconBubble } from "@/components/ui";
import type { GoalMeasure } from "@/lib/goals/model";

/** Each kind of goal keeps one colour wherever it appears, so it can be told apart at a glance. */
const MEASURE_TINT: Record<GoalMeasure, string> = {
  cards: "bg-accent-muted text-accent",
  questions: "app-warning",
  topic: "app-success",
};

/** What a goal counts, drawn: a stack of cards, a marked sheet, a target. */
export function GoalMeasureIcon({ measure, className = "h-5 w-5" }: { measure: GoalMeasure; className?: string }) {
  const shared = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
  if (measure === "questions") {
    return (
      <svg {...shared}>
        <path d="M7 3.5h7.5L19 8v12.5H7z" />
        <path d="M14.5 3.5V8H19" />
        <path d="m10 14.2 1.9 1.9 3.9-4.3" />
      </svg>
    );
  }
  if (measure === "topic") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="4.6" />
        <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <rect x="3.5" y="7.5" width="13" height="13" rx="2.5" />
      <path d="M8 4h9.5A2.5 2.5 0 0 1 20 6.5V16" />
    </svg>
  );
}

export function GoalMeasureBadge({ measure, size = "md" }: { measure: GoalMeasure; size?: "sm" | "md" | "lg" }) {
  return (
    <IconBubble size={size} aria-hidden className={MEASURE_TINT[measure]}>
      <GoalMeasureIcon measure={measure} className={size === "sm" ? "h-4 w-4" : "h-5 w-5"} />
    </IconBubble>
  );
}
