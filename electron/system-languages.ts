import { app } from "electron";

/** The machine's preferred languages, in its order; empty when the OS won't say. */
export function systemLanguages(): string[] {
  try {
    return app.getPreferredSystemLanguages();
  } catch {
    return [];
  }
}
