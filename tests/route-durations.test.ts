import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Route time limits come from a short, shared list.
 *
 * Vercel builds one serverless function for each distinct route configuration,
 * and the Hobby plan refuses a deployment with more than twelve. Every new
 * `maxDuration` value is a new function: one route with its own 40 seconds
 * made thirteen, and every deployment after it failed while CI stayed green.
 * Raising a route's cap to the next shared value never shortens it, so pick
 * from the list rather than adding to it.
 */
const SHARED_DURATIONS = [30, 60, 120, 150, 180, 300];

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return /^(route|page|layout)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("route time limits", () => {
  it("use only the shared durations, so the deployment stays within its function limit", () => {
    const strays = routeFiles(join(process.cwd(), "app")).flatMap((file) => {
      const match = /^export const maxDuration = (\d+);?\s*$/m.exec(readFileSync(file, "utf8"));
      return match && !SHARED_DURATIONS.includes(Number(match[1])) ? [`${file}: ${match[1]}`] : [];
    });
    expect(strays).toEqual([]);
  });
});
