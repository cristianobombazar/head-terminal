import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isLanguagePreference, type LanguagePreference } from "../../src/i18n/locale";

/**
 * The language picked in Settings lives in main's own file, not in the
 * renderer's localStorage: main needs it before the window exists, to build
 * the menu and hand the renderer its language.
 */
const FILE_NAME = "language.json";

/** Synchronous on purpose: read once at startup. Anything unreadable is "auto". */
export function readLanguagePreference(userDataPath: string): LanguagePreference {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataPath, FILE_NAME), "utf8"));
    const value = (parsed as { language?: unknown } | null)?.language;
    return isLanguagePreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export async function writeLanguagePreference(
  userDataPath: string,
  preference: LanguagePreference,
): Promise<void> {
  await writeFile(
    join(userDataPath, FILE_NAME),
    `${JSON.stringify({ language: preference })}\n`,
    "utf8",
  );
}
