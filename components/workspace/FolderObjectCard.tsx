import Link from "next/link";
import ObjectIcon from "./ObjectIcon";
import { getObjectColorPreset } from "@/lib/workspace/object-card-styles";

export type FolderObjectStat = {
  label: string;
  value: string | number;
};

type FolderObjectCardProps = {
  title: string;
  subtitle?: string;
  color?: string | null;
  icon?: string | null;
  stats?: FolderObjectStat[];
  updatedLabel?: string;
  href?: string;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  compact?: boolean;
};

/**
 * The folder itself -- back sheet, tab and front -- in the folder's colour.
 * Drawn on its own so an empty Practice page can show the same folder a
 * student is about to make.
 */
export function FolderArt({
  color,
  icon,
  compact = false,
}: {
  color?: string | null;
  icon?: string | null;
  compact?: boolean;
}) {
  const preset = getObjectColorPreset(color);
  return (
    <div className={`relative mx-auto w-full ${compact ? "h-[4.6rem] max-w-[5.75rem]" : "h-[6.45rem] max-w-[7.85rem]"}`}>
      <div
        className={`absolute left-[13%] right-[10%] top-[13%] rounded-t-sm border border-black/10 ${compact ? "h-[2.3rem]" : "h-[3.3rem]"}`}
        style={{
          backgroundColor: preset.paper,
        }}
      />
      <div
        className={`absolute left-[9%] top-[7%] w-[39%] rounded-t-sm border border-black/10 ${compact ? "h-[1.3rem]" : "h-[1.8rem]"}`}
        style={{
          backgroundColor: preset.light,
        }}
      />
      <div
        className={`absolute inset-x-[3%] bottom-0 rounded-sm border border-black/15 transition-transform duration-fast group-hover:-rotate-[0.35deg] ${compact ? "h-[3.35rem]" : "h-[4.7rem]"}`}
        style={{
          backgroundColor: preset.base,
          boxShadow: "0 8px 16px rgba(5, 8, 18, 0.22)",
        }}
      >
        <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
          <ObjectIcon icon={icon} className={`${compact ? "h-6 w-6" : "h-7 w-7"} text-white/88`} />
        </div>
      </div>
    </div>
  );
}

export default function FolderObjectCard({
  title,
  color,
  icon,
  href,
  onClick,
  selected = false,
  className = "",
  compact = false,
}: FolderObjectCardProps) {
  const content = (
    <div
      className={`group mx-auto flex h-full ${compact ? "min-h-[7.1rem] max-w-[6.5rem] px-1.5 py-2" : "min-h-[9.75rem] max-w-[8.35rem] px-2 py-2.5"} w-full cursor-pointer flex-col items-center rounded-lg border text-center transition duration-fast active:scale-[0.985] ${
        selected
          ? "border-[var(--color-selected-border)] bg-[var(--color-selected-bg)] shadow-e2"
          : "border-transparent bg-transparent hover:-translate-y-0.5 hover:border-[var(--color-border)] hover:bg-[var(--color-glass-subtle)]"
      } ${className}`}
    >
      <FolderArt color={color} icon={icon} compact={compact} />

      <div className={`${compact ? "mt-1" : "mt-2"} w-full min-w-0`}>
        <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]" title={title}>
          {title}
        </div>
      </div>
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block h-full">
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block h-full w-full">
        {content}
      </button>
    );
  }

  return content;
}
