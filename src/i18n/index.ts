import { messages, type Messages } from "./messages";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locale";

export {
  chooseLocale,
  DEFAULT_LOCALE,
  isLanguagePreference,
  isLocale,
  LOCALE_NAMES,
  resolveLocale,
  type LanguagePreference,
  type Locale,
} from "./locale";
export type { Messages } from "./messages";

/**
 * The renderer knows its language before any of its modules runs: main
 * resolved it from the machine's languages and the preload hands it over
 * synchronously, so a label table built from `msg` at import time is already
 * in the right language. Main sets its own with `setLocale`; tests run in
 * the default.
 */
function initialLocale(): Locale {
  const fromPreload = (
    globalThis as { headTerminal?: { app?: { locale?: unknown } } }
  ).headTerminal?.app?.locale;
  return isLocale(fromPreload) ? fromPreload : DEFAULT_LOCALE;
}

export let locale: Locale = initialLocale();

/**
 * Every text the app shows, in its language. Read it where the text is used
 * (`msg.sidebar.title`); never keep a reference taken at import time in main,
 * whose language is only set once the app is ready.
 */
export let msg: Messages = messages[locale];

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale;
}

/** Called on every language switch, after `msg` already speaks the new one. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Switches the language on the spot: main at startup and when Settings picks
 * another one, the renderer on that same pick. The renderer re-renders
 * through `useLocale`; label tables read `msg` when accessed, so they follow.
 */
export function setLocale(next: Locale): void {
  if (next === locale) {
    return;
  }
  locale = next;
  msg = messages[next];
  for (const listener of listeners) {
    listener();
  }
}
