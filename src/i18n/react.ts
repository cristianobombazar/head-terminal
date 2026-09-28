import { useSyncExternalStore } from "react";

import { getLocale, subscribeLocale, type Locale } from ".";

/**
 * Re-renders the calling component when the language switches. The app root
 * calls it, so the whole tree re-renders in place — nothing remounts, no
 * terminal restarts; a `memo` component calls it too, since it would
 * otherwise skip that re-render.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
