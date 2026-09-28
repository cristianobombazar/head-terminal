import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLanguagePreference, writeLanguagePreference } from "./language-preference";

describe("language preference", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "head-terminal-language-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("follows the machine until the user picks a language", () => {
    expect(readLanguagePreference(dir)).toBe("auto");
  });

  it("reads back the language the user picked", async () => {
    await writeLanguagePreference(dir, "en");
    expect(readLanguagePreference(dir)).toBe("en");

    await writeLanguagePreference(dir, "pt-BR");
    expect(readLanguagePreference(dir)).toBe("pt-BR");
  });

  it("takes a broken or foreign file as auto", () => {
    writeFileSync(join(dir, "language.json"), "{ not json");
    expect(readLanguagePreference(dir)).toBe("auto");

    writeFileSync(join(dir, "language.json"), JSON.stringify({ language: "fr" }));
    expect(readLanguagePreference(dir)).toBe("auto");
  });
});
