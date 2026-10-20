import ConstellationStar from "@/components/constellation/ConstellationStar";
import { buildPreviewStar } from "@/lib/constellation/stars";

/**
 * The star a goal will earn, shown while the goal is being set.
 *
 * Drawn from the same two numbers the real star will be written with, so it
 * grows as the goal does: a bigger goal is visibly a bigger star before it is
 * made, which is the most direct way to say what it is worth.
 */
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
