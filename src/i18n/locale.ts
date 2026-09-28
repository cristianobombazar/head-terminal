export type Locale = "pt-BR" | "en";

/** Brazilian Portuguese, unless the machine clearly prefers English. */
export const DEFAULT_LOCALE: Locale = "pt-BR";

export function isLocale(value: unknown): value is Locale {
  return value === "pt-BR" || value === "en";
}

/** What the user picked in Settings: follow the machine, or one language. */
export type LanguagePreference = "auto" | Locale;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "auto" || isLocale(value);
}

/** Each language by its own name, the same whatever the UI is in. */
export const LOCALE_NAMES: Record<Locale, string> = {
  "pt-BR": "Português (Brasil)",
  en: "English",
};

/** The picked language, or — on "auto" — the machine's. */
export function chooseLocale(
  preference: LanguagePreference,
  systemLanguages: readonly string[],
): Locale {
  return preference === "auto" ? resolveLocale(systemLanguages) : preference;
}

/**
 * The first of the machine's preferred languages the app speaks, in the
 * machine's own order: `en-BR` is English, `pt-PT` is Portuguese. A machine
 * that prefers neither — or says nothing — gets the default.
 */
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const primary = language.trim().toLowerCase().split(/[-_]/u)[0];
    if (primary === "en") return "en";
    if (primary === "pt") return "pt-BR";
  }
  return DEFAULT_LOCALE;
}
