"use client";

import {
  clampPercentage,
  getEffectiveStarVisualSize,
  type NormalizedStar,
  type StarTint,
} from "@/lib/constellation/stars";
import { NORTHERN_STAR_BOX, NORTHERN_STAR_PATH } from "@/components/ui/NorthernStar";

type ConstellationStarProps = {
  star: NormalizedStar;
  /** Called with what pressed the star: "mouse", "touch" or "pen". */
  onDragStart?: (pointerType: string) => void;
  onNudge?: (position: NormalizedStar["position"]) => void;
  variant?: "default" | "background" | "preview";
  label?: string;
  /**
   * What a press on this star means right now.
   *
   * The sky has one gesture and two things it could mean, so the page picks
   * which. In "arrange" a press starts a drag; in "connect" it starts a line to
   * another star. Announcing the difference matters as much as behaving
   * differently, because a screen reader user has no mode indicator to look at.
   */
  interaction?: "arrange" | "connect";
  /** The star a line is currently being drawn from. */
  isLinkSource?: boolean;
  /**
   * The star the half-drawn line is currently over.
   *
   * Letting go here joins the two, so this is the one piece of feedback that
   * turns the drop from a guess into a decision.
   */
  isLinkTarget?: boolean;
  /** Keyboard equivalent of pressing the star, used to pick link ends. */
  onActivate?: () => void;
  /**
   * Draw at this many pixels instead of the size the goal earned.
   *
   * For the reward, where the star is the whole subject of the screen: a
   * one-card goal's 18px star reads as a speck there. Glow, bloom and sparkles
   * all scale from this, so a larger star is the same star, not a stretched one.
   */
  visualSize?: number;
};

/**
 * The earned star, as a mask for the light behind it.
 *
 * This masked a 202KB PNG, so the star a student earned in the reward overlay
 * and the star they then found in their sky were two different drawings. The
 * overlay, the walkthrough trail and the signed-out landing page all use
 * NorthernStar, and its own docstring says the point is that they "read as one
 * object at three sizes" -- the sky, which is the whole feature, was the one
 * surface that never joined.
 *
 * Masking rather than drawing keeps the gradient carrying the light and the
 * filter carrying the glow. Only the silhouette changes.
 */
const NORTHERN_STAR_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${NORTHERN_STAR_BOX} ${NORTHERN_STAR_BOX}"><path d="${NORTHERN_STAR_PATH}" fill="#000"/></svg>`
)}")`;

const STAR_MASK_STYLE = {
  WebkitMaskImage: NORTHERN_STAR_MASK,
  maskImage: NORTHERN_STAR_MASK,
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskSize: "contain",
  maskSize: "contain",
  maskMode: "alpha",
} as const;

/**
 * White, and only white.
 *
 * Stars came in white, blue and gold, warming as goals were completed. Drawn,
 * the hue sat at the 24 per cent stop of this gradient, so a gold star was gold
 * through its core rather than white-hot with warm light around it. Real stars
 * are white in the middle and carry their colour in what they throw; these did
 * the opposite, and looked it.
 */
/*
 * A gifted figure may be tinted, and the same rule holds: the core stays
 * white-hot and the colour lives in the light it throws. Each palette holds the
 * colours, as "r, g, b", that the gradient, glow, bloom and sparkles use.
 */
type StarLight = { inner: string; mid: string; deep: string; outer: string; glow: string; sparkle: string };

const STAR_LIGHT: Record<"white" | StarTint, StarLight> = {
  white: { inner: "236, 238, 255", mid: "220, 224, 255", deep: "208, 214, 255", outer: "196, 198, 255", glow: "198, 202, 255", sparkle: "255, 255, 255" },
  pink: { inner: "255, 232, 244", mid: "255, 190, 222", deep: "255, 164, 210", outer: "255, 140, 196", glow: "255, 150, 202", sparkle: "255, 226, 240" },
};

function getStarGradient(light: StarLight) {
  return `radial-gradient(circle at center, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0.9) 12%, rgba(${light.mid}, 0.3) 38%, rgba(${light.outer}, 0) 66%)`;
}

/**
 * The light a star throws: a tight white core and a wide violet bloom.
 *
 * Both are drop-shadows, so both blur the star's own silhouette and fall off on
 * a Gaussian -- shaped like the star, with no boundary anywhere. That is the
 * distinction that matters here. An earlier pass got a circular div behind each
 * star, which read as a disc; the answer was never less light, it was light
 * that follows the shape.
 *
 * It then went too far the other way and became a hairline, which is why the
 * outer bloom is a real radius. It is what makes a thin star legible at 18px:
 * the star is thin and the light around it is not.
 *
 * The tight core shadow is the opposite problem and stayed wrong longer. At
 * 0.12 to 0.2 of the star it was wide enough to fill the gap between the four
 * rays, so the middle read as a solid blob and the star looked thick however
 * far the path was thinned. The centre's apparent weight was never mostly the
 * geometry. It is a third of what it was.
 */
function getStarGlowFilter(glowStrength: number, starSize: number, light: StarLight) {
  const core = starSize * (0.05 + glowStrength * 0.04);
  const bloom = starSize * (0.36 + glowStrength * 0.28);

  return [
    `drop-shadow(0 0 ${core}px rgba(255, 255, 255, ${0.6 + glowStrength * 0.25}))`,
    `drop-shadow(0 0 ${bloom}px rgba(${light.glow}, ${0.34 + glowStrength * 0.2}))`,
  ].join(" ");
}

/**
 * How many sparkles a star throws.
 *
 * Every star gets some, on every surface. There were two exclusions and both
 * were rationing elements from the days when the page was struggling for
 * frames: a 30px floor, below which a star threw none -- and since size tracks
 * the goal behind it, the stars going without were the ones earned for smaller
 * goals -- and the whole background variant, which is the same sky seen through
 * the app and had no business being a duller copy of it.
 *
 * The blend modes that caused the frame problem are long gone. Count scales
 * with the star instead, which is also what looks right: four sparkles around
 * an 18px star would crowd it. Small stars get two, on opposite diagonals;
 * larger ones get all four, one per quadrant.
 */
const SPARKLE_FULL_STAR_SIZE = 30;
const SPARKLES_PER_STAR = 4;

/**
 * Every background star sparkles again, at two apiece.
 *
 * A sparkle is another masked, animated element, and the background carries the
 * most stars while being the one place something else on the page needs the
 * main thread. Measured by timing how long it takes to mount a page's worth of
 * DOM -- which is what switching areas of the app does -- against a page with
 * no star field at all:
 *
 *   no background                          11.6ms   57fps    6 long frames
 *   60 stars, sparkles on every one        17.3ms   52fps   18 long frames
 *   40 stars, sparkles on those over 36px  12.5ms   59fps    6 long frames
 *
 * The middle row is where the cost was, and it is 60 stars carrying up to four
 * sparkles each -- around 240 of them. Rationing by size then took the count to
 * roughly 30, which bought the frames back and left most of the sky with no
 * sparkles at all: stars are 18 to 52 pixels, so a 36px floor silently excluded
 * the majority, and the sky read as dead.
 *
 * Forty stars at two each is 80, a third of what the expensive row measured and
 * a long way under it. That is a reasoned bet rather than a measurement, and
 * `BACKGROUND_SPARKLES_PER_STAR` is the knob: at 1 the count halves again, at 0
 * the star bodies still breathe on their own.
 */
const BACKGROUND_SPARKLES_PER_STAR = 2;

function getSparkleCount(starSize: number, isBackground: boolean) {
  if (isBackground) return BACKGROUND_SPARKLES_PER_STAR;

  return starSize >= SPARKLE_FULL_STAR_SIZE ? SPARKLES_PER_STAR : 2;
}

/**
 * How dim a star gets at the bottom of its breath, seeded per star.
 *
 * The floor was a single 0.76 for every star in the sky, which is a swing of
 * under a quarter and, behind a page that is also dimmed, close to invisible --
 * "the stars do not twinkle any more" is what a fixed shallow floor looks like.
 *
 * Varying it is what makes it read as a sky rather than a setting: some stars
 * barely move, others halve and come back, and none of them are in step. It
 * costs nothing at all -- the element and its animation already exist, and
 * opacity is the one property the compositor handles on its own.
 */
function getTwinkleFloor(star: NormalizedStar) {
  return 0.45 + getSeededFraction(star.id, 53) * 0.35;
}

/**
 * The bloom: light standing off the star, in the star's own proportions.
 *
 * This has now been wrong in both directions and the failures are worth
 * keeping, because they are opposite. A circular div was drawn behind each star
 * and read as "a strict circle around the star" -- its alpha stepped 0.16, 0.07,
 * 0, which leaves a shoulder, and the eye finds a shoulder and calls it an
 * edge. Replacing it with two crossed ellipses along the star's axes went the
 * other way: thin streaks running past the tips read as spikes pointing off the
 * peaks rather than as anything glowing.
 *
 * So: one soft ellipse, no streaks, with alpha roughly halving at every stop so
 * the falloff never straightens into an edge.
 *
 * It is round, and getting there took overshooting twice. Matching the star's
 * own proportions at 34 by 56 compounded into a standing vertical oval, because
 * a bloom taller than wide around a star taller than wide doubles rather than
 * cancels. Correcting to 54 by 42 then read as the horizontal rays being
 * stretched, most visibly on the largest stars where the bloom is widest. The
 * light around a star should not have a long axis at all: 48 by 48.
 *
 * Held below the sparkles in brightness on purpose. Around 0.4 it starts to
 * wash them out, and the sparkles are the detail worth seeing.
 */
const BLOOM_BOX_RATIO = 3.2;

function getBloomBackground(glowStrength: number, light: StarLight) {
  const alpha = 0.22 + glowStrength * 0.1;
  const at = (fraction: number) => (alpha * fraction).toFixed(3);

  return `radial-gradient(ellipse 48% 48% at 50% 50%, rgba(255, 255, 255, ${alpha}) 0%, rgba(${light.inner}, ${at(0.5)}) 16%, rgba(${light.mid}, ${at(0.24)}) 32%, rgba(${light.deep}, ${at(0.1)}) 50%, rgba(${light.outer}, ${at(0.03)}) 70%, rgba(${light.outer}, 0) 100%)`;
}

/**
 * A stable number in [0, 1) for one star and one purpose.
 *
 * FNV-1a with a final avalanche, rather than the `hash * 31 % 100000` this was.
 * That version barely dispersed: two ids differing in their last character came
 * out one part in a hundred thousand apart, so a whole sky of stars named in
 * sequence got the same answer to three decimal places -- which is why the
 * quadrant bias noted below was as bad as it was, and why every star ended up
 * breathing to an identical depth the moment anything rounded the result.
 *
 * Changing this reshuffles where sparkles sit and how long they take. Both are
 * cosmetic and neither was chosen; only the spread was ever the point.
 */
function getSeededFraction(seed: string, index: number) {
  let hash = Math.imul(2166136261 ^ index, 16777619);
  for (let position = 0; position < seed.length; position += 1) {
    hash ^= seed.charCodeAt(position);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967296;
}

/**
 * Where a star's sparkles sit, and when each one lights.
 *
 * One per quadrant, jittered inside it, rather than a seeded angle anywhere on
 * the circle. The seeded version was badly biased: across 400 ids the quadrant
 * split came out 400 / 10 / 480 / 310, and for sequentially numbered ids it
 * picked the *same three* quadrants every time, so every star in a sky had an
 * empty top-left corner. A hash that is only used three or four times per star
 * is nowhere near enough samples to trust for coverage.
 *
 * Anchoring each sparkle to a quadrant centre and jittering by less than half a
 * quadrant guarantees all four are occupied while keeping stars unalike. The
 * seed still sets distance, size and timing, where a bias does no harm.
 *
 * The cycles are long and staggered, so the sparkles brighten at different
 * moments rather than together.
 */
function getSparkles(
  star: NormalizedStar,
  starSize: number,
  isBackground: boolean
) {
  const count = getSparkleCount(starSize, isBackground);

  return Array.from({ length: count }, (_, index) => {
    // With two, they take opposite diagonals rather than adjacent ones, so a
    // small star still reads as lit on both sides instead of lopsided.
    const step = (Math.PI * 2) / count;
    const quadrantCentre = index * step + Math.PI / 4;
    const jitter = (getSeededFraction(star.id, index) - 0.5) * (step * 0.4);
    const angle = quadrantCentre + jitter;
    const distance = 55 + getSeededFraction(star.id, index + 7) * 35;
    /*
     * Sized with the star, but never below what the eye can find.
     *
     * Proportional alone put a 2.3px sparkle around an 18px star, and at that
     * size a point of light behind a page is not dim, it is absent -- which is
     * most of the sky, since the smallest stars are the commonest.
     */
    const size = Math.max(
      3.2,
      starSize * (0.13 + getSeededFraction(star.id, index + 13) * 0.08)
    );

    return {
      key: `${star.id}-sparkle-${index}`,
      size,
      left: 50 + Math.cos(angle) * distance,
      top: 50 + Math.sin(angle) * distance,
      driftX: Math.cos(angle) * starSize * 0.14,
      driftY: Math.sin(angle) * starSize * 0.14,
      duration: 5.5 + getSeededFraction(star.id, index + 23) * 4,
      delay: getSeededFraction(star.id, index + 31) * 6,
    };
  });
}

/**
 * How long one breath takes: about four seconds.
 *
 * This has been as short as three, which read as a pulse, and as long as eight,
 * which is genuinely below the threshold where the eye follows it -- so far
 * below that the sky stopped looking alive at all. Four is the middle: quick
 * enough to notice, slow enough that noticing it is not the point.
 *
 * The spread matters as much as the number. Every star runs a slightly
 * different cycle seeded from its own id, so forty of them never fall into step
 * -- forty stars breathing together is a heartbeat, not a sky.
 */
function getTwinkleDuration(star: NormalizedStar, isBackground: boolean) {
  const base = isBackground ? 3.9 : 3.5;
  const variation = (star.createdAt % 4) / 5 + ((star.id.length % 7) / 7);

  return `${base + variation}s`;
}

function getTwinkleDelay(star: NormalizedStar) {
  const delay = (star.createdAt % 9) / 10;
  return `${delay}s`;
}

export default function ConstellationStar({
  star,
  onDragStart,
  onNudge,
  variant = "default",
  label = "Earned star",
  interaction = "arrange",
  isLinkSource = false,
  isLinkTarget = false,
  onActivate,
  visualSize,
}: ConstellationStarProps) {
  const isBackground = variant === "background";
  const isPreview = variant === "preview";
  const glowStrength = Math.max(0, Math.min(1, star.glow));
  // Was multiplied by a three-branch ternary whose every branch was 1.
  const starSize = visualSize ?? getEffectiveStarVisualSize(star);
  const sparkles = getSparkles(star, starSize, isBackground);
  const light = STAR_LIGHT[star.tint ?? "white"];
  const className = `absolute select-none ${variant === "default" ? "constellation-star-enter" : ""} ${onDragStart ? "cursor-grab touch-none" : ""}`;
  const style = {
    left: `${star.position.x}%`,
    top: `${star.position.y}%`,
    transform: "translate(-50%, -50%)",
    width: `${starSize}px`,
    height: `${starSize}px`,
  };
  /*
   * One element for the star, and nothing promoted.
   *
   * This was three stacked elements -- a twinkle wrapper, a circular halo and
   * the body -- of which two carried `mix-blend-mode: screen` and all three
   * carried `will-change`. At forty stars that is roughly 120 GPU layers and 80
   * blend readbacks a frame, and a blended element cannot be composited on its
   * own: its backdrop has to be re-rasterised every frame. It was visibly laggy.
   *
   * Screen against a near-black sky is very close to normal for bright pixels,
   * so dropping the blend mode costs almost nothing to look at, and the twinkle
   * now animates opacity alone, which the compositor handles without help.
   */
  /*
   * The mark on a star that is picked up, or about to be joined to.
   *
   * This was `outline` on the button, which is a square -- a hard-cornered box
   * around a star, in a sky. A ring is the shape the thing it marks actually
   * is, and it stays a ring: never filled, because the sky's own rule is that
   * nothing solid goes behind a star. It reads as a control rather than as
   * light, which is exactly what it is.
   *
   * The source ring breathes and the target ring does not. Holding still is the
   * signal: a line has found somewhere to land, and letting go now will join
   * them.
   */
  /*
   * Just clear of the ray tips, and nothing more.
   *
   * This was 2.1 times the star with a 30px floor, which put a 38px ring around
   * an 18px star and a 109px one around a 52px star -- big enough to read as a
   * region of the sky being selected rather than a star. The star box is the
   * star's full extent, since the long rays reach its edge, so a small fraction
   * past it is all the clearance a ring needs. No floor: the floor was what made
   * the smallest stars look most wrapped up.
   */
  const ringSize = starSize * 1.32;
  const ring =
    isLinkSource || isLinkTarget ? (
      <span
        aria-hidden="true"
        data-star-ring="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 rounded-full ${
          isLinkTarget ? "" : "constellation-star-ring"
        }`}
        style={{
          width: `${ringSize}px`,
          height: `${ringSize}px`,
          transform: "translate(-50%, -50%)",
          border: isLinkTarget
            ? "1.5px solid rgba(255, 255, 255, 0.85)"
            : "1px solid rgba(226, 230, 255, 0.6)",
          // Scaled with the ring: an 18px glow around a 24px circle is a halo,
          // not an edge.
          boxShadow: isLinkTarget
            ? "0 0 8px rgba(214, 221, 255, 0.45)"
            : "0 0 6px rgba(198, 202, 255, 0.28)",
        }}
      />
    ) : null;

  /*
   * A touch target a finger can actually land on.
   *
   * The drawn star is 18 to 52 pixels, and the button was exactly that -- so on
   * the smallest stars the thing you press is a quarter the size of the thing
   * you see, since the bloom around it is over three times wider. Miss it, and
   * the press lands on the sky instead, where nothing stops the browser reading
   * the drag as a page scroll. That is the screen moving when somebody meant to
   * move a star, and it is a hit-testing problem rather than a touch-action one.
   *
   * Overflowing the button rather than resizing it: the star's own box is what
   * places its light and its sparkles, and 44px is Apple's minimum rather than
   * a number that suits an 18px star.
   */
  const hitSize = Math.max(starSize, 44);
  const hitArea =
    onDragStart || onActivate ? (
      <span
        aria-hidden="true"
        data-star-hit-area="true"
        className="absolute left-1/2 top-1/2 touch-none rounded-full"
        style={{
          width: `${hitSize}px`,
          height: `${hitSize}px`,
          transform: "translate(-50%, -50%)",
        }}
      />
    ) : null;

  const visual = (
    <>
      {hitArea}
      {ring}
      {/* Behind the star and unmasked, so the light stands off it. */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2"
        aria-hidden="true"
        style={{
          width: `${starSize * BLOOM_BOX_RATIO}px`,
          height: `${starSize * BLOOM_BOX_RATIO}px`,
          transform: "translate(-50%, -50%)",
          background: getBloomBackground(glowStrength, light),
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: getStarGradient(light),
          /*
           * A background star is drawn the same as one in the sky.
           *
           * It used to be a tighter gradient at a lower opacity, and then had
           * three further dimmers stacked over it, so it arrived on screen as a
           * flat dot with no visible glow or twinkle. The background is meant
           * to be the same sky seen through the app, not a duller copy of it.
           */
          opacity: isPreview ? 0.92 : 0.86,
          filter: getStarGlowFilter(glowStrength, starSize, light),
          // How far down this star's breath goes. The keyframe reads it, so
          // every star in the sky swings a different amount.
          ["--twinkle-floor" as string]: isPreview
            ? 0.9
            : getTwinkleFloor(star).toFixed(3),
          animationName: "constellation-twinkle",
          animationDuration: getTwinkleDuration(star, isBackground),
          animationDelay: getTwinkleDelay(star),
          animationIterationCount: "infinite",
          animationTimingFunction: "ease-in-out",
          ...STAR_MASK_STYLE,
        }}
      />
      {sparkles.map((sparkle) => (
        <div
          key={sparkle.key}
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{
            width: `${sparkle.size}px`,
            height: `${sparkle.size}px`,
            left: `${sparkle.left}%`,
            top: `${sparkle.top}%`,
            marginLeft: `${-sparkle.size / 2}px`,
            marginTop: `${-sparkle.size / 2}px`,
            background: `rgba(${light.sparkle}, 0.95)`,
            // Matches the floor in constellation-sparkle: a sparkle is always
            // faintly lit, so this is where it sits before its cycle starts.
            opacity: 0.3,
            ["--sparkle-drift-x" as string]: `${sparkle.driftX}px`,
            ["--sparkle-drift-y" as string]: `${sparkle.driftY}px`,
            animationName: "constellation-sparkle",
            animationDuration: `${sparkle.duration}s`,
            animationDelay: `${sparkle.delay}s`,
            animationIterationCount: "infinite",
            animationTimingFunction: "ease-in-out",
            ...STAR_MASK_STYLE,
          }}
        />
      ))}
    </>
  );

  if (onDragStart || onNudge || onActivate) {
    const isConnecting = interaction === "connect";
    const instruction = isConnecting
      ? isLinkSource
        ? "Selected. Choose another star to join it to, or press Escape to cancel."
        : "Press to start a line from this star."
      : "Use the arrow keys to move this star.";

    return (
      <button
        type="button"
        data-star-id={star.id}
        aria-label={`${label}. ${instruction}`}
        aria-pressed={isConnecting ? isLinkSource : undefined}
        onPointerDown={(event) => {
          if (!onDragStart) return;
          /*
           * Focus without scrolling, then swallow the default.
           *
           * Pressing a star focuses it, and a browser scrolls a newly focused
           * control into view -- so on iPad, touching a star near the edge of a
           * 560px sky jumped the whole page under the finger mid-drag. Taking
           * the focus deliberately, with the scroll off, keeps the star
           * reachable by keyboard without the page moving.
           */
          event.currentTarget.focus({ preventScroll: true });
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          onDragStart(event.pointerType);
        }}
        onKeyDown={(event) => {
          if (isConnecting) {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate?.();
            }
            return;
          }
          if (!onNudge) return;
          const step = event.shiftKey ? 5 : 1;
          const offset = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step },
          }[event.key];
          if (!offset) return;
          event.preventDefault();
          onNudge({
            x: clampPercentage(star.position.x + offset.x),
            y: clampPercentage(star.position.y + offset.y),
          });
        }}
        /*
         * Round, so the focus ring is a circle around a star rather than a box
         * around one: an outline follows the element's own radius.
         */
        /*
         * `touch-none` on the button itself, which is the element a finger
         * actually lands on.
         *
         * The invisible hit area inside it already had this, but that span is
         * `aria-hidden` decoration -- the press is received here. iOS settles
         * whether a touch may scroll the page at the moment it starts, from the
         * `touch-action` of the element under the finger, and nothing later
         * takes that back: not `preventDefault` on a move, not capturing the
         * pointer. So the element under the finger has to say no first, and a
         * blocker on `touchmove` is only the second half of the fix.
         */
        className={`${className} touch-none rounded-full border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[6px] focus-visible:outline-[rgba(226,230,255,0.75)]`}
        style={style}
        title={label}
      >
        {visual}
      </button>
    );
  }

  return (
    <div
      className={className}
      style={style}
      title={label}
    >
      {visual}
    </div>
  );
}
