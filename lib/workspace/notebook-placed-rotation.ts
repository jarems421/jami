/**
 * A placed image's or graph's turn, kept only when there is one: in radians,
 * folded into a half turn either way. Absent and upright are the same, so
 * older pages and older builds read it as they always did.
 */
export function placedRotation(value: unknown): { rotation?: number } {
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  const folded = value - 2 * Math.PI * Math.round(value / (2 * Math.PI));
  return Math.abs(folded) < 1e-4 ? {} : { rotation: folded };
}
