import { describe, expect, it } from "vitest";

import { chooseLocale, isLanguagePreference, resolveLocale } from "./locale";

describe("resolveLocale", () => {
  it("speaks English on an English machine, whatever the region", () => {
    expect(resolveLocale(["en-BR"])).toBe("en");
    expect(resolveLocale(["en-US", "pt-BR"])).toBe("en");
    expect(resolveLocale(["en_GB"])).toBe("en");
  });

  it("speaks Portuguese on a Portuguese machine, Portugal included", () => {
    expect(resolveLocale(["pt-BR"])).toBe("pt-BR");
    expect(resolveLocale(["pt-PT", "en-US"])).toBe("pt-BR");
    expect(resolveLocale(["PT"])).toBe("pt-BR");
  });

  it("follows the first language it speaks in the machine's order", () => {
    expect(resolveLocale(["es-ES", "en-US", "pt-BR"])).toBe("en");
    expect(resolveLocale(["fr-FR", "pt-BR", "en-US"])).toBe("pt-BR");
  });

  it("falls back to Portuguese when it can't decide", () => {
    expect(resolveLocale(["es-ES", "fr-FR"])).toBe("pt-BR");
    expect(resolveLocale([])).toBe("pt-BR");
    expect(resolveLocale([""])).toBe("pt-BR");
  });
});

describe("chooseLocale", () => {
  it("follows the machine on auto", () => {
    expect(chooseLocale("auto", ["en-BR"])).toBe("en");
    expect(chooseLocale("auto", ["fr-FR"])).toBe("pt-BR");
  });

  it("keeps the language the user picked, whatever the machine says", () => {
    expect(chooseLocale("pt-BR", ["en-BR"])).toBe("pt-BR");
    expect(chooseLocale("en", ["pt-BR"])).toBe("en");
  });
});

describe("isLanguagePreference", () => {
  it("takes auto and the two languages, nothing else", () => {
    expect(["auto", "pt-BR", "en"].every(isLanguagePreference)).toBe(true);
    expect(["pt", "en-US", "", null, 1].some(isLanguagePreference)).toBe(false);
  });
});
