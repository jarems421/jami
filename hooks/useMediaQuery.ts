"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Below Tailwind's `md` breakpoint: the layout where pages show their phone variant. */
export const PHONE_LAYOUT_QUERY = "(max-width: 767px)";

/**
 * Where the notebook treats the screen as a phone's: viewing and light typed
 * notes. Narrower than the app's own phone layout, so an iPad mini held
 * upright (744 CSS px) gets the full notebook, as every other iPad does.
 */
export const NOTEBOOK_PHONE_LAYOUT_QUERY = "(max-width: 699px)";

/**
 * Whether a media query matches, kept current as it changes.
 *
 * False on the server and while hydrating, so the first client render agrees
 * with the markup the server sent; the real answer follows straight after.
 * After that it is read synchronously, so a page reached by client navigation
 * renders the right layout on its first frame instead of correcting itself.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getServerSnapshot() {
  return false;
}
