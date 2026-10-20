import ConstellationStar from "@/components/constellation/ConstellationStar";
import { buildPreviewStar } from "@/lib/constellation/stars";

/**
 * The star a goal will earn, shown while the goal is being set.
 *
 * Drawn from the same two numbers the real star will be written with, so it
 * grows as the goal does: a bigger goal is visibly a bigger star before it is
 * made, which is the most direct way to say what it is worth.
 */
/** Three goals' stars side by side, small to large: what a goal is worth, before there is one. */
const TRIO = [
  { id: "trio-small", effort: 10, x: 22, y: 64 },
  { id: "trio-medium", effort: 80, x: 50, y: 34 },
  { id: "trio-large", effort: 320, x: 78, y: 62 },
] as const;

export function GoalStarTrio({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      // eslint-disable-next-line no-restricted-syntax
      className={`relative overflow-hidden rounded-xl border border-[rgba(238,225,255,0.18)] bg-[linear-gradient(180deg,#080416_0%,#060311_58%,#030108_100%)] shadow-[inset_0_0_34px_rgba(143,125,232,0.14)] ${className}`}
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(143,125,232,0.16),rgba(6,3,17,0.66))]" />
      <div className="absolute inset-0 z-10">
        {TRIO.map((item) => (
          <ConstellationStar
            key={item.id}
            variant="preview"
            star={buildPreviewStar({ id: item.id, effort: item.effort, glow: 0.85, position: { x: item.x, y: item.y } })}
          />
        ))}
      </div>
    </div>
  );
}

export default function GoalStarPreview({
  effort,
  glow,
  caption,
}: {
  effort: number;
  glow: number;
  caption: string;
}) {
  const star = buildPreviewStar({ effort, glow });
  return (
    <figure className="space-y-2">
      {/*
        An inner glow, which is the opposite of elevation: it pushes light into
        the panel rather than lifting the panel off the page. No height on the
        scale describes a hollow.
      */}
      <div
        // eslint-disable-next-line no-restricted-syntax
        className="relative h-40 overflow-hidden rounded-xl border border-[rgba(238,225,255,0.18)] bg-[linear-gradient(180deg,#080416_0%,#060311_58%,#030108_100%)] shadow-[inset_0_0_34px_rgba(143,125,232,0.14)] sm:h-44"
      >
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(143,125,232,0.16),rgba(6,3,17,0.66))]" />
        <div className="absolute inset-0 z-10">
          <ConstellationStar star={star} variant="preview" />
        </div>
      </div>
      <figcaption className="text-xs leading-5 text-text-muted">{caption}</figcaption>
    </figure>
  );
}
