import { type ReactNode } from "react";
import Card from "./Card";

type EmptyStateProps = {
  emoji?: string;
  /** A drawing in place of the emoji chip, such as the object about to be made. Decorative. */
  illustration?: ReactNode;
  eyebrow?: string;
  title: string;
  description?: string;
  helperText?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  variant?: "default" | "compact" | "plain";
  align?: "center" | "left";
};

export default function EmptyState({
  emoji,
  illustration,
  eyebrow,
  title,
  description,
  helperText,
  action,
  secondaryAction,
  variant = "default",
  align = "center",
}: EmptyStateProps) {
  const isCompact = variant === "compact";
  const isWordIcon = Boolean(emoji && emoji.length > 2);
  const textAlign = align === "left" ? "text-left" : "text-center";
  const iconAlign = align === "left" ? "" : "mx-auto";

  const hasMark = Boolean(emoji || illustration);

  const content = (
    <>
      {illustration ? (
        <div className={`${align === "left" ? "" : "flex justify-center"}`} aria-hidden="true">
          {illustration}
        </div>
      ) : emoji ? (
        <div
          className={`${iconAlign} app-chip flex ${isCompact ? "h-11 min-w-11" : "h-14 min-w-14"} ${isWordIcon ? "px-3 text-2xs font-bold uppercase tracking-[0.14em]" : isCompact ? "w-11 text-2xl" : "w-14 text-3xl"} items-center justify-center rounded-xl shadow-e1`}
        >
          {emoji}
        </div>
      ) : null}
      {eyebrow ? (
        <div className={`${hasMark ? "mt-4" : ""} text-2xs font-semibold uppercase tracking-[0.2em] text-text-muted`}>
          {eyebrow}
        </div>
      ) : null}
      <h3 className={`${eyebrow || hasMark ? "mt-3" : ""} ${isCompact ? "text-base" : "text-lg sm:text-xl"} font-medium tracking-tight text-text-primary`}>
        {title}
      </h3>
      {description ? (
        <p className={`${isCompact ? "mt-2" : "mt-3"} max-w-2xl text-sm leading-6 text-text-secondary ${align === "center" ? "mx-auto" : ""}`}>
          {description}
        </p>
      ) : null}
      {helperText ? (
        <p className={`${isCompact ? "mt-2" : "mt-3"} max-w-2xl text-xs leading-5 text-text-muted ${align === "center" ? "mx-auto" : ""}`}>
          {helperText}
        </p>
      ) : null}
      {action || secondaryAction ? (
        <div className={`${isCompact ? "mt-4" : "mt-5"} flex flex-wrap gap-3 ${align === "center" ? "justify-center" : ""}`}>
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </>
  );

  if (variant === "plain") {
    return <div className={`animate-fade-in ${textAlign}`}>{content}</div>;
  }

  return (
    <Card
      tone="warm"
      padding={isCompact ? "md" : "lg"}
      className={`animate-fade-in ${textAlign}`}
    >
      {content}
    </Card>
  );
}
