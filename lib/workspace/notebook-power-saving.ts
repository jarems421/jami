/**
 * Whether the browser is holding the page to 30 frames a second to save power.
 *
 * Safari on an iPad does that to every web page in Low Power Mode (and when
 * the iPad runs hot): it draws the page every 33 ms, however little the page
 * asks of it, and no page can opt out. A notebook is drawn by the page -- the
 * ink, panning, the toolbar -- so it shows the cap more than any other screen,
 * while scrolling elsewhere, which the iPad does itself, stays smooth.
 * Students take it for the app being slow, so the notebook says what is
 * happening and how to turn it off.
 *
 * The cap is told from a page that is merely busy by how steady it is: capped,
 * nearly every frame is 33 ms and none is quicker; busy at 60 a second, the
 * frames mix 17 ms with longer ones.
 */
export const NOTEBOOK_POWER_SAVING_FRAMES = {
  /** A capped frame: 33 ms, with room for timer jitter. */
  cappedMinMs: 29,
  cappedMaxMs: 40,
  /** The share of frames that must look capped. */
  cappedShare: 0.8,
  /** Quicker than this, the page was drawn at full rate. */
  fastMs: 25,
  /** The share of quick frames that rules the cap out. */
  fastShare: 0.05,
  /** Too few frames to say. */
  minFrames: 20,
};

/** Whether these frame intervals (ms) are a page held to 30 frames a second. */
export function isNotebookFrameRateCapped(intervals: readonly number[]): boolean {
  const limits = NOTEBOOK_POWER_SAVING_FRAMES;
  if (intervals.length < limits.minFrames) return false;
  let capped = 0;
  let fast = 0;
  for (const interval of intervals) {
    if (interval < limits.fastMs) fast += 1;
    else if (interval >= limits.cappedMinMs && interval <= limits.cappedMaxMs) capped += 1;
  }
  return fast / intervals.length <= limits.fastShare && capped / intervals.length >= limits.cappedShare;
}

/** How the frame rate is sampled while a notebook is open. */
export const NOTEBOOK_POWER_SAVING_SAMPLING = {
  /** After the notebook opens, once its own opening work is done. */
  firstAfterMs: 1500,
  /** How long each look lasts. */
  sampleMs: 1000,
  /** How often to look again: Low Power Mode comes on by itself at 20% battery. */
  everyMs: 60_000,
};

/** What the notice says: Low Power Mode on an iPad or iPhone, battery saver elsewhere. */
export function notebookPowerSavingMessage(appleDevice: boolean): string {
  return appleDevice
    ? "Low Power Mode is slowing writing down. Turn it off in Settings → Battery for smooth ink."
    : "Battery saver is slowing writing down. Turn it off for smooth ink.";
}
