"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import ToolbarIconButton, {
  NotebookIcon,
  type NotebookIconName,
} from "@/components/workspace/NotebookToolbarIconButton";
import { NOTEBOOK_PAGE_IMAGE_TYPES } from "@/lib/workspace/notebook-page-image-upload";
import { notebookToolbarMenuPosition, type NotebookToolbarDock } from "@/lib/workspace/notebook-toolbar";

export const NOTEBOOK_INSERT_MENU_ID = "notebook-insert-menu";

const px = (value: number | undefined) => (value === undefined ? "" : `${value}px`);

function MenuItem({
  icon,
  label,
  disabled = false,
  onSelect,
}: {
  icon: NotebookIconName;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-semibold text-text-primary transition hover:bg-[var(--color-glass-subtle)] disabled:cursor-not-allowed disabled:text-[var(--button-disabled-text)]"
    >
      <NotebookIcon name={icon} />
      {label}
    </button>
  );
}

/**
 * The toolbar's Insert button: a picture from the device, or a graph, onto
 * the current page. Both are occasional, so they share one button and a small
 * menu instead of taking two places on a toolbar that also has to make room
 * for the tools a student reaches for all the time.
 *
 * Whether it is open is the page's toolbar menu state (`openMenu`), so it and
 * a tool's settings never show at once, and whatever puts those away -- the
 * pen landing, a drag, Escape -- puts this away too.
 *
 * The menu is drawn on the page's body, beside the button and away from the
 * toolbar's edge (`notebookToolbarMenuPosition`): the toolbar's paint
 * containment would clip it anywhere inside.
 */
export default function NotebookToolbarInsertMenu({
  dock,
  open,
  quiet,
  onToggle,
  onAddImage,
  addingImage,
  onAddGraph,
}: {
  dock: NotebookToolbarDock;
  open: boolean;
  quiet: boolean;
  onToggle: () => void;
  /** A picture chosen from the device, to place on the current page. */
  onAddImage: (file: File) => void;
  addingImage: boolean;
  /** Opens the graph editor, to plot a new graph on the current page. */
  onAddGraph: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // Outside the menu, so the picker's answer still arrives once the menu has gone.
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const placeMenu = useCallback(
    (menu: HTMLDivElement | null) => {
      menuRef.current = menu;
      const anchor = anchorRef.current;
      if (!menu || !anchor) return;
      const position = notebookToolbarMenuPosition(dock, anchor.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      menu.style.left = px(position.left);
      menu.style.top = px(position.top);
      menu.style.right = px(position.right);
      menu.style.bottom = px(position.bottom);
      menu.style.transform = position.transform;
    },
    [dock]
  );
  // Placed again when the window changes under it -- an iPad turned on its side.
  useEffect(() => {
    if (!open) return;
    const placeAgain = () => placeMenu(menuRef.current);
    window.addEventListener("resize", placeAgain);
    return () => window.removeEventListener("resize", placeAgain);
  }, [open, placeMenu]);

  return (
    <div ref={anchorRef} className="relative">
      <ToolbarIconButton
        label={addingImage ? "Insert (adding an image)" : "Insert"}
        icon="plus"
        quiet={quiet}
        active={open}
        expanded={open}
        controls={open ? NOTEBOOK_INSERT_MENU_ID : undefined}
        hasPopup="menu"
        onClick={onToggle}
      >
        {addingImage ? (
          <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-accent" />
        ) : null}
      </ToolbarIconButton>
      {open
        ? createPortal(
            <div
              ref={placeMenu}
              id={NOTEBOOK_INSERT_MENU_ID}
              role="menu"
              aria-label="Insert"
              // A press here is the menu's own: not the start of a toolbar
              // drag, nor a tap on the page that puts menus away.
              onPointerDown={(event) => event.stopPropagation()}
              className="notebook-toolbar-popover-in fixed z-50 min-w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] p-1.5 shadow-e2"
            >
              <MenuItem
                icon="image"
                label={addingImage ? "Adding image…" : "Image"}
                disabled={addingImage}
                onSelect={() => {
                  // In the same tap, or Safari will not open the picker.
                  imageInputRef.current?.click();
                  onToggle();
                }}
              />
              <MenuItem
                icon="graph"
                label="Graph"
                onSelect={() => {
                  onToggle();
                  onAddGraph();
                }}
              />
            </div>,
            document.body
          )
        : null}
      <input
        ref={imageInputRef}
        type="file"
        accept={NOTEBOOK_PAGE_IMAGE_TYPES.join(",")}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file again still fires a change.
          event.target.value = "";
          if (file) onAddImage(file);
        }}
      />
    </div>
  );
}
