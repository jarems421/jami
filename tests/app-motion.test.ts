import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the app is allowed to do to feel like something.
 *
 * Motion here is shared: one stagger, one dialog entrance, one meter fill, used
 * across the whole product rather than reinvented per surface. A few rules bound
 * it, all of them easy to break by accident later, so they are held here rather
 * than only written down.
 */

const root = process.cwd();
const globals = readFileSync(join(root, "app", "globals.css"), "utf8");

const planningFiles = readdirSync(join(root, "components", "planning"))
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => ({
    name: `components/planning/${name}`,
    source: readFileSync(join(root, "components", "planning", name), "utf8"),
  }));

/** Every `@media (prefers-reduced-motion: no-preference)` block's contents. */
function noPreferenceBlocks(css: string) {
  const blocks: string[] = [];
  const marker = "@media (prefers-reduced-motion: no-preference)";
  let at = css.indexOf(marker);
  while (at >= 0) {
    const open = css.indexOf("{", at);
    let depth = 0;
    let cursor = open;
    while (cursor < css.length) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      cursor += 1;
    }
    blocks.push(css.slice(open, cursor));
    at = css.indexOf(marker, cursor);
  }
  return blocks;
}

const gated = noPreferenceBlocks(globals).join("\n");

/** The looping ones. A one-shot entrance is not what reduced motion is about. */
const LOOPING_ANIMATIONS = ["plan-spine-travel"];
const ONE_SHOT_ANIMATIONS = [
  "app-rise-in",
  "plan-sweep-in",
  "app-dialog-backdrop-in",
  "app-dialog-panel-in",
  "app-meter-grow",
];

describe("motion respects a student who asked for less of it", () => {
  it("runs every looping animation only where motion is welcome", () => {
    for (const animation of LOOPING_ANIMATIONS) {
      // Declared at top level, as every other animation in this file is.
      expect(globals).toContain(`@keyframes ${animation}`);
      // But only ever *applied* inside a no-preference block.
      expect(gated).toContain(animation);

      const applied = [...globals.matchAll(new RegExp(`animation:\\s*${animation}`, "g"))];
      expect(applied.length).toBeGreaterThan(0);
      for (const match of applied) {
        const declaration = globals.slice(match.index ?? 0, (match.index ?? 0) + 200);
        expect(gated).toContain(declaration.slice(0, 40));
      }
    }
  });

  it("gates every entrance animation too", () => {
    for (const animation of ONE_SHOT_ANIMATIONS) {
      expect(gated, `${animation} runs regardless of preference`).toContain(animation);
    }
  });

  it("leaves nothing invisible when those animations never run", () => {
    /*
     * The real trap. `app-rise` fills `both`, so its children sit at the
     * opening keyframe -- opacity 0 -- until the animation runs. Gating the
     * animation without giving the class a standalone resting state would hand
     * a student who asked for reduced motion a blank list rather than a still
     * one.
     */
    expect(globals).toMatch(/\.app-rise > \*\s*\{\s*opacity:\s*1;/);
    // The dialog entrance carries no fill mode, so it needs no such rescue --
    // but its own class must not hide anything either.
    expect(globals).not.toMatch(/\.app-dialog-panel\s*\{[^}]*opacity:\s*0/);
    expect(globals).not.toMatch(/\.app-dialog-backdrop\s*\{[^}]*opacity:\s*0/);
  });
});

describe("the shared meter", () => {
  it("grows by scaling rather than by animating width", () => {
    // Width is layout; scale is compositor work. A meter animating width would
    // cost a reflow on every frame of every bar on the page.
    expect(globals).toMatch(/@keyframes app-meter-grow \{[\s\S]*?scaleX/);
    expect(globals).not.toMatch(/@keyframes app-meter-grow \{[\s\S]*?width:/);
    expect(globals).toMatch(/\.app-meter-fill\s*\{\s*transform-origin:\s*left/);
  });

  it("keeps bars that track live work out of it", () => {
    /*
     * A bar tracking work in flight re-mounts while the work runs, and growing
     * from zero each time would say the job had restarted. Growth is opt-in,
     * and these deliberately do not opt in.
     */
    const live = [
      "components/practice/ExamGenerationProgress.tsx",
      "components/study/StudyCardStage.tsx",
    ];
    for (const file of live) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, `${file} opted a live bar into growing`).not.toMatch(
        /<ProgressBar[\s\S]*?\sgrow[\s>]/
      );
    }
  });
});

describe("atmosphere never means minting a star", () => {
  it("draws no star of its own anywhere in the planning surfaces", () => {
    /*
     * A star means a goal was earned. Scattering decorative ones to make a
     * screen feel magical is exactly how they stop meaning that, and the design
     * system reserves the shape for `NorthernStar` alone. These surfaces get
     * their feeling from light and motion instead.
     */
    for (const file of planningFiles) {
      expect(file.source, `${file.name} imports the earned-star shape`).not.toContain(
        "NorthernStar"
      );
      expect(file.source, `${file.name} draws a star-like polygon`).not.toMatch(/<polygon/i);
    }
  });

  it("lights the planning surfaces with lines, not drawn shapes or washes", () => {
    /*
     * "Light has no edge": a glow is never a disc drawn behind something to
     * stand in for its light. The agenda carried a small glowing circle per
     * sitting and it has been removed -- it read as a second bullet beside
     * every tick -- and the drifting wash across the top of the planner and the
     * Tutor front door read as a stain of light nobody had placed. What is
     * left is line.
     */
    expect(globals).toMatch(/\.plan-spine\s*\{[^}]*linear-gradient/);
    expect(globals).not.toContain("plan-node");
    expect(globals).not.toContain("plan-aurora");
  });
});

describe("the atmosphere stays cheap", () => {
  it("adds no blend mode or promoted layer to the shared motion layers", () => {
    /*
     * Today carries up to sixty stars behind the plan card. An earlier pass
     * elsewhere in the app put blended, promoted layers on every star and the
     * page was visibly laggy, so these layers animate transform and opacity
     * only.
     */
    const rules = [
      ...globals.matchAll(/\.(?:plan-|app-rise|app-dialog|app-meter)[a-z-]*[^{}]*\{([^}]*)\}/g),
    ]
      .map((match) => match[1] ?? "")
      .join("\n");

    expect(rules).not.toBe("");
    expect(rules).not.toContain("mix-blend-mode");
    expect(rules).not.toContain("will-change");
    expect(rules).not.toMatch(/animation:[^;]*\b(width|height|margin|padding)\b/);
  });
});
