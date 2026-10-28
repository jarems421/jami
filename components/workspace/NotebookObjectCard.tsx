"use client";

import Link from "next/link";
import { useAdaptiveMenuPlacement } from "@/components/ui/useAdaptiveMenuPlacement";
import ObjectIcon from "@/components/workspace/ObjectIcon";
import ObjectActionsSheet, {
  type ObjectActionsSheetAction,
} from "@/components/workspace/ObjectActionsSheet";
import { useObjectCardActions } from "@/hooks/useObjectCardActions";
import { cx } from "@/lib/app/class-names";
import {
  getNotebookPaperPalette,
  getNotebookRuleColor,
} from "@/lib/workspace/notebook-paper-palette";
import type { NotebookPageColor } from "@/lib/workspace/notebooks";
import { getObjectColorPreset } from "@/lib/workspace/object-card-styles";

export type NotebookObjectCardProps = {
  title: string;
  subtitle?: string;
  typeLabel?: string;
  folderName?: string;
  color?: string;
  icon?: string;
  pageColor?: NotebookPageColor;
  pageStyle?: string;
  pageCount?: number;
  updatedLabel?: string;
  previewInkSvg?: string;
  href?: string;
  onClick?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  className?: string;
  compact?: boolean;
  editorPreview?: boolean;
};

/**
 * The notebook itself -- cover, spine and the page block bound into it -- in
 * the notebook's colour and paper. Drawn on its own so an empty Practice page
 * can show the same notebook a student is about to open.
 */
export function NotebookArt({
  color,
  icon,
  pageColor,
  pageStyle,
  sizeClassName = "h-28 w-[6.1rem]",
}: Pick<NotebookObjectCardProps, "color" | "icon" | "pageColor" | "pageStyle"> & {
  sizeClassName?: string;
}) {
  const preset = getObjectColorPreset(color);
  const paperFill = getNotebookPaperPalette(pageColor).paper;
  const paperIsDark = getNotebookPaperPalette(pageColor).isDark;
  const paperLine = getNotebookRuleColor(pageColor, paperIsDark ? 0.18 : 0.13);
  // Edged in something the paper is not, so black pages stay visible on a dark theme.
  const paperEdge = paperIsDark ? "border-white/25" : "border-slate-900/15";
  const paperStyle =
    pageStyle === "lined"
      ? {
          backgroundColor: paperFill,
          backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent 10px, ${paperLine} 11px)`,
        }
      : pageStyle === "grid"
        ? {
            backgroundColor: paperFill,
            backgroundImage: `repeating-linear-gradient(to right, ${paperLine} 0 1px, transparent 1px 11px), repeating-linear-gradient(to bottom, ${paperLine} 0 1px, transparent 1px 11px)`,
          }
        : pageStyle === "dot"
          ? {
              backgroundColor: paperFill,
              backgroundImage: `radial-gradient(circle, ${paperLine} 1px, transparent 1px)`,
              backgroundSize: "9px 9px",
            }
          : { backgroundColor: paperFill };

  return (
    <div className="flex items-center justify-center">
      <div className={cx("relative", sizeClassName)}>
        {/*
          * The page block, bound into the cover. Both sheets are the notebook's
          * own paper, centred on the cover and tucked in evenly top and bottom,
          * so they read as its pages rather than cards sliding out from behind
          * -- they used to sit lower than the cover and hang past its foot.
          */}
        <div
          className={cx("absolute inset-y-[6%] left-[10%] right-0 rounded-r-sm border", paperEdge)}
          style={paperStyle}
          aria-hidden="true"
        />
        <div
          className={cx("absolute inset-y-[3%] left-[10%] right-[5%] rounded-r-sm border", paperEdge)}
          style={paperStyle}
          aria-hidden="true"
        />
        <div
          className="absolute inset-y-0 left-0 h-full w-[86%] origin-left rounded-sm border border-black/15 shadow-e1 transition duration-200 group-hover/notebook:-rotate-[0.65deg]"
          style={{
            backgroundColor: preset.base,
          }}
        >
          <div className="absolute inset-y-0 left-0 w-3 rounded-l-sm border-r border-black/15 bg-black/10" aria-hidden="true" />
          <div className="absolute inset-y-2 right-1.5 w-px bg-white/28" aria-hidden="true" />
          <ObjectIcon
            icon={icon}
            className="absolute left-[53%] top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-white/88"
          />
        </div>
      </div>
    </div>
  );
}

function NotebookCardInner({
  title,
  typeLabel,
  color,
  icon,
  pageColor,
  pageStyle,
  pageCount,
  updatedLabel,
  compact,
  editorPreview,
}: NotebookObjectCardProps) {
  return (
    <div
      className={cx(
        "group/notebook mx-auto flex h-full w-full max-w-[8.35rem] cursor-pointer flex-col items-center rounded-lg border border-transparent bg-transparent px-2 py-2.5 text-center transition duration-200 hover:border-[var(--color-border)] hover:bg-[var(--color-glass-subtle)]",
        editorPreview ? "min-h-[7rem] max-w-[6rem] px-1.5 py-2" : compact ? "min-h-[9.6rem]" : "min-h-[10.9rem]",
      )}
    >
      <NotebookArt
        color={color}
        icon={icon}
        pageColor={pageColor}
        pageStyle={pageStyle}
        sizeClassName={editorPreview ? "h-[4.8rem] w-[4.6rem]" : compact ? "h-24 w-[5.45rem]" : "h-28 w-[6.1rem]"}
      />

      <div className={cx("w-full space-y-1", editorPreview ? "mt-1.5" : "mt-3")}>
        <div>
          <p className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--color-text-primary)]" title={title}>{title}</p>
        </div>
        <p className="truncate text-xs font-medium text-[var(--color-text-muted)]">
          {updatedLabel ??
            (typeof pageCount === "number"
              ? `${pageCount} ${pageCount === 1 ? "page" : "pages"}`
              : typeLabel)}
        </p>
      </div>
    </div>
  );
}

export function NotebookObjectCard(props: NotebookObjectCardProps) {
  const actionSheet = useObjectCardActions("notebook");
  const { handleToggle, menuPositionClass } = useAdaptiveMenuPlacement(112);

  const hasActions = Boolean(props.onEdit || props.onDelete);
  const mobileActions: ObjectActionsSheetAction[] = [];
  if (props.onEdit) {
    mobileActions.push({
      id: "edit",
      label: "Edit notebook",
      disabled: props.deleting,
      onSelect: props.onEdit,
    });
  }
  if (props.onDelete) {
    mobileActions.push({
      id: "delete",
      label: props.deleting ? "Deleting..." : "Delete notebook",
      tone: "danger",
      disabled: props.deleting,
      onSelect: props.onDelete,
    });
  }
  const standaloneInteractionClass = hasActions
    ? undefined
    : "transition duration-200 hover:-translate-y-0.5 active:scale-[0.985]";
  const card = props.href ? (
    <Link
      href={props.href}
      prefetch={false}
      className={cx("block h-full", standaloneInteractionClass, props.className)}
    >
      <NotebookCardInner {...props} />
    </Link>
  ) : props.onClick ? (
    <button
      type="button"
      onClick={props.onClick}
      className={cx(
        "block h-full w-full",
        standaloneInteractionClass,
        props.className
      )}
    >
      <NotebookCardInner {...props} />
    </button>
  ) : (
    <div className={cx("h-full", props.className)}>
      <NotebookCardInner {...props} />
    </div>
  );

  if (!hasActions) return card;
  return (
    <div
      className="relative h-full select-none transition duration-200 hover:-translate-y-0.5 md:grid md:grid-cols-[minmax(0,1fr)_2.5rem] md:items-start md:select-auto"
      style={{ WebkitTouchCallout: "none" }}
      {...actionSheet.pressProps}
    >
      {card}
      <button
        type="button"
        className="sr-only md:hidden"
        onClick={actionSheet.open}
      >
        Open notebook actions for {props.title}
      </button>
      <details
        className="group/actions relative z-20 hidden h-10 w-10 items-center justify-center md:flex"
        onToggle={handleToggle}
      >
        <summary
          aria-label={`Notebook actions for ${props.title}`}
          title="Notebook actions"
          className="flex h-[1.875rem] w-[1.875rem] cursor-pointer list-none items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] text-text-muted transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-glass-medium)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            className="h-4 w-4"
          >
            <circle cx="4" cy="10" r="1.35" />
            <circle cx="10" cy="10" r="1.35" />
            <circle cx="16" cy="10" r="1.35" />
          </svg>
        </summary>
        <div
          className={cx(
            "absolute right-0 z-30 grid min-w-44 gap-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] p-1.5 text-left shadow-e3",
            menuPositionClass
          )}
        >
          {props.onEdit ? (
            <button
              type="button"
              disabled={props.deleting}
              className="rounded-sm px-3 py-2 text-left text-sm font-medium text-text-primary transition hover:bg-[var(--color-glass-subtle)] disabled:cursor-not-allowed disabled:text-[var(--button-disabled-text)]"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                props.onEdit?.();
              }}
            >
              Edit notebook
            </button>
          ) : null}
          {props.onDelete ? (
            <button
              type="button"
              disabled={props.deleting}
              className="rounded-sm px-3 py-2 text-left text-sm font-semibold text-error transition hover:bg-[var(--color-error-muted)] disabled:cursor-not-allowed disabled:text-[var(--button-disabled-text)]"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                props.onDelete?.();
              }}
            >
              {props.deleting ? "Deleting..." : "Delete notebook"}
            </button>
          ) : null}
        </div>
      </details>
      <ObjectActionsSheet
        open={actionSheet.isOpen}
        objectKind="notebook"
        title={props.title}
        actions={mobileActions}
        onClose={actionSheet.close}
      />
    </div>
  );
}
