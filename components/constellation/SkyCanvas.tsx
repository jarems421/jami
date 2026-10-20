"use client";

import Link from "next/link";
import ConstellationLines from "@/components/constellation/ConstellationLines";
import ConstellationStar from "@/components/constellation/ConstellationStar";
import type { ConstellationSkyMode } from "@/components/constellation/ConstellationControls";
import ShootingStars from "@/components/constellation/ShootingStars";
import { EmptyState } from "@/components/ui";
import type { ConstellationLine } from "@/lib/constellation/constellations";
import { getShootingStarCount } from "@/lib/constellation/shooting-stars";
import { SKY_CONTAINER_ID, type NormalizedStar } from "@/lib/constellation/stars";
import { goalStarLabel, type Goal } from "@/lib/goals/model";

function starLabel(star: NormalizedStar, goalsById: Record<string, Goal>) {
  if (star.rewardKind === "onboarding") return star.rewardLabel ?? "First study loop";
  const goal = goalsById[star.goalId];
  return goal ? goalStarLabel(goal) : "Earned star";
}

/**
 * The open sky: its stars, the lines between them, a line being drawn, and a
 * few shooting stars. What a press on a star means is the page's to decide;
 * this only says which star was pressed and how.
 */
export default function SkyCanvas({
  skyId,
  stars,
  lines,
  goalsById,
  mode,
  link,
  canArrange,
  onRemoveLine,
  onStarActivate,
  onStarPress,
  onStarNudge,
}: {
  skyId: string;
  stars: NormalizedStar[];
  lines: ConstellationLine[];
  goalsById: Record<string, Goal>;
  mode: ConstellationSkyMode;
  link: {
    fromStarId: string | null;
    point: { x: number; y: number } | null;
    hoverStarId: string | null;
  };
  canArrange: boolean;
  onRemoveLine: (line: ConstellationLine) => void;
  onStarActivate: (star: NormalizedStar) => void;
  onStarPress: (star: NormalizedStar, pointerType: string) => void;
  onStarNudge: (starId: string, position: NormalizedStar["position"]) => void;
}) {
  const isConnecting = mode === "connect";

  return (
    <div
      id={SKY_CONTAINER_ID}
      // Every drag in here is a star's, never a pull to refresh.
      data-no-pull-refresh
      /*
       * The sky takes the whole gesture from a tablet upwards.
       *
       * Arranging and connecting are both direct manipulation, and a drag that
       * starts anywhere in here is meant for a star -- so nothing in it should
       * ever be read as a page scroll. A press that misses a star used to
       * scroll the page instead, which is the whole complaint about the screen
       * moving.
       *
       * This applies at every width. The rest of the page remains scrollable
       * around the sky, but once a gesture begins in this canvas it belongs to
       * arranging or connecting stars.
       */
      className="relative h-[60vh] w-full touch-none select-none overflow-hidden overscroll-contain rounded-2xl border border-[var(--color-border)] bg-surface-base sm:h-[560px]"
      style={{
        /*
         * Night, and nothing else. Two wide violet washes were painted here to
         * carry the ambient half of the glow, and they read as light coming
         * from nowhere -- a bloom in the corner of an empty sky with no star
         * responsible for it. The radiance belongs to the stars and is drawn
         * by them.
         */
        backgroundColor: "#090413",
      }}
    >
      {/* More stars earned, a few more streaks: never enough to distract. */}
      <ShootingStars count={getShootingStarCount(stars.length, "sky")} seed={skyId} />
      <ConstellationLines
        lines={lines}
        stars={stars}
        pending={
          link.fromStarId && link.point
            ? { fromStarId: link.fromStarId, ...link.point, toStarId: link.hoverStarId }
            : null
        }
        onRemoveLine={isConnecting ? onRemoveLine : undefined}
      />
      <div className="absolute inset-0 z-10">
        {stars.map((star) => (
          <ConstellationStar
            key={star.id}
            star={star}
            interaction={mode}
            isLinkSource={link.fromStarId === star.id}
            isLinkTarget={isConnecting && link.hoverStarId === star.id}
            onActivate={isConnecting ? () => onStarActivate(star) : undefined}
            label={starLabel(star, goalsById)}
            onDragStart={canArrange ? (pointerType) => onStarPress(star, pointerType) : undefined}
            onNudge={
              canArrange && !isConnecting
                ? (position) => onStarNudge(star.id, position)
                : undefined
            }
          />
        ))}
      </div>
      {stars.length === 0 ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-5">
          <div className="max-w-md">
            <EmptyState
              variant="plain"
              emoji="Stars"
              eyebrow="No stars yet"
              title="Complete goals to fill this sky"
              description="Skies are rewards, not another task list. Finish a study goal and its star will appear here."
              action={
                <Link
                  href="/dashboard/goals"
                  className="app-button-primary inline-flex min-h-[2.75rem] items-center justify-center rounded-2xl px-4 py-2 text-sm font-medium"
                >
                  Create a goal
                </Link>
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
