"use client";

import type { ReactNode } from "react";
import { JamiTutorIcon } from "@/components/ui";

export type NotebookIconName =
  | "back"
  | "forward"
  | "pages"
  | "text"
  | "pen"
  | "highlighter"
  | "eraser"
  | "undo"
  | "redo"
  | "ai"
  | "chevron"
  | "options"
  | "trash"
  | "plus"
  | "check"
  | "alert"
  | "close"
  | "image"
  | "expand"
  | "minus"
  | "move"
  | "graph"
  | "box"
  | "oval"
  | "crop"
  | "eye"
  | "zoom-in"
  | "zoom-out"
  | "pointer"
  | "lasso"
  | "sheet";

// Hand-drawn on a consistent 24px grid with a uniform 1.8 stroke, rounded
// caps/joins, and shared optical margins, so the set reads as one family.
export function NotebookIcon({ name }: { name: NotebookIconName }) {
  if (name === "ai") {
    return <JamiTutorIcon className="h-[1.25rem] w-[1.25rem]" />;
  }

  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[1.125rem] w-[1.125rem]"
    >
      {name === "back" ? (
        <path {...common} d="M14.5 17.5 9 12l5.5-5.5" />
      ) : null}
      {name === "forward" ? (
        <path {...common} d="m9.5 6.5 5.5 5.5-5.5 5.5" />
      ) : null}
      {name === "pages" ? (
        <>
          <rect
            {...common}
            x="8"
            y="3.8"
            width="11.2"
            height="14.4"
            rx="2.2"
          />
          <path {...common} d="M4.8 8.1v9.7a2.7 2.7 0 0 0 2.7 2.7h7.7" />
        </>
      ) : null}
      {name === "text" ? (
        <path {...common} d="M6 7.4V5.4h12v2M12 5.4v13.2M9.5 18.6h5" />
      ) : null}
      {name === "sheet" ? (
        <>
          <rect {...common} x="3.8" y="4.8" width="16.4" height="14.4" rx="2.2" />
          <path {...common} d="M10.4 4.8v14.4M6.3 8.6h1.6M6.3 11.6h1.6M6.3 14.6h1.6" />
        </>
      ) : null}
      {name === "pen" ? (
        <>
          <path
            {...common}
            d="m4.9 19.1 1-3.9L16 5.1a2.05 2.05 0 0 1 2.9 2.9L8.8 18.1l-3.9 1Z"
          />
          <path {...common} d="m13.9 7.2 2.9 2.9" />
        </>
      ) : null}
      {name === "highlighter" ? (
        <>
          <path
            {...common}
            d="M5.6 17.9 14.7 8.8l1.7-1.7a1.95 1.95 0 0 1 2.75 0l.35.35a1.95 1.95 0 0 1 0 2.75L17.8 11.9l-9.1 9.1H5.6v-3.1Z"
          />
          <path {...common} d="M4.6 21h9.2" />
        </>
      ) : null}
      {name === "eraser" ? (
        <>
          <path
            {...common}
            d="M13.6 5.7 5.5 13.8a2 2 0 0 0 0 2.85l2.15 2.15a2 2 0 0 0 1.4.6h3.25l6.1-6.1a2 2 0 0 0 0-2.85l-2.9-2.9a2 2 0 0 0-2.85 0Z"
          />
          <path {...common} d="m9.3 10 4.9 4.9M12.7 19.4h6.7" />
        </>
      ) : null}
      {name === "undo" ? (
        <>
          <path {...common} d="M9 13.6 4.5 9.1 9 4.6" />
          <path {...common} d="M4.5 9.1h9.6a5.35 5.35 0 0 1 0 10.7H9.2" />
        </>
      ) : null}
      {name === "redo" ? (
        <>
          <path {...common} d="M15 13.6l4.5-4.5L15 4.6" />
          <path {...common} d="M19.5 9.1H9.9a5.35 5.35 0 0 0 0 10.7h4.9" />
        </>
      ) : null}
      {name === "chevron" ? (
        <path {...common} d="m7 10.4 5 5 5-5" />
      ) : null}
      {name === "options" ? (
        <>
          <circle cx="5" cy="12" r="1.35" fill="currentColor" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" />
          <circle cx="19" cy="12" r="1.35" fill="currentColor" />
        </>
      ) : null}
      {name === "trash" ? (
        <>
          <path
            {...common}
            d="M4.5 6.6h15M9.5 6.6V5.2a1.6 1.6 0 0 1 1.6-1.6h1.8a1.6 1.6 0 0 1 1.6 1.6v1.4"
          />
          <path
            {...common}
            d="m18.3 6.6-.85 12a2 2 0 0 1-2 1.85H8.55a2 2 0 0 1-2-1.85l-.85-12"
          />
          <path {...common} d="M10.1 10.6v5.8M13.9 10.6v5.8" />
        </>
      ) : null}
      {name === "plus" ? (
        <path {...common} d="M12 5.5v13M5.5 12h13" />
      ) : null}
      {name === "check" ? (
        <path {...common} d="m5.5 12.6 4.2 4.2 8.8-9.4" />
      ) : null}
      {name === "alert" ? (
        <>
          <circle {...common} cx="12" cy="12" r="8.25" />
          <path {...common} d="M12 8v4.6M12 15.9h.01" />
        </>
      ) : null}
      {name === "close" ? (
        <path {...common} d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
      ) : null}
      {name === "image" ? (
        <>
          <rect {...common} x="3.8" y="5" width="16.4" height="14" rx="2.4" />
          <circle {...common} cx="9" cy="10" r="1.6" />
          <path
            {...common}
            d="m4.6 17.4 4.6-4.5a1.6 1.6 0 0 1 2.2 0l2.1 2 1.6-1.5a1.6 1.6 0 0 1 2.2 0l2.8 2.7"
          />
        </>
      ) : null}
      {name === "expand" ? (
        <path
          {...common}
          d="M4.8 9.2V4.8h4.4M19.2 9.2V4.8h-4.4M4.8 14.8v4.4h4.4M19.2 14.8v4.4h-4.4"
        />
      ) : null}
      {name === "minus" ? <path {...common} d="M5.5 12h13" /> : null}
      {name === "move" ? (
        <>
          <path {...common} d="M12 4.8v14.4M4.8 12h14.4" />
          <path
            {...common}
            d="M9.8 7 12 4.8 14.2 7M9.8 17 12 19.2l2.2-2.2M7 9.8 4.8 12 7 14.2M17 9.8l2.2 2.2-2.2 2.2"
          />
        </>
      ) : null}
      {name === "graph" ? (
        <>
          <path {...common} d="M4.8 4.8v14.4h14.4" />
          <path {...common} d="M7.6 16.4c1.9-6.9 4.1-8.6 5.8-5.6 1.3 2.3 2.8 2.2 4.4-2.6" />
        </>
      ) : null}
      {name === "box" ? (
        <rect {...common} x="4.6" y="6.6" width="14.8" height="10.8" rx="1.8" />
      ) : null}
      {name === "oval" ? <ellipse {...common} cx="12" cy="12" rx="7.6" ry="5.8" /> : null}
      {name === "crop" ? (
        <path {...common} d="M7 3.8V17h13.2M3.8 7H17v13.2" />
      ) : null}
      {name === "eye" ? (
        <>
          <path {...common} d="M3.6 12s3-5.6 8.4-5.6 8.4 5.6 8.4 5.6-3 5.6-8.4 5.6S3.6 12 3.6 12Z" />
          <circle {...common} cx="12" cy="12" r="2.4" />
        </>
      ) : null}
      {name === "lasso" ? (
        <>
          <path {...common} d="M6.2 15.4C3.9 13.6 3.8 9.4 7 6.9c3.3-2.6 9.1-2.4 11.2.6 2 2.9-.3 6.8-4.6 7.8-2.4.6-4.9.4-6.8-.4" strokeDasharray="2.6 2.4" />
          <path {...common} d="M7.2 14.9c-.7 1.9.4 3.6 2.2 3.6" />
        </>
      ) : null}
      {name === "pointer" ? (
        <>
          <rect {...common} x="3.6" y="4.4" width="9" height="5.8" rx="1.5" />
          <path {...common} d="m12.6 9.6 5.2 6.2" />
          <circle cx="18.6" cy="16.8" r="2" fill="currentColor" />
        </>
      ) : null}
      {name === "zoom-in" || name === "zoom-out" ? (
        <>
          <circle {...common} cx="10.6" cy="10.6" r="6" />
          <path {...common} d="m15 15 4.6 4.6M8 10.6h5.2" />
          {name === "zoom-in" ? <path {...common} d="M10.6 8v5.2" /> : null}
        </>
      ) : null}
    </svg>
  );
}

export default function ToolbarIconButton({
  label,
  icon,
  active = false,
  pressed,
  disabled = false,
  expanded,
  controls,
  hasPopup,
  quiet = false,
  tutorialTarget,
  onClick,
  children,
}: {
  label: string;
  icon: NotebookIconName;
  active?: boolean;
  /** For a button that toggles or picks a tool: announced as pressed. */
  pressed?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  /** For a button that opens a menu. */
  hasPopup?: "menu";
  /**
   * No outline until it is pressed or pointed at: for a row of tools sitting
   * in a bar, where a ring round every one of them is noise.
   */
  quiet?: boolean;
  tutorialTarget?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={pressed}
      aria-controls={controls}
      aria-haspopup={hasPopup}
      title={label}
      disabled={disabled}
      data-notebook-toolbar-action="true"
      data-tutorial-target={tutorialTarget}
      // Selection is otherwise only visible in the class string; expose it so
      // tests and browser smokes can read state without matching on styling.
      data-active={active ? "true" : undefined}
      onClick={onClick}
      className={`relative inline-flex h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border text-sm font-semibold transition duration-200 disabled:cursor-not-allowed disabled:!text-[var(--button-disabled-text)] disabled:saturate-[0.82] ${
        quiet
          ? "disabled:!bg-transparent"
          : "disabled:!border-[var(--button-disabled-border)] disabled:!bg-[var(--button-disabled-bg)]"
      } ${
        active
          /*
           * A selection ring and a lift at once. Splitting them into two elements to use
           * two tokens would be worse than one honest exception.
           */
          // eslint-disable-next-line no-restricted-syntax
          ? "border-[var(--color-selected-border)] bg-[var(--color-selected-bg)] text-[var(--color-selected-text)] shadow-[0_0_0_3px_rgba(143,125,232,0.18),0_8px_18px_rgba(0,0,0,0.16)]"
          : quiet
            ? "border-transparent bg-transparent text-text-secondary hover:bg-[var(--color-glass-subtle)] hover:text-text-primary active:scale-95"
            : "border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)] hover:-translate-y-0.5 hover:border-[var(--button-secondary-border-hover)] hover:bg-[var(--button-secondary-bg-hover)] active:translate-y-0 active:scale-95"
      }`}
    >
      <NotebookIcon name={icon} />
      {children}
    </button>
  );
}
